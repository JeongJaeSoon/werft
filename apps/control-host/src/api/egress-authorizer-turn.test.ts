import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationTopicId,
  type ConversationTurnId,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresConversationCalls,
  createPostgresWorkerUnitOfWork,
  saveBudgetLimit,
} from "@werft-ai/db";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  type BudgetRoot,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  conversationCallReserve,
  createConversationCalls,
  createWorkerGateway,
  hashConversationCallToken,
} from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { TEST_MODEL, testCatalog } from "../testing/catalog.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_EXCHANGE_ID_HEADER,
  EGRESS_USAGE_PATH,
} from "./egress-authorizer.ts";

/**
 * A conversation turn's provider calls as the proxy asks for them: each one
 * reserved on the turn's account through the authorizer, the gateway and the
 * store over a migrated database.
 */

// Built here so no literal reads as a credential.
const BEARER = ["conversation", "turn", "authorizer", "bearer"].join("-");
const WORKSPACE = "00000000-0000-4000-8000-0000000000c4";
const MODEL = TEST_MODEL;
const LIMITS = { model: MODEL, maxTokens: 128, maxRequestBytes: 2_048 };
const RESERVE = conversationCallReserve(LIMITS);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let authorize: (request: Request) => Promise<Response>;
let store: ReturnType<typeof createPostgresConversationCalls>;
let calls: ReturnType<typeof createConversationCalls>;
let logs: MemoryLogSink;
let teamId: string;
let agentId: string;
let conversationId: string;
let connectionId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  // The agent, its team and its topics alone; their other rows are not under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema });
  const catalog = testCatalog({
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "catalog-provider-key",
        ref: { stored: "connection:test-connection" },
      },
    },
    repositories: {},
  });
  connectionId = Object.keys(catalog.connections)[0] ?? "";
  store = createPostgresConversationCalls(db as never);
  logs = new MemoryLogSink();
  authorize = createEgressAuthorizer({
    gateway: createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: acceptAllCheckpoints,
      conversationCalls: { store },
      options: {
        sessionBudget: { costUsd: 1_000, tokens: null },
        leaseTtlMs: 60_000,
      },
    }),
    logger: createLogger({ sinks: [logs] }),
    token: BEARER,
  });
  calls = createConversationCalls({ store, catalog });
  teamId = crypto.randomUUID();
  agentId = crypto.randomUUID();
  await db
    .insert(schema.memberTeams)
    .values({ id: teamId, workspaceId: WORKSPACE, name: "team" });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: "agent",
    name: "agent",
  });
  conversationId = crypto.randomUUID();
  await db.insert(schema.conversations).values({
    id: conversationId,
    workspaceId: WORKSPACE,
    agentId,
    kind: "channel",
    teamId: "T0TURNS",
    channelId: "C0TURNS",
  });
});

afterEach(async () => {
  await client.close();
});

async function newTopic(): Promise<ConversationTopicId> {
  const id = conversationTopicIdSchema.parse(crypto.randomUUID());
  await db.insert(schema.conversationTopics).values({
    id,
    workspaceId: WORKSPACE,
    agentId,
    conversationId,
    conversationKind: "channel",
    slackTeamId: "T0TURNS",
    slackChannelId: "C0TURNS",
    slackThreadTs: `${Date.now()}.${Math.floor(Math.random() * 1e6)}`,
  });
  return id;
}

/** An operator's turn on a topic of its own unless one is named. */
async function operatorTurn(topicId?: ConversationTopicId) {
  const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
  const issued = await calls.issueOperatorTurn({
    workspaceId: WORKSPACE,
    agentId,
    conversationId: conversationIdSchema.parse(conversationId),
    topicId: topicId ?? (await newTopic()),
    turnId,
    operator: "ops@api-host",
    releaseId: null,
    connectionId,
    ...LIMITS,
    ttlMs: 180_000,
  });
  if (issued.outcome !== "issued") throw new Error(issued.outcome);
  return { turnId, token: issued.token };
}

