import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConversationId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
} from "@werft-ai/contracts";
import {
  CONVERSATION_CALL_TOKEN_PREFIX,
  chooseBudgetAccount,
  conversationCallReserve,
  createConversationCalls,
  hashConversationCallToken,
  type ProviderUsage,
  reservationTokens,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  lockBudgetCall,
  reserveBudgetIn,
  saveBudgetLimit,
} from "./budget-accounts.ts";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import { dropBufferedInputs } from "./conversations/judgment-buffer.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  budgetAccounts,
  budgetReservations,
  conversationCalls,
  memberTeams,
  workspaces,
} from "./schema.ts";
import { makeFixtureRelease } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };
const RESERVE = conversationCallReserve(LIMITS);
const CONNECTION = "conn-messages";
const catalog = {
  connections: {
    [CONNECTION]: {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;
const USED: ProviderUsage = {
  model: MODEL,
  inputTokens: 900,
  outputTokens: 40,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: false,
};

integration("conversation calls on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  let workspaceId: string;
  let agentId: string;
  let conversationId: ConversationId;
  const TEAM = "T0CALLS";
  const CHANNEL = "C0CALLS";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "conversation_calls_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema }) as NodePgDatabase<
      typeof schema
    > as unknown as Database;
    workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Calls" });
    const teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "team" });
    agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: teamId,
      slug: "agent",
      name: "agent",
    });
    conversationId = conversationIdSchema.parse(crypto.randomUUID());
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), workspaceId, TEAM, CHANNEL],
    );
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
      [conversationId, workspaceId, agentId, TEAM, CHANNEL],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresConversationCalls(db);
  const keyOf = () =>
    conversationCallKeySchema.parse(`${crypto.randomUUID()}:m1`);
  const issue = (
    userId: string,
    judgment: { callKey?: ReturnType<typeof keyOf>; topicId?: string } = {},
  ) =>
    createConversationCalls({ store: store(), catalog }).issue({
      workspaceId,
      agentId,
      conversationId,
      topicId:
        judgment.topicId === undefined
          ? null
          : conversationTopicIdSchema.parse(judgment.topicId),
      callClass: "m1",
      releaseId: null,
      callKey: judgment.callKey ?? keyOf(),
      attempt: 1,
      root: { kind: "user", userId },
      connectionId: CONNECTION,
      ...LIMITS,
    });
  async function issued(userId: string = crypto.randomUUID()) {
    const result = await issue(userId);
    if (result.outcome !== "issued") throw new Error(result.outcome);
    return result;
  }
  const grant = (token: string, exchangeId: string) =>
    store().authorizeAtomic({
      tokenHash: hashConversationCallToken(token),
      exchangeId,
    });
  const accountOf = async (ownerId: string) =>
    (
      await db
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.ownerId, ownerId))
    )[0];

  test("eight first grants of one token at once: one exchange is bound", async () => {
    const call = await issued();
    const exchanges = Array.from({ length: 8 }, () => crypto.randomUUID());
    const results = await Promise.all(
      exchanges.map((exchange) => grant(call.token, exchange)),
    );
    const bound = exchanges.filter(
      (_, index) => results[index]?.outcome === "ok",
    );
    expect(bound).toHaveLength(1);
    const [row] = await db
      .select()
      .from(conversationCalls)
      .where(eq(conversationCalls.id, call.callId));
    expect(row?.state).toBe("in_flight");
    expect(row?.exchangeId).toBe(bound[0] as string);
  });

  test("two issues at once on an account that holds one: one token, one refusal, no stray row", async () => {
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId },
      { costUsd: null, tokens: RESERVE.tokens * 2 - 1 },
    );
    const results = await Promise.all([0, 1].map(() => issue(userId)));
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "issued",
      "refused",
    ]);
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.requesterUserId, userId));
    expect(rows).toHaveLength(1);
  });

  test("two reports of one call at once: it is spent once", async () => {
    const userId = crypto.randomUUID();
    const call = await issued(userId);
    const exchange = crypto.randomUUID();
    await grant(call.token, exchange);
    const results = await Promise.all(
      [0, 1].map(() =>
        store().settleAtomic({
          callId: call.callId,
          exchangeId: exchange,
          usage: USED,
          priceFor: () => ({ costUsd: 0.002 }),
        }),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_settled",
      "settled",
    ]);
    expect(await accountOf(userId)).toMatchObject({
      spentTokens: reservationTokens(USED),
      reservedTokens: 0,
    });
  });

  test("a release and a first grant of an expiring token at once: the call is one or the other, its reservation with it", async () => {
    for (let round = 0; round < 10; round++) {
      const userId = crypto.randomUUID();
      const call = await issued(userId);
      // Expires while the two race: either may see it first.
      await db
        .update(conversationCalls)
        .set({ expiresAt: sql`clock_timestamp() + interval '20 milliseconds'` })
        .where(eq(conversationCalls.id, call.callId));
      await Bun.sleep(15);
      const [, granted] = await Promise.all([
        (async () => {
          await Bun.sleep(5);
          return store().releaseExpired({ limit: 100, dryRun: false });
        })(),
        grant(call.token, crypto.randomUUID()),
      ]);
      // A release that ran too early leaves it for the next pass.
      await Bun.sleep(25);
      await store().releaseExpired({ limit: 100, dryRun: false });
      const [row] = await db
        .select({ state: conversationCalls.state })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, call.callId));
      const [reservation] = await db
        .select({ state: budgetReservations.state })
        .from(budgetReservations)
        .where(eq(budgetReservations.callId, call.callId));
      if (granted.outcome === "ok") {
        expect([row?.state, reservation?.state]).toEqual([
          "in_flight",
          "reserved",
        ]);
        expect(await accountOf(userId)).toMatchObject({
          reservedTokens: RESERVE.tokens,
        });
      } else {
        expect([row?.state, reservation?.state]).toEqual([
          "released",
          "released",
        ]);
        expect(await accountOf(userId)).toMatchObject({ reservedTokens: 0 });
      }
    }
  });

  // On an account that holds one call: a later issue that missed the
  // earlier one's row would be refused instead of told it is a replay.
  test("eight issues of one key and attempt at once on an account that holds one: one call, the rest replays", async () => {
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId },
      { costUsd: null, tokens: RESERVE.tokens * 2 - 1 },
    );
    const callKey = keyOf();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => issue(userId, { callKey })),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      ...Array.from({ length: 7 }, () => "already_issued" as const),
      "issued",
    ]);
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.callKey, callKey));
    expect(rows).toHaveLength(1);
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
  });

  test("eight people's issues of one key and attempt at once: one call, held on one account", async () => {
    const userIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    const callKey = keyOf();
    const results = await Promise.all(
      userIds.map((userId) => issue(userId, { callKey })),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      ...Array.from({ length: 7 }, () => "already_issued" as const),
      "issued",
    ]);
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.callKey, callKey));
    expect(rows).toHaveLength(1);
    const held = await Promise.all(
      userIds.map(
        async (userId) => (await accountOf(userId))?.reservedTokens ?? 0,
      ),
    );
    expect(held.reduce((total, tokens) => total + tokens, 0)).toBe(
      RESERVE.tokens,
    );
    const reservations = await pool.query(
      "SELECT call_id FROM budget_reservations WHERE call_id NOT IN (SELECT id FROM conversation_calls)",
    );
    expect(reservations.rows).toEqual([]);
  });

  test("a call names its agent's release; another agent's release is refused with nothing held", async () => {
    const releaseId = await makeFixtureRelease(db, { workspaceId });
    const {
      rows: [release],
    } = await pool.query("SELECT agent_id FROM agent_releases WHERE id = $1", [
      releaseId,
    ]);
    const releaseAgent = release.agent_id as string;
    const releaseConversation = conversationIdSchema.parse(crypto.randomUUID());
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
      [releaseConversation, workspaceId, releaseAgent, TEAM, CHANNEL],
    );
    const calls = createConversationCalls({ store: store(), catalog });
    const base = {
      workspaceId,
      topicId: null,
      callClass: "m1" as const,
      releaseId,
      attempt: 1,
      connectionId: CONNECTION,
      ...LIMITS,
    };
    const own = await calls.issue({
      ...base,
      agentId: releaseAgent,
      conversationId: releaseConversation,
      callKey: keyOf(),
      root: { kind: "user", userId: crypto.randomUUID() },
    });
    if (own.outcome !== "issued") throw new Error(own.outcome);
    const [row] = await db
      .select({ releaseId: conversationCalls.releaseId })
      .from(conversationCalls)
      .where(eq(conversationCalls.id, own.callId));
    expect(row?.releaseId).toBe(releaseId);
    const userId = crypto.randomUUID();
    await expect(
      calls.issue({
        ...base,
        agentId,
        conversationId,
        callKey: keyOf(),
        root: { kind: "user", userId },
      }),
    ).rejects.toThrow("conversation_calls_release_fk");
    expect((await accountOf(userId))?.reservedTokens ?? 0).toBe(0);
  });

  test("the buffer drops the last input of a topic a call names: the topic goes, the call stays with no topic", async () => {
    const topicId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, '100.000100')",
      [topicId, workspaceId, agentId, conversationId, TEAM, CHANNEL],
    );
    const inputId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq,
        slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id,
        body, buffer_expires_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, '100.000101', 'slack_user', 'U0PERSON',
        'unheard', now() + interval '10 minutes')`,
      [inputId, workspaceId, agentId, topicId, TEAM, CHANNEL],
    );
    const call = await issue(crypto.randomUUID(), { topicId });
    if (call.outcome !== "issued") throw new Error(call.outcome);
    expect(
      await db.transaction((tx) => dropBufferedInputs(tx, [inputId])),
    ).toBe(1);
    const topics = await pool.query(
      "SELECT id FROM conversation_topics WHERE id = $1",
      [topicId],
    );
    expect(topics.rows).toEqual([]);
    const [row] = await db
      .select()
      .from(conversationCalls)
      .where(eq(conversationCalls.id, call.callId));
    expect(row).toMatchObject({
      state: "reserved",
      conversationId,
      topicId: null,
      callClass: "m1",
    });
  });

  test("a call an older image issues, with none of the new columns, is granted and settled", async () => {
    const userId = crypto.randomUUID();
    const callId = conversationCallIdSchema.parse(crypto.randomUUID());
    const token = `${CONVERSATION_CALL_TOKEN_PREFIX}${crypto.randomUUID()}`;
    // What an image from before migration 0340 writes on an issue.
    await db.transaction(async (tx) => {
      await lockBudgetCall(tx, callId);
      const reserved = await reserveBudgetIn(tx, {
        callId,
        workspaceId,
        choice: chooseBudgetAccount({ kind: "user", userId }, null),
        reserve: RESERVE,
        unmetered: false,
      });
      if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
    });
    await pool.query(
      `INSERT INTO conversation_calls (id, workspace_id, agent_id, token_hash,
        root_kind, requester_user_id, connection_id, path, model, max_tokens,
        max_request_bytes, expires_at)
       VALUES ($1, $2, $3, $4, 'user', $5, $6, '/v1/messages', $7, $8, $9,
        now() + interval '2 minutes')`,
      [
        callId,
        workspaceId,
        agentId,
        Buffer.from(hashConversationCallToken(token)),
        userId,
        CONNECTION,
        MODEL,
        LIMITS.maxTokens,
        LIMITS.maxRequestBytes,
      ],
    );
    await issued(userId);
    const exchange = crypto.randomUUID();
    expect((await grant(token, exchange)).outcome).toBe("ok");
    expect(
      (
        await store().settleAtomic({
          callId,
          exchangeId: exchange,
          usage: USED,
          priceFor: () => ({ costUsd: 0.002 }),
        })
      ).outcome,
    ).toBe("settled");
    expect(await accountOf(userId)).toMatchObject({
      spentTokens: reservationTokens(USED),
      reservedTokens: RESERVE.tokens,
    });
  });
});
