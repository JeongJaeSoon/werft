import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type ConversationCallId,
  type ConversationId,
  type ConversationTopicId,
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
// Neither price table nor the LiteLLM snapshot names it.
const UNPRICED = "werft-test-model-nothing-prices";
const catalog = {
  connections: {
    [CONNECTION]: {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL, UNPRICED],
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
  let teamId: string;
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
    teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "team" });
    // The agent's own calls (root none) are charged to its team.
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "team", teamId },
      { costUsd: null, tokens: RESERVE.tokens * 1_000 },
    );
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), workspaceId, TEAM, CHANNEL],
    );
  }, 60_000);

  // An agent of its own per test, its calls in progress counted apart.
  async function newAgent() {
    const id = crypto.randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: teamId,
      slug: `agent-${id}`,
      name: "agent",
    });
    const conversation = conversationIdSchema.parse(crypto.randomUUID());
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
      [conversation, workspaceId, id, TEAM, CHANNEL],
    );
    return { agentId: id, conversationId: conversation };
  }

  beforeEach(async () => {
    ({ agentId, conversationId } = await newAgent());
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresConversationCalls(db);
  const keyOf = () =>
    conversationCallKeySchema.parse(`${crypto.randomUUID()}:m2`);
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
      // m2, held by no channel's limit.
      callClass: "m2",
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

  test("four issues at once for a model nothing prices on an account with only a cost limit: those under its limit on tokens of unknown price are issued, the rest refused with nothing held", async () => {
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId },
      { costUsd: 1, tokens: null },
    );
    const unpriced = conversationCallReserve({ ...LIMITS, model: UNPRICED });
    // An agent each: the account's row, not one agent's lock, orders them.
    const callers = await Promise.all([0, 1, 2, 3].map(() => newAgent()));
    const results = await Promise.all(
      callers.map(({ agentId, conversationId }) =>
        createConversationCalls({
          store: store(),
          catalog,
          unknownPriceTokenLimit: async () => unpriced.tokens * 2 + 1,
        }).issue({
          workspaceId,
          agentId,
          conversationId,
          topicId: null,
          callClass: "m2",
          releaseId: null,
          callKey: keyOf(),
          attempt: 1,
          root: { kind: "user", userId },
          connectionId: CONNECTION,
          ...LIMITS,
          model: UNPRICED,
        }),
      ),
    );
    expect(
      results.map((result) =>
        result.outcome === "refused" ? result.by : result.outcome,
      ),
    ).toEqual(
      expect.arrayContaining([
        "issued",
        "issued",
        "unknown_price_tokens",
        "unknown_price_tokens",
      ]),
    );
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: unpriced.tokens * 2,
      reservedCostUsd: 0,
    });
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.requesterUserId, userId));
    expect(rows).toHaveLength(2);
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
          priceFor: () => ({ costUsd: 0.002, pricedBy: "table" }),
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
      // A granted call stays in flight, so each round has an agent of its
      // own, clear of the agent's limit.
      ({ agentId, conversationId } = await newAgent());
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
    const reservations = await db
      .select({ id: budgetReservations.callId })
      .from(budgetReservations)
      .where(eq(budgetReservations.callId, rows[0]?.id as string));
    expect(reservations).toHaveLength(1);
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
      callClass: "m2" as const,
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
    const refused: unknown = await calls
      .issue({
        ...base,
        agentId,
        conversationId,
        callKey: keyOf(),
        root: { kind: "user", userId },
      })
      .catch((error: unknown) => error);
    expect(
      (refused as { cause?: { constraint?: string } }).cause?.constraint,
    ).toBe("conversation_calls_release_fk");
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
      callClass: "m2",
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
          priceFor: () => ({ costUsd: 0.002, pricedBy: "table" }),
        })
      ).outcome,
    ).toBe("settled");
    expect(await accountOf(userId)).toMatchObject({
      spentTokens: reservationTokens(USED),
      reservedTokens: RESERVE.tokens,
    });
  });

  describe("concurrency limits", () => {
    const NO_ONE = { kind: "none" } as const;
    type Agent = { agentId: string; conversationId: ConversationId };
    let threads = 0;
    async function topicOf(agent: Agent) {
      const topicId = conversationTopicIdSchema.parse(crypto.randomUUID());
      threads += 1;
      await pool.query(
        "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
        [
          topicId,
          workspaceId,
          agent.agentId,
          agent.conversationId,
          TEAM,
          CHANNEL,
          `200.${String(threads).padStart(6, "0")}`,
        ],
      );
      return topicId;
    }
    const callOf = (
      agent: Agent,
      options: {
        callClass?: "m1" | "m2" | "summary";
        topicId?: ConversationTopicId;
        root?: { kind: "user"; userId: string } | typeof NO_ONE;
      } = {},
    ) => {
      const callClass = options.callClass ?? "m2";
      return createConversationCalls({ store: store(), catalog }).issue({
        workspaceId,
        agentId: agent.agentId,
        conversationId: agent.conversationId,
        topicId: options.topicId ?? null,
        callClass,
        releaseId: null,
        callKey: conversationCallKeySchema.parse(
          `${crypto.randomUUID()}:${callClass}`,
        ),
        attempt: 1,
        root: options.root ?? NO_ONE,
        connectionId: CONNECTION,
        ...LIMITS,
      });
    };
    const outcomes = (
      results: Awaited<ReturnType<typeof callOf>>[],
    ): string[] =>
      results
        .map((result) =>
          result.outcome === "concurrency_limited"
            ? `limited:${result.limit}`
            : result.outcome,
        )
        .sort();
    const tokenOf = (result: Awaited<ReturnType<typeof callOf>>) => {
      if (result.outcome !== "issued") throw new Error(result.outcome);
      return result;
    };
    const callsOf = (agent: Agent) =>
      db
        .select({ id: conversationCalls.id })
        .from(conversationCalls)
        .where(eq(conversationCalls.agentId, agent.agentId));
    const teamReserved = async () =>
      (await accountOf(teamId))?.reservedTokens ?? 0;
    const settle = async (call: {
      callId: ConversationCallId;
      token: string;
    }) => {
      const exchange = crypto.randomUUID();
      expect((await grant(call.token, exchange)).outcome).toBe("ok");
      expect(
        (
          await store().settleAtomic({
            callId: call.callId,
            exchangeId: exchange,
            usage: USED,
            priceFor: () => ({ costUsd: 0.002, pricedBy: "table" }),
          })
        ).outcome,
      ).toBe("settled");
    };

    test("nine calls of one agent at once: eight are issued, one is limited by the agent and holds nothing", async () => {
      const agent = { agentId, conversationId };
      const before = await teamReserved();
      const results = await Promise.all(
        Array.from({ length: 9 }, () => callOf(agent)),
      );
      expect(outcomes(results)).toEqual([
        ...Array(8).fill("issued"),
        "limited:agent",
      ]);
      expect(
        results.find((result) => result.outcome === "concurrency_limited"),
      ).toEqual({
        outcome: "concurrency_limited",
        limit: "agent",
        inProgress: 8,
        unknown: 0,
      });
      expect(await callsOf(agent)).toHaveLength(8);
      expect((await teamReserved()) - before).toBe(RESERVE.tokens * 8);
    });

    test("two M1 calls of one channel at once: one is issued; a summary call beside it is not held", async () => {
      const agent = { agentId, conversationId };
      const results = await Promise.all([
        callOf(agent, { callClass: "m1" }),
        callOf(agent, { callClass: "m1" }),
      ]);
      expect(outcomes(results)).toEqual(["issued", "limited:channel"]);
      expect((await callOf(agent, { callClass: "summary" })).outcome).toBe(
        "issued",
      );
      // Another agent's M1 in the same channel is its own line.
      expect(
        (await callOf(await newAgent(), { callClass: "m1" })).outcome,
      ).toBe("issued");
    });

    test("two calls of one topic at once: one is issued; another topic's is issued too", async () => {
      const agent = { agentId, conversationId };
      const [one, other] = [await topicOf(agent), await topicOf(agent)];
      const results = await Promise.all([
        callOf(agent, { topicId: one }),
        callOf(agent, { topicId: one }),
        callOf(agent, { topicId: other }),
      ]);
      expect(outcomes(results)).toEqual(["issued", "issued", "limited:topic"]);
    });

    test("one person's calls on five topics at once: four are issued, one is limited by the person", async () => {
      const agent = { agentId, conversationId };
      const root = { kind: "user", userId: crypto.randomUUID() } as const;
      const topics = await Promise.all(
        Array.from({ length: 5 }, () => topicOf(agent)),
      );
      const results = await Promise.all(
        topics.map((topicId) => callOf(agent, { topicId, root })),
      );
      expect(outcomes(results)).toEqual([
        ...Array(4).fill("issued"),
        "limited:requester",
      ]);
    });

    test("one person's five calls through two agents at once: four are issued", async () => {
      const [first, second] = [{ agentId, conversationId }, await newAgent()];
      const root = { kind: "user", userId: crypto.randomUUID() } as const;
      const results = await Promise.all(
        [first, first, first, second, second].map((agent) =>
          callOf(agent, { root }),
        ),
      );
      expect(outcomes(results)).toEqual([
        ...Array(4).fill("issued"),
        "limited:requester",
      ]);
    });

    test("a settled call frees its place; so does a token that expired, before and after its release", async () => {
      const agent = { agentId, conversationId };
      const first = tokenOf(await callOf(agent, { callClass: "m1" }));
      expect(await callOf(agent, { callClass: "m1" })).toMatchObject({
        outcome: "concurrency_limited",
        limit: "channel",
      });
      await settle(first);
      const second = tokenOf(await callOf(agent, { callClass: "m1" }));
      await pool.query(
        "UPDATE conversation_calls SET expires_at = now() - interval '1 second' WHERE id = $1",
        [second.callId],
      );
      // An expired token cannot be used, so it holds no place even before
      // the reconciler releases it.
      const third = tokenOf(await callOf(agent, { callClass: "m1" }));
      await pool.query(
        "UPDATE conversation_calls SET expires_at = now() - interval '1 second' WHERE id = $1",
        [third.callId],
      );
      expect(
        (await store().releaseExpired({ limit: 1_000, dryRun: false }))
          .released,
      ).toBeGreaterThanOrEqual(2);
      expect((await callOf(agent, { callClass: "m1" })).outcome).toBe("issued");
    });

    test("a first grant waits on the limits' locks and binds no token that expired meanwhile", async () => {
      const agent = { agentId, conversationId };
      const first = tokenOf(await callOf(agent, { callClass: "m1" }));
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtext('conversation_call_limit'), hashtext($1))",
          [`agent:${agent.agentId}`],
        );
        let settled = false;
        const granting = grant(first.token, crypto.randomUUID()).finally(() => {
          settled = true;
        });
        // The grant's session waits on the advisory lock the holder has.
        let waiting = 0;
        for (let i = 0; i < 50 && waiting === 0; i++) {
          await Bun.sleep(50);
          waiting = (
            await pool.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
            )
          ).rows[0].n;
        }
        expect(waiting).toBe(1);
        expect(settled).toBe(false);
        await pool.query(
          "UPDATE conversation_calls SET expires_at = now() - interval '1 second' WHERE id = $1",
          [first.callId],
        );
        await holder.query("COMMIT");
        expect((await granting).outcome).toBe("invalid_token");
      } finally {
        holder.release();
      }
      // The next M1 is the channel's one call in progress.
      expect((await callOf(agent, { callClass: "m1" })).outcome).toBe("issued");
      expect(await callOf(agent, { callClass: "m1" })).toMatchObject({
        outcome: "concurrency_limited",
        limit: "channel",
      });
    });

    test("an M1 attempt the provider answered with an error, reported at nothing, gives the channel's place and its reservation to the next attempt", async () => {
      const agent = { agentId, conversationId };
      const before = await teamReserved();
      const first = tokenOf(await callOf(agent, { callClass: "m1" }));
      const exchange = crypto.randomUUID();
      expect((await grant(first.token, exchange)).outcome).toBe("ok");
      // Bound and unreported, it holds the channel's one place.
      expect(await callOf(agent, { callClass: "m1" })).toMatchObject({
        outcome: "concurrency_limited",
        limit: "channel",
      });
      // What the egress proxy reports for a provider's error answer.
      const settled = await store().settleAtomic({
        callId: first.callId,
        exchangeId: exchange,
        usage: { ...USED, inputTokens: 0, outputTokens: 0 },
        priceFor: () => ({ costUsd: 0, pricedBy: "table" }),
      });
      expect(settled).toMatchObject({ outcome: "settled", costUsd: 0 });
      expect(await teamReserved()).toBe(before);
      expect((await callOf(agent, { callClass: "m1" })).outcome).toBe("issued");
    });

    test("a summary in progress does not hold a channel's first M1", async () => {
      const agent = { agentId, conversationId };
      tokenOf(await callOf(agent, { callClass: "summary" }));
      tokenOf(await callOf(agent, { callClass: "m1" }));
      expect(await callOf(agent, { callClass: "m1" })).toMatchObject({
        outcome: "concurrency_limited",
        limit: "channel",
        inProgress: 1,
      });
    });

    test("calls of unknown end hold the agent's places, said in the refusal, until a late report settles one", async () => {
      const agent = { agentId, conversationId };
      const calls = (
        await Promise.all(Array.from({ length: 8 }, () => callOf(agent)))
      ).map(tokenOf);
      const exchanges = calls.map(() => crypto.randomUUID());
      for (const [i, call] of calls.entries()) {
        expect((await grant(call.token, exchanges[i] as string)).outcome).toBe(
          "ok",
        );
      }
      // Past the exchange lease with no report.
      await pool.query(
        "UPDATE conversation_calls SET started_at = now() - interval '1 day' WHERE agent_id = $1",
        [agent.agentId],
      );
      expect(
        (await store().markUnknown({ limit: 1_000, dryRun: false })).unknown,
      ).toBeGreaterThanOrEqual(8);
      expect(await callOf(agent)).toEqual({
        outcome: "concurrency_limited",
        limit: "agent",
        inProgress: 8,
        unknown: 8,
      });
      expect(
        await store().unknownByAgent({ atLeast: 4, limit: 1_000 }),
      ).toContainEqual({ workspaceId, agentId: agent.agentId, unknown: 8 });
      const [late] = calls;
      if (!late) throw new Error("no call");
      expect(
        (
          await store().settleAtomic({
            callId: late.callId,
            exchangeId: exchanges[0] as string,
            usage: USED,
            priceFor: () => ({ costUsd: 0.002, pricedBy: "table" }),
          })
        ).outcome,
      ).toBe("settled");
      expect((await callOf(agent)).outcome).toBe("issued");
    });
  });
});
