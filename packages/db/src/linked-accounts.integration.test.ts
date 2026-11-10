import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type AuthorizationRequest, scopesForRole } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  type ExternalAccountNames,
  type ExternalAccountRef,
  type IdentityReader,
  type Principal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import {
  createPostgresLinkedAccountStore,
  resolveLinkedSubject,
} from "./linked-accounts.ts";
import { createPostgresMemberStore } from "./members.ts";
import * as schema from "./schema.ts";
import {
  linkedAccounts,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import {
  registerSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

type Reread = Parameters<IdentityReader["reread"]>[0];

// Fixture ids shaped like Slack's; no Slack app is involved.
const slackId = (prefix: string) =>
  `${prefix}${randomUUID().slice(0, 8).toUpperCase()}`;

integration("linked_accounts on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const store = () => createPostgresLinkedAccountStore(db);

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "linked_accounts_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function workspace(name = "Acme") {
    const id = randomUUID();
    await db.insert(workspaces).values({ id, slug: `ws-${id}`, name });
    return id;
  }

  async function member(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  async function install(
    workspaceId: string,
    teamId = slackId("T"),
    verified = true,
  ) {
    const key = { appId: slackId("A"), teamId };
    await registerSlackInstallation(db, { ...key, workspaceId });
    if (verified) {
      await verifySlackInstallation(db, { ...key, botUserId: slackId("U") });
    }
    return teamId;
  }

  function asUser(workspaceId: string, userId: string): Principal {
    return {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "user", id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    };
  }

  function offboard(ws: string, userId: string, ownerId: string) {
    return createPostgresMemberStore(db).setAccess({
      actor: {
        principal: { ...asUser(ws, ownerId), requestId: "req-offboard" },
        workspaceId: ws,
        userId: ownerId,
      },
      userId,
      scope: "membership",
      disabled: true,
      reason: null,
      receiptId: randomUUID(),
    });
  }

  const slack = (
    teamId: string,
    userId = slackId("U"),
  ): ExternalAccountRef => ({
    provider: "slack",
    externalTenant: teamId,
    externalUserId: userId,
  });

  const noNames = { externalTenantName: null, externalUserName: null };

  function link(
    ws: string,
    userId: string,
    account: ExternalAccountRef,
    names: ExternalAccountNames = noNames,
  ) {
    return store().link({
      principal: asUser(ws, userId),
      workspaceId: ws,
      userId,
      account,
      names,
    });
  }

  async function linked(
    ws: string,
    userId: string,
    account: ExternalAccountRef,
  ) {
    const result = await link(ws, userId, account);
    if (result.outcome !== "linked") throw new Error(result.outcome);
    return result;
  }

  async function setup() {
    const ws = await workspace();
    const team = await install(ws);
    const user = await member(ws, "member");
    return { ws, team, user };
  }

  describe("linking", () => {
    test("links an installed team's account and records who did it", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const result = await linked(ws, user, account);
      expect(result.account).toMatchObject({
        workspaceId: ws,
        userId: user,
        provider: "slack",
        externalTenant: team,
        externalUserId: account.externalUserId,
        status: "active",
        revision: 1,
      });
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, result.receiptId));
      expect(receipt).toMatchObject({
        ownerId: ws,
        operation: "link_account",
        status: "succeeded",
        targetRef: { user_id: user, workspace_id: ws },
        actor: {
          principal: { kind: "user", id: user },
          actor_user_id: user,
          agent_id: null,
        },
        result: {
          linked_account_id: result.account.id,
          provider: "slack",
          external_tenant: team,
          external_user_id: account.externalUserId,
          revision: 1,
        },
      });
    });

    test("keeps the names Slack gave, replaced by each re-verification", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const first = await link(ws, user, account, {
        externalTenantName: "Hafen",
        externalUserName: "Alice",
      });
      expect(first).toMatchObject({
        outcome: "linked",
        account: { externalTenantName: "Hafen", externalUserName: "Alice" },
      });
      await link(ws, user, account, {
        externalTenantName: "Hafen Ops",
        externalUserName: null,
      });
      expect(await store().list(ws, user, 50)).toMatchObject([
        {
          externalUserId: account.externalUserId,
          externalTenantName: "Hafen Ops",
          externalUserName: null,
          revision: 1,
        },
      ]);
    });

    test("a workspace with no verified Slack install refuses every link", async () => {
      const ws = await workspace();
      const pending = await install(ws, slackId("T"), false);
      const user = await member(ws, "member");
      expect(await link(ws, user, slack(pending))).toEqual({
        outcome: "not_installed",
      });
    });

    test("another Slack team is refused and names the workspace", async () => {
      const ws = await workspace("Hafen");
      await install(ws);
      const user = await member(ws, "member");
      expect(await link(ws, user, slack(slackId("T")))).toEqual({
        outcome: "team_mismatch",
        workspaceName: "Hafen",
      });
      const elsewhere = await workspace();
      const otherTeam = await install(elsewhere);
      expect((await link(ws, user, slack(otherTeam))).outcome).toBe(
        "team_mismatch",
      );
    });

    test("an account linked to someone else is never overwritten", async () => {
      const { ws, team, user } = await setup();
      const other = await member(ws, "member");
      const account = slack(team);
      const first = await linked(ws, user, account);
      expect(await link(ws, other, account)).toEqual({ outcome: "taken" });
      const rows = await db
        .select({ userId: linkedAccounts.userId })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.externalUserId, account.externalUserId));
      expect(rows).toEqual([{ userId: user }]);
      expect((await linked(ws, user, account)).account.id).toBe(
        first.account.id,
      );
    });

    test("an account linked in another workspace is taken, even by the same person", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const first = await linked(ws, user, account);
      const second = await workspace();
      await install(second, team);
      await db
        .insert(memberships)
        .values({ workspaceId: second, userId: user, role: "member" });
      expect(await link(second, user, account)).toEqual({ outcome: "taken" });
      const rows = await db
        .select({
          id: linkedAccounts.id,
          workspaceId: linkedAccounts.workspaceId,
        })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.externalUserId, account.externalUserId));
      expect(rows).toEqual([{ id: first.account.id, workspaceId: ws }]);
    });

    test("two people racing for one account: one links, the other is told it is taken", async () => {
      const { ws, team, user } = await setup();
      const other = await member(ws, "member");
      const account = slack(team);
      const results = await Promise.all([
        link(ws, user, account),
        link(ws, other, account),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["linked", "taken"]);
    });

    test("a second account in the same team is refused until the first is unlinked", async () => {
      const { ws, team, user } = await setup();
      const first = await linked(ws, user, slack(team));
      const second = slack(team);
      expect(await link(ws, user, second)).toEqual({ outcome: "exists" });
      await store().unlink({
        principal: asUser(ws, user),
        workspaceId: ws,
        userId: user,
        linkedAccountId: first.account.id,
      });
      expect((await link(ws, user, second)).outcome).toBe("linked");
    });

    test("linking again keeps the row and its revision", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const first = await linked(ws, user, account);
      const again = await linked(ws, user, account);
      expect(again.account.id).toBe(first.account.id);
      expect(again.account.revision).toBe(1);
      expect(again.receiptId).not.toBe(first.receiptId);
    });

    test("an offboarded caller cannot link", async () => {
      const { ws, team, user } = await setup();
      await db
        .update(memberships)
        .set({ disabledAt: new Date() })
        .where(eq(memberships.userId, user));
      expect(await link(ws, user, slack(team))).toEqual({
        outcome: "actor_inactive",
      });
    });
  });

  describe("unlinking and resolving", () => {
    test("resolves a linked account to its person, and to no one once unlinked", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      expect(await resolveLinkedSubject(db, account)).toEqual({
        status: "linked",
        linkedAccount: { id: row.id, revision: 1 },
        userId: user,
        workspaceId: ws,
        role: "member",
      });

      const result = await store().unlink({
        principal: asUser(ws, user),
        workspaceId: ws,
        userId: user,
        linkedAccountId: row.id,
      });
      expect(result.outcome).toBe("unlinked");
      expect(await resolveLinkedSubject(db, account)).toEqual({
        status: "unlinked",
      });
      const [receipt] = await db
        .select({ operation: receipts.operation, result: receipts.result })
        .from(receipts)
        .where(
          eq(
            receipts.id,
            result.outcome === "unlinked" ? result.receiptId : "",
          ),
        );
      expect(receipt).toEqual({
        operation: "unlink_account",
        result: expect.objectContaining({
          linked_account_id: row.id,
          revision: 2,
        }),
      });
      expect(await store().list(ws, user, 50)).toEqual([]);
    });

    test("only the person who linked can unlink, and only once", async () => {
      const { ws, team, user } = await setup();
      const other = await member(ws, "member");
      const { account: row } = await linked(ws, user, slack(team));
      const unlinkAs = (userId: string) =>
        store().unlink({
          principal: asUser(ws, userId),
          workspaceId: ws,
          userId,
          linkedAccountId: row.id,
        });
      expect(await unlinkAs(other)).toEqual({ outcome: "not_found" });
      expect((await unlinkAs(user)).outcome).toBe("unlinked");
      expect(await unlinkAs(user)).toEqual({ outcome: "not_found" });
    });

    test("never linked resolves to unlinked", async () => {
      expect(await resolveLinkedSubject(db, slack(slackId("T")))).toEqual({
        status: "unlinked",
      });
    });

    test("a deactivation event makes the link stale; linking again reactivates it", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      const marked = await store().markStale(account);
      expect(marked).toMatchObject({
        outcome: "stale",
        account: { id: row.id, status: "stale", revision: 2 },
      });
      expect(await store().markStale(account)).toEqual({
        outcome: "not_found",
      });
      expect(await resolveLinkedSubject(db, account)).toEqual({
        status: "stale",
        linkedAccount: { id: row.id, revision: 2 },
        userId: user,
        workspaceId: ws,
      });
      expect(await store().list(ws, user, 50)).toMatchObject([
        { id: row.id, status: "stale" },
      ]);

      const again = await linked(ws, user, account);
      expect(again.account).toMatchObject({
        id: row.id,
        status: "active",
        revision: 3,
      });
    });

    test("offboarding revokes the link, which then resolves as revoked", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      const owner = await member(ws, "owner");
      const offboarded = await offboard(ws, user, owner);
      expect(offboarded).toMatchObject({
        outcome: "changed",
        effects: { revokedLinkedAccounts: 1 },
      });
      const [stored] = await db
        .select({
          status: linkedAccounts.status,
          revokedReason: linkedAccounts.revokedReason,
        })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.id, row.id));
      expect(stored).toEqual({
        status: "revoked",
        revokedReason: "offboarded",
      });
      expect(await resolveLinkedSubject(db, account)).toEqual({
        status: "revoked",
        linkedAccount: { id: row.id, revision: 2 },
        userId: user,
        workspaceId: ws,
      });
    });

    // A relink reads the holder row while an unlink or a stale mark on it is
    // still uncommitted; the relink must act on the row as that left it.
    async function relinkWhileHeld(change: string) {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(change, [row.id]);
        const relink = link(ws, user, account);
        // Long enough for the relink to reach the holder row and wait on it.
        await Bun.sleep(200);
        await holder.query("COMMIT");
        return { row, result: await relink };
      } finally {
        holder.release();
      }
    }

    test("a relink waiting on an unlink links afresh once the unlink commits", async () => {
      const { row, result } = await relinkWhileHeld(
        "UPDATE linked_accounts SET status = 'revoked', revoked_reason = 'unlinked', revoked_at = now(), revision = revision + 1 WHERE id = $1",
      );
      if (result.outcome !== "linked") throw new Error(result.outcome);
      expect(result.account.id).not.toBe(row.id);
      expect(result.account).toMatchObject({ status: "active", revision: 1 });
    });

    test("a relink waiting on a stale mark reactivates with a new revision", async () => {
      const { row, result } = await relinkWhileHeld(
        "UPDATE linked_accounts SET status = 'stale', revision = revision + 1 WHERE id = $1",
      );
      if (result.outcome !== "linked") throw new Error(result.outcome);
      expect(result.account).toMatchObject({
        id: row.id,
        status: "active",
        revision: 3,
      });
    });

    test("a link racing an offboard never outlives it", async () => {
      for (let round = 0; round < 10; round++) {
        const { ws, team, user } = await setup();
        const owner = await member(ws, "owner");
        await Promise.all([
          link(ws, user, slack(team)),
          offboard(ws, user, owner),
        ]);
        const live = await db
          .select({ id: linkedAccounts.id })
          .from(linkedAccounts)
          .where(
            and(
              eq(linkedAccounts.userId, user),
              ne(linkedAccounts.status, "revoked"),
            ),
          );
        expect(live).toEqual([]);
      }
    });

    // Unlink re-reads no membership: what keeps an offboarded caller out is
    // that offboarding revokes every live link of theirs in the workspace in
    // its own transaction, so unlink's `WHERE live` finds none, or waits on
    // that row lock and finds none once the offboard commits.
    const unlinkAs = (ws: string, userId: string, linkedAccountId: string) =>
      store().unlink({
        principal: asUser(ws, userId),
        workspaceId: ws,
        userId,
        linkedAccountId,
      });

    const unlinkReceipts = (linkedAccountId: string) =>
      db
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.operation, "unlink_account"),
            sql`${receipts.result}->>'linked_account_id' = ${linkedAccountId}`,
          ),
        );

    const revokedReasonOf = async (id: string) => {
      const [row] = await db
        .select({ revokedReason: linkedAccounts.revokedReason })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.id, id));
      return row?.revokedReason;
    };

    async function waitForLockWaiters(count: number) {
      for (let tries = 0; tries < 200; tries++) {
        const { rows } = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if ((rows[0]?.n ?? 0) >= count) return;
        await Bun.sleep(10);
      }
      throw new Error(`fewer than ${count} lock waiters`);
    }

    test("an offboarded caller cannot unlink", async () => {
      const { ws, team, user } = await setup();
      const owner = await member(ws, "owner");
      const { account: row } = await linked(ws, user, slack(team));
      await offboard(ws, user, owner);
      expect(await unlinkAs(ws, user, row.id)).toEqual({
        outcome: "not_found",
      });
      expect(await revokedReasonOf(row.id)).toBe("offboarded");
      expect(await unlinkReceipts(row.id)).toEqual([]);
    });

    test("an unlink that starts while an offboard is in flight finds nothing once it commits", async () => {
      const { ws, team, user } = await setup();
      const owner = await member(ws, "owner");
      const { account: row } = await linked(ws, user, slack(team));
      // An uncommitted receipt with the offboard's id parks the offboard on
      // the primary key at its last write, after it revoked the link.
      const receiptId = randomUUID();
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "INSERT INTO receipts (id, owner_id, operation, target_ref) VALUES ($1, $2, 'hold', '{}')",
          [receiptId, ws],
        );
        const offboarding = createPostgresMemberStore(db).setAccess({
          actor: {
            principal: { ...asUser(ws, owner), requestId: "req-offboard" },
            workspaceId: ws,
            userId: owner,
          },
          userId: user,
          scope: "membership",
          disabled: true,
          reason: null,
          receiptId,
        });
        await waitForLockWaiters(1);
        const unlinking = unlinkAs(ws, user, row.id);
        await waitForLockWaiters(2);
        await holder.query("ROLLBACK");
        const [offboarded, unlinked] = await Promise.all([
          offboarding,
          unlinking,
        ]);
        expect(offboarded.outcome).toBe("changed");
        expect(unlinked).toEqual({ outcome: "not_found" });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await revokedReasonOf(row.id)).toBe("offboarded");
      expect(await unlinkReceipts(row.id)).toEqual([]);
    });

    test("an unlink racing an offboard commits only if it came first", async () => {
      for (let round = 0; round < 10; round++) {
        const { ws, team, user } = await setup();
        const owner = await member(ws, "owner");
        const { account: row } = await linked(ws, user, slack(team));
        const [unlinked, offboarded] = await Promise.all([
          unlinkAs(ws, user, row.id),
          offboard(ws, user, owner),
        ]);
        if (offboarded.outcome !== "changed" || !offboarded.effects.disabled) {
          throw new Error(offboarded.outcome);
        }
        if (unlinked.outcome === "unlinked") {
          // Serialized before the offboard, which then had nothing to revoke.
          expect(offboarded.effects.revokedLinkedAccounts).toBe(0);
          expect(await revokedReasonOf(row.id)).toBe("unlinked");
          expect(await unlinkReceipts(row.id)).toHaveLength(1);
        } else {
          expect(offboarded.effects.revokedLinkedAccounts).toBe(1);
          expect(await revokedReasonOf(row.id)).toBe("offboarded");
          expect(await unlinkReceipts(row.id)).toEqual([]);
        }
      }
    });

    test("a live link whose person was disabled outside offboarding resolves as disabled", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      await linked(ws, user, account);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, user));
      expect((await resolveLinkedSubject(db, account)).status).toBe("disabled");
    });
  });

  describe("judged again at processing time", () => {
    const agentId = randomUUID();
    const installationSubject = (
      ws: string,
      actorUserId: string,
      link: { id: string; revision: number },
    ): Reread =>
      ({
        principal: {
          kind: "installation",
          id: randomUUID(),
          owner_id: ws,
          workspace_id: ws,
          scopes: ["sessions:read", "sessions:write"],
        },
        actor_user_id: actorUserId,
        linked_account: link,
        surface: {
          kind: "slack",
          slack_user_kind: "member",
          ceiling: { actions: ["session.submit"], disclosure: "full" },
          agent_id: agentId,
        },
      }) as Reread;

    test("the reader judges the linked person as they stand now", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      const ref = { id: row.id, revision: row.revision };
      const reader = createDatabaseIdentityReader(db);

      expect(await reader.reread(installationSubject(ws, user, ref))).toEqual({
        status: "ok",
        principal: {
          kind: "user",
          id: user,
          workspace_id: ws,
          role: "member",
          scopes: [...scopesForRole("member")],
        },
      });
      expect(
        await reader.reread({
          ...installationSubject(ws, user, ref),
          surface: { kind: "api" },
        }),
      ).toEqual({ status: "unlinked" });
      const stranger = await member(ws, "member");
      expect(
        await reader.reread(installationSubject(ws, stranger, ref)),
      ).toEqual({ status: "unlinked" });
      expect(
        await reader.reread(installationSubject(await workspace(), user, ref)),
      ).toEqual({ status: "unlinked" });

      await store().markStale(account);
      expect(await reader.reread(installationSubject(ws, user, ref))).toEqual({
        status: "stale_link",
      });
      // Linked again: the row is active, but not the reading the caller had.
      const again = await linked(ws, user, account);
      expect(await reader.reread(installationSubject(ws, user, ref))).toEqual({
        status: "stale_link",
      });
      const fresh = { id: again.account.id, revision: again.account.revision };
      expect(
        (await reader.reread(installationSubject(ws, user, fresh))).status,
      ).toBe("ok");

      const owner = await member(ws, "owner");
      await offboard(ws, user, owner);
      expect(await reader.reread(installationSubject(ws, user, fresh))).toEqual(
        { status: "disabled" },
      );
    });

    test("input resolved before an unlink is refused when it is processed after", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      const { account: row } = await linked(ws, user, account);
      // Resolved when the event arrived and queued.
      const atArrival = await resolveLinkedSubject(db, account);
      if (atArrival.status !== "linked") throw new Error(atArrival.status);

      await store().unlink({
        principal: asUser(ws, user),
        workspaceId: ws,
        userId: user,
        linkedAccountId: row.id,
      });

      // Processed later: resolving again finds no one...
      expect(await resolveLinkedSubject(db, account)).toEqual({
        status: "unlinked",
      });
      // ...and a decision made on the reading taken at arrival is refused.
      const policy = createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      });
      const request = {
        subject: installationSubject(ws, user, atArrival.linkedAccount),
        action: "session.submit",
        resource: { kind: "surface_binding", id: null, owner_scope: ws },
        request_id: randomUUID(),
      } as AuthorizationRequest;
      expect(await policy.authorize(request)).toMatchObject({
        outcome: "deny",
        reason_code: "unlinked",
      });
    });

    test("a live link is judged as its person, under the channel's ceiling", async () => {
      const { ws, team, user } = await setup();
      const { account: row } = await linked(ws, user, slack(team));
      const policy = createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      });
      const subject = installationSubject(ws, user, {
        id: row.id,
        revision: row.revision,
      });
      const ask = (ceiling: string[]) =>
        policy.authorize({
          subject: {
            ...subject,
            surface: {
              ...subject.surface,
              ceiling: { actions: ceiling, disclosure: "full" },
            },
          },
          action: "session.submit",
          resource: {
            kind: "surface_binding",
            id: null,
            owner_scope: ws,
            agent_id: agentId,
          },
          request_id: randomUUID(),
        } as AuthorizationRequest);
      expect(await ask(["session.submit"])).toMatchObject({
        outcome: "allow",
        reason_code: "ok",
        effective_scopes: ["sessions:write"],
      });
      expect(await ask(["session.read"])).toMatchObject({
        outcome: "deny",
        reason_code: "surface_ceiling",
      });
    });

    test("the partial indexes allow one live link per account and per person in a team", async () => {
      const { ws, team, user } = await setup();
      const account = slack(team);
      await linked(ws, user, account);
      const other = await member(ws, "member");
      const insert = (userId: string, externalUserId: string) =>
        db.insert(linkedAccounts).values({
          id: randomUUID(),
          workspaceId: ws,
          userId,
          provider: "slack",
          externalTenant: team,
          externalUserId,
          verifiedVia: "slack_oidc",
          verifiedAt: new Date(),
        });
      await expect(
        insert(other, account.externalUserId).then(() => "inserted"),
      ).rejects.toThrow();
      await expect(
        insert(user, slackId("U")).then(() => "inserted"),
      ).rejects.toThrow();
      const live = await db
        .select({ id: linkedAccounts.id })
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.externalTenant, team),
            eq(linkedAccounts.status, "active"),
          ),
        );
      expect(live).toHaveLength(1);
    });
  });

  describe("GitHub links", () => {
    const github = (id: string): ExternalAccountRef => ({
      provider: "github",
      externalTenant: "github.com",
      externalUserId: id,
    });
    const named = (login: string) => ({
      externalTenantName: "GitHub",
      externalUserName: login,
    });
    const githubId = () => String(100_000 + Math.floor(Math.random() * 1e9));

    test("link without a Slack install, verified by github_oauth, with the login in the receipt", async () => {
      const ws = await workspace();
      const user = await member(ws, "member");
      const id = githubId();
      const result = await link(ws, user, github(id), named("octocat"));
      if (result.outcome !== "linked") throw new Error(result.outcome);
      expect(result.account).toMatchObject({
        provider: "github",
        externalTenant: "github.com",
        externalUserId: id,
        externalUserName: "octocat",
      });
      const [row] = await db
        .select({ via: linkedAccounts.verifiedVia })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.id, result.account.id));
      expect(row?.via).toBe("github_oauth");
      const [receipt] = await db
        .select({ result: receipts.result })
        .from(receipts)
        .where(eq(receipts.id, result.receiptId));
      expect(receipt?.result).toMatchObject({
        provider: "github",
        external_user_id: id,
        login: "octocat",
      });
    });

    test("the same GitHub account linked by a second person is taken, in this workspace or another", async () => {
      const ws = await workspace();
      const first = await member(ws, "member");
      const second = await member(ws, "member");
      const id = githubId();
      expect(
        (await link(ws, first, github(id), named("octocat"))).outcome,
      ).toBe("linked");
      expect(
        (await link(ws, second, github(id), named("octocat"))).outcome,
      ).toBe("taken");
      const elsewhere = await workspace();
      const stranger = await member(elsewhere, "member");
      expect(
        (await link(elsewhere, stranger, github(id), named("octocat"))).outcome,
      ).toBe("taken");
      const live = await db
        .select({ userId: linkedAccounts.userId })
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.provider, "github"),
            eq(linkedAccounts.externalUserId, id),
            eq(linkedAccounts.status, "active"),
          ),
        );
      expect(live).toEqual([{ userId: first }]);
    });

    test("a person with a GitHub link cannot link a second account", async () => {
      const ws = await workspace();
      const user = await member(ws, "member");
      await link(ws, user, github(githubId()), named("octocat"));
      expect(
        (await link(ws, user, github(githubId()), named("hubot"))).outcome,
      ).toBe("exists");
    });
  });
});
