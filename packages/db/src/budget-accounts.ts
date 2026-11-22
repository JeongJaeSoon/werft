import type { BudgetAccountId } from "@werft-ai/contracts";
import {
  admitsBudgetReserve,
  assertBudgetAmount,
  type BudgetLedger,
  type BudgetLimit,
  type BudgetOwner,
  type BudgetReserveResult,
  personLimitOf,
} from "@werft-ai/platform";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { budgetAccounts, budgetLimits, budgetReservations } from "./schema.ts";

/** What a budget limit row is for. */
export type BudgetLimitTarget =
  | { kind: "person_default" }
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string };

function subjectOf(target: BudgetLimitTarget) {
  return {
    subject: target.kind,
    subjectId:
      target.kind === "user"
        ? target.userId
        : target.kind === "team"
          ? target.teamId
          : null,
  };
}

function subjectIs(workspaceId: string, target: BudgetLimitTarget) {
  const { subject, subjectId } = subjectOf(target);
  return and(
    eq(budgetLimits.workspaceId, workspaceId),
    eq(budgetLimits.subject, subject),
    subjectId === null
      ? isNull(budgetLimits.subjectId)
      : eq(budgetLimits.subjectId, subjectId),
  );
}

/** Sets one limit row; null removes it, which is no limit. */
export async function saveBudgetLimit(
  db: Database,
  workspaceId: string,
  target: BudgetLimitTarget,
  limit: BudgetLimit | null,
): Promise<void> {
  if (limit !== null) assertBudgetAmount(limit);
  if (limit === null) {
    await db.delete(budgetLimits).where(subjectIs(workspaceId, target));
    return;
  }
  await db
    .insert(budgetLimits)
    .values({ workspaceId, ...subjectOf(target), ...limit })
    .onConflictDoUpdate({
      target: [
        budgetLimits.workspaceId,
        budgetLimits.subject,
        budgetLimits.subjectId,
      ],
      set: { ...limit, updatedAt: DB_NOW },
    });
}

/** The limit an owner's account is held to; null is none. */
export async function budgetLimitOf(
  db: Database,
  workspaceId: string,
  owner: BudgetOwner,
): Promise<BudgetLimit | null> {
  const rows = await db
    .select({
      subject: budgetLimits.subject,
      costUsd: budgetLimits.costUsd,
      tokens: budgetLimits.tokens,
    })
    .from(budgetLimits)
    .where(
      owner.kind === "team"
        ? subjectIs(workspaceId, { kind: "team", teamId: owner.teamId })
        : or(
            subjectIs(workspaceId, { kind: "user", userId: owner.userId }),
            subjectIs(workspaceId, { kind: "person_default" }),
          ),
    );
  const of = (subject: string): BudgetLimit | null => {
    const row = rows.find((candidate) => candidate.subject === subject);
    return row ? { costUsd: row.costUsd, tokens: row.tokens } : null;
  };
  return owner.kind === "team"
    ? of("team")
    : personLimitOf(of("user"), of("person_default"));
}

// The month an account period covers, read once per reserve so the insert
// and the lock name the same month across a boundary. a0 cuts months in UTC.
async function currentPeriodStart(tx: Database): Promise<string> {
  const [row] = await tx
    .select({
      start: sql<string>`date_trunc('month', ${DB_NOW} AT TIME ZONE 'UTC')::date::text`,
    })
    .from(sql`(SELECT 1) AS one`);
  if (!row) throw new Error("clock_timestamp() unreadable");
  return row.start;
}

// The scale of the cost columns, so a replay compares what was stored.
const toStoredCost = (costUsd: number) => Math.round(costUsd * 1e6) / 1e6;

function ownerColumns(owner: BudgetOwner) {
  return owner.kind === "user"
    ? { ownerKind: "user" as const, ownerId: owner.userId }
    : { ownerKind: "team" as const, ownerId: owner.teamId };
}

/** This month's account row of an owner, made if missing, locked. */
async function lockCurrentAccount(
  tx: Database,
  workspaceId: string,
  owner: BudgetOwner,
) {
  const columns = ownerColumns(owner);
  const periodStart = await currentPeriodStart(tx);
  await tx
    .insert(budgetAccounts)
    .values({
      id: crypto.randomUUID() as BudgetAccountId,
      workspaceId,
      ...columns,
      periodStart,
    })
    .onConflictDoNothing();
  const [account] = await tx
    .select()
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.workspaceId, workspaceId),
        eq(budgetAccounts.ownerKind, columns.ownerKind),
        eq(budgetAccounts.ownerId, columns.ownerId),
        eq(budgetAccounts.periodStart, periodStart),
      ),
    )
    .for("update");
  if (!account) throw new Error("budget account row missing after insert");
  return account;
}

/**
 * The first key of the two-key advisory lock every reserve, settle and
 * release of one call takes first, before any row lock: so the three of one
 * call run one after the other, and each takes the account row after it.
 * Apart from the provider exchange ledger's spaces (provider-exchanges.ts).
 */
export const BUDGET_CALL_LOCK_SPACE = 1_380_271_444;

