import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import {
  type BudgetRoot,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  conversationCallReserve,
  createConversationCalls,
  hashConversationCallToken,
  type ProviderUsage,
  priceSettledUsage,
  type SessionCatalog,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "./budget-accounts.ts";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  budgetAccounts,
  budgetReservations,
  conversationCalls,
  conversations,
  conversationTopics,
  conversationTurnPermits,
  memberTeams,
} from "./schema.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the calls read; foreign keys are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const WORKSPACE = "00000000-0000-4000-8000-0000000000e7";
const SLACK_TEAM = "T0UNPRICED";
const PRICED = "claude-haiku-4-5";
// Neither price table nor the LiteLLM snapshot names it.
const UNPRICED = "werft-test-model-nothing-prices";
const SIZE = { maxTokens: 256, maxRequestBytes: 4_096 };
const RESERVE = conversationCallReserve({ model: UNPRICED, ...SIZE });
// What one call for the unpriced model holds: its tokens and no amount.
const T = RESERVE.tokens;

const catalog = {
  connections: {
    "conn-messages": {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [PRICED, UNPRICED],
    },
    "conn-local": {
      provider: {
        kind: "anthropic",
        endpoint: "http://litellm:4000",
        billing: "none",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [UNPRICED],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;

const usageOf = (model: string, inputTokens: number): ProviderUsage => ({
  model,
  inputTokens,
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
});

const conversationOf = new Map<string, ConversationId>();

async function agentOf(options: { teamArchived?: boolean } = {}) {
  const teamId = randomUUID();
  const agentId = randomUUID();
  await db.insert(memberTeams).values({
    id: teamId,
    workspaceId: WORKSPACE,
    name: `team-${teamId.slice(0, 8)}`,
    ...(options.teamArchived ? { archivedAt: new Date() } : {}),
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: `a-${agentId.slice(0, 8)}`,
    name: "agent",
  });
  const conversationId = conversationIdSchema.parse(randomUUID());
  await db.insert(conversations).values({
    id: conversationId,
    workspaceId: WORKSPACE,
    agentId,
    kind: "channel",
    teamId: SLACK_TEAM,
    channelId: `C${agentId.slice(0, 8)}`,
  });
  conversationOf.set(agentId, conversationId);
  return { agentId, teamId, conversationId };
}

const store = () => createPostgresConversationCalls(db);
const callsWith = (limit: number) =>
  createConversationCalls({
    store: store(),
    catalog,
    unknownPriceTokenLimit: async () => limit,
  });

const person = (userId: string): BudgetRoot => ({ kind: "user", userId });
const agentKey: BudgetRoot = {
  kind: "key",
  keyKind: "agent",
  createdByUserId: null,
};

function issue(
  limit: number,
  agentId: string,
  root: BudgetRoot,
  model: string,
  connectionId = "conn-messages",
) {
  return callsWith(limit).issue({
    workspaceId: WORKSPACE,
    agentId,
    conversationId: conversationOf.get(agentId) as ConversationId,
    topicId: null,
    callClass: "m2",
    releaseId: null,
    callKey: conversationCallKeySchema.parse(`${randomUUID()}:m2`),
    attempt: 1,
    root,
    connectionId,
    model,
    ...SIZE,
  });
}

async function issued(...args: Parameters<typeof issue>) {
  const result = await issue(...args);
  if (result.outcome !== "issued") {
    throw new Error(`not issued: ${JSON.stringify(result)}`);
  }
  return result;
}

/** Granted and reported as the gateway prices it: from both models. */
async function used(
  call: { callId: string; token: string },
  answer: ProviderUsage,
) {
  const exchangeId = randomUUID();
  const granted = await store().authorizeAtomic({
    tokenHash: hashConversationCallToken(call.token),
    exchangeId,
  });
  if (granted.outcome !== "ok") throw new Error(granted.outcome);
  return store().settleAtomic({
    callId: granted.callId,
    exchangeId,
    usage: answer,
    priceFor: (row) =>
      row.unmetered
        ? { costUsd: 0, pricedBy: "unmetered" }
        : priceSettledUsage(answer, row.model),
  });
}

const callCount = async () =>
  (await db.select({ id: conversationCalls.id }).from(conversationCalls))
    .length;

const costOnly = (userId: string) =>
  saveBudgetLimit(
    db,
    WORKSPACE,
    { kind: "user", userId },
    { costUsd: 1, tokens: null },
  );

describe("a conversation call's limit on tokens of unknown price, by account and month", () => {
  test("an account with only a cost limit: calls for a model nothing prices are issued under the limit and refused once their reserves reach it, with nothing held", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    await issued(3 * T, agentId, person(userId), UNPRICED);
    await issued(3 * T, agentId, person(userId), UNPRICED);
    expect(await issue(3 * T, agentId, person(userId), UNPRICED)).toEqual({
      outcome: "refused",
      rootKind: "user",
      accountId: expect.any(String),
      by: "unknown_price_tokens",
    });
    expect(await callCount()).toBe(2);
    expect(await db.select().from(budgetReservations)).toHaveLength(2);
    const [account] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.ownerId, userId));
    // The cost limit never counted them: they hold no amount.
    expect(account).toMatchObject({
      reservedTokens: 2 * T,
      reservedCostUsd: 0,
    });
    const marks = await db
      .select({ pricedBy: conversationCalls.pricedBy })
      .from(conversationCalls);
    expect(marks).toEqual([{ pricedBy: "unknown" }, { pricedBy: "unknown" }]);
  });

  test("a priced model's calls are as before on an account with no tokens of unknown price, however low the limit", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    for (let n = 0; n < 3; n++) {
      const call = await issued(1, agentId, person(userId), PRICED);
      expect(await used(call, usageOf(PRICED, 900))).toMatchObject({
        outcome: "settled",
        pricedBy: "table",
      });
    }
    const priced = await db
      .select({ pricedBy: conversationCalls.pricedBy })
      .from(conversationCalls);
    expect(priced.every((row) => row.pricedBy === "table")).toBe(true);
  });

  test("once the month's tokens of unknown price reach the limit, a priced call is refused too; an unmetered one is not judged", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    const limit = T + 1;
    const first = await issued(limit, agentId, person(userId), UNPRICED);
    expect(await used(first, usageOf(UNPRICED, 5_000))).toMatchObject({
      outcome: "settled",
      costUsd: 0,
      pricedBy: "unknown",
    });
    expect(await issue(limit, agentId, person(userId), PRICED)).toMatchObject({
      outcome: "refused",
      by: "unknown_price_tokens",
    });
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED, "conn-local"))
        .outcome,
    ).toBe("issued");
    // Another person's account has its own month.
    expect(
      (await issue(limit, agentId, person(randomUUID()), UNPRICED)).outcome,
    ).toBe("issued");
  });

  test("a priced call answered by a model nothing prices is marked at its settlement, and its tokens count", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    const limit = 2_000;
    const call = await issued(limit, agentId, person(userId), PRICED);
    expect(await used(call, usageOf(UNPRICED, 900))).toMatchObject({
      outcome: "settled",
      costUsd: 0,
      pricedBy: "unknown",
    });
    // 940 of 2,000 used: a reserve of more than what is left is refused.
    expect(await issue(limit, agentId, person(userId), UNPRICED)).toMatchObject(
      { outcome: "refused", by: "unknown_price_tokens" },
    );
    expect((await issue(limit, agentId, person(userId), PRICED)).outcome).toBe(
      "issued",
    );
  });

  test("a row an older image wrote, with no mark, is read as priced", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    const limit = T + 1;
    const first = await issued(limit, agentId, person(userId), UNPRICED);
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("refused");
    await db
      .update(conversationCalls)
      .set({ pricedBy: null })
      .where(eq(conversationCalls.id, first.callId));
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("issued");
  });

  test("a released call gives its room back", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    const limit = T + 1;
    const first = await issued(limit, agentId, person(userId), UNPRICED);
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("refused");
    await db
      .update(conversationCalls)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(conversationCalls.id, first.callId));
    expect(await store().releaseExpired({ limit: 10, dryRun: false })).toEqual({
      released: 1,
    });
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("issued");
  });

  test("a new month (UTC) starts from nothing: last month's calls count no more", async () => {
    const { agentId } = await agentOf();
    const userId = randomUUID();
    await costOnly(userId);
    const limit = T + 1;
    await issued(limit, agentId, person(userId), UNPRICED);
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("refused");
    // The call and its account as last month left them.
    await db.execute(
      sql`UPDATE conversation_calls SET created_at = created_at - interval '40 days'`,
    );
    await db.execute(
      sql`UPDATE budget_accounts SET period_start = (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - interval '1 month')::date`,
    );
    expect(
      (await issue(limit, agentId, person(userId), UNPRICED)).outcome,
    ).toBe("issued");
  });

  test("a call held on no account counts against its agent alone, by month", async () => {
    const one = await agentOf({ teamArchived: true });
    const other = await agentOf({ teamArchived: true });
    const limit = T + 1;
    await issued(limit, one.agentId, agentKey, UNPRICED);
    expect(await issue(limit, one.agentId, agentKey, UNPRICED)).toEqual({
      outcome: "refused",
      rootKind: "key",
      accountId: null,
      by: "unknown_price_tokens",
    });
    expect(
      (await issue(limit, other.agentId, agentKey, UNPRICED)).outcome,
    ).toBe("issued");
    await db.execute(
      sql`UPDATE conversation_calls SET created_at = created_at - interval '40 days' WHERE agent_id = ${one.agentId}::uuid`,
    );
    expect((await issue(limit, one.agentId, agentKey, UNPRICED)).outcome).toBe(
      "issued",
    );
  });

  test("a report again answers with what its first settlement stored", async () => {
    const { agentId } = await agentOf();
    const call = await issued(5_000_000, agentId, person(randomUUID()), PRICED);
    const exchangeId = randomUUID();
    await store().authorizeAtomic({
      tokenHash: hashConversationCallToken(call.token),
      exchangeId,
    });
    const report = (pricedBy: "table" | "unknown") =>
      store().settleAtomic({
        callId: call.callId,
        exchangeId,
        usage: usageOf(PRICED, 900),
        priceFor: () => ({ costUsd: 0.001, pricedBy }),
      });
    expect(await report("table")).toMatchObject({
      outcome: "settled",
      pricedBy: "table",
    });
    expect(await report("unknown")).toMatchObject({
      outcome: "already_settled",
      pricedBy: "table",
    });
    // A call an older image settled stored nothing: the gateway reads the
    // answer again.
    await db
      .update(conversationCalls)
      .set({ pricedBy: null })
      .where(eq(conversationCalls.id, call.callId));
    expect(await report("unknown")).toMatchObject({
      outcome: "already_settled",
      pricedBy: null,
    });
  });
});

