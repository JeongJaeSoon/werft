import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { createPostgresAgentAdminStore } from "./musterrolle/agent-admins.ts";
import { createPostgresMemberStore } from "./musterrolle/members.ts";
import {
  createPostgresSessionUnitOfWork,
  lockedNotRunnable,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  memberships,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { allowFor } from "./testing/member-manage-allow.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };
const REFUSED = { outcome: "not_runnable", reason: "agent_ownerless" } as const;

// A new session of an agent no one has administered for the grace period is
// refused in the write, judged on the live rows rather than on the mark.
integration("starting an ownerless agent on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_ownerless_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const uow = () => createPostgresSessionUnitOfWork(db);
  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const acting = (caller: Caller) => ({
    principal: caller,
    workspaceId: caller.ownerId,
    userId: idOf(caller),
  });

  async function person(workspaceId: string, role: WorkspaceRole = "member") {
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

  const admin = (by: Caller, agentId: string, who: Caller) =>
    createPostgresAgentAdminStore(db).add({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: idOf(who) },
      managerRoles: MANAGERS,
    });

  // A workspace owner, one member who administers the agent, and an agent
  // whose managing team has no lead, so that member is its only owner.
  async function world() {
    const ws = randomUUID();
    const slug = `ws-${ws.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: ws, slug, name: slug });
    const owner = await person(ws, "owner");
    const keeper = await person(ws);
    return { ws, owner, keeper, ...(await agentIn(ws, owner, keeper)) };
  }

  async function agentIn(ws: string, owner: Caller, keeper: Caller) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws,
      managingTeamId: await fixtureTeam(db, ws),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {},
      contentSha256: "a".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "a".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    expect(await admin(owner, agentId, keeper)).toMatchObject({
      outcome: "added",
    });
    return { agentId, releaseId };
  }

  const create = (by: Caller, releaseId: string, key = randomUUID()) =>
    uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: key,
      payloadHash: "create",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId,
      message: "start",
      limits: LIMITS,
    });

  // What the reconciler would have written that long ago.
  const markedAgo = (agentId: string, age: string) =>
    db
      .update(agents)
      .set({ ownerlessSince: sql`now() - ${age}::interval` })
      .where(eq(agents.id, agentId));

  const removeKeeper = (w: {
    owner: Caller;
    keeper: Caller;
    agentId: string;
  }) =>
    createPostgresAgentAdminStore(db).remove({
      actor: acting(w.owner),
      receiptId: randomUUID(),
      agentId: w.agentId,
      subject: { kind: "user", id: idOf(w.keeper) },
      managerRoles: MANAGERS,
    });

  const disable = (by: Caller, who: Caller) =>
    createPostgresMemberStore(db).setAccess({
      decision: allowFor(acting(by)),
      actor: acting(by),
      userId: idOf(who),
      scope: "membership",
      disabled: true,
      reason: null,
      receiptId: randomUUID(),
    });

  const takeOver = (by: Caller, sessionId: string) =>
    createPostgresMemberStore(db).takeOver({
      principal: by,
      workspaceId: by.ownerId,
      sessionId,
      newRequesterId: idOf(by),
    });

  async function awaitingTakeover(sessionId: string) {
    const [row] = await db
      .select({ at: sessions.takeoverRequiredAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.at !== null && row?.at !== undefined;
  }

  // The agent detail's count and list read this filter.
  const listedFor = async (ws: string, agentId: string) =>
    (
      await createPostgresMemberStore(db).listAwaitingTakeover(ws, 200, {
        agentId,
      })
    ).items.map((row) => row.sessionId);

  test("refused only once the mark is older than the grace period", async () => {
    const w = await world();
    expect(await removeKeeper(w)).toMatchObject({ outcome: "removed" });
    expect(await create(w.owner, w.releaseId)).toMatchObject({
      outcome: "accepted",
    });
    await markedAgo(w.agentId, "13 days 23 hours");
    expect(await create(w.owner, w.releaseId)).toMatchObject({
      outcome: "accepted",
    });
    await markedAgo(w.agentId, "14 days 1 minute");
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);
  });

  test("an old mark does not refuse once someone administers the agent again", async () => {
    // The reconciler has not cleared the mark yet: ownership is read live.
    const w = await world();
    await markedAgo(w.agentId, "30 days");
    expect(await create(w.owner, w.releaseId)).toMatchObject({
      outcome: "accepted",
    });
  });

  test("a retry of an earlier start and input to an open session still go through", async () => {
    const w = await world();
    const key = randomUUID();
    const first = await create(w.owner, w.releaseId, key);
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    expect(await removeKeeper(w)).toMatchObject({ outcome: "removed" });
    await markedAgo(w.agentId, "30 days");
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);

    expect(await create(w.owner, w.releaseId, key)).toMatchObject({
      outcome: "replayed",
      response: { session_id: first.response.session_id },
    });
    expect(
      await uow().appendInputAtomic({
        principal: w.owner,
        sessionId: first.response.session_id,
        idempotencyKey: randomUUID(),
        payloadHash: "append",
        message: "more",
        limits: LIMITS,
      }),
    ).toMatchObject({ outcome: "accepted" });
  });

  test("a paused agent answers agent_inactive first", async () => {
    const w = await world();
    expect(await removeKeeper(w)).toMatchObject({ outcome: "removed" });
    await markedAgo(w.agentId, "30 days");
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, w.agentId));
    expect(await create(w.owner, w.releaseId)).toEqual({
      outcome: "not_runnable",
      reason: "agent_inactive",
    });
  });

  test("a start that read before the last admin's disable committed goes through", async () => {
    // Accepted on purpose. Disabling a member writes only their membership
    // (or account) row, which the start reads without a lock; removing an
    // admin on the agent itself locks the agent row and is waited for.
    const w = await world();
    await markedAgo(w.agentId, "30 days");
    await holding(async (client) => {
      await client.query(
        "UPDATE memberships SET disabled_at = now() WHERE workspace_id = $1 AND user_id = $2",
        [w.ws, idOf(w.keeper)],
      );
      expect(await create(w.owner, w.releaseId)).toMatchObject({
        outcome: "accepted",
      });
      await client.query("COMMIT");
    });
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);
  });

  test("ownership is judged on what an admin removal committed while the lock waited", async () => {
    // A start takes the agent row first in its usage check, so the judgement
    // is called alone here to make its own lock the one that waits. The
    // removal holds the agent row as the agent-side delete does.
    const w = await world();
    await markedAgo(w.agentId, "30 days");
    await holding(async (client, started) => {
      const holder = await backendPid(client);
      await client.query(
        "SELECT 1 FROM agents WHERE id = $1 FOR NO KEY UPDATE",
        [w.agentId],
      );
      await client.query("DELETE FROM agent_admins WHERE agent_id = $1", [
        w.agentId,
      ]);
      const judged = db.transaction((tx) => lockedNotRunnable(tx, w.releaseId));
      started.push(judged);
      await waiting(holder, { onHolder: 1, onOthers: 0 });
      await client.query("COMMIT");
      expect(await judged).toBe("agent_ownerless");
    });
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);
  });

  test("an admin removal waits for a start that holds the agent row", async () => {
    // Holding the agent's MCP settings parks the start right after its agent
    // lock, before it commits.
    const w = await world();
    await markedAgo(w.agentId, "30 days");
    await db.insert(agentMcpSettings).values({
      agentId: w.agentId,
      workspaceId: w.ws,
      server: null,
      allowedTools: [],
      credentialRefs: [],
    });
    await holding(async (client, started) => {
      const holder = await backendPid(client);
      await client.query(
        "SELECT 1 FROM agent_mcp_settings WHERE agent_id = $1 FOR UPDATE",
        [w.agentId],
      );
      const start = create(w.owner, w.releaseId);
      started.push(start);
      await waiting(holder, { onHolder: 1, onOthers: 0 });
      // The removal waits on the start, not on the held settings row.
      const removal = removeKeeper(w);
      started.push(removal);
      await waiting(holder, { onHolder: 1, onOthers: 1 });
      await client.query("COMMIT");
      expect(await start).toMatchObject({ outcome: "accepted" });
      expect(await removal).toMatchObject({ outcome: "removed" });
    });
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);
  });

  test("succession first, then takeover: each recovers its own part", async () => {
    const w = await world();
    const sessionId = await started(w.keeper, w.releaseId);
    expect(await disable(w.owner, w.keeper)).toMatchObject({
      outcome: "changed",
    });
    await markedAgo(w.agentId, "30 days");
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);
    expect(await awaitingTakeover(sessionId)).toBe(true);

    const heir = await person(w.ws);
    expect(await admin(w.owner, w.agentId, heir)).toMatchObject({
      outcome: "added",
    });
    expect(await create(w.owner, w.releaseId)).toMatchObject({
      outcome: "accepted",
    });
    // Succession names an admin; the session still waits for a requester.
    expect(await awaitingTakeover(sessionId)).toBe(true);
    expect(await listedFor(w.ws, w.agentId)).toEqual([sessionId]);
    expect(await takeOver(w.owner, sessionId)).toMatchObject({
      outcome: "taken_over",
    });
    expect(await awaitingTakeover(sessionId)).toBe(false);
    expect(await listedFor(w.ws, w.agentId)).toEqual([]);
  });

  test("the takeover list names each session's agent and keeps one agent's", async () => {
    const w = await world();
    const other = await agentIn(w.ws, w.owner, w.keeper);
    const mine = await started(w.keeper, w.releaseId);
    const theirs = await started(w.keeper, other.releaseId);
    expect(await disable(w.owner, w.keeper)).toMatchObject({
      outcome: "changed",
    });

    const store = createPostgresMemberStore(db);
    const listed = await store.listAwaitingTakeover(w.ws, 200);
    expect(listed.total).toBe(2);
    const all = listed.items;
    expect(all.map((row) => [row.sessionId, row.agentId]).sort()).toEqual(
      [
        [mine, w.agentId],
        [theirs, other.agentId],
      ].sort(),
    );
    for (const agentId of [w.agentId, other.agentId]) {
      expect(await listedFor(w.ws, agentId)).toEqual(
        all
          .filter((row) => row.agentId === agentId)
          .map((row) => row.sessionId),
      );
    }
    expect(await listedFor(w.ws, w.agentId)).toEqual([mine]);
    expect(await listedFor(w.ws, w.agentId.toUpperCase())).toEqual([mine]);
    expect(await listedFor(w.ws, randomUUID())).toEqual([]);
    // Another workspace's agent id finds nothing here.
    expect(await listedFor((await world()).ws, w.agentId)).toEqual([]);

    // The total counts past the limit; the session filter finds one.
    const cut = await store.listAwaitingTakeover(w.ws, 1);
    expect([cut.items.length, cut.total]).toEqual([1, 2]);
    expect(
      await store.listAwaitingTakeover(w.ws, 200, {
        sessionId: theirs.toUpperCase(),
      }),
    ).toMatchObject({ items: [{ sessionId: theirs }], total: 1 });
    expect(
      await store.listAwaitingTakeover(w.ws, 200, { sessionId: randomUUID() }),
    ).toEqual({ items: [], total: 0 });
  });

  test("takeover first, then succession: each recovers its own part", async () => {
    const w = await world();
    const sessionId = await started(w.keeper, w.releaseId);
    expect(await disable(w.owner, w.keeper)).toMatchObject({
      outcome: "changed",
    });
    await markedAgo(w.agentId, "30 days");
    expect(await listedFor(w.ws, w.agentId)).toEqual([sessionId]);

    expect(await takeOver(w.owner, sessionId)).toMatchObject({
      outcome: "taken_over",
    });
    expect(await listedFor(w.ws, w.agentId)).toEqual([]);
    // Taking over a session names its requester, not an admin of the agent.
    expect(await create(w.owner, w.releaseId)).toEqual(REFUSED);

    const heir = await person(w.ws);
    expect(await admin(w.owner, w.agentId, heir)).toMatchObject({
      outcome: "added",
    });
    expect(await create(w.owner, w.releaseId)).toMatchObject({
      outcome: "accepted",
    });
  });

  // Runs `body` in a transaction on a client of its own. Whatever `body` did
  // not commit is rolled back before the client goes back to the pool (after
  // a COMMIT the ROLLBACK only warns), and the calls it started are settled,
  // so a failed wait leaves no lock behind for the next test.
  async function holding(
    body: (client: PoolClient, started: Promise<unknown>[]) => Promise<void>,
  ) {
    const client = await pool.connect();
    const started: Promise<unknown>[] = [];
    try {
      await client.query("BEGIN");
      await body(client, started);
    } finally {
      // A client whose ROLLBACK failed is destroyed, which ends its
      // transaction on the server too.
      let broken: Error | undefined;
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        broken = error instanceof Error ? error : new Error(String(error));
      }
      client.release(broken);
      await Promise.allSettled(started);
    }
  }

  async function backendPid(client: PoolClient) {
    const { rows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error("no backend pid");
    return pid;
  }

  // Until as many backends wait on `holder`, and on anyone else, as given.
  async function waiting(
    holder: number,
    want: { onHolder: number; onOthers: number },
  ) {
    let seen: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await pool.query<{ onHolder: number; onOthers: number }>(
        `SELECT
           count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS "onHolder",
           count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0
             AND NOT $1 = ANY(pg_blocking_pids(pid)))::int AS "onOthers"
         FROM pg_stat_activity WHERE datname = current_database()`,
        [holder],
      );
      seen = rows[0];
      if (
        rows[0]?.onHolder === want.onHolder &&
        rows[0]?.onOthers === want.onOthers
      ) {
        return;
      }
      await Bun.sleep(50);
    }
    throw new Error(
      `lock waits never became ${JSON.stringify(want)}: ${JSON.stringify(seen)}`,
    );
  }

  async function started(by: Caller, releaseId: string) {
    const created = await create(by, releaseId);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }
});
