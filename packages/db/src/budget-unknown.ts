import { randomUUID } from "node:crypto";
import {
  type BudgetAccountId,
  type BudgetOwnerKind,
  type BudgetUnknownResolution,
  type ConversationCallId,
  conversationCallIdSchema,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { lockBudgetCall } from "./budget-accounts.ts";
import { DB_NOW, fromDbNow } from "./db-clock.ts";
import {
  lockProviderExchange,
  PROVIDER_EXCHANGE_LEASE_MS,
} from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import {
  budgetAccounts,
  budgetReservations,
  conversationCalls,
  conversationTurns,
  providerExchanges,
  receipts,
  turns,
} from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";

/** At most this many reservations are resolved by one run. */
export const UNKNOWN_BUDGET_RESOLVE_MAX = 100;

/** Which ledger a reservation's call is on; unlinked when neither row is left. */
export type UnknownBudgetCallKind = "session" | "conversation" | "unlinked";

/** One reservation whose end is unknown, as the operator command lists it. */
export type UnknownBudgetLine = {
  callId: string;
  callKind: UnknownBudgetCallKind;
  workspaceId: string;
  accountId: BudgetAccountId | null;
  ownerKind: BudgetOwnerKind | null;
  ownerId: string | null;
  periodStart: string | null;
  costUsd: number;
  tokens: number;
  unknownAt: Date;
  createdAt: Date;
  sessionId: string | null;
  agentId: string | null;
  conversationTurnId: string | null;
};

const UUID =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// A conversation call's id is a uuid and a session call's is its exchange id,
// which need not be: the cast is guarded so a text id never reaches it.
const conversationCallOf = sql`${conversationCalls.id} = CASE WHEN ${budgetReservations.callId} ~ ${UUID} THEN ${budgetReservations.callId}::uuid END`;

const unknownHeld = and(
  eq(budgetReservations.state, "reserved"),
  isNotNull(budgetReservations.unknownAt),
);

/**
 * Reservations of unknown end, the oldest mark first, at most `limit`: of one
 * account, or every one.
 */
export async function unknownBudgetLines(
  db: Database,
  input: { accountId?: BudgetAccountId | undefined; limit: number },
): Promise<UnknownBudgetLine[]> {
  const rows = await db
    .select({
      callId: budgetReservations.callId,
      workspaceId: budgetReservations.workspaceId,
      accountId: budgetReservations.accountId,
      ownerKind: budgetAccounts.ownerKind,
      ownerId: budgetAccounts.ownerId,
      periodStart: budgetAccounts.periodStart,
      costUsd: budgetReservations.costUsd,
      tokens: budgetReservations.tokens,
      unknownAt: budgetReservations.unknownAt,
      createdAt: budgetReservations.createdAt,
      sessionId: providerExchanges.sessionId,
      agentId: conversationCalls.agentId,
      conversationTurnId: conversationCalls.conversationTurnId,
      conversation: sql<boolean>`${conversationCalls.id} IS NOT NULL`,
    })
    .from(budgetReservations)
    .leftJoin(
      budgetAccounts,
      eq(budgetAccounts.id, budgetReservations.accountId),
    )
    .leftJoin(
      providerExchanges,
      eq(providerExchanges.exchangeId, budgetReservations.callId),
    )
    .leftJoin(conversationCalls, conversationCallOf)
    .where(
      and(
        unknownHeld,
        input.accountId === undefined
          ? undefined
          : eq(budgetReservations.accountId, input.accountId),
      ),
    )
    .orderBy(budgetReservations.unknownAt, budgetReservations.callId)
    .limit(input.limit);
  return rows.map(({ conversation, ...row }) => ({
    ...row,
    unknownAt: row.unknownAt as Date,
    callKind: conversation
      ? "conversation"
      : row.sessionId !== null
        ? "session"
        : "unlinked",
  }));
}

/** What became of one named reservation. */
export type UnknownBudgetResolveLine =
  | { callId: string; outcome: "not_found" | "not_unknown" }
  | {
      callId: string;
      outcome: "resolved" | "would_resolve";
      callKind: UnknownBudgetCallKind;
      accountId: BudgetAccountId | null;
      held: { costUsd: number; tokens: number };
      charged: { costUsd: number; tokens: number };
      receiptId: string | null;
    };

export type UnknownBudgetResolveResult =
  | { outcome: "not_admin"; workspaceIds: string[] }
  | {
      outcome: "resolved" | "dry_run";
      lines: UnknownBudgetResolveLine[];
      /** The lines a run stopped before: its operator lost the role meanwhile. */
      stoppedAt: string | null;
    };

export type UnknownBudgetResolveInput = {
  callIds: readonly string[];
  /** A live owner or admin of each reservation's workspace, by address. */
  by: string;
  resolution: Exclude<BudgetUnknownResolution, "estimated">;
  /** Required to refund. */
  reason: string | null;
  dryRun: boolean;
  /** Written on each receipt, so one run's are found together. */
  runId: string;
};

async function managerOf(
  db: Database,
  workspaceId: string,
  by: string,
  lock: boolean,
): Promise<string | undefined> {
  // The user row first, as a suspension takes it: re-checked after a
  // membership lock wait, a joined user row is the old snapshot's, so an
  // account disabled meanwhile would read as live.
  if (lock) {
    await db.execute(
      sql`SELECT id FROM users WHERE email = ${by.toLowerCase()} FOR SHARE`,
    );
  }
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT u.id FROM users u
      JOIN memberships m ON m.user_id = u.id
      WHERE u.email = ${by.toLowerCase()}
        AND m.workspace_id = ${workspaceId}::uuid
        AND m.role IN (${sql.join(
          WORKSPACE_MANAGER_ROLES.map((role) => sql`${role}`),
          sql`, `,
        )})
        AND m.disabled_at IS NULL AND u.disabled_at IS NULL
      ${lock ? sql`FOR SHARE OF m` : sql``}`),
  )[0]?.id;
}

class OperatorGone extends Error {}

/**
 * Resolves each named reservation whose end is unknown, in a transaction of
 * its own: spent charges what it held, refunded charges nothing; either way
 * the hold comes off its account and a `resolve_unknown_budget` receipt is
 * written with it. Its call leaves what is in progress: a conversation call
 * becomes `resolved`, a session call's exchange row is released. A line not
 * reserved with an unknown end is left as it is. Refused whole, before any
 * write, when `by` is not a manager of every workspace named.
 */
export async function resolveUnknownBudget(
  db: Database,
  input: UnknownBudgetResolveInput,
): Promise<UnknownBudgetResolveResult> {
  if (input.resolution === "refunded" && !input.reason?.trim()) {
    throw new Error("a refund needs its reason");
  }
  if (input.callIds.length > UNKNOWN_BUDGET_RESOLVE_MAX) {
    throw new Error(`at most ${UNKNOWN_BUDGET_RESOLVE_MAX} reservations a run`);
  }
  const callIds = [...new Set(input.callIds)];
  const found =
    callIds.length === 0
      ? []
      : await db
          .select({
            callId: budgetReservations.callId,
            workspaceId: budgetReservations.workspaceId,
          })
          .from(budgetReservations)
          .where(inArray(budgetReservations.callId, callIds));
  const workspaceIds = [...new Set(found.map((row) => row.workspaceId))].sort();
  const refused: string[] = [];
  for (const workspaceId of workspaceIds) {
    if ((await managerOf(db, workspaceId, input.by, false)) === undefined) {
      refused.push(workspaceId);
    }
  }
  if (refused.length > 0)
    return { outcome: "not_admin", workspaceIds: refused };

  const lines: UnknownBudgetResolveLine[] = [];
  if (input.dryRun) {
    const held = new Map(
      (
        await db
          .select({
            callId: budgetReservations.callId,
            accountId: budgetReservations.accountId,
            costUsd: budgetReservations.costUsd,
            tokens: budgetReservations.tokens,
            unknown: sql<boolean>`${unknownHeld}`,
            sessionId: providerExchanges.sessionId,
            conversation: sql<boolean>`${conversationCalls.id} IS NOT NULL`,
          })
          .from(budgetReservations)
          .leftJoin(
            providerExchanges,
            eq(providerExchanges.exchangeId, budgetReservations.callId),
          )
          .leftJoin(conversationCalls, conversationCallOf)
          .where(
            callIds.length === 0
              ? sql`false`
              : inArray(budgetReservations.callId, callIds),
          )
      ).map((row) => [row.callId, row]),
    );
    for (const callId of callIds) {
      const row = held.get(callId);
      if (!row) {
        lines.push({ callId, outcome: "not_found" });
      } else if (!row.unknown) {
        lines.push({ callId, outcome: "not_unknown" });
      } else {
        const amount = { costUsd: row.costUsd, tokens: row.tokens };
        lines.push({
          callId,
          outcome: "would_resolve",
          callKind: row.conversation
            ? "conversation"
            : row.sessionId !== null
              ? "session"
              : "unlinked",
          accountId: row.accountId,
          held: amount,
          charged:
            input.resolution === "spent" ? amount : { costUsd: 0, tokens: 0 },
          receiptId: null,
        });
      }
    }
    return { outcome: "dry_run", lines, stoppedAt: null };
  }

  for (const callId of callIds) {
    try {
      lines.push(await db.transaction((tx) => resolveOneIn(tx, callId, input)));
    } catch (error) {
      if (error instanceof OperatorGone) {
        return { outcome: "resolved", lines, stoppedAt: callId };
      }
      throw error;
    }
  }
  return { outcome: "resolved", lines, stoppedAt: null };
}

/**
 * Locks, in the order every writer of a budgeted call takes them: the
 * operator's membership row first, as a member's disable holds it before
 * anything of a call; the exchange's lock (provider-exchanges.ts); the
 * call's lock; the conversation call's row; the reservation row; the
 * account row, last.
 */
async function resolveOneIn(
  tx: Database,
  callId: string,
  input: UnknownBudgetResolveInput,
): Promise<UnknownBudgetResolveLine> {
  const [named] = await tx
    .select({ workspaceId: budgetReservations.workspaceId })
    .from(budgetReservations)
    .where(eq(budgetReservations.callId, callId));
  if (!named) return { callId, outcome: "not_found" };
  const operator = await managerOf(tx, named.workspaceId, input.by, true);
  if (operator === undefined) throw new OperatorGone();
  await lockProviderExchange(tx, callId);
  await lockBudgetCall(tx, callId);
  const conversationCallId = conversationCallIdSchema.safeParse(callId);
  const [call] = conversationCallId.success
    ? await tx
        .select({
          id: conversationCalls.id,
          state: conversationCalls.state,
          agentId: conversationCalls.agentId,
          conversationTurnId: conversationCalls.conversationTurnId,
        })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, conversationCallId.data))
        .for("update")
    : [];
  const [row] = await tx
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.callId, callId))
    .for("update");
  if (!row || row.state !== "reserved" || row.unknownAt === null) {
    return { callId, outcome: "not_unknown" };
  }
  const held = { costUsd: row.costUsd, tokens: row.tokens };
  const charged =
    input.resolution === "spent" ? held : { costUsd: 0, tokens: 0 };
  const { callKind, receiptId } = await closeUnknownIn(tx, {
    row,
    unknownAt: row.unknownAt,
    call,
    resolution: input.resolution,
    charged,
    actor: {
      principal: { kind: "user", id: operator },
      actor_user_id: operator,
      agent_id: null,
    },
    receipt: { reason: input.reason, run_id: input.runId, by: "operator_cli" },
  });
  return {
    callId,
    outcome: "resolved",
    callKind,
    accountId: row.accountId,
    held,
    charged,
    receiptId,
  };
}

type ReservationRow = typeof budgetReservations.$inferSelect;

/**
 * The writes of a close, under the locks resolveOneIn takes: its call leaves
 * what is in progress (a conversation call becomes `resolved`, a session
 * call's exchange row is released), the reservation becomes `resolved` at
 * `charged`, the hold comes off its account, and a `resolve_unknown_budget`
 * receipt is written with it.
 */
async function closeUnknownIn(
  tx: Database,
  input: {
    row: ReservationRow;
    unknownAt: Date;
    call:
      | {
          id: ConversationCallId;
          state: string;
          agentId: string;
          conversationTurnId: string | null;
        }
      | undefined;
    resolution: BudgetUnknownResolution;
    charged: { costUsd: number; tokens: number };
    actor: {
      principal: { kind: "user"; id: string };
      actor_user_id: string;
      agent_id: null;
    } | null;
    receipt: { reason: string | null; run_id: string | null; by: string };
  },
): Promise<{ callKind: UnknownBudgetCallKind; receiptId: string }> {
  const { row, call, charged } = input;
  const callId = row.callId;
  const held = { costUsd: row.costUsd, tokens: row.tokens };
  if (call?.state === "in_flight") {
    await tx
      .update(conversationCalls)
      .set({ state: "resolved", endedAt: DB_NOW })
      .where(eq(conversationCalls.id, call.id));
  }
  // Released as the proxy releases a call it gave up on: the session no
  // longer holds it, and a late report still settles by the call id.
  const [exchange] = await tx
    .update(providerExchanges)
    .set({
      releasedAt: sql`COALESCE(${providerExchanges.releasedAt}, clock_timestamp())`,
    })
    .where(eq(providerExchanges.exchangeId, callId))
    .returning({ sessionId: providerExchanges.sessionId });
  await tx
    .update(budgetReservations)
    .set({
      state: "resolved",
      resolution: input.resolution,
      settledCostUsd: charged.costUsd,
      settledTokens: charged.tokens,
      endedAt: DB_NOW,
    })
    .where(eq(budgetReservations.callId, callId));
  const [account] =
    row.accountId === null
      ? []
      : await tx
          .update(budgetAccounts)
          .set({
            reservedCostUsd: sql`${budgetAccounts.reservedCostUsd} - ${held.costUsd}`,
            reservedTokens: sql`${budgetAccounts.reservedTokens} - ${held.tokens}`,
            spentCostUsd: sql`${budgetAccounts.spentCostUsd} + ${charged.costUsd}`,
            spentTokens: sql`${budgetAccounts.spentTokens} + ${charged.tokens}`,
          })
          .where(eq(budgetAccounts.id, row.accountId))
          .returning({
            ownerKind: budgetAccounts.ownerKind,
            ownerId: budgetAccounts.ownerId,
            periodStart: budgetAccounts.periodStart,
          });
  const callKind: UnknownBudgetCallKind = call
    ? "conversation"
    : exchange
      ? "session"
      : "unlinked";
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: row.workspaceId,
    operation: "resolve_unknown_budget",
    targetRef: targetOf(row.workspaceId, account),
    status: "succeeded",
    result: {
      call_id: callId,
      call_kind: callKind,
      session_id: exchange?.sessionId ?? null,
      agent_id: call?.agentId ?? null,
      conversation_turn_id: call?.conversationTurnId ?? null,
      account_id: row.accountId,
      owner_kind: account?.ownerKind ?? null,
      owner_id: account?.ownerId ?? null,
      period_start: account?.periodStart ?? null,
      resolution: input.resolution,
      reason: input.receipt.reason,
      held_cost_usd: held.costUsd,
      held_tokens: held.tokens,
      charged_cost_usd: charged.costUsd,
      charged_tokens: charged.tokens,
      unknown_at: input.unknownAt.toISOString(),
      run_id: input.receipt.run_id,
      by: input.receipt.by,
    },
    actor: input.actor,
  });
  return { callKind, receiptId };
}

// The account's owner, or the workspace for a call no account held.
function targetOf(
  workspaceId: string,
  account: { ownerKind: BudgetOwnerKind; ownerId: string } | undefined,
) {
  if (account?.ownerKind === "user") {
    return { user_id: account.ownerId, workspace_id: workspaceId };
  }
  return {
    resource: account
      ? { kind: "team", id: account.ownerId }
      : { kind: "workspace", id: workspaceId },
    workspace_id: workspaceId,
  };
}

/**
 * The longest a provider call can run, from its open (a session's) or its
 * start (a conversation call's). Past it, a call whose turn ended cannot still
 * be streaming: nothing the reconciler waits for can come but a late report.
 */
export const PROVIDER_CALL_MAX_MS = 3_600_000;

// A session turn that ended without completing; a conversation turn has no
// state past these.
const ENDED_SESSION_TURN = ["cancelled", "failed"] as const;
const ENDED_CONVERSATION_TURN = [
  "decided",
  "no_decision",
  "voided_by_delete",
] as const;

const listOf = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

// Reservations of unknown end whose call can no longer run: its turn ended
// (cancelled or failed for a session's; any end for a conversation turn's),
// its lease ran out, and PROVIDER_CALL_MAX_MS passed. A session call's turn
// is the attempt's last turn that started by the call's open. A call of no
// turn (a judgment, a summary) is left to an operator.
function deadUnknownCandidates(limit: number, callId?: string) {
  const callMaxPast = fromDbNow(-PROVIDER_CALL_MAX_MS);
  const sessionCallDead = sql`EXISTS (
    SELECT 1 FROM ${providerExchanges}
    WHERE ${providerExchanges.exchangeId} = ${budgetReservations.callId}
      AND ${providerExchanges.releasedAt} IS NULL
      AND ${providerExchanges.leaseExpiresAt} < clock_timestamp()
      AND ${providerExchanges.openedAt} < ${callMaxPast}
      AND (
        SELECT ${turns.status} FROM ${turns}
        WHERE ${turns.sessionId} = ${providerExchanges.sessionId}
          AND ${turns.attemptId} = ${providerExchanges.attemptId}
          AND ${turns.startedAt} <= ${providerExchanges.openedAt}
        ORDER BY ${turns.startedAt} DESC, ${turns.id} DESC
        LIMIT 1
      ) IN (${listOf(ENDED_SESSION_TURN)}))`;
  const conversationCallDead = sql`EXISTS (
    SELECT 1 FROM ${conversationCalls}
    JOIN ${conversationTurns}
      ON ${conversationTurns.id} = ${conversationCalls.conversationTurnId}
    WHERE ${conversationCallOf}
      AND ${conversationCalls.state} = 'in_flight'
      AND ${conversationCalls.unknownAt} IS NOT NULL
      AND ${conversationCalls.startedAt} < ${fromDbNow(-PROVIDER_EXCHANGE_LEASE_MS)}
      AND ${conversationCalls.startedAt} < ${callMaxPast}
      AND ${conversationTurns.state} IN (${listOf(ENDED_CONVERSATION_TURN)}))`;
  return sql`
    SELECT ${budgetReservations.callId} AS call_id FROM ${budgetReservations}
    WHERE ${unknownHeld}
      AND (${sessionCallDead} OR ${conversationCallDead})
      ${callId === undefined ? sql`` : sql`AND ${budgetReservations.callId} = ${callId}`}
    ORDER BY ${budgetReservations.unknownAt}, ${budgetReservations.callId}
    LIMIT ${limit}`;
}

/** One reservation the reconciler settled as estimated. */
export type EstimatedBudgetLine = {
  callId: string;
  callKind: UnknownBudgetCallKind;
  accountId: BudgetAccountId | null;
  charged: { costUsd: number; tokens: number };
  receiptId: string | null;
};

/**
 * Settles each reservation of unknown end whose call can no longer run
 * (deadUnknownCandidates), at most `limit`, each in a transaction of its own:
 * charged at what it held, as `estimated`, and closed as an operator's
 * resolve closes one, its receipt written by the reconciler. A late report
 * then adds its difference as an adjustment, as for any resolved row. A dry
 * run says what would be settled and changes nothing.
 */
export async function settleDeadUnknownBudget(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<EstimatedBudgetLine[]> {
  const ids = rowsOf<{ call_id: string }>(
    await db.execute(deadUnknownCandidates(input.limit)),
  ).map((row) => row.call_id);
  if (input.dryRun) {
    const held =
      ids.length === 0
        ? []
        : await db
            .select({
              callId: budgetReservations.callId,
              accountId: budgetReservations.accountId,
              costUsd: budgetReservations.costUsd,
              tokens: budgetReservations.tokens,
              conversation: sql<boolean>`${conversationCalls.id} IS NOT NULL`,
            })
            .from(budgetReservations)
            .leftJoin(conversationCalls, conversationCallOf)
            .where(inArray(budgetReservations.callId, ids));
    return held.map((row) => ({
      callId: row.callId,
      callKind: row.conversation ? "conversation" : "session",
      accountId: row.accountId,
      charged: { costUsd: row.costUsd, tokens: row.tokens },
      receiptId: null,
    }));
  }
  const lines: EstimatedBudgetLine[] = [];
  for (const callId of ids) {
    const line = await db.transaction((tx) => settleDeadOneIn(tx, callId));
    if (line) lines.push(line);
  }
  return lines;
}

// Locked as resolveOneIn locks, without an operator; judged again under the
// locks, so a report or a renewal that came meanwhile keeps the row.
async function settleDeadOneIn(
  tx: Database,
  callId: string,
): Promise<EstimatedBudgetLine | null> {
  await lockProviderExchange(tx, callId);
  await lockBudgetCall(tx, callId);
  const conversationCallId = conversationCallIdSchema.safeParse(callId);
  const [call] = conversationCallId.success
    ? await tx
        .select({
          id: conversationCalls.id,
          state: conversationCalls.state,
          agentId: conversationCalls.agentId,
          conversationTurnId: conversationCalls.conversationTurnId,
        })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, conversationCallId.data))
        .for("update")
    : [];
  const [row] = await tx
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.callId, callId))
    .for("update");
  if (!row || row.state !== "reserved" || row.unknownAt === null) return null;
  const still = rowsOf<{ call_id: string }>(
    await tx.execute(deadUnknownCandidates(1, callId)),
  );
  if (still.length === 0) return null;
  const charged = { costUsd: row.costUsd, tokens: row.tokens };
  const { callKind, receiptId } = await closeUnknownIn(tx, {
    row,
    unknownAt: row.unknownAt,
    call,
    resolution: "estimated",
    charged,
    actor: null,
    receipt: { reason: null, run_id: null, by: "reconciler" },
  });
  return { callId, callKind, accountId: row.accountId, charged, receiptId };
}