/** A turn whose root is `root`, written the way a product path would. */
async function rootedTurn(root: BudgetRoot, topicId?: ConversationTopicId) {
  const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
  const token = [
    CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
    crypto.randomUUID(),
  ].join("");
  const issued = await store.issueTurnPermitAtomic({
    turnId,
    tokenHash: hashConversationCallToken(token),
    workspaceId: WORKSPACE,
    agentId,
    conversationId: conversationIdSchema.parse(conversationId),
    topicId: topicId ?? (await newTopic()),
    requester:
      root.kind === "user"
        ? { kind: "user", id: root.userId }
        : { kind: "slack_bot", id: "B0BOT" },
    releaseId: null,
    root,
    connectionId,
    path: "/v1/messages",
    ...LIMITS,
    callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
    ttlMs: 180_000,
  });
  if (issued.outcome !== "issued") throw new Error(issued.outcome);
  return { turnId, token };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return authorize(
    new Request(`http://authorizer.invalid${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const providerAsk = (token: string, exchangeId: string) =>
  post(
    EGRESS_AUTHORIZER_PATH,
    { token, purpose: "provider" },
    { [EGRESS_EXCHANGE_ID_HEADER]: exchangeId },
  );

/** A call the proxy was granted: its exchange and the call id it reports on. */
async function granted(token: string) {
  const exchange = crypto.randomUUID();
  const response = await providerAsk(token, exchange);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { conversation_call_id: string };
  return { exchange, callId: body.conversation_call_id };
}

const usage = {
  model: MODEL,
  input_tokens: 700,
  output_tokens: 12,
  cache_creation_input_tokens: 0,
  cache_creation_1h_input_tokens: 0,
  cache_read_input_tokens: 0,
  estimated: false,
};

const report = (call: { exchange: string; callId: string }) =>
  post(EGRESS_USAGE_PATH, {
    exchange_id: call.exchange,
    conversation_call_id: call.callId,
    usage,
  });

const callsOf = (turnId: ConversationTurnId) =>
  db
    .select()
    .from(schema.conversationCalls)
    .where(eq(schema.conversationCalls.conversationTurnId, turnId))
    .orderBy(schema.conversationCalls.attempt);

const permitOf = async (turnId: ConversationTurnId) =>
  (
    await db
      .select()
      .from(schema.conversationTurnPermits)
      .where(eq(schema.conversationTurnPermits.turnId, turnId))
  )[0];

const refusals = () =>
  logs.records.filter(
    (record) => record.message === "Conversation turn call refused",
  );

describe("a conversation turn's provider calls", () => {
  test("three calls of one turn are three ledger rows of the turn, each reserved and settled on its own", async () => {
    const turn = await operatorTurn();
    const settled: string[] = [];
    for (let n = 0; n < 3; n++) {
      const call = await granted(turn.token);
      // The proxy's regrant of the same exchange is the same call.
      const again = await providerAsk(turn.token, call.exchange);
      expect(
        ((await again.json()) as { conversation_call_id: string })
          .conversation_call_id,
      ).toBe(call.callId);
      expect((await report(call)).status).toBe(200);
      settled.push(call.callId);
    }

    const rows = await callsOf(turn.turnId);
    expect(rows.map((row): string => row.id)).toEqual(settled);
    expect(new Set(settled).size).toBe(3);
    for (const [n, row] of rows.entries()) {
      expect(row).toMatchObject({
        state: "settled",
        callClass: "m2",
        conversationTurnId: turn.turnId,
        callKey: `operator-${turn.turnId}:m2`,
        attempt: n + 1,
        rootKind: "key",
        requesterUserId: null,
        model: MODEL,
        maxTokens: LIMITS.maxTokens,
        maxRequestBytes: LIMITS.maxRequestBytes,
      });
      expect(row.costUsd).toBeGreaterThan(0);
    }
    const reservations = await db
      .select()
      .from(schema.budgetReservations)
      .where(
        sql`${schema.budgetReservations.callId} IN (${sql.join(
          settled.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    expect(reservations.map((row) => row.state)).toEqual([
      "settled",
      "settled",
      "settled",
    ]);
    expect((await permitOf(turn.turnId))?.calls).toBe(3);
    // The turn's row is an m2 turn its operator requested.
    const [row] = await db
      .select()
      .from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, turn.turnId));
    expect(row).toMatchObject({
      origin: "m2",
      state: "running",
      requesterKind: "operator",
      requesterId: "ops@api-host",
    });
  });

  test("a call the turn's account cannot hold is refused with nothing held, and the turn ends on that refusal", async () => {
    // Room for one call and not two.
    await saveBudgetLimit(
      db as never,
      WORKSPACE,
      { kind: "team", teamId },
      { costUsd: null, tokens: Math.floor(RESERVE.tokens * 1.5) },
    );
    const turn = await operatorTurn();
    await granted(turn.token);
    // Another turn of the agent, on a topic of its own: only the account stops it.
    const second = await operatorTurn();
    const refused = await providerAsk(second.token, crypto.randomUUID());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(await callsOf(second.turnId)).toEqual([]);
    expect(await permitOf(second.turnId)).toMatchObject({
      refusal: "budget",
      calls: 0,
    });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.fields).toMatchObject({
      turn_id: second.turnId,
      refused_by: "budget",
      budget_root_kind: "key",
    });

    expect(await calls.endTurn(second.turnId)).toEqual({
      ended: "recorded",
      refusal: "budget",
    });
    const [row] = await db
      .select()
      .from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, second.turnId));
    expect(row?.state).toBe("no_decision");
    expect(row?.endedAt).not.toBeNull();
  });

  test("a call that never finishes stays of unknown end and keeps its reservation", async () => {
    const turn = await operatorTurn();
    const call = await granted(turn.token);
    await db
      .update(schema.conversationCalls)
      .set({ startedAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.conversationCalls.id, call.callId as never));

    expect(await store.markUnknown({ limit: 10, dryRun: false })).toEqual({
      unknown: 1,
    });
    // Nothing releases it, the reconciler's release included.
    expect(await store.releaseExpired({ limit: 10, dryRun: false })).toEqual({
      released: 0,
    });
    const [row] = await callsOf(turn.turnId);
    expect(row?.state).toBe("in_flight");
    expect(row?.unknownAt).not.toBeNull();
    const [reservation] = await db
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.callId, call.callId));
    expect(reservation?.state).toBe("reserved");
    expect(reservation?.unknownAt).not.toBeNull();
    // A late report settles it at what it says.
    expect((await report(call)).status).toBe(200);
    expect((await callsOf(turn.turnId))[0]?.state).toBe("settled");
  });

  test("a turn a person asked for is charged to that person, one with no person to the agent's team", async () => {
    const userId = crypto.randomUUID();
    const person = await rootedTurn({ kind: "user", userId });
    const bot = await rootedTurn({ kind: "slack_bot" });
    const operator = await operatorTurn();
    const accountOf = async (callId: string) => {
      const [row] = await db
        .select({
          ownerKind: schema.budgetAccounts.ownerKind,
          ownerId: schema.budgetAccounts.ownerId,
        })
        .from(schema.budgetReservations)
        .innerJoin(
          schema.budgetAccounts,
          eq(schema.budgetAccounts.id, schema.budgetReservations.accountId),
        )
        .where(eq(schema.budgetReservations.callId, callId));
      return row;
    };

    const personCall = await granted(person.token);
    const botCall = await granted(bot.token);
    const operatorCall = await granted(operator.token);

    expect(await accountOf(personCall.callId)).toEqual({
      ownerKind: "user",
      ownerId: userId,
    });
    expect(await accountOf(botCall.callId)).toEqual({
      ownerKind: "team",
      ownerId: teamId,
    });
    expect(await accountOf(operatorCall.callId)).toEqual({
      ownerKind: "team",
      ownerId: teamId,
    });
    expect((await callsOf(person.turnId))[0]).toMatchObject({
      rootKind: "user",
      requesterUserId: userId,
    });
    expect((await callsOf(bot.turnId))[0]).toMatchObject({
      rootKind: "slack_bot",
      requesterUserId: null,
    });
    expect((await callsOf(operator.turnId))[0]).toMatchObject({
      rootKind: "key",
      requesterUserId: null,
    });
  });

  test("the provider route without a live permit is refused, and so is an ended turn's", async () => {
    const unknown = [
      CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
      crypto.randomUUID(),
    ].join("");
    expect((await providerAsk(unknown, crypto.randomUUID())).status).toBe(401);

    const turn = await operatorTurn();
    const call = await granted(turn.token);
    // Another call's exchange is not this turn's to take.
    const other = await operatorTurn();
    expect((await providerAsk(other.token, call.exchange)).status).toBe(401);
    expect((await report(call)).status).toBe(200);
    expect((await calls.endTurn(turn.turnId)).ended).toBe("recorded");
    expect((await providerAsk(turn.token, crypto.randomUUID())).status).toBe(
      401,
    );
    // An expired permit, its turn still running.
    const late = await operatorTurn();
    await db
      .update(schema.conversationTurnPermits)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.conversationTurnPermits.turnId, late.turnId));
    expect((await providerAsk(late.token, crypto.randomUUID())).status).toBe(
      401,
    );
    expect(await callsOf(turn.turnId)).toHaveLength(1);
    expect(await callsOf(late.turnId)).toEqual([]);
  });

  test("the call limits hold at the proxy's ask: one call at a time on a topic, four at a time for a person", async () => {
    const topic = await newTopic();
    const first = await operatorTurn(topic);
    const beside = await operatorTurn(topic);
    await granted(first.token);
    // The turn counts once: its next call need not wait for the last to settle.
    await granted(first.token);
    const limited = await providerAsk(beside.token, crypto.randomUUID());
    expect(limited.status).toBe(403);
    expect(await limited.json()).toMatchObject({
      details: { reason_code: "conversation_call_limit_topic" },
    });
    expect(await permitOf(beside.turnId)).toMatchObject({
      refusal: "concurrency",
      calls: 0,
    });

    const userId = crypto.randomUUID();
    const turns = [];
    for (let n = 0; n < 5; n++) {
      turns.push(await rootedTurn({ kind: "user", userId }));
    }
    for (const turn of turns.slice(0, 4)) await granted(turn.token);
    const fifth = await providerAsk(turns[4]?.token ?? "", crypto.randomUUID());
    expect(fifth.status).toBe(403);
    expect(await fifth.json()).toMatchObject({
      details: { reason_code: "conversation_call_limit_requester" },
    });
    expect(
      refusals().map((record) => [
        record.fields?.turn_id,
        record.fields?.limit,
      ]),
    ).toEqual([
      [beside.turnId, "topic"],
      [turns[4]?.turnId, "requester"],
    ]);
    const open = await db
      .select({ id: schema.conversationCalls.id })
      .from(schema.conversationCalls)
      .where(
        and(
          eq(schema.conversationCalls.requesterUserId, userId),
          eq(schema.conversationCalls.state, "in_flight"),
        ),
      );
    expect(open).toHaveLength(4);
  });
});
