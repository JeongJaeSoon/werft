import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type BudgetRoot,
  CONVERSATION_CALL_TOKEN_PREFIX,
  conversationCallReserve,
  createConversationCalls,
  hashConversationCallToken,
  type ProviderUsage,
  reservationTokens,
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
  memberTeams,
  providerUsage,
  sessions,
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

const WORKSPACE = "00000000-0000-4000-8000-0000000000c2";
const CONNECTION = "conn-messages";
const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };
const RESERVE = conversationCallReserve(LIMITS);

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
    "conn-local": {
      provider: {
        kind: "anthropic",
        endpoint: "http://litellm:4000",
        billing: "none",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL],
    },
    "conn-responses": {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: ["gpt-5.5"],
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
const BILLED = 0.0021;

async function agentOf(options: { teamArchived?: boolean } = {}) {
  const teamId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
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
  return { agentId, teamId };
}

const store = () => createPostgresConversationCalls(db);
const calls = () => createConversationCalls({ store: store(), catalog });

function issue(agentId: string, root: BudgetRoot, connectionId = CONNECTION) {
  return calls().issue({
    workspaceId: WORKSPACE,
    agentId,
    root,
    connectionId,
    ...LIMITS,
  });
}

async function issued(agentId: string, root: BudgetRoot) {
  const result = await issue(agentId, root);
  if (result.outcome !== "issued") {
    throw new Error(`not issued: ${JSON.stringify(result)}`);
  }
  return result;
}

const grant = (token: string, exchangeId: string) =>
  store().authorizeAtomic({
    tokenHash: hashConversationCallToken(token),
    exchangeId,
  });

const settle = (
  callId: Awaited<ReturnType<typeof issued>>["callId"],
  exchangeId: string,
  usage: ProviderUsage = USED,
) =>
  store().settleAtomic({
    callId,
    exchangeId,
    usage,
    priceFor: () => ({ costUsd: BILLED }),
  });

async function callOf(id: string) {
  const [row] = await db
    .select()
    .from(conversationCalls)
    .where(eq(conversationCalls.id, id as never));
  return row;
}

async function reservationOf(callId: string) {
  const [row] = await db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.callId, callId));
  return row;
}

async function accountOf(ownerId: string) {
  const [account] = await db
    .select()
    .from(budgetAccounts)
    .where(eq(budgetAccounts.ownerId, ownerId));
  return account;
}

const person = (userId: string): BudgetRoot => ({ kind: "user", userId });

