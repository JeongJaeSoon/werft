import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type BudgetAccountId,
  type ConversationCallId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  budgetAccounts,
  budgetAdjustments,
  budgetReservations,
  conversationCalls,
  createPostgresConversationCalls,
  createPostgresWorkerUnitOfWork,
  createProviderExchangeLedger,
  type Database,
  PROVIDER_CALL_MAX_MS,
  providerExchanges,
  reconcileProviderExchanges,
  saveBudgetLimit,
  settleDeadUnknownBudget,
  unknownBudgetByAccount,
} from "@werft-ai/db";
import {
  admitsBudgetReserve,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  conversationCallReserve,
  type HeldSpend,
  hashConversationCallToken,
  type ProviderUsage,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { runDeadUnknownBudgetSettle } from "./budget-unknown.ts";

const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };
const RESERVE = conversationCallReserve(LIMITS);
const CONNECTION = "conn-messages";
const PAST_MAX = `${PROVIDER_CALL_MAX_MS + 60_000} milliseconds`;

function usage(inputTokens: number, outputTokens: number): ProviderUsage {
  return {
    model: MODEL,
    inputTokens,
    outputTokens,
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
}

/**
 * The reconciler's settle of reservations of unknown end whose call can no
 * longer run: its turn ended, its lease ran out and PROVIDER_CALL_MAX_MS
 * passed. Any one missing keeps the hold.
 */
describe("reservations of unknown end of an ended turn", () => {
  let pool: PGlite;
  let db: Database;
  let workspaceId: string;
  let teamId: string;
  const TEAM = "T0SETTLE";
  const CHANNEL = "C0SETTLE";
  let thread = 0;

  beforeAll(async () => {
    pool = await migratedPGlite();
    db = drizzle(pool, { schema }) as unknown as Database;
    workspaceId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Settle')",
      [workspaceId, `ws-${workspaceId}`],
    );
    teamId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, 'team')",
      [teamId, workspaceId],
    );
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), workspaceId, TEAM, CHANNEL],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.close();
  });

  const settle = () =>
    settleDeadUnknownBudget(db, { limit: 1_000, dryRun: false });

  const reservationOf = async (callId: string) =>
    (
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.callId, callId))
    )[0];
  const accountById = async (id: BudgetAccountId) =>
    (
      await db.select().from(budgetAccounts).where(eq(budgetAccounts.id, id))
    )[0];
  const receiptsOf = async (callId: string) =>
    (
      await pool.query<{ actor: unknown; result: Record<string, unknown> }>(
        "SELECT actor, result FROM receipts WHERE operation = 'resolve_unknown_budget' AND result->>'call_id' = $1",
        [callId],
      )
    ).rows;
  const unknownIds = async () =>
    (
      await pool.query<{ call_id: string }>(
        "SELECT call_id FROM budget_reservations WHERE state = 'reserved' AND unknown_at IS NOT NULL",
      )
    ).rows.map((row) => row.call_id);

  /**
   * A session whose attempt ran one turn, and a call of that turn held on a
   * person's account, past its lease with no report and marked unknown. The
   * call was opened past PROVIDER_CALL_MAX_MS unless `recent`.
   */
  async function sessionCall(input: {
    turnStatus: string;
    /** The attempt's turns in order, each started that long ago; by default one turn of `turnStatus` started 3 hours ago. */
    turns?: { status: string; startedAgo: string; endedAgo?: string }[];
    recent?: boolean;
    owner?: { kind: "user"; userId: string } | { kind: "team"; teamId: string };
    rootKind?: "user" | "none";
  }) {
    const sessionId = crypto.randomUUID();
    const attemptId = `att-${crypto.randomUUID()}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(schema.sessions).values({
        id: sessionId,
        ownerId: "owner-budget-settle-it",
        repoUrl: "https://github.com/acme/app.git",
        branch: "main",
        repositoryId: "app",
        checkpointRevision: 1,
        workspaceId,
      });
      await tx.insert(schema.attempts).values({
        id: attemptId,
        sessionId,
        executionId: `exec-${attemptId}`,
        leaseEpoch: 1,
        executionGeneration: 1,
        authRevision: 1,
        state: "lost",
        leaseExpiresAt: new Date("2020-01-01T00:00:00Z"),
      });
      const turns = input.turns ?? [
        { status: input.turnStatus, startedAgo: "3 hours" },
      ];
      for (const [index, turn] of turns.entries()) {
        await tx.insert(schema.turns).values({
          sessionId,
          sequence: index + 1,
          message: "m",
          status: turn.status,
          attemptId,
          startedAt: sql`now() - ${turn.startedAgo}::interval`,
          ...(turn.endedAgo === undefined
            ? {}
            : { endedAt: sql`now() - ${turn.endedAgo}::interval` }),
        });
      }
    });
    const userId = crypto.randomUUID();
    const owner = input.owner ?? { kind: "user", userId };
    const exchangeId = crypto.randomUUID();
    const opened = await createProviderExchangeLedger(db, {
      admits: async () => () => true,
    }).open({
      exchangeId,
      sessionId,
      attemptId,
      reserve: usage(1_000, 100),
      budget: { rootKind: input.rootKind ?? "user", owner },
    });
    expect(opened.outcome).toBe("created");
    await pool.query(
      `UPDATE provider_exchanges SET lease_expires_at = now() - interval '1 minute', opened_at = now() - $2::interval WHERE exchange_id = $1`,
      [exchangeId, input.recent ? "10 minutes" : PAST_MAX],
    );
    await reconcileProviderExchanges(db, { limit: 1_000, dryRun: false });
    const held = await reservationOf(exchangeId);
    if (!held?.accountId) throw new Error("no reservation on an account");
    expect(held.unknownAt).not.toBeNull();
    return { sessionId, attemptId, exchangeId, userId, held };
  }

  test("all three met: settled at what it held, as estimated, with the reconciler's receipt", async () => {
    const call = await sessionCall({ turnStatus: "cancelled" });
    const before = await accountById(call.held.accountId as BudgetAccountId);
    if (!before) throw new Error("no account");
    const lines = await settle();
    expect(lines).toContainEqual({
      callId: call.exchangeId,
      callKind: "session",
      accountId: before.id,
      charged: { costUsd: call.held.costUsd, tokens: call.held.tokens },
      receiptId: expect.any(String),
    });
    expect(await reservationOf(call.exchangeId)).toMatchObject({
      state: "resolved",
      resolution: "estimated",
      settledCostUsd: call.held.costUsd,
      settledTokens: call.held.tokens,
    });
    const after = await accountById(before.id);
    expect(after?.reservedTokens).toBe(
      before.reservedTokens - call.held.tokens,
    );
    expect(after?.spentTokens).toBe(before.spentTokens + call.held.tokens);
    expect(after?.spentCostUsd).toBeCloseTo(
      before.spentCostUsd + call.held.costUsd,
      6,
    );
    const [exchange] = await db
      .select({ releasedAt: providerExchanges.releasedAt })
      .from(providerExchanges)
      .where(eq(providerExchanges.exchangeId, call.exchangeId));
    expect(exchange?.releasedAt).not.toBeNull();
    const [receipt, ...more] = await receiptsOf(call.exchangeId);
    expect(more).toHaveLength(0);
    expect(receipt?.actor).toBeNull();
    expect(receipt?.result).toMatchObject({
      call_kind: "session",
      session_id: call.sessionId,
      resolution: "estimated",
      reason: null,
      run_id: null,
      by: "reconciler",
      held_tokens: call.held.tokens,
      charged_tokens: call.held.tokens,
    });
    // A second pass finds nothing more to settle.
    expect(
      (await settle()).filter((line) => line.callId === call.exchangeId),
    ).toEqual([]);
    expect(await receiptsOf(call.exchangeId)).toHaveLength(1);
  });

  test("a failed turn's call is settled the same way", async () => {
    const call = await sessionCall({ turnStatus: "failed" });
    await settle();
    expect((await reservationOf(call.exchangeId))?.resolution).toBe(
      "estimated",
    );
  });

  test("a turn not ended keeps the hold", async () => {
    const call = await sessionCall({ turnStatus: "outcome_unknown" });
    await settle();
    expect(await reservationOf(call.exchangeId)).toMatchObject({
      state: "reserved",
      resolution: null,
    });
    expect(await unknownIds()).toContain(call.exchangeId);
    expect(await receiptsOf(call.exchangeId)).toHaveLength(0);
  });

  test("a lease not run out keeps the hold", async () => {
    const call = await sessionCall({ turnStatus: "cancelled" });
    // The proxy's renewal moved the lease after the mark.
    await pool.query(
      "UPDATE provider_exchanges SET lease_expires_at = now() + interval '5 minutes' WHERE exchange_id = $1",
      [call.exchangeId],
    );
    await settle();
    expect((await reservationOf(call.exchangeId))?.state).toBe("reserved");
    expect(await receiptsOf(call.exchangeId)).toHaveLength(0);
  });

  test("a call opened within PROVIDER_CALL_MAX_MS keeps the hold", async () => {
    const call = await sessionCall({ turnStatus: "cancelled", recent: true });
    await settle();
    expect((await reservationOf(call.exchangeId))?.state).toBe("reserved");
    expect(await receiptsOf(call.exchangeId)).toHaveLength(0);
  });

  test("a late report after the settle adjusts once and is not counted twice", async () => {
    const call = await sessionCall({ turnStatus: "cancelled" });
    await settle();
    const before = await accountById(call.held.accountId as BudgetAccountId);
    if (!before) throw new Error("no account");
    const report = () =>
      createPostgresWorkerUnitOfWork(db).recordProviderUsageAtomic({
        exchangeId: call.exchangeId,
        sessionId: call.sessionId,
        attemptId: call.attemptId,
        usage: usage(5, 5),
        priceFor: () => ({ costUsd: 0, pricedBy: "table" }),
      });
    await report();
    await report();
    const after = await accountById(before.id);
    // What the settle charged is replaced by what the report says: 10 tokens.
    expect(after?.spentTokens).toBe(before.spentTokens + 10 - call.held.tokens);
    expect(after?.reservedTokens).toBe(before.reservedTokens);
    const adjustments = await db
      .select()
      .from(budgetAdjustments)
      .where(eq(budgetAdjustments.callId, call.exchangeId));
    expect(adjustments).toHaveLength(1);
    expect((await reservationOf(call.exchangeId))?.resolution).toBe(
      "estimated",
    );
  });

  test("a dead turn's hold on a team account leaves the unknown report and the session's limit; the account's total stays", async () => {
    // The agent's own calls (root kind none) stop at 80% of the team's limit.
    const tokens = 10_000_000;
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "team", teamId },
      { costUsd: null, tokens },
    );
    const call = await sessionCall({
      turnStatus: "cancelled",
      owner: { kind: "team", teamId },
      rootKind: "none",
    });
    const accountId = call.held.accountId as BudgetAccountId;
    const before = await accountById(accountId);
    if (!before) throw new Error("no account");
    const reportedBefore = await unknownBudgetByAccount(db, 1_000);
    expect(
      reportedBefore.accounts.find((account) => account.accountId === accountId)
        ?.count,
    ).toBeGreaterThanOrEqual(1);
    const admitsNext = (account: NonNullable<typeof before>) =>
      admitsBudgetReserve({
        rootKind: "none",
        limit: { costUsd: null, tokens },
        held: {
          spent: { costUsd: account.spentCostUsd, tokens: account.spentTokens },
          reserved: {
            costUsd: account.reservedCostUsd,
            tokens: account.reservedTokens,
          },
        },
        reserve: { costUsd: 0, tokens: Math.floor(tokens * 0.8) - 1 },
      });

    await settle();

    const after = await accountById(accountId);
    if (!after) throw new Error("no account");
    expect(after.spentTokens + after.reservedTokens).toBe(
      before.spentTokens + before.reservedTokens,
    );
    expect(after.reservedTokens).toBe(before.reservedTokens - call.held.tokens);
    expect(admitsNext(after)).toBe(admitsNext(before));
    expect(await unknownIds()).not.toContain(call.exchangeId);
    const reportedAfter = await unknownBudgetByAccount(db, 1_000);
    expect(
      reportedAfter.accounts.find((account) => account.accountId === accountId)
        ?.count ?? 0,
    ).toBe(
      (reportedBefore.accounts.find(
        (account) => account.accountId === accountId,
      )?.count ?? 0) - 1,
    );
    // The session's next open no longer sees the call as held.
    let seen: HeldSpend | undefined;
    const next = await createProviderExchangeLedger(db, {
      admits: async () => (held) => {
        seen = held;
        return true;
      },
    }).open({
      exchangeId: crypto.randomUUID(),
      sessionId: call.sessionId,
      attemptId: call.attemptId,
      reserve: usage(10, 10),
    });
    expect(next.outcome).toBe("created");
    expect(JSON.stringify(seen)).not.toContain(call.exchangeId);
    expect(seen).toBeDefined();
  });

  describe("a conversation turn's call", () => {
    const store = () => createPostgresConversationCalls(db);

    async function turnCall(turnState: string, startedAgo = PAST_MAX) {
      const agentId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name) VALUES ($1, $2, $3, $4, 'agent')",
        [agentId, workspaceId, teamId, `agent-${agentId}`],
      );
      const conversationId = conversationIdSchema.parse(crypto.randomUUID());
      await pool.query(
        "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
        [conversationId, workspaceId, agentId, TEAM, CHANNEL],
      );
      const topicId = conversationTopicIdSchema.parse(crypto.randomUUID());
      thread += 1;
      await pool.query(
        "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
        [
          topicId,
          workspaceId,
          agentId,
          conversationId,
          TEAM,
          CHANNEL,
          `400.${String(thread).padStart(6, "0")}`,
        ],
      );
      const userId = crypto.randomUUID();
      const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
      const token = CONVERSATION_TURN_PERMIT_TOKEN_PREFIX + crypto.randomUUID();
      const permit = await store().issueTurnPermitAtomic({
        turnId,
        tokenHash: hashConversationCallToken(token),
        workspaceId,
        agentId,
        conversationId,
        topicId,
        requester: { kind: "user", id: userId },
        releaseId: null,
        root: { kind: "user", userId },
        connectionId: CONNECTION,
        path: "/v1/messages",
        ...LIMITS,
        callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
        ttlMs: 180_000,
      });
      expect(permit.outcome).toBe("issued");
      const callId: ConversationCallId = conversationCallIdSchema.parse(
        crypto.randomUUID(),
      );
      const granted = await store().authorizeTurnCallAtomic({
        tokenHash: hashConversationCallToken(token),
        exchangeId: crypto.randomUUID(),
        callId,
        reserveFor: () => ({
          reserve: RESERVE,
          unmetered: false,
          pricedBy: "table",
        }),
        unknownPriceTokenLimit: 5_000_000,
      });
      expect(granted.outcome).toBe("ok");
      await pool.query(
        "UPDATE conversation_calls SET started_at = now() - $2::interval WHERE id = $1",
        [callId, startedAgo],
      );
      await store().markUnknown({ limit: 1_000, dryRun: false });
      await pool.query(
        "UPDATE conversation_turns SET state = $2, ended_at = CASE WHEN $2 = 'running' THEN NULL ELSE now() END WHERE id = $1",
        [turnId, turnState],
      );
      expect((await reservationOf(callId))?.unknownAt).not.toBeNull();
      return { callId, turnId };
    }

    const callState = async (callId: ConversationCallId) =>
      (
        await db
          .select({ state: conversationCalls.state })
          .from(conversationCalls)
          .where(eq(conversationCalls.id, callId))
      )[0]?.state;

    test("an ended turn's call is settled as estimated and stops counting as in progress", async () => {
      const call = await turnCall("no_decision");
      await settle();
      expect(await reservationOf(call.callId)).toMatchObject({
        state: "resolved",
        resolution: "estimated",
        settledTokens: RESERVE.tokens,
      });
      expect(await callState(call.callId)).toBe("resolved");
      const [receipt] = await receiptsOf(call.callId);
      expect(receipt?.result).toMatchObject({
        call_kind: "conversation",
        conversation_turn_id: call.turnId,
        resolution: "estimated",
        by: "reconciler",
      });
    });

    test("a running turn's call, or one started within PROVIDER_CALL_MAX_MS, keeps the hold", async () => {
      const running = await turnCall("running");
      const recent = await turnCall("no_decision", "10 minutes");
      await settle();
      for (const call of [running, recent]) {
        expect((await reservationOf(call.callId))?.state).toBe("reserved");
        expect(await callState(call.callId)).toBe("in_flight");
      }
    });
  });

  test("a turn that started well after the call's open is not its turn", async () => {
    // Opened about 61 minutes ago, during the cancelled turn; the completed
    // turn started half an hour later.
    const call = await sessionCall({
      turnStatus: "cancelled",
      turns: [
        { status: "cancelled", startedAgo: "3 hours" },
        {
          status: "completed",
          startedAgo: "30 minutes",
          endedAgo: "20 minutes",
        },
      ],
    });
    await settle();
    expect((await reservationOf(call.exchangeId))?.resolution).toBe(
      "estimated",
    );
  });

  test("an earlier ended turn does not settle a call of a later turn still open", async () => {
    // Opened about 61 minutes ago, during the running turn.
    const call = await sessionCall({
      turnStatus: "running",
      turns: [
        { status: "failed", startedAgo: "3 hours" },
        { status: "running", startedAgo: "2 hours" },
      ],
    });
    await settle();
    expect((await reservationOf(call.exchangeId))?.state).toBe("reserved");
    expect(await receiptsOf(call.exchangeId)).toHaveLength(0);
  });

  test("a later turn's clock ahead of the database's does not hand its call to an ended turn", async () => {
    // The running turn's start, by the API's clock, reads a minute after the
    // call opened (about 61 minutes ago); the call is the running turn's.
    const call = await sessionCall({
      turnStatus: "running",
      turns: [
        { status: "failed", startedAgo: "3 hours", endedAgo: "62 minutes" },
        { status: "running", startedAgo: "60 minutes" },
      ],
    });
    await settle();
    expect((await reservationOf(call.exchangeId))?.state).toBe("reserved");
  });

  test("a call near the end of one turn and the start of the next waits unless both ended without completing", async () => {
    const turns = (second: string) => [
      { status: "cancelled", startedAgo: "3 hours", endedAgo: "62 minutes" },
      { status: second, startedAgo: "60 minutes", endedAgo: "50 minutes" },
    ];
    const completed = await sessionCall({
      turnStatus: "cancelled",
      turns: turns("completed"),
    });
    const failed = await sessionCall({
      turnStatus: "cancelled",
      turns: turns("failed"),
    });
    await settle();
    expect((await reservationOf(completed.exchangeId))?.state).toBe("reserved");
    expect((await reservationOf(failed.exchangeId))?.resolution).toBe(
      "estimated",
    );
  });

  test("a batch's later failure leaves the committed settle and its callback", async () => {
    const first = await sessionCall({ turnStatus: "cancelled" });
    const second = await sessionCall({ turnStatus: "cancelled" });
    await pool.query(
      "UPDATE budget_reservations SET unknown_at = unknown_at + interval '1 second' WHERE call_id = $1",
      [second.exchangeId],
    );
    await pool.query(`CREATE FUNCTION refuse_settle() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
    await pool.query(
      `CREATE TRIGGER refuse_settle BEFORE UPDATE ON budget_reservations FOR EACH ROW WHEN (OLD.call_id = '${second.exchangeId}') EXECUTE FUNCTION refuse_settle()`,
    );
    const seen: string[] = [];
    try {
      await expect(
        settleDeadUnknownBudget(db, {
          limit: 1_000,
          dryRun: false,
          onSettled: (line) => void seen.push(line.callId),
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query("DROP TRIGGER refuse_settle ON budget_reservations");
      await pool.query("DROP FUNCTION refuse_settle()");
    }
    expect(seen).toContain(first.exchangeId);
    expect(seen).not.toContain(second.exchangeId);
    expect((await reservationOf(first.exchangeId))?.resolution).toBe(
      "estimated",
    );
    expect((await reservationOf(second.exchangeId))?.state).toBe("reserved");
    await settle();
    expect((await reservationOf(second.exchangeId))?.resolution).toBe(
      "estimated",
    );
  });

  test("a settle is logged as it commits, even when a later one of the batch fails", async () => {
    const records: unknown[] = [];
    const committed = {
      callId: "call-committed",
      callKind: "session" as const,
      accountId: null,
      charged: { costUsd: 1, tokens: 1 },
      receiptId: "receipt-1",
    };
    await expect(
      runDeadUnknownBudgetSettle({
        environment: { RECONCILER_BATCH_SIZE: "10" },
        logger: {
          info: () => {},
          warn: (_message, fields) => void records.push(fields),
        },
        settle: async ({ onSettled }) => {
          onSettled(committed);
          throw new Error("the second call failed");
        },
      }),
    ).rejects.toThrow("the second call failed");
    expect(records).toEqual([
      expect.objectContaining({ call_id: "call-committed", dry_run: false }),
    ]);
  });

  test("the reconciler's pass logs each settle; a dry run logs it and changes nothing", async () => {
    const call = await sessionCall({ turnStatus: "cancelled" });
    const records: { message: string; fields: unknown }[] = [];
    const logger = {
      info: () => {},
      warn: (message: string, fields?: Record<string, unknown>) =>
        void records.push({ message, fields }),
    };
    const dry = await runDeadUnknownBudgetSettle({
      environment: { RECONCILER_BATCH_SIZE: "1000", RECONCILER_DRY_RUN: "1" },
      logger,
      settle: (options) => settleDeadUnknownBudget(db, options),
    });
    expect(dry.map((line) => line.callId)).toContain(call.exchangeId);
    expect((await reservationOf(call.exchangeId))?.state).toBe("reserved");
    expect(await receiptsOf(call.exchangeId)).toHaveLength(0);
    await runDeadUnknownBudgetSettle({
      environment: { RECONCILER_BATCH_SIZE: "1000" },
      logger,
      settle: (options) => settleDeadUnknownBudget(db, options),
    });
    expect((await reservationOf(call.exchangeId))?.resolution).toBe(
      "estimated",
    );
    const logged = records.filter(
      (record) =>
        (record.fields as { call_id?: string }).call_id === call.exchangeId,
    );
    expect(logged.map((record) => record.message)).toEqual([
      "Budget reservation of unknown end settled as estimated",
      "Budget reservation of unknown end settled as estimated",
    ]);
    expect(logged[0]?.fields).toMatchObject({
      dry_run: true,
      receipt_id: null,
    });
    expect(logged[1]?.fields).toMatchObject({
      dry_run: false,
      call_kind: "session",
      receipt_id: expect.any(String),
    });
  });
});