describe("a conversation turn's calls on the limit on tokens of unknown price", () => {
  async function permitOf(
    agentId: string,
    conversationId: ConversationId,
    model: string,
  ) {
    const topicId = conversationTopicIdSchema.parse(randomUUID());
    await db.insert(conversationTopics).values({
      id: topicId,
      workspaceId: WORKSPACE,
      agentId,
      conversationId,
      conversationKind: "channel",
      slackTeamId: SLACK_TEAM,
      slackChannelId: `C${agentId.slice(0, 8)}`,
      slackThreadTs: `1764000000.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
    });
    const turnId = conversationTurnIdSchema.parse(randomUUID());
    const token = `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}${randomUUID()}`;
    const permit = await store().issueTurnPermitAtomic({
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId: WORKSPACE,
      agentId,
      conversationId,
      topicId,
      requester: { kind: "operator", id: "ops@host" },
      releaseId: null,
      root: { kind: "key", keyKind: "operator", createdByUserId: null },
      connectionId: "conn-messages",
      path: "/v1/messages",
      model,
      ...SIZE,
      callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
      ttlMs: 180_000,
    });
    if (permit.outcome !== "issued") throw new Error(permit.outcome);
    const call = (limit: number) =>
      store().authorizeTurnCallAtomic({
        tokenHash: hashConversationCallToken(token),
        exchangeId: randomUUID(),
        callId: conversationCallIdSchema.parse(randomUUID()),
        unknownPriceTokenLimit: limit,
        // As the gateway holds a call on the permit.
        reserveFor: (held) => {
          const reserve = conversationCallReserve(held);
          return {
            reserve: { costUsd: reserve.costUsd, tokens: reserve.tokens },
            unmetered: false,
            pricedBy: reserve.pricedBy,
          };
        },
      });
    return { turnId, call };
  }

  test("a turn's calls for a model nothing prices are granted under the team account's limit and refused once it is reached, the permit keeping a budget refusal; a priced turn is refused too", async () => {
    const { agentId, teamId, conversationId } = await agentOf();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId },
      { costUsd: 5, tokens: null },
    );
    const limit = 2 * T + 1;
    const turn = await permitOf(agentId, conversationId, UNPRICED);
    expect((await turn.call(limit)).outcome).toBe("ok");
    expect((await turn.call(limit)).outcome).toBe("ok");
    expect(await turn.call(limit)).toMatchObject({
      outcome: "refused",
      turnId: turn.turnId,
      rootKind: "key",
      by: "unknown_price_tokens",
    });
    const [permit] = await db
      .select({ refusal: conversationTurnPermits.refusal })
      .from(conversationTurnPermits)
      .where(eq(conversationTurnPermits.turnId, turn.turnId));
    expect(permit?.refusal).toBe("budget");
    expect(await callCount()).toBe(2);
    // The account's month, not the turn: the next turn starts refused, a
    // priced one too.
    const priced = await permitOf(agentId, conversationId, PRICED);
    await db.execute(sql`UPDATE conversation_turn_permits SET refusal = NULL`);
    expect(await priced.call(2 * T)).toMatchObject({
      outcome: "refused",
      by: "unknown_price_tokens",
    });
    // Under a higher limit the priced turn's call is granted as before.
    expect((await priced.call(5_000_000)).outcome).toBe("ok");
  });

  test("a priced turn on an account with no tokens of unknown price is granted as before, however low the limit", async () => {
    const { agentId, teamId, conversationId } = await agentOf();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId },
      { costUsd: 5, tokens: null },
    );
    const turn = await permitOf(agentId, conversationId, PRICED);
    for (let n = 0; n < 3; n++) {
      expect((await turn.call(1)).outcome).toBe("ok");
    }
    const marks = await db
      .select({ pricedBy: conversationCalls.pricedBy })
      .from(conversationCalls);
    expect(marks.every((row) => row.pricedBy === "table")).toBe(true);
  });
});
