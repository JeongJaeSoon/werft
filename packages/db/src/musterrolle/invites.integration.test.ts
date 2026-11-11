import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SESSION_SCOPE_VALUES } from "@werft-ai/contracts";
import {
  type AcceptInviteInput,
  type ActingOwner,
  BootstrapDoneError,
  callerFor,
  InvalidCursorError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { dbNow } from "../db-clock.ts";
import * as schema from "../schema.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  invites,
  loginMethods,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { encodeMemberCursor } from "../sessions/cursors.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { bootstrapOwner, createWebSession } from "./identity.ts";
import { createPostgresInviteStore } from "./invites.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

function hashOf(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token).digest());
}

integration("invite store on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresInviteStore>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresInviteStore(db);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function account(email = `${randomUUID()}@example.invalid`) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: `hash-${userId}`,
      displayName: "Someone",
    });
    return { userId, email, passwordHash: `hash-${userId}` };
  }

  async function member(workspaceId: string, role: "owner" | "member") {
    const created = await account();
    await db
      .insert(memberships)
      .values({ workspaceId, userId: created.userId, role });
    return created.userId;
  }

  function acting(workspaceId: string, userId: string): ActingOwner {
    return {
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...SESSION_SCOPE_VALUES],
        },
        { kind: "web" },
        randomUUID(),
      ),
      workspaceId,
      userId,
    };
  }

  async function issue(
    actor: ActingOwner,
    email: string,
    options: { role?: "owner" | "member"; ttlMs?: number } = {},
  ) {
    const token = `apv_${randomUUID()}`;
    const receiptId = randomUUID();
    const result = await store.createInvite({
      id: randomUUID(),
      actor,
      email,
      role: options.role ?? "member",
      tokenHash: hashOf(token),
      ttlMs: options.ttlMs ?? 7 * DAY_MS,
      receiptId,
    });
    return { result, token, receiptId };
  }

  function newAccount(token: string, email = "x"): AcceptInviteInput {
    return {
      tokenHash: hashOf(token),
      account: {
        kind: "new",
        userId: randomUUID(),
        passwordHash: `new-hash-${email}`,
        displayName: "New",
        loginMethodId: randomUUID(),
      },
      session: {
        id: randomUUID(),
        tokenHash: hashOf(randomUUID()),
        ttlMs: DAY_MS,
        userAgent: null,
        maxLive: 10,
      },
      receiptId: randomUUID(),
    };
  }

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  test("an invite keeps only its token's hash and expires on the database clock", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const { result, token, receiptId } = await issue(
      acting(ws, owner),
      "hash-only@example.invalid",
    );
    if (result.outcome !== "created") throw new Error(result.outcome);
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, result.invite.id));
    expect(Buffer.from(row?.tokenHash ?? []).toString("hex")).toBe(
      Buffer.from(hashOf(token)).toString("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(token);
    const ttl =
      (row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0);
    expect(Math.abs(ttl - 7 * DAY_MS)).toBeLessThan(5_000);
    expect(result.invite.status).toBe("pending");
    const written = await receipt(receiptId);
    expect(written?.operation).toBe("invite_member");
    expect(JSON.stringify(written?.actor)).toContain(owner);
  });

  test("issuing again revokes the address's live invite", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const first = await issue(actor, "again@example.invalid");
    const second = await issue(actor, "again@example.invalid");
    expect(second.result.outcome).toBe("created");
    expect(await store.peekInvite(hashOf(first.token))).toEqual({
      outcome: "expired",
    });
    expect(await store.acceptInvite(newAccount(first.token))).toEqual({
      outcome: "expired",
    });
    expect((await store.peekInvite(hashOf(second.token))).outcome).toBe(
      "pending",
    );
  });

  test("a live member's address and a demoted actor are refused", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const other = await account();
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId: other.userId, role: "member" });
    expect((await issue(acting(ws, owner), other.email)).result).toEqual({
      outcome: "already_member",
    });
    const demoted = await member(ws, "member");
    expect(
      (await issue(acting(ws, demoted), "late@example.invalid")).result,
    ).toEqual({ outcome: "actor_inactive" });
  });

  test("a new address gets an account, a membership, a session and a receipt, once", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const { token } = await issue(acting(ws, owner), "fresh@example.invalid", {
      role: "owner",
    });
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "pending",
      email: "fresh@example.invalid",
      existingUser: null,
    });
    const input = newAccount(token);
    const accepted = await store.acceptInvite(input);
    expect(accepted).toMatchObject({
      outcome: "accepted",
      userId: input.account.userId,
      workspaceId: ws,
      role: "owner",
    });
    const [joined] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, ws),
          eq(memberships.userId, input.account.userId),
        ),
      );
    expect(joined?.role).toBe("owner");
    const [session] = await db
      .select()
      .from(webSessions)
      .where(eq(webSessions.id, input.session.id));
    expect(session?.userId).toBe(input.account.userId);
    const methods = await db
      .select()
      .from(loginMethods)
      .where(eq(loginMethods.userId, input.account.userId));
    expect(methods.map((m) => m.kind)).toEqual(["password"]);
    const written = await receipt(input.receiptId);
    expect(written?.operation).toBe("accept_invite");
    expect(JSON.stringify(written?.actor)).toContain(input.account.userId);
    expect(await store.acceptInvite(newAccount(token))).toEqual({
      outcome: "used",
    });
    expect(await store.peekInvite(hashOf(token))).toEqual({ outcome: "used" });
  });

  test("an existing account joins only with the hash it was verified against, and keeps its password", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const existing = await account("known@example.invalid");
    const { token } = await issue(acting(ws, owner), existing.email);
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "pending",
      email: existing.email,
      existingUser: {
        id: existing.userId,
        passwordHash: existing.passwordHash,
      },
    });
    const base = newAccount(token);
    expect(
      await store.acceptInvite({
        ...base,
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: "an older hash",
        },
      }),
    ).toEqual({ outcome: "account_changed" });
    expect(
      await store.acceptInvite({
        ...base,
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: existing.passwordHash,
        },
      }),
    ).toMatchObject({ outcome: "accepted", userId: existing.userId });
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, existing.userId));
    expect(row?.passwordHash).toBe(existing.passwordHash);
    expect(row?.displayName).toBe("Someone");
  });

  test("revoking: pending, then again, then an accepted invite", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const pending = await issue(actor, "revoke@example.invalid");
    if (pending.result.outcome !== "created") throw new Error("not created");
    const id = pending.result.invite.id;
    expect(
      await store.revokeInvite({ id, actor, receiptId: randomUUID() }),
    ).toEqual({ outcome: "revoked" });
    expect(
      await store.revokeInvite({ id, actor, receiptId: randomUUID() }),
    ).toEqual({ outcome: "already_revoked" });
    expect(await store.peekInvite(hashOf(pending.token))).toEqual({
      outcome: "expired",
    });
    const used = await issue(actor, "used@example.invalid");
    if (used.result.outcome !== "created") throw new Error("not created");
    await store.acceptInvite(newAccount(used.token));
    expect(
      await store.revokeInvite({
        id: used.result.invite.id,
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "accepted" });
    expect(
      await store.revokeInvite({
        id: randomUUID(),
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    const statuses = (await store.listInvites(ws, 10)).map((i) => i.status);
    expect(statuses.sort()).toEqual(["accepted", "revoked"]);
  });

  test("an expired invite cannot be accepted and lists as expired", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "slow@example.invalid", { ttlMs: 1 });
    await Bun.sleep(10);
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "expired",
    });
    expect(await store.acceptInvite(newAccount(token))).toEqual({
      outcome: "expired",
    });
    expect((await store.listInvites(ws, 10))[0]?.status).toBe("expired");
    expect(await store.peekInvite(hashOf("never issued"))).toEqual({
      outcome: "unknown",
    });
  });

  test("two accepts of one token: exactly one account", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "twice@example.invalid");
    const results = await Promise.all([
      store.acceptInvite(newAccount(token)),
      store.acceptInvite(newAccount(token)),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "used"]);
    const created = await db
      .select()
      .from(users)
      .where(eq(users.email, "twice@example.invalid"));
    expect(created).toHaveLength(1);
  });

  test("an account created for the address mid-accept answers account_changed", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "race@example.invalid");
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'race@example.invalid', 'x', 'Race')",
        [randomUUID()],
      );
      const pending = store.acceptInvite(newAccount(token));
      await Bun.sleep(300);
      await other.query("COMMIT");
      expect(await pending).toEqual({ outcome: "account_changed" });
    } finally {
      other.release();
    }
    expect((await store.peekInvite(hashOf(token))).outcome).toBe("pending");
  });

  test("a new account waits on the email lock an external first sign-in holds", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "shared@example.invalid");
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "SELECT pg_advisory_xact_lock(hashtext('login-email:shared@example.invalid'))",
      );
      let settled = false;
      const pending = store.acceptInvite(newAccount(token)).finally(() => {
        settled = true;
      });
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await other.query("COMMIT");
      expect((await pending).outcome).toBe("accepted");
    } finally {
      other.release();
    }
  });

  test("an invite that expires while the accept waits on a lock is not accepted", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const existing = await account();
    const { token } = await issue(actor, existing.email, { ttlMs: 1_000 });
    const other = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        existing.userId,
      ]);
      // Takes the invite while it is live, then waits on the user row.
      pending = store.acceptInvite({
        ...newAccount(token),
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: existing.passwordHash,
        },
      });
      await Bun.sleep(1_500);
      await other.query("COMMIT");
      expect(await pending).toEqual({ outcome: "expired" });
    } finally {
      other.release();
    }
    const joined = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, ws),
          eq(memberships.userId, existing.userId),
        ),
      );
    expect(joined).toHaveLength(0);
  });

  test("issuing and accepting lock the actor's user row before its membership", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const other = await pool.connect();
    try {
      // The accept order: user row, then membership.
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        owner,
      ]);
      const issued = issue(acting(ws, owner), "order@example.invalid");
      await Bun.sleep(300);
      await other.query(
        "SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [ws, owner],
      );
      await other.query("COMMIT");
      expect((await issued).result.outcome).toBe("created");
    } finally {
      other.release();
    }
  });

  test("an actor whose account is disabled mid-write is refused", async () => {
    const ws = await workspace();
    const writes = [
      (owner: string) =>
        issue(acting(ws, owner), `${randomUUID()}@example.invalid`).then(
          ({ result }) => result,
        ),
      async (owner: string) =>
        store.changeMemberRole({
          userId: await member(ws, "member"),
          role: "owner",
          actor: acting(ws, owner),
          receiptId: randomUUID(),
        }),
    ];
    for (const write of writes) {
      const owner = await member(ws, "owner");
      const other = await pool.connect();
      try {
        // An account disable's order: the user row, then its memberships.
        await other.query("BEGIN");
        await other.query(
          "UPDATE users SET disabled_at = now() WHERE id = $1",
          [owner],
        );
        await other.query(
          "SELECT 1 FROM memberships WHERE user_id = $1 FOR UPDATE",
          [owner],
        );
        const writing = write(owner);
        await Bun.sleep(300);
        await other.query("COMMIT");
        expect(await writing).toEqual({ outcome: "actor_inactive" });
      } finally {
        other.release();
      }
    }
  });

  test("a role change waiting on a suspension of its target answers account_disabled", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const target = await member(ws, "member");
    const other = await pool.connect();
    try {
      // An account disable's order: the user row, then its memberships.
      await other.query("BEGIN");
      await other.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
        target,
      ]);
      await other.query(
        "SELECT 1 FROM memberships WHERE user_id = $1 FOR UPDATE",
        [target],
      );
      const changing = store.changeMemberRole({
        userId: target,
        role: "admin",
        actor: acting(ws, owner),
        receiptId: randomUUID(),
      });
      // Commit only once the change is queued behind the suspension: started
      // after it, the change would pass without the fix too. Polled from the
      // pool, since a transaction sees pg_stat_activity as of its start.
      for (let tries = 0; ; tries++) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows[0].n > 0) break;
        if (tries > 100) throw new Error("the role change never waited");
        await Bun.sleep(50);
      }
      await other.query("COMMIT");
      expect(await changing).toEqual({ outcome: "account_disabled" });
    } finally {
      other.release();
    }
    const [row] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, target));
    expect(row?.role).toBe("member");
  });

  test("roles: nobody changes their own, and two owners demoting each other leave one", async () => {
    const ws = await workspace();
    const first = await member(ws, "owner");
    expect(
      await store.changeMemberRole({
        userId: first,
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "self_protected" });
    expect(
      await store.changeMemberRole({
        userId: randomUUID(),
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    const second = await member(ws, "owner");
    const results = await Promise.all([
      store.changeMemberRole({
        userId: second,
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
      store.changeMemberRole({
        userId: first,
        role: "member",
        actor: acting(ws, second),
        receiptId: randomUUID(),
      }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "actor_inactive",
      "changed",
    ]);
    const owners = (await store.listMembers(ws, { limit: 100 })).items.filter(
      (m) => m.role === "owner",
    );
    expect(owners).toHaveLength(1);
  });

  async function agent(
    workspaceId: string,
    name: string,
    status: "active" | "paused" | "archived" = "active",
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${id.slice(0, 8)}`,
      name,
      status,
    });
    return id;
  }

  async function team(workspaceId: string, people: string[], archived = false) {
    const id = randomUUID();
    await db.insert(memberTeams).values({
      id,
      workspaceId,
      name: `t-${id.slice(0, 8)}`,
      archivedAt: archived ? new Date() : null,
    });
    for (const userId of people) {
      await db
        .insert(memberTeamMembers)
        .values({ id: randomUUID(), workspaceId, teamId: id, userId });
    }
    return id;
  }

  test("a member row lists the agents they administer, telling direct from team", async () => {
    const ws = await workspace();
    const other = await workspace();
    const [direct, viaTeam, both, left, none] = [
      await member(ws, "member"),
      await member(ws, "member"),
      await member(ws, "member"),
      await member(ws, "member"),
      await member(ws, "member"),
    ];
    const zeta = await agent(ws, "Zeta");
    const alpha = await agent(ws, "Alpha", "paused");
    const gone = await agent(ws, "Gone", "archived");
    const shelved = await agent(ws, "Shelved");
    const elsewhere = await agent(other, "Elsewhere");
    await db.insert(agentAdmins).values([
      { workspaceId: ws, agentId: zeta, userId: direct },
      { workspaceId: ws, agentId: alpha, userId: direct },
      { workspaceId: ws, agentId: gone, userId: direct },
      { workspaceId: ws, agentId: zeta, userId: both },
    ]);
    const crew = await team(ws, [viaTeam, both, left]);
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(eq(memberTeamMembers.userId, left));
    const archivedTeam = await team(ws, [viaTeam], true);
    await db.insert(agentAdminTeams).values([
      { workspaceId: ws, agentId: zeta, teamId: crew },
      { workspaceId: ws, agentId: alpha, teamId: crew },
      { workspaceId: ws, agentId: shelved, teamId: archivedTeam },
    ]);
    const outsider = await member(other, "member");
    await db
      .insert(agentAdmins)
      .values({ workspaceId: other, agentId: elsewhere, userId: outsider });

    const rows = new Map(
      (await store.listMembers(ws, { limit: 100 })).items.map((row) => [
        row.userId,
        row.administeredAgents,
      ]),
    );
    expect(rows.get(direct)).toEqual([
      { id: alpha, name: "Alpha", via: "user" },
      { id: zeta, name: "Zeta", via: "user" },
    ]);
    expect(rows.get(viaTeam)).toEqual([
      { id: alpha, name: "Alpha", via: "team" },
      { id: zeta, name: "Zeta", via: "team" },
    ]);
    expect(rows.get(both)).toEqual([
      { id: alpha, name: "Alpha", via: "team" },
      { id: zeta, name: "Zeta", via: "user" },
    ]);
    expect(rows.get(left)).toEqual([]);
    expect(rows.get(none)).toEqual([]);
  });

  test("last_active_at is the newest web session touch, null without one", async () => {
    const ws = await workspace();
    const never = await member(ws, "member");
    const active = await member(ws, "member");
    const older = new Date("2026-10-01T00:00:00.000Z");
    const newer = new Date("2026-10-20T12:34:56.000Z");
    for (const [lastSeenAt, revokedAt] of [
      [newer, new Date("2026-10-21T00:00:00.000Z")],
      [older, null],
    ] as const) {
      await db.insert(webSessions).values({
        id: randomUUID(),
        userId: active,
        tokenHash: hashOf(randomUUID()),
        expiresAt: new Date(Date.now() + DAY_MS),
        revokedAt,
        lastSeenAt,
      });
    }
    const rows = new Map(
      (await store.listMembers(ws, { limit: 100 })).items.map((row) => [
        row.userId,
        row.lastActiveAt,
      ]),
    );
    expect(rows.get(never)).toBeNull();
    expect(rows.get(active)?.toISOString()).toBe(newer.toISOString());
  });

  test("last_active_at outlives an expired session and survives the next login's pruning", async () => {
    const ws = await workspace();
    const person = await account();
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId: person.userId, role: "member" });
    const expired = new Date("2026-09-01T00:00:00.000Z");
    await db.insert(webSessions).values({
      id: randomUUID(),
      userId: person.userId,
      tokenHash: hashOf(randomUUID()),
      expiresAt: new Date("2026-09-02T00:00:00.000Z"),
      lastSeenAt: expired,
    });
    const activeOf = async () =>
      (await store.listMembers(ws, { limit: 100 })).items.find(
        (row) => row.userId === person.userId,
      )?.lastActiveAt;
    expect((await activeOf())?.toISOString()).toBe(expired.toISOString());

    const before = await dbNow(db);
    expect(
      await createWebSession(db, {
        id: randomUUID(),
        userId: person.userId,
        verifiedPasswordHash: person.passwordHash,
        tokenHash: hashOf(randomUUID()),
        ttlMs: DAY_MS,
        userAgent: null,
        maxLive: 1,
      }),
    ).not.toBeNull();
    const rows = await db
      .select({ id: webSessions.id })
      .from(webSessions)
      .where(eq(webSessions.userId, person.userId));
    expect(rows).toHaveLength(1);
    expect((await activeOf())?.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });

  test("a member list shows the earlier of membership and account disabling", async () => {
    const ws = await workspace();
    const userId = await member(ws, "member");
    const at = new Date("2026-10-01T00:00:00.000Z");
    await db.update(users).set({ disabledAt: at }).where(eq(users.id, userId));
    const listed = (await store.listMembers(ws, { limit: 100 })).items.find(
      (m) => m.userId === userId,
    );
    expect(listed?.disabledAt?.toISOString()).toBe(at.toISOString());
  });

  async function named(
    workspaceId: string,
    displayName: string,
    email: string,
    createdAt: string,
  ) {
    const userId = randomUUID();
    await db
      .insert(users)
      .values({ id: userId, email, passwordHash: null, displayName });
    await db.insert(memberships).values({
      workspaceId,
      userId,
      role: "member",
      createdAt: sql`${createdAt}::timestamptz`,
    });
    return userId;
  }

  async function walk(workspaceId: string, limit: number, q?: string) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listMembers(workspaceId, { limit, q, cursor });
      pages.push(page.items.map((m) => m.userId));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return pages;
  }

  test("member pages walk every member once, oldest first, ties by user id", async () => {
    const ws = await workspace();
    const tag = randomUUID().slice(0, 8);
    // Same microsecond for three rows, so only the user id orders them.
    const stamps = [
      "2026-01-01 00:00:00.000001+00",
      "2026-01-01 00:00:00.000002+00",
      "2026-01-01 00:00:00.000002+00",
      "2026-01-01 00:00:00.000002+00",
      "2026-01-01 00:00:00.000003+00",
      "2026-01-02 00:00:00+00",
      "2026-01-03 00:00:00+00",
    ];
    const ids: { id: string; at: string }[] = [];
    for (const [index, at] of stamps.entries()) {
      ids.push({
        id: await named(
          ws,
          `P${index}`,
          `p${index}-${tag}@example.invalid`,
          at,
        ),
        at,
      });
    }
    const expected = ids
      .sort((a, b) =>
        a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1,
      )
      .map((row) => row.id);
    const pages = await walk(ws, 3);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
    expect(pages.flat()).toEqual(expected);
    expect((await walk(ws, 100)).flat()).toEqual(expected);
  });

  test("a page of exactly limit members is the last one", async () => {
    const ws = await workspace();
    for (const index of [0, 1, 2, 3]) {
      await member(ws, index === 0 ? "owner" : "member");
    }
    const first = await store.listMembers(ws, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await store.listMembers(ws, {
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.items).toHaveLength(2);
    expect(second.next_cursor).toBeNull();
    expect(await store.listMembers(ws, { limit: 4 })).toMatchObject({
      next_cursor: null,
    });
  });

  test("q matches name or email in part, ignoring case, wildcards literal", async () => {
    const ws = await workspace();
    const other = await workspace();
    const tag = randomUUID().slice(0, 8);
    const at = "2026-01-01 00:00:00+00";
    const kim = await named(ws, "Kim Minji", `mj-${tag}@corp.invalid`, at);
    const lee = await named(ws, "Lee", `lee.kim-${tag}@corp.invalid`, at);
    const percent = await named(ws, "100% Kim", `pc-${tag}@corp.invalid`, at);
    const under = await named(ws, "a_b", `ab-${tag}@corp.invalid`, at);
    const slash = await named(ws, "back\\slash", `bs-${tag}@corp.invalid`, at);
    const plain = await named(ws, "axb", `axb-${tag}@corp.invalid`, at);
    await named(other, "Kim Elsewhere", `kim-${tag}@other.invalid`, at);
    const disabled = await named(
      ws,
      "Kim Gone",
      `gone-${tag}@corp.invalid`,
      at,
    );
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, disabled));
    const ids = async (q: string) => (await walk(ws, 100, q)).flat().sort();
    expect(await ids("kim")).toEqual([kim, lee, percent, disabled].sort());
    expect(await ids("MINJI")).toEqual([kim]);
    // Emails are stored lowercase; the query side still ignores case.
    expect(await ids(`LEE.KIM-${tag}`)).toEqual([lee]);
    expect(await ids("%")).toEqual([percent]);
    expect(await ids("a_b")).toEqual([under]);
    expect(await ids("_")).toEqual([under]);
    expect(await ids("\\")).toEqual([slash]);
    expect(await ids("x")).toEqual([plain]);
    expect(await ids("elsewhere")).toEqual([]);
    expect((await walk(ws, 1, "kim")).map((page) => page.length)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test("user_ids keeps the members among them, in list order, and pages by the same cursor", async () => {
    const ws = await workspace();
    const elsewhere = await workspace();
    const tag = randomUUID().slice(0, 8);
    const at = (day: number) => `2026-02-0${day} 00:00:00+00`;
    const first = await named(ws, "A", `a-${tag}@example.invalid`, at(1));
    await named(ws, "B", `b-${tag}@example.invalid`, at(2));
    const third = await named(ws, "C", `c-${tag}@example.invalid`, at(3));
    const outsider = await named(
      elsewhere,
      "D",
      `d-${tag}@example.invalid`,
      at(4),
    );
    const read = async (userIds: string[], limit = 100) => {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listMembers(ws, {
          limit,
          user_ids: userIds,
          cursor,
        });
        pages.push(page.items.map((m) => m.userId));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return pages;
    };
    // Asked out of order and in capitals; another workspace's member and an
    // unknown id are left out.
    expect(
      await read([third.toUpperCase(), outsider, randomUUID(), first]),
    ).toEqual([[first, third]]);
    expect(await read([third, first], 1)).toEqual([[first], [third]]);
  });

  test("a cursor the store did not mint is InvalidCursorError", async () => {
    const ws = await workspace();
    const forged = [
      "not-base64-json",
      Buffer.from("{}").toString("base64url"),
      encodeMemberCursor({ created_at: "2026-01-01", user_id: randomUUID() }),
      encodeMemberCursor({
        created_at: "2026-01-01 00:00:00+00",
        user_id: "not-a-uuid",
      }),
      encodeMemberCursor({
        created_at: "2026-13-01 00:00:00+00",
        user_id: randomUUID(),
      }),
    ];
    for (const cursor of forged) {
      await expect(
        store.listMembers(ws, { limit: 10, cursor }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });
});

// Owner recovery counts live owners across the install, so it gets a database
// of its own.
integration("invites across owner recovery on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_recovery_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("recovering an owner revokes every invite issued before it", async () => {
    const store = createPostgresInviteStore(db);
    const ws = randomUUID();
    await db.insert(workspaces).values({ id: ws, slug: "recover", name: "r" });
    const owner = randomUUID();
    await db.insert(users).values({
      id: owner,
      email: "lost@example.invalid",
      passwordHash: "old",
      displayName: "Lost",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId: owner, role: "owner" });
    const token = `apv_${randomUUID()}`;
    const created = await store.createInvite({
      id: randomUUID(),
      actor: {
        principal: callerFor(
          {
            kind: "user",
            id: owner,
            workspace_id: ws,
            role: "owner",
            scopes: [...SESSION_SCOPE_VALUES],
          },
          { kind: "web" },
          randomUUID(),
        ),
        workspaceId: ws,
        userId: owner,
      },
      email: "outsider@example.invalid",
      role: "owner",
      tokenHash: hashOf(token),
      ttlMs: 7 * DAY_MS,
      receiptId: randomUUID(),
    });
    expect(created.outcome).toBe("created");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner));

    await bootstrapOwner(db, {
      userId: randomUUID(),
      email: "lost@example.invalid",
      passwordHash: "recovered",
      displayName: "Lost",
      workspaceId: randomUUID(),
      workspaceSlug: "unused",
      workspaceName: "unused",
      bootstrapTokenHash: hashOf("recovery token"),
      receiptId: randomUUID(),
      loginMethodId: randomUUID(),
    });

    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "expired",
    });
    expect((await store.listInvites(ws, 10))[0]?.status).toBe("revoked");
  });
});

integration("owner recovery racing an owner invite on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_recovery_race_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("recovery stops when an accept it waited on created a live owner", async () => {
    const ws = randomUUID();
    await db.insert(workspaces).values({ id: ws, slug: "race", name: "r" });
    const lost = randomUUID();
    await db.insert(users).values({
      id: lost,
      email: "gone@example.invalid",
      passwordHash: "old",
      displayName: "Gone",
    });
    await db.insert(memberships).values({
      workspaceId: ws,
      userId: lost,
      role: "owner",
      disabledAt: new Date(),
    });
    const inviteId = randomUUID();
    await db.insert(invites).values({
      id: inviteId,
      workspaceId: ws,
      email: "heir@example.invalid",
      role: "owner",
      tokenHash: hashOf(`apv_${randomUUID()}`),
      invitedBy: lost,
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const heir = randomUUID();
    const accept = await pool.connect();
    try {
      // What an accept holds and writes before it commits.
      await accept.query("BEGIN");
      await accept.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
        inviteId,
      ]);
      await accept.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'heir@example.invalid', 'x', 'Heir')",
        [heir],
      );
      await accept.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [ws, heir],
      );
      await accept.query(
        "UPDATE invites SET accepted_at = clock_timestamp() WHERE id = $1",
        [inviteId],
      );
      const recovery = bootstrapOwner(db, {
        userId: randomUUID(),
        email: "gone@example.invalid",
        passwordHash: "recovered",
        displayName: "Gone",
        workspaceId: randomUUID(),
        workspaceSlug: "unused",
        workspaceName: "unused",
        bootstrapTokenHash: hashOf("second recovery token"),
        receiptId: randomUUID(),
        loginMethodId: randomUUID(),
      });
      await Bun.sleep(300);
      await accept.query("COMMIT");
      await expect(recovery).rejects.toBeInstanceOf(BootstrapDoneError);
    } finally {
      accept.release();
    }
    const [kept] = await db.select().from(users).where(eq(users.id, lost));
    expect(kept?.passwordHash).toBe("old");
  });
});
