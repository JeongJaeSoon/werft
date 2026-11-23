import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type SessionScope,
  scopesForRole,
  type WebSessionId,
} from "@werft-ai/contracts";
import { type Caller, callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  apiKeys,
  memberships,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  fixtureRelease,
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };
// AUTH_MODE=none and keys from before workspaces partition on this.
const LEGACY_OWNER = "00000000-0000-4000-8000-00000000000a";
const SCOPES: SessionScope[] = ["sessions:read", "sessions:write"];

// 94S-1945: every turn a caller queues records the credential its requester
// came in on, beside the requester columns, and the turn read shows both.
integration("turn requester credential on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "turn_requester_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const uow = () => createPostgresSessionUnitOfWork(db);

  async function world() {
    const ws = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: ws, slug: `ws-${ws.slice(0, 8)}`, name: "ws" });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "Owner",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId, role: "owner" });
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
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 0 })
      .where(eq(agents.id, agentId));
    return { ws, userId, agentId, releaseId };
  }

  const userPrincipal = (ws: string, userId: string) => ({
    kind: "user" as const,
    id: userId,
    workspace_id: ws,
    role: "owner" as const,
    scopes: [...scopesForRole("owner")],
  });

  async function key(
    ws: string | null,
    kind: "personal" | "agent" | "operator",
    by: { userId?: string; agentId?: string },
  ) {
    const id = randomUUID();
    await db.insert(apiKeys).values({
      id,
      keyHash: Buffer.from(randomUUID()),
      ownerId: ws ?? LEGACY_OWNER,
      workspaceId: ws,
      kind,
      scopes: SCOPES,
      createdByUserId: by.userId ?? null,
      agentId: by.agentId ?? null,
    });
    return callerFor(
      {
        kind: "api_key",
        id,
        owner_id: ws ?? LEGACY_OWNER,
        workspace_id: ws,
        scopes: SCOPES,
      },
      { kind: "api" },
      randomUUID(),
      {
        creatorId: by.userId ?? null,
        agentId: by.agentId ?? null,
        kind,
      },
    );
  }

  async function start(by: Caller, releaseId: string) {
    const created = await uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: randomUUID(),
      payloadHash: "create",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId,
      message: "start",
      limits: LIMITS,
    });
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }

  async function append(by: Caller, sessionId: string) {
    const appended = await uow().appendInputAtomic({
      principal: by,
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: "append",
      message: "more",
      limits: LIMITS,
    });
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
  }

  const recorded = (sessionId: string) =>
    db
      .select({
        kind: turns.requesterKind,
        id: turns.requesterId,
        auth: turns.requesterAuth,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));

  test("a console turn records its login; a person with no login on the caller records none", async () => {
    const w = await world();
    const webSessionId = randomUUID() as WebSessionId;
    const console = callerFor(
      userPrincipal(w.ws, w.userId),
      { kind: "web" },
      randomUUID(),
      undefined,
      webSessionId,
    );
    const sessionId = await start(console, w.releaseId);
    await append(
      callerFor(userPrincipal(w.ws, w.userId), { kind: "web" }, randomUUID()),
      sessionId,
    );
    expect(await recorded(sessionId)).toEqual([
      {
        kind: "user",
        id: w.userId,
        auth: { method: "web_session", web_session_id: webSessionId },
      },
      { kind: "user", id: w.userId, auth: null },
    ]);
  });

  test("a personal key records the key, an agent key its agent", async () => {
    const w = await world();
    const personal = await key(w.ws, "personal", { userId: w.userId });
    const agent = await key(w.ws, "agent", { agentId: w.agentId });
    const sessionId = await start(personal, w.releaseId);
    await append(agent, sessionId);
    expect(await recorded(sessionId)).toEqual([
      {
        kind: "user",
        id: w.userId,
        auth: {
          method: "personal_key",
          api_key_id: personal.actor?.apiKeyId,
        },
      },
      {
        kind: "api_key",
        id: agent.actor?.apiKeyId ?? "",
        auth: { method: "agent_key", agent_id: w.agentId },
      },
    ]);
  });

  test("an operator key is a service key; AUTH_MODE=none is unauthenticated", async () => {
    const releaseId = await fixtureRelease(db);
    const service = await key(null, "operator", {});
    const none = callerFor(
      {
        kind: "api_key",
        id: LEGACY_OWNER,
        owner_id: LEGACY_OWNER,
        workspace_id: null,
        scopes: SCOPES,
      },
      { kind: "api" },
      randomUUID(),
    );
    const sessionId = await start(service, releaseId);
    expect(await recorded(sessionId)).toEqual([
      {
        kind: "api_key",
        id: service.actor?.apiKeyId ?? "",
        auth: { method: "service_key" },
      },
    ]);
    const unauthenticated = await start(none, releaseId);
    expect(await recorded(unauthenticated)).toEqual([
      { kind: null, id: null, auth: { method: "unauthenticated" } },
    ]);
  });

  test("the turn read shows the requester as stored, unknown values included", async () => {
    const w = await world();
    const console = callerFor(
      userPrincipal(w.ws, w.userId),
      { kind: "web" },
      randomUUID(),
      undefined,
      randomUUID() as WebSessionId,
    );
    const sessionId = await start(console, w.releaseId);
    for (let n = 0; n < 4; n++) await append(console, sessionId);
    const set = (
      sequence: number,
      values: Partial<typeof turns.$inferInsert>,
    ) =>
      db
        .update(turns)
        .set(values)
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        );
    // Written by a release from before the column.
    await set(2, { requesterAuth: null });
    // Written by a later release, in a shape this one does not know.
    await set(3, {
      requesterKind: "routine",
      requesterId: "r-1",
      requesterAuth: { method: "routine", run_id: "x" },
    });
    await set(4, {
      requesterAuth: {
        carried_from: { turn: "1", reason: "continuation" },
      },
    });
    await set(5, { requesterKind: "user", requesterId: null });
    const page = await createPostgresSessionReader(db).listTurns(
      console.ownerId,
      sessionId,
      { limit: 50 },
    );
    expect(page?.items.map((turn) => turn.requester)).toEqual([
      {
        kind: "user",
        id: w.userId,
        auth_method: "web_session",
        carried: false,
      },
      { kind: "user", id: w.userId, auth_method: null, carried: false },
      { kind: "routine", id: "r-1", auth_method: "routine", carried: false },
      { kind: "user", id: w.userId, auth_method: null, carried: true },
      null,
    ]);
  });
});