describe("a conversation call's reservation", () => {
  test("a person's call: reserved before the token, used once, settled on their account", async () => {
    const { agentId } = await agentOf();
    const userId = crypto.randomUUID();
    const call = await issued(agentId, person(userId));
    expect(call.token.startsWith(CONVERSATION_CALL_TOKEN_PREFIX)).toBe(true);

    // Reserved on the person's account with no limit: recorded, not refused.
    expect(await callOf(call.callId)).toMatchObject({
      state: "reserved",
      rootKind: "user",
      requesterUserId: userId,
      model: MODEL,
      maxTokens: LIMITS.maxTokens,
      maxRequestBytes: LIMITS.maxRequestBytes,
      exchangeId: null,
    });
    // Only its hash is kept.
    const stored = await callOf(call.callId);
    expect(Buffer.from(stored?.tokenHash ?? []).toString()).not.toContain(
      call.token,
    );
    expect(await reservationOf(call.callId)).toMatchObject({
      state: "reserved",
      rootKind: "user",
      tokens: RESERVE.tokens,
    });
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
      spentTokens: 0,
    });

    const exchange = crypto.randomUUID();
    expect(await grant(call.token, exchange)).toEqual({
      outcome: "ok",
      callId: call.callId,
      connectionId: CONNECTION,
      path: "/v1/messages",
      model: MODEL,
      maxTokens: LIMITS.maxTokens,
      maxRequestBytes: LIMITS.maxRequestBytes,
    });
    expect((await callOf(call.callId))?.state).toBe("in_flight");
    // The proxy's regrant of the same exchange passes; another is refused.
    expect((await grant(call.token, exchange)).outcome).toBe("ok");
    expect((await grant(call.token, crypto.randomUUID())).outcome).toBe(
      "invalid_token",
    );

    expect(await settle(call.callId, exchange)).toEqual({
      outcome: "settled",
      costUsd: BILLED,
      unmetered: false,
    });
    expect(await callOf(call.callId)).toMatchObject({
      state: "settled",
      costUsd: BILLED,
      tokens: reservationTokens(USED),
      usage: USED,
    });
    expect(await reservationOf(call.callId)).toMatchObject({
      state: "settled",
      settledCostUsd: BILLED,
      settledTokens: reservationTokens(USED),
    });
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: 0,
      reservedCostUsd: 0,
      spentCostUsd: BILLED,
      spentTokens: reservationTokens(USED),
    });
    // No session's usage, and a token used up.
    expect(await db.select().from(providerUsage)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
    expect((await grant(call.token, exchange)).outcome).toBe("invalid_token");
  });

  test("a report again: the same usage replays, other usage or another exchange conflicts", async () => {
    const { agentId } = await agentOf();
    const call = await issued(agentId, person(crypto.randomUUID()));
    const exchange = crypto.randomUUID();
    await grant(call.token, exchange);
    expect((await settle(call.callId, exchange)).outcome).toBe("settled");
    expect(await settle(call.callId, exchange)).toEqual({
      outcome: "already_settled",
      costUsd: BILLED,
      unmetered: false,
    });
    expect(
      await settle(call.callId, exchange, { ...USED, outputTokens: 41 }),
    ).toEqual({ outcome: "conflict" });
    expect(await settle(call.callId, crypto.randomUUID())).toEqual({
      outcome: "conflict",
    });
    expect(await settle(crypto.randomUUID() as never, exchange)).toEqual({
      outcome: "unknown_call",
    });
  });

  test("an unmetered connection's call costs nothing, and says so on a replay", async () => {
    const { agentId } = await agentOf();
    const result = await issue(
      agentId,
      person(crypto.randomUUID()),
      "conn-local",
    );
    if (result.outcome !== "issued") throw new Error(result.outcome);
    const exchange = crypto.randomUUID();
    await grant(result.token, exchange);
    expect(await settle(result.callId, exchange)).toEqual({
      outcome: "settled",
      costUsd: 0,
      unmetered: true,
    });
    expect(await settle(result.callId, exchange)).toEqual({
      outcome: "already_settled",
      costUsd: 0,
      unmetered: true,
    });
  });

  test("a report before any grant is another exchange's", async () => {
    const { agentId } = await agentOf();
    const call = await issued(agentId, person(crypto.randomUUID()));
    expect(await settle(call.callId, crypto.randomUUID())).toEqual({
      outcome: "conflict",
    });
    expect((await callOf(call.callId))?.state).toBe("reserved");
  });

  test("an account that cannot hold the call gets no token and no row", async () => {
    const { agentId } = await agentOf();
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId },
      { costUsd: null, tokens: RESERVE.tokens },
    );
    const refused = await issue(agentId, person(userId));
    expect(refused).toMatchObject({ outcome: "refused", rootKind: "user" });
    expect(await db.select().from(conversationCalls)).toEqual([]);
    expect(await db.select().from(budgetReservations)).toEqual([]);
    expect(await accountOf(userId)).toMatchObject({ reservedTokens: 0 });
  });

  test("a limit that fits one call: the second is refused until the first settles", async () => {
    const { agentId } = await agentOf();
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId },
      { costUsd: null, tokens: RESERVE.tokens * 2 - 1 },
    );
    const first = await issued(agentId, person(userId));
    expect((await issue(agentId, person(userId))).outcome).toBe("refused");
    const exchange = crypto.randomUUID();
    await grant(first.token, exchange);
    await settle(first.callId, exchange);
    expect((await issue(agentId, person(userId))).outcome).toBe("issued");
  });

  test("the agent's own call needs a team limit; a person's passes with none", async () => {
    const { agentId, teamId } = await agentOf();
    expect(await issue(agentId, { kind: "none" })).toEqual({
      outcome: "refused",
      rootKind: "none",
      accountId: expect.any(String),
    });
    expect(await db.select().from(conversationCalls)).toEqual([]);
    expect((await issue(agentId, person(crypto.randomUUID()))).outcome).toBe(
      "issued",
    );
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId },
      { costUsd: 10, tokens: null },
    );
    const own = await issued(agentId, { kind: "none" });
    expect(await callOf(own.callId)).toMatchObject({
      rootKind: "none",
      requesterUserId: null,
    });
    expect(await accountOf(teamId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
  });

  test("an agent whose team is archived: its own call is refused with no account", async () => {
    const { agentId } = await agentOf({ teamArchived: true });
    expect(await issue(agentId, { kind: "none" })).toEqual({
      outcome: "refused",
      rootKind: "none",
      accountId: null,
    });
  });

  test("a personal key is charged to its maker as a key; an agent key to the team", async () => {
    const { agentId, teamId } = await agentOf();
    const maker = crypto.randomUUID();
    const personal = await issued(agentId, {
      kind: "key",
      keyKind: "personal",
      createdByUserId: maker,
    });
    expect(await callOf(personal.callId)).toMatchObject({
      rootKind: "key",
      requesterUserId: maker,
    });
    expect(await accountOf(maker)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
    const agentKey = await issued(agentId, {
      kind: "key",
      keyKind: "agent",
      createdByUserId: null,
    });
    expect(await callOf(agentKey.callId)).toMatchObject({
      rootKind: "key",
      requesterUserId: null,
    });
    expect(await accountOf(teamId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
  });

  test("an unknown or deleted agent, or a connection that serves no Messages, gets nothing", async () => {
    expect(
      await issue(crypto.randomUUID(), person(crypto.randomUUID())),
    ).toEqual({ outcome: "unknown_agent" });
    const { agentId } = await agentOf();
    expect(
      await issue(agentId, person(crypto.randomUUID()), "conn-responses"),
    ).toEqual({ outcome: "unavailable" });
    expect(
      await issue(agentId, person(crypto.randomUUID()), "conn-gone"),
    ).toEqual({ outcome: "unavailable" });
    await db
      .update(agents)
      .set({ status: "archived", deletedAt: new Date(), deletedBy: agentId })
      .where(eq(agents.id, agentId));
    expect(await issue(agentId, person(crypto.randomUUID()))).toEqual({
      outcome: "unknown_agent",
    });
    expect(await db.select().from(budgetReservations)).toEqual([]);
  });
});

describe("a conversation call's token running out", () => {
  const expire = (callId: string) =>
    db
      .update(conversationCalls)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(conversationCalls.id, callId as never));

  test("an unused token's reservation is released, and the token refused", async () => {
    const { agentId } = await agentOf();
    const userId = crypto.randomUUID();
    const call = await issued(agentId, person(userId));
    await expire(call.callId);
    expect(await store().releaseExpired({ limit: 10, dryRun: true })).toEqual({
      released: 1,
    });
    expect((await callOf(call.callId))?.state).toBe("reserved");
    expect(await store().releaseExpired({ limit: 10, dryRun: false })).toEqual({
      released: 1,
    });
    expect((await callOf(call.callId))?.state).toBe("released");
    expect((await reservationOf(call.callId))?.state).toBe("released");
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: 0,
      spentTokens: 0,
    });
    expect((await grant(call.token, crypto.randomUUID())).outcome).toBe(
      "invalid_token",
    );
    expect(await store().releaseExpired({ limit: 10, dryRun: false })).toEqual({
      released: 0,
    });
  });

  test("a call in flight past its token is not released, refuses a regrant, and still settles", async () => {
    const { agentId } = await agentOf();
    const userId = crypto.randomUUID();
    const call = await issued(agentId, person(userId));
    const exchange = crypto.randomUUID();
    await grant(call.token, exchange);
    await expire(call.callId);
    expect(await store().releaseExpired({ limit: 10, dryRun: false })).toEqual({
      released: 0,
    });
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
    expect((await grant(call.token, exchange)).outcome).toBe("invalid_token");
    expect((await settle(call.callId, exchange)).outcome).toBe("settled");
  });

  test("a token not used in time is refused even before the release", async () => {
    const { agentId } = await agentOf();
    const call = await issued(agentId, person(crypto.randomUUID()));
    await expire(call.callId);
    expect((await grant(call.token, crypto.randomUUID())).outcome).toBe(
      "invalid_token",
    );
  });
});