async function lockBudgetCall(tx: Database, callId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${BUDGET_CALL_LOCK_SPACE}::int, hashtext(${callId}))`,
  );
}

export function createBudgetLedger(db: Database): BudgetLedger {
  async function replayOf(
    tx: Database,
    input: Parameters<BudgetLedger["reserve"]>[0],
    costUsd: number,
  ): Promise<BudgetReserveResult | null> {
    const [row] = await tx
      .select({
        reservation: budgetReservations,
        ownerKind: budgetAccounts.ownerKind,
        ownerId: budgetAccounts.ownerId,
      })
      .from(budgetReservations)
      .leftJoin(
        budgetAccounts,
        eq(budgetAccounts.id, budgetReservations.accountId),
      )
      .where(eq(budgetReservations.callId, input.callId));
    if (!row) return null;
    const owner = input.choice.owner;
    const sameOwner =
      owner === null
        ? row.ownerKind === null
        : row.ownerKind === ownerColumns(owner).ownerKind &&
          row.ownerId === ownerColumns(owner).ownerId;
    const same =
      sameOwner &&
      row.reservation.workspaceId === input.workspaceId &&
      row.reservation.rootKind === input.choice.rootKind &&
      row.reservation.unmetered === input.unmetered &&
      row.reservation.costUsd === costUsd &&
      row.reservation.tokens === input.reserve.tokens;
    return same
      ? { outcome: "replayed", state: row.reservation.state }
      : { outcome: "conflict" };
  }

  return {
    async reserve(input) {
      const costUsd = input.unmetered ? 0 : toStoredCost(input.reserve.costUsd);
      const tokens = input.reserve.tokens;
      // The amount as given, before an unmetered call's cost is dropped.
      assertBudgetAmount(input.reserve);
      return db.transaction(async (tx) => {
        await lockBudgetCall(tx, input.callId);
        const replay = await replayOf(tx, input, costUsd);
        if (replay) return replay;
        const owner = input.choice.owner;
        // The account row's lock is what makes two reserves of one account
        // judge one after the other.
        const account =
          owner === null
            ? null
            : await lockCurrentAccount(tx, input.workspaceId, owner);
        const limit =
          owner === null
            ? null
            : await budgetLimitOf(tx, input.workspaceId, owner);
        const admitted = admitsBudgetReserve({
          rootKind: input.choice.rootKind,
          limit,
          held: account && {
            spent: {
              costUsd: account.spentCostUsd,
              tokens: account.spentTokens,
            },
            reserved: {
              costUsd: account.reservedCostUsd,
              tokens: account.reservedTokens,
            },
          },
          reserve: { costUsd, tokens },
        });
        const accountId = account?.id ?? null;
        if (!admitted) return { outcome: "refused", accountId };
        const inserted = await tx
          .insert(budgetReservations)
          .values({
            callId: input.callId,
            workspaceId: input.workspaceId,
            accountId,
            rootKind: input.choice.rootKind,
            unmetered: input.unmetered,
            costUsd,
            tokens,
          })
          .onConflictDoNothing()
          .returning({ callId: budgetReservations.callId });
        // Under the call's lock no other reserve of the id gets in.
        if (inserted.length === 0) return { outcome: "conflict" };
        if (account) {
          await tx
            .update(budgetAccounts)
            .set({
              reservedCostUsd: sql`${budgetAccounts.reservedCostUsd} + ${costUsd}`,
              reservedTokens: sql`${budgetAccounts.reservedTokens} + ${tokens}`,
            })
            .where(eq(budgetAccounts.id, account.id));
        }
        return {
          outcome: "reserved",
          accountId,
          rootKind: input.choice.rootKind,
        };
      });
    },

    async settle({ callId, actual }) {
      assertBudgetAmount(actual);
      return db.transaction(async (tx) => {
        await lockBudgetCall(tx, callId);
        const [row] = await tx
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.callId, callId))
          .for("update");
        if (!row) return "unknown";
        if (row.state === "settled") return "already_settled";
        const costUsd = row.unmetered ? 0 : toStoredCost(actual.costUsd);
        // A released reserve was already taken off; a call billed after its
        // release still spent what the settlement says.
        const held = row.state === "reserved";
        await tx
          .update(budgetReservations)
          .set({
            state: "settled",
            settledCostUsd: costUsd,
            settledTokens: actual.tokens,
            endedAt: DB_NOW,
          })
          .where(eq(budgetReservations.callId, callId));
        if (row.accountId !== null) {
          await tx
            .update(budgetAccounts)
            .set({
              spentCostUsd: sql`${budgetAccounts.spentCostUsd} + ${costUsd}`,
              spentTokens: sql`${budgetAccounts.spentTokens} + ${actual.tokens}`,
              ...(held
                ? {
                    reservedCostUsd: sql`${budgetAccounts.reservedCostUsd} - ${row.costUsd}`,
                    reservedTokens: sql`${budgetAccounts.reservedTokens} - ${row.tokens}`,
                  }
                : {}),
            })
            .where(eq(budgetAccounts.id, row.accountId));
        }
        return "settled";
      });
    },

    async release(callId) {
      return db.transaction(async (tx) => {
        await lockBudgetCall(tx, callId);
        const [row] = await tx
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.callId, callId))
          .for("update");
        if (!row) return "unknown";
        if (row.state === "settled") return "settled";
        if (row.state === "released") return "already_released";
        await tx
          .update(budgetReservations)
          .set({ state: "released", endedAt: DB_NOW })
          .where(eq(budgetReservations.callId, callId));
        if (row.accountId !== null) {
          await tx
            .update(budgetAccounts)
            .set({
              reservedCostUsd: sql`${budgetAccounts.reservedCostUsd} - ${row.costUsd}`,
              reservedTokens: sql`${budgetAccounts.reservedTokens} - ${row.tokens}`,
            })
            .where(eq(budgetAccounts.id, row.accountId));
        }
        return "released";
      });
    },
  };
}
