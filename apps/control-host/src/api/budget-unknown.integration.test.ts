import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConversationCallId,
  type ConversationId,
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
  providerExchanges,
  reconcileProviderExchanges,
  saveBudgetLimit,
  unknownBudgetByAccount,
} from "@werft-ai/db";
import {
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
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
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runUnknownBudgetReport } from "../reconciler/budget-unknown.ts";
import { runBudgetUnknown } from "./budget-unknown.ts";

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
// Less and more than a call reserves (RESERVE), in tokens and in cost.
const SMALL = { usage: usage(100, 10), costUsd: 0.0001 };
const LARGE = { usage: usage(10_000, 1_000), costUsd: 1 };

integration("the operator's resolve of reservations of unknown end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  let workspaceId: string;
  let teamId: string;
  let adminId: string;
  const ADMIN = "budget-admin@example.com";
  const MEMBER = "budget-member@example.com";
  const TEAM = "T0UNKNOWN";
  const CHANNEL = "C0UNKNOWN";
  let thread = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "budget_unknown_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema }) as unknown as Database;
    workspaceId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Unknown')",
      [workspaceId, `ws-${workspaceId}`],
    );
    teamId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, 'team')",
      [teamId, workspaceId],
    );
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "team", teamId },
      { costUsd: null, tokens: RESERVE.tokens * 1_000 },
    );
    adminId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    for (const [id, email, role] of [
      [adminId, ADMIN, "admin"],
      [memberId, MEMBER, "member"],
    ] as const) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, email],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [workspaceId, id, role],
      );
    }
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), workspaceId, TEAM, CHANNEL],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function command(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runBudgetUnknown(argv, {
      env: { DATABASE_URL: "postgres://unused" },
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
      openDatabase: async () => ({ db, close: async () => {} }),
    });
    const [line] = out;
    return {
      exit,
      err,
      line: (line === undefined ? null : JSON.parse(line)) as Record<
        string,
        // biome-ignore lint/suspicious/noExplicitAny: the command's JSON line
        any
      > | null,
    };
  }

  async function newAgent() {
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
    return { agentId, conversationId };
  }

  const store = () => createPostgresConversationCalls(db);
  const issue = (
    agent: { agentId: string; conversationId: ConversationId },
    userId: string,
  ) =>
    createConversationCalls({ store: store(), catalog }).issue({
      workspaceId,
      agentId: agent.agentId,
      conversationId: agent.conversationId,
      topicId: null,
      callClass: "m2",
      releaseId: null,
      callKey: conversationCallKeySchema.parse(`${crypto.randomUUID()}:m2`),
      attempt: 1,
      root: { kind: "user", userId },
      connectionId: CONNECTION,
      ...LIMITS,
    });

  // Issued, used by the proxy, and past the lease with no report: marked.
  async function unknownCall(
    agent: { agentId: string; conversationId: ConversationId },
    userId: string,
  ): Promise<{ callId: ConversationCallId; exchangeId: string }> {
    const issued = await issue(agent, userId);
    if (issued.outcome !== "issued") throw new Error(issued.outcome);
    const exchangeId = crypto.randomUUID();
    const granted = await store().authorizeAtomic({
      tokenHash: hashConversationCallToken(issued.token),
      exchangeId,
    });
    if (granted.outcome !== "ok") throw new Error(granted.outcome);
    await pool.query(
      "UPDATE conversation_calls SET started_at = now() - interval '1 day' WHERE id = $1",
      [issued.callId],
    );
    await store().markUnknown({ limit: 1_000, dryRun: false });
    return { callId: issued.callId, exchangeId };
  }

  const report = (
    call: { callId: ConversationCallId; exchangeId: string },
    late: { usage: ProviderUsage; costUsd: number },
  ) =>
    store().settleAtomic({
      callId: call.callId,
      exchangeId: call.exchangeId,
      usage: late.usage,
      priceFor: () => ({ costUsd: late.costUsd }),
    });

  const accountOf = async (ownerId: string) => {
    const [row] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.ownerId, ownerId));
    if (!row) throw new Error("no account");
    return row;
  };
  const reservationOf = async (callId: string) =>
    (
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.callId, callId))
    )[0];
  const adjustmentsOf = (callId: string) =>
    db
      .select()
      .from(budgetAdjustments)
      .where(eq(budgetAdjustments.callId, callId));
  const receiptOf = async (callId: string) =>
    (
      await pool.query(
        "SELECT *, xmin::text AS xid FROM receipts WHERE operation = 'resolve_unknown_budget' AND result->>'call_id' = $1",
        [callId],
      )
    ).rows;

  test("list says what the reconciler logs: per account and the total", async () => {
    const agent = await newAgent();
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    await unknownCall(agent, a);
    await unknownCall(agent, a);
    await unknownCall(agent, b);
    const records: { level: string; message: string; fields: unknown }[] = [];
    await runUnknownBudgetReport({
      environment: { RECONCILER_BATCH_SIZE: "100" },
      logger: {
        info: (message, fields) =>
          void records.push({ level: "info", message, fields }),
        warn: (message, fields) =>
          void records.push({ level: "warn", message, fields }),
      },
      unknownByAccount: (limit) => unknownBudgetByAccount(db, limit),
    });
    const listed = await command("list", "--limit", "100");
    expect(listed.exit).toBe(0);
    const line = listed.line;
    if (line === null) throw new Error("no output");
    const logged = records
      .filter((record) => record.level === "warn")
      .map((record) => record.fields);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: the command's JSON line
      line.accounts.map((account: any) => ({
        account_id: account.account_id,
        owner_kind: account.owner_kind,
        owner_id: account.owner_id,
        unknown_count: account.unknown_count,
        held_cost_usd: account.held_cost_usd,
        held_tokens: account.held_tokens,
      })),
    ).toEqual(logged);
    const total = records.find((record) => record.level === "info")
      ?.fields as Record<string, unknown>;
    expect(line.total).toEqual({
      account_count: total.account_count,
      unknown_count: total.unknown_count,
      held_cost_usd: total.held_cost_usd,
      held_tokens: total.held_tokens,
    });
    const ofA = line.accounts.find(
      // biome-ignore lint/suspicious/noExplicitAny: the command's JSON line
      (account: any) => account.owner_id === a,
    );
    expect(ofA).toMatchObject({
      unknown_count: 2,
      held_tokens: RESERVE.tokens * 2,
    });
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: the command's JSON line
      line.lines.filter((entry: any) => entry.owner_id === a),
    ).toHaveLength(2);
  });

  test("the default resolve charges what it held, takes the hold off, and writes its receipt in the same transaction", async () => {
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    const call = await unknownCall(agent, userId);
    const before = await accountOf(userId);
    const held = await reservationOf(call.callId);
    if (!held) throw new Error("no reservation");
    const done = await command("resolve", "--call", call.callId, "--by", ADMIN);
    expect(done.exit).toBe(0);
    expect(done.line).toMatchObject({
      outcome: "resolved",
      resolution: "spent",
      resolved: 1,
      lines: [
        {
          call_id: call.callId,
          outcome: "resolved",
          call_kind: "conversation",
          held_tokens: RESERVE.tokens,
          charged_tokens: RESERVE.tokens,
        },
      ],
    });
    const after = await accountOf(userId);
    expect(after.reservedTokens).toBe(before.reservedTokens - RESERVE.tokens);
    expect(after.reservedCostUsd).toBeCloseTo(
      before.reservedCostUsd - held.costUsd,
      6,
    );
    expect(after.spentTokens).toBe(before.spentTokens + RESERVE.tokens);
    expect(after.spentCostUsd).toBeCloseTo(
      before.spentCostUsd + held.costUsd,
      6,
    );
    expect(await reservationOf(call.callId)).toMatchObject({
      state: "resolved",
      resolution: "spent",
      settledTokens: RESERVE.tokens,
    });
    const [row] = await db
      .select({ state: conversationCalls.state })
      .from(conversationCalls)
      .where(eq(conversationCalls.id, call.callId));
    expect(row?.state).toBe("resolved");
    const [receipt] = await receiptOf(call.callId);
    expect(receipt).toMatchObject({
      owner_id: workspaceId,
      status: "succeeded",
      target_ref: { user_id: userId, workspace_id: workspaceId },
      actor: { actor_user_id: adminId },
      result: {
        call_kind: "conversation",
        agent_id: agent.agentId,
        resolution: "spent",
        reason: null,
        held_tokens: RESERVE.tokens,
        charged_tokens: RESERVE.tokens,
        by: "operator_cli",
        run_id: done.line?.run_id,
      },
    });
    const xid = await pool.query(
      "SELECT xmin::text AS xid FROM budget_reservations WHERE call_id = $1",
      [call.callId],
    );
    expect(receipt.xid).toBe(xid.rows[0].xid);
  });

  test("--refund needs a reason; with one it gives the hold back and the receipt keeps the reason", async () => {
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    const call = await unknownCall(agent, userId);
    const before = await accountOf(userId);
    const bare = await command(
      "resolve",
      "--call",
      call.callId,
      "--by",
      ADMIN,
      "--refund",
    );
    expect(bare.exit).toBe(2);
    expect(bare.err.join("\n")).toContain("--refund needs --reason");
    expect((await reservationOf(call.callId))?.state).toBe("reserved");
    const done = await command(
      "resolve",
      "--call",
      call.callId,
      "--by",
      ADMIN,
      "--refund",
      "--reason",
      "the provider billed nothing",
    );
    expect(done.exit).toBe(0);
    expect(done.line?.lines[0]).toMatchObject({
      outcome: "resolved",
      charged_cost_usd: 0,
      charged_tokens: 0,
    });
    const after = await accountOf(userId);
    expect(after.reservedTokens).toBe(before.reservedTokens - RESERVE.tokens);
    expect(after.spentTokens).toBe(before.spentTokens);
    expect(after.spentCostUsd).toBeCloseTo(before.spentCostUsd, 6);
    const [receipt] = await receiptOf(call.callId);
    expect(receipt.result).toMatchObject({
      resolution: "refunded",
      reason: "the provider billed nothing",
      charged_tokens: 0,
    });
  });

  test("a dry run writes nothing, a line not of unknown end is left, and a member is refused", async () => {
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    const call = await unknownCall(agent, userId);
    const open = await issue(agent, userId);
    if (open.outcome !== "issued") throw new Error(open.outcome);
    const before = await accountOf(userId);
    const dry = await command(
      "resolve",
      "--call",
      call.callId,
      "--call",
      open.callId,
      "--by",
      ADMIN,
      "--dry-run",
    );
    expect(dry.exit).toBe(0);
    expect(dry.line).toMatchObject({
      outcome: "dry_run",
      run_id: null,
      lines: [
        { call_id: call.callId, outcome: "would_resolve" },
        { call_id: open.callId, outcome: "not_unknown" },
      ],
    });
    expect(await accountOf(userId)).toEqual(before);
    expect((await reservationOf(call.callId))?.state).toBe("reserved");
    expect(await receiptOf(call.callId)).toHaveLength(0);
    const member = await command(
      "resolve",
      "--call",
      call.callId,
      "--by",
      MEMBER,
    );
    expect(member.exit).toBe(4);
    expect(member.line).toEqual({
      outcome: "not_admin",
      workspace_ids: [workspaceId],
    });
    const real = await command("resolve", "--call", open.callId, "--by", ADMIN);
    expect(real.line).toMatchObject({
      outcome: "unchanged",
      lines: [{ call_id: open.callId, outcome: "not_unknown" }],
    });
    expect((await reservationOf(open.callId))?.state).toBe("reserved");
  });

  test("after a resolve the account and the agent take new calls again", async () => {
    // A person's four places held by calls of unknown end.
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    for (let i = 0; i < 4; i++) await unknownCall(agent, userId);
    expect(await issue(agent, userId)).toMatchObject({
      outcome: "concurrency_limited",
      limit: "requester",
      unknown: 4,
    });
    const account = await accountOf(userId);
    const done = await command(
      "resolve",
      "--account",
      account.id,
      "--by",
      ADMIN,
    );
    expect(done.line).toMatchObject({ outcome: "resolved", resolved: 4 });
    expect((await issue(agent, userId)).outcome).toBe("issued");

    // A person's account full of one hold of unknown end.
    const person = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId: person },
      { costUsd: null, tokens: Math.floor(RESERVE.tokens * 1.5) },
    );
    const held = await unknownCall(await newAgent(), person);
    const other = await newAgent();
    expect((await issue(other, person)).outcome).toBe("refused");
    await command(
      "resolve",
      "--call",
      held.callId,
      "--by",
      ADMIN,
      "--refund",
      "--reason",
      "test",
    );
    expect((await issue(other, person)).outcome).toBe("issued");
  });

  test("late reports adjust once, on the call's account, and never reopen it", async () => {
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    const [less, more, refunded] = [
      await unknownCall(agent, userId),
      await unknownCall(agent, userId),
      await unknownCall(agent, userId),
    ];
    const held = await reservationOf(less.callId);
    if (!held) throw new Error("no reservation");
    await command(
      "resolve",
      "--call",
      less.callId,
      "--call",
      more.callId,
      "--by",
      ADMIN,
    );
    await command(
      "resolve",
      "--call",
      refunded.callId,
      "--by",
      ADMIN,
      "--refund",
      "--reason",
      "test",
    );
    const before = await accountOf(userId);
    expect((await report(less, SMALL)).outcome).toBe("settled");
    expect((await report(more, LARGE)).outcome).toBe("settled");
    expect((await report(refunded, SMALL)).outcome).toBe("settled");
    // The same report again, and another, add nothing.
    expect((await report(less, SMALL)).outcome).toBe("already_settled");
    expect((await report(less, LARGE)).outcome).toBe("already_settled");

    const small = reservationTokens(SMALL.usage);
    const large = reservationTokens(LARGE.usage);
    const [ofLess] = await adjustmentsOf(less.callId);
    expect(await adjustmentsOf(less.callId)).toHaveLength(1);
    expect(ofLess).toMatchObject({
      callId: less.callId,
      accountId: before.id,
      reportedTokens: small,
      tokens: small - RESERVE.tokens,
    });
    expect(ofLess?.costUsd).toBeCloseTo(SMALL.costUsd - held.costUsd, 6);
    const [ofMore] = await adjustmentsOf(more.callId);
    expect(ofMore).toMatchObject({ tokens: large - RESERVE.tokens });
    expect(ofMore?.costUsd).toBeCloseTo(LARGE.costUsd - held.costUsd, 6);
    const [ofRefunded] = await adjustmentsOf(refunded.callId);
    expect(ofRefunded).toMatchObject({ tokens: small });
    expect(ofRefunded?.costUsd).toBeCloseTo(SMALL.costUsd, 6);

    const after = await accountOf(userId);
    expect(after.spentTokens).toBe(
      before.spentTokens +
        (small - RESERVE.tokens) +
        (large - RESERVE.tokens) +
        small,
    );
    expect(after.spentCostUsd).toBeCloseTo(
      before.spentCostUsd +
        (SMALL.costUsd - held.costUsd) +
        (LARGE.costUsd - held.costUsd) +
        SMALL.costUsd,
      5,
    );
    expect(after.reservedTokens).toBe(before.reservedTokens);
    for (const call of [less, more, refunded]) {
      expect((await reservationOf(call.callId))?.state).toBe("resolved");
      const [row] = await db
        .select({
          state: conversationCalls.state,
          usage: conversationCalls.usage,
        })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, call.callId));
      expect(row).toEqual({ state: "resolved", usage: null });
    }
  });

  test("a late report after the month turned adjusts the call's own month, not this one", async () => {
    const agent = await newAgent();
    const userId = crypto.randomUUID();
    const call = await unknownCall(agent, userId);
    await command("resolve", "--call", call.callId, "--by", ADMIN);
    const old = await accountOf(userId);
    // The account the call was held on becomes last month's.
    await pool.query(
      "UPDATE budget_accounts SET period_start = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date WHERE id = $1",
      [old.id],
    );
    const fresh = await issue(agent, userId);
    if (fresh.outcome !== "issued") throw new Error(fresh.outcome);
    const current = (
      await db
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.ownerId, userId))
    ).find((row) => row.id !== old.id);
    if (!current) throw new Error("no account this month");
    expect((await report(call, LARGE)).outcome).toBe("settled");
    const [adjustment] = await adjustmentsOf(call.callId);
    expect(adjustment?.accountId).toBe(old.id);
    const [oldAfter] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.id, old.id));
    const [currentAfter] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.id, current.id));
    expect(oldAfter?.spentTokens).toBe(
      old.spentTokens + reservationTokens(LARGE.usage) - RESERVE.tokens,
    );
    expect(currentAfter).toEqual(current);
  });

  test("a call of a conversation turn's permit is resolved the same way", async () => {
    const agent = await newAgent();
    const topicId = conversationTopicIdSchema.parse(crypto.randomUUID());
    thread += 1;
    await pool.query(
      "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
      [
        topicId,
        workspaceId,
        agent.agentId,
        agent.conversationId,
        TEAM,
        CHANNEL,
        `300.${String(thread).padStart(6, "0")}`,
      ],
    );
    const userId = crypto.randomUUID();
    const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
    const token = `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const permit = await store().issueTurnPermitAtomic({
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId,
      agentId: agent.agentId,
      conversationId: agent.conversationId,
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
    const callId = conversationCallIdSchema.parse(crypto.randomUUID());
    const exchangeId = crypto.randomUUID();
    const granted = await store().authorizeTurnCallAtomic({
      tokenHash: hashConversationCallToken(token),
      exchangeId,
      callId,
      reserveFor: () => ({ reserve: RESERVE, unmetered: false }),
    });
    expect(granted.outcome).toBe("ok");
    await pool.query(
      "UPDATE conversation_calls SET started_at = now() - interval '1 day' WHERE id = $1",
      [callId],
    );
    await store().markUnknown({ limit: 1_000, dryRun: false });
    const done = await command("resolve", "--call", callId, "--by", ADMIN);
    expect(done.line?.lines[0]).toMatchObject({
      outcome: "resolved",
      call_kind: "conversation",
    });
    const [receipt] = await receiptOf(callId);
    expect(receipt.result.conversation_turn_id).toBe(turnId);
    expect((await report({ callId, exchangeId }, SMALL)).outcome).toBe(
      "settled",
    );
    expect(await adjustmentsOf(callId)).toHaveLength(1);
  });

  test("a session's call: its exchange row is released, and its late report adjusts", async () => {
    const sessionId = crypto.randomUUID();
    const attemptId = `att-${crypto.randomUUID()}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(schema.sessions).values({
        id: sessionId,
        ownerId: "owner-budget-unknown-it",
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
        state: "running",
        leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
      });
    });
    const userId = crypto.randomUUID();
    const exchangeId = crypto.randomUUID();
    const opened = await createProviderExchangeLedger(db, {
      admits: async () => () => true,
    }).open({
      exchangeId,
      sessionId,
      attemptId,
      reserve: usage(1_000, 100),
      budget: { rootKind: "user", owner: { kind: "user", userId } },
    });
    expect(opened.outcome).toBe("created");
    await pool.query(
      "UPDATE provider_exchanges SET lease_expires_at = now() - interval '1 minute' WHERE exchange_id = $1",
      [exchangeId],
    );
    await reconcileProviderExchanges(db, { limit: 1_000, dryRun: false });
    expect((await reservationOf(exchangeId))?.unknownAt).not.toBeNull();
    const done = await command("resolve", "--call", exchangeId, "--by", ADMIN);
    expect(done.line?.lines[0]).toMatchObject({
      outcome: "resolved",
      call_kind: "session",
    });
    const [exchange] = await db
      .select({ releasedAt: providerExchanges.releasedAt })
      .from(providerExchanges)
      .where(eq(providerExchanges.exchangeId, exchangeId));
    expect(exchange?.releasedAt).not.toBeNull();
    const [receipt] = await receiptOf(exchangeId);
    expect(receipt.result).toMatchObject({
      call_kind: "session",
      session_id: sessionId,
      agent_id: null,
    });
    const before = await accountOf(userId);
    const held = await reservationOf(exchangeId);
    await createPostgresWorkerUnitOfWork(db).recordProviderUsageAtomic({
      exchangeId,
      sessionId,
      attemptId,
      usage: usage(5, 5),
      priceFor: () => ({ costUsd: 0, pricedBy: "table" }),
    });
    const after = await accountOf(userId);
    expect(after.spentTokens).toBe(
      before.spentTokens + 10 - (held?.settledTokens ?? 0),
    );
    expect((await reservationOf(exchangeId))?.state).toBe("resolved");
    expect(await adjustmentsOf(exchangeId)).toHaveLength(1);
  });

  test("receipts name the account's owner: a team's for the agent's own calls", async () => {
    const agent = await newAgent();
    const issued = await createConversationCalls({
      store: store(),
      catalog,
    }).issue({
      workspaceId,
      agentId: agent.agentId,
      conversationId: agent.conversationId,
      topicId: null,
      callClass: "m2",
      releaseId: null,
      callKey: conversationCallKeySchema.parse(`${crypto.randomUUID()}:m2`),
      attempt: 1,
      root: { kind: "none" },
      connectionId: CONNECTION,
      ...LIMITS,
    });
    if (issued.outcome !== "issued") throw new Error(issued.outcome);
    await store().authorizeAtomic({
      tokenHash: hashConversationCallToken(issued.token),
      exchangeId: crypto.randomUUID(),
    });
    await pool.query(
      "UPDATE conversation_calls SET started_at = now() - interval '1 day' WHERE id = $1",
      [issued.callId],
    );
    await store().markUnknown({ limit: 1_000, dryRun: false });
    await command("resolve", "--call", issued.callId, "--by", ADMIN);
    const [receipt] = await receiptOf(issued.callId);
    expect(receipt.target_ref).toEqual({
      resource: { kind: "team", id: teamId },
      workspace_id: workspaceId,
    });
    expect(receipt.result.owner_kind).toBe("team");
  });
});
