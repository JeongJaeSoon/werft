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
import { Pool } from "pg";
import { createPostgresAgentAdminStore } from "./musterrolle/agent-admins.ts";
import { createPostgresMemberStore } from "./musterrolle/members.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  memberships,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
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
    return { ws, owner, keeper, agentId, releaseId };
  }

  const create = (by: Caller, releaseId: string) =>
    uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: randomUUID(),
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE memberships SET disabled_at = now() WHERE workspace_id = $1 AND user_id = $2",
        [w.ws, idOf(w.keeper)],
      );
      expect(await create(w.owner, w.releaseId)).toMatchObject({
        outcome: "accepted",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
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
    expect(await takeOver(w.owner, sessionId)).toMatchObject({
      outcome: "taken_over",
    });
    expect(await awaitingTakeover(sessionId)).toBe(false);
  });

  test("takeover first, then succession: each recovers its own part", async () => {
    const w = await world();
    const sessionId = await started(w.keeper, w.releaseId);
    expect(await disable(w.owner, w.keeper)).toMatchObject({
      outcome: "changed",
    });
    await markedAgo(w.agentId, "30 days");

    expect(await takeOver(w.owner, sessionId)).toMatchObject({
      outcome: "taken_over",
    });
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

  async function started(by: Caller, releaseId: string) {
    const created = await create(by, releaseId);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }
});