test("no use goes missing: the calls' settled sum is the account's spend", async () => {
  const { agentId } = await agentOf();
  const userId = crypto.randomUUID();
  const used = [10, 20, 30].map((outputTokens) => ({ ...USED, outputTokens }));
  for (const usage of used) {
    const call = await issued(agentId, person(userId));
    const exchange = crypto.randomUUID();
    await grant(call.token, exchange);
    await settle(call.callId, exchange, usage);
  }
  // One released, one still in flight: neither spends.
  await issued(agentId, person(userId));
  const flying = await issued(agentId, person(userId));
  await grant(flying.token, crypto.randomUUID());
  await db
    .update(conversationCalls)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(conversationCalls.state, "reserved"));
  await store().releaseExpired({ limit: 10, dryRun: false });

  const [sums] = await db
    .select({
      cost: sql<string>`sum(${conversationCalls.costUsd})`,
      tokens: sql<string>`sum(${conversationCalls.tokens})`,
    })
    .from(conversationCalls);
  const account = await accountOf(userId);
  expect(Number(sums?.cost)).toBeCloseTo(account?.spentCostUsd ?? -1, 6);
  expect(Number(sums?.tokens)).toBe(account?.spentTokens ?? -1);
  expect(account?.spentTokens).toBe(
    used.reduce((total, usage) => total + reservationTokens(usage), 0),
  );
  expect(account?.reservedTokens).toBe(RESERVE.tokens);
});
