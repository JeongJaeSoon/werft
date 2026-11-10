import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import * as schema from "./schema.ts";
import {
  agentAdminTeams,
  agents,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

integration("teams as agent admins on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_admin_teams_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
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

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";

  function acting(caller: Caller): TeamActor {
    return {
      principal: caller,
      workspaceId: caller.ownerId,
      userId: idOf(caller),
    };
  }

  async function agent(workspaceId: string, createdBy: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${id.slice(0, 8)}`,
      name: "agent",
      createdBy,
    });
    return id;
  }

  const teams = () => createPostgresTeamStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const authority = () => createDatabaseAgentAuthority(db);

  async function newTeam(by: Caller, name = `team-${randomUUID()}`) {
    const result = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name,
    });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.team;
  }

  const member = (by: Caller, teamId: string, who: Caller, add = true) =>
    teams()[add ? "addMember" : "removeMember"]({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  test("a team administers an agent through its live members, read at every decision", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const managed = await person(workspaceId, "member");
    const outside = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, idOf(owner));
    const team = await newTeam(owner);
    await member(owner, team.id, managed);
    const isAdmin = (who: Caller) =>
      authority().isAdmin(workspaceId, agentId, idOf(who));

    expect(await isAdmin(managed)).toBe(false);
    const assigned = await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "team", id: team.id },
      managerRoles: MANAGERS,
    });
    expect(assigned).toMatchObject({
      outcome: "added",
      admins: { teams: [{ teamId: team.id, name: team.name }] },
    });
    expect(await isAdmin(managed)).toBe(true);
    expect(await isAdmin(outside)).toBe(false);
    expect(
      (await admins().listAdministered(workspaceId, idOf(managed), 50)).map(
        (a) => a.id,
      ),
    ).toEqual([agentId]);

    // Out of the team: out of the agent, from the next read on.
    await member(owner, team.id, managed, false);
    expect(await isAdmin(managed)).toBe(false);
    expect(
      await admins().listAdministered(workspaceId, idOf(managed), 50),
    ).toEqual([]);

    // Back in, then a disabled membership holds nothing through the team.
    await member(owner, team.id, managed);
    expect(await isAdmin(managed)).toBe(true);
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(managed)));
    expect(await isAdmin(managed)).toBe(false);
    await db
      .update(memberships)
      .set({ disabledAt: null })
      .where(eq(memberships.userId, idOf(managed)));
    expect(await isAdmin(managed)).toBe(true);

    // Deleting the team ends what it lent.
    await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: team.id,
    });
    expect(await isAdmin(managed)).toBe(false);
    expect(
      await db
        .select()
        .from(agentAdminTeams)
        .where(eq(agentAdminTeams.agentId, agentId)),
    ).toEqual([]);
  });

  test("who may change an agent's admins, and to whom", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const creator = await person(workspaceId, "member");
    const plain = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, idOf(creator));
    const change = (
      by: Caller,
      subject: { kind: "user" | "team"; id: string },
      add = true,
    ) =>
      admins()[add ? "add" : "remove"]({
        actor: acting(by),
        receiptId: randomUUID(),
        agentId,
        subject,
        managerRoles: MANAGERS,
      });

    // A plain member does not hold the right; an owner does.
    expect(await change(plain, { kind: "user", id: idOf(plain) })).toEqual({
      outcome: "actor_inactive",
    });
    expect(
      await change(owner, { kind: "user", id: idOf(creator) }),
    ).toMatchObject({ outcome: "added" });
    // The agent's admin may name another.
    expect(
      await change(creator, { kind: "user", id: idOf(plain) }),
    ).toMatchObject({ outcome: "added" });
    expect(
      await change(creator, { kind: "user", id: idOf(plain) }),
    ).toMatchObject({ outcome: "unchanged" });
    expect(await change(owner, { kind: "user", id: randomUUID() })).toEqual({
      outcome: "subject_not_found",
    });
    // A disabled member cannot be named an admin.
    const gone = await person(workspaceId, "member");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(gone)));
    expect(await change(owner, { kind: "user", id: idOf(gone) })).toEqual({
      outcome: "subject_not_found",
    });
    expect(await change(owner, { kind: "team", id: randomUUID() })).toEqual({
      outcome: "subject_not_found",
    });
    const elsewhere = await workspace();
    const foreignTeam = await newTeam(await person(elsewhere, "owner"));
    expect(await change(owner, { kind: "team", id: foreignTeam.id })).toEqual({
      outcome: "subject_not_found",
    });
    expect(
      await admins().add({
        actor: acting(owner),
        receiptId: randomUUID(),
        agentId: randomUUID(),
        subject: { kind: "user", id: idOf(plain) },
        managerRoles: MANAGERS,
      }),
    ).toEqual({ outcome: "not_found" });

    expect(
      await change(owner, { kind: "user", id: idOf(plain) }, false),
    ).toMatchObject({ outcome: "removed" });
    expect(await authority().isAdmin(workspaceId, agentId, idOf(plain))).toBe(
      false,
    );
    const listed = await admins().list(workspaceId, agentId);
    expect(listed?.users.map((u) => u.userId)).toEqual([idOf(creator)]);
    expect(
      (
        await db
          .select({
            operation: receipts.operation,
            requestId: receipts.requestId,
          })
          .from(receipts)
          .where(eq(receipts.ownerId, workspaceId))
      )
        .map((r) => `${r.operation}:${r.requestId !== null}`)
        .sort(),
    ).toEqual([
      "add_agent_admin:true",
      "add_agent_admin:true",
      "remove_agent_admin:true",
    ]);
  });

  test("only a team manager names an admin team; an agent admin only takes one off (94S-837)", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const manager = await person(workspaceId, "admin");
    const lead = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, idOf(owner));
    const team = await newTeam(owner);
    await member(owner, team.id, lead);
    await teams().setMemberRole({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: team.id,
      userId: idOf(lead),
      role: "lead",
    });
    const change = (
      by: Caller,
      subject: { kind: "user" | "team"; id: string },
      add = true,
    ) =>
      admins()[add ? "add" : "remove"]({
        actor: acting(by),
        receiptId: randomUUID(),
        agentId,
        subject,
        managerRoles: MANAGERS,
      });
    const receiptCount = async () =>
      (
        await db
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.ownerId, workspaceId))
      ).length;
    const asTeam = { kind: "team", id: team.id } as const;

    // The agent's admin, even leading the team, does not lend it.
    await change(owner, { kind: "user", id: idOf(lead) });
    const before = await receiptCount();
    expect(await change(lead, asTeam)).toEqual({
      outcome: "team_not_allowed",
    });
    expect(await admins().list(workspaceId, agentId)).toMatchObject({
      teams: [],
    });
    expect(await receiptCount()).toBe(before);

    // An admin does, and the agent's admin takes it off again.
    expect(await change(manager, asTeam)).toMatchObject({ outcome: "added" });
    expect(await change(lead, asTeam, false)).toMatchObject({
      outcome: "removed",
    });
    expect(await admins().list(workspaceId, agentId)).toMatchObject({
      teams: [],
    });

    // The role is read in the transaction: an admin demoted after the
    // service's check, still an agent admin, cannot add and leaves no receipt.
    await change(owner, { kind: "user", id: idOf(manager) });
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.userId, idOf(manager)));
    const afterDemotion = await receiptCount();
    expect(await change(manager, asTeam)).toEqual({
      outcome: "team_not_allowed",
    });
    expect(await admins().list(workspaceId, agentId)).toMatchObject({
      teams: [],
    });
    expect(await receiptCount()).toBe(afterDemotion);
  });

  test("two admins removing each other at once: one wins, the other is refused", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    for (let round = 0; round < 5; round++) {
      const a = await person(workspaceId, "member");
      const b = await person(workspaceId, "member");
      const agentId = await agent(workspaceId, idOf(owner));
      const change = (by: Caller, who: Caller, add = true) =>
        admins()[add ? "add" : "remove"]({
          actor: acting(by),
          receiptId: randomUUID(),
          agentId,
          subject: { kind: "user", id: idOf(who) },
          managerRoles: MANAGERS,
        });
      await change(owner, a);
      await change(owner, b);

      const outcomes = (
        await Promise.all([change(a, b, false), change(b, a, false)])
      ).map((r) => r.outcome);
      expect(outcomes.sort()).toEqual(["actor_inactive", "removed"]);
    }
  });

  test("a team admin issues and sees the agent's keys until they leave the team", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const managed = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, idOf(owner));
    const team = await newTeam(owner);
    await member(owner, team.id, managed);
    await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "team", id: team.id },
      managerRoles: MANAGERS,
    });
    const keys = createPostgresWorkspaceKeyStore(db);
    const issue = () =>
      keys.issue({
        principal: managed,
        id: randomUUID(),
        workspaceId,
        keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        kind: "agent",
        name: null,
        agentId,
        createdByUserId: idOf(managed),
        scopes: ["sessions:read"],
        expiresAt: null,
        receiptId: randomUUID(),
        issuerRoles: MANAGERS,
      });
    const visible = async () =>
      (
        await keys.list(
          workspaceId,
          { personalOf: idOf(managed), allAgentKeysFor: MANAGERS },
          { limit: 50 },
        )
      ).items.map((k) => k.id);

    const issued = await issue();
    if (issued.outcome !== "issued") throw new Error(issued.outcome);
    expect(await visible()).toEqual([issued.key.id]);

    await member(owner, team.id, managed, false);
    expect(await issue()).toEqual({ outcome: "outranked" });
    expect(await visible()).toEqual([]);
  });

  test("a member's key issue waits out a team delete instead of deadlocking it", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const managed = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, idOf(owner));
    const team = await newTeam(owner);
    await member(owner, team.id, managed);
    await admins().add({
      actor: acting(owner),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "team", id: team.id },
      managerRoles: MANAGERS,
    });

    // Replays the team delete's lock order by hand so the key issue is
    // known to be waiting between its two steps.
    const deleter = await pool.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query(
        "SELECT id FROM member_teams WHERE id = $1 FOR UPDATE",
        [team.id],
      );
      const issued = createPostgresWorkspaceKeyStore(db).issue({
        principal: managed,
        id: randomUUID(),
        workspaceId,
        keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        kind: "agent",
        name: null,
        agentId,
        createdByUserId: idOf(managed),
        scopes: ["sessions:read"],
        expiresAt: null,
        receiptId: randomUUID(),
        issuerRoles: MANAGERS,
      });
      const waiting = async () =>
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )
        ).rowCount;
      for (let i = 0; i < 100 && !(await waiting()); i++) {
        await Bun.sleep(20);
      }
      expect(await waiting()).toBeGreaterThan(0);
      await deleter.query("DELETE FROM agent_admin_teams WHERE team_id = $1", [
        team.id,
      ]);
      await deleter.query(
        "UPDATE member_teams SET archived_at = now() WHERE id = $1",
        [team.id],
      );
      await deleter.query("COMMIT");
      expect(await issued).toEqual({ outcome: "outranked" });
    } finally {
      deleter.release();
    }
  });
});
