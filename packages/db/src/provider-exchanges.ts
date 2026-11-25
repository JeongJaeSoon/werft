import type { BudgetAccountId } from "@werft-ai/contracts";
import type {
  BudgetChoice,
  BudgetReserveInput,
  HeldSpend,
  ProviderExchangeInput,
  ProviderExchangeLedger,
  ProviderExchangeOpenResult,
  ProviderExchangeReleaseResult,
  ProviderUsage,
} from "@werft-ai/platform";
import { reservationCostUsd, reservationTokens } from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  lockBudgetCall,
  markBudgetUnknownIn,
  releaseBudgetIn,
  reserveBudgetIn,
  settleBudgetIn,
} from "./budget-accounts.ts";
import { fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  budgetReservations,
  providerExchanges,
  providerUsage,
  sessions,
} from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";

/**
 * How long an open row stands without a renewal or a report before the
 * reconciler logs it and marks its reservation's end unknown (unknown_at);
 * a conversation call in flight this long is marked too. Covers the proxy's slowest
 * normal path: an authorizer outage cuts the exchange about 120 seconds
 * after the last good regrant, and the report's retries take up to about
 * 61 seconds more. A row past it still counts as a reservation until a
 * report or a release.
 */
export const PROVIDER_EXCHANGE_LEASE_MS = 300_000;

/**
 * Released rows are kept this long, so a late open of the same id still
 * finds the mark, then deleted. Unreleased rows are never deleted by age.
 */
export const PROVIDER_EXCHANGE_KEEP_DAYS = 7;

/**
 * The first key of the two-key advisory lock the open and the usage report
 * take on an exchange. Every other advisory lock in this repository is the
 * one-key form, a key space PostgreSQL keeps apart from this one, so this
 * lock never waits on or for any of them.
 */
export const LOCK_SPACE = 1_380_271_442;

/**
 * Serializes the open and the report of one exchange, whatever owner either
 * names. The first statement of both transactions: neither holds a row lock
 * when it waits here.
 */
export async function lockProviderExchange(
  tx: Database,
  exchangeId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCK_SPACE}::int, hashtext(${exchangeId}))`,
  );
}

/**
 * The report's half, in the report's own transaction after it recorded or
 * replayed: deletes the row when it is the reporter's. A row of another
 * owner stays, and the caller is told so it can say it.
 */
export async function settleProviderExchange(
  tx: Database,
  input: {
    exchangeId: string;
    sessionId: string;
    attemptId: string;
    /** What the report charged, settled on the account the open held. */
    actual: { costUsd: number; tokens: number };
  },
): Promise<{ foreignRow: boolean }> {
  const deleted = await tx
    .delete(providerExchanges)
    .where(
      and(
        eq(providerExchanges.exchangeId, input.exchangeId),
        eq(providerExchanges.sessionId, input.sessionId),
        eq(providerExchanges.attemptId, input.attemptId),
      ),
    )
    .returning({ exchangeId: providerExchanges.exchangeId });
  const [other] =
    deleted.length > 0
      ? []
      : await tx
          .select({ exchangeId: providerExchanges.exchangeId })
          .from(providerExchanges)
          .where(eq(providerExchanges.exchangeId, input.exchangeId))
          .limit(1);
  if (other !== undefined) return { foreignRow: true };
  // Settled by the call id, not by the row: the row that held the account may
  // be gone, its release mark deleted after PROVIDER_EXCHANGE_KEEP_DAYS, or
  // replaced by a later release's mark that names no account. A call that
  // never named one has no reservation, and nothing changes. After the
  // session and attempt rows the report holds: the account row comes last.
  await settleBudgetIn(tx, { callId: input.exchangeId, actual: input.actual });
  return { foreignRow: false };
}

/**
 * One session's opens wait here, after their exchange's lock, so two never
 * judge the same sum. A key space of its own; the report and the release
 * never take it, and only lower a sum an open reads in one statement. The id
 * is hashed as PostgreSQL spells a uuid, so every spelling of one session
 * takes one lock.
 */
export async function lockProviderExchangeSession(
  tx: Database,
  sessionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${SESSION_LOCK_SPACE}::int, hashtext(${sessionId}::uuid::text))`,
  );
}

/** The second two-key space: one session's opens, apart from LOCK_SPACE. */
export const SESSION_LOCK_SPACE = 1_380_271_443;

/**
 * Of an id under its exchange lock: whether its pair exists, and what a
 * report or a row already says about it. Reads only, no row lock: the fence
 * and the model cut lock the session and attempt rows in their own orders,
 * and the ledger stays out of that.
 */
async function standingOf(
  tx: Database,
  input: ProviderExchangeInput,
): Promise<
  | { kind: "unknown_attempt" | "settled" | "conflict" | "none" }
  | {
      kind: "row";
      sameOwner: boolean;
      sameReserve: boolean;
      released: boolean;
      budgeted: boolean;
    }
> {
  const [pair] = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.id, input.attemptId),
        eq(attempts.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  if (!pair) return { kind: "unknown_attempt" };
  // The owner compared in SQL: a session id is a uuid, which the database
  // reads in either case.
  const sameOwnerOf = (
    table: typeof providerUsage | typeof providerExchanges,
  ) =>
    sql<boolean>`${table.sessionId} = ${input.sessionId}::uuid AND ${table.attemptId} = ${input.attemptId}`;
  const [reported] = await tx
    .select({ sameOwner: sameOwnerOf(providerUsage) })
    .from(providerUsage)
    .where(eq(providerUsage.exchangeId, input.exchangeId))
    .limit(1);
  if (reported) return { kind: reported.sameOwner ? "settled" : "conflict" };
  const [row] = await tx
    .select({
      sameOwner: sameOwnerOf(providerExchanges),
      sameReserve: sql<boolean>`${providerExchanges.reserve} = ${JSON.stringify(input.reserve)}::jsonb`,
      released: sql<boolean>`${providerExchanges.releasedAt} IS NOT NULL`,
      budgeted: sql<boolean>`${providerExchanges.budgetRootKind} IS NOT NULL`,
    })
    .from(providerExchanges)
    .where(eq(providerExchanges.exchangeId, input.exchangeId))
    .limit(1);
  return row ? { kind: "row", ...row } : { kind: "none" };
}

/**
 * The account side of an open: the call id is the exchange's, and the
 * reserve is priced as admitsReservations prices the session's side, so the
 * two judges hold the same amount.
 */
function budgetReserveOf(
  input: ProviderExchangeInput,
  choice: BudgetChoice,
  session: { workspaceId: string | null; unmetered: boolean },
): BudgetReserveInput {
  if (session.workspaceId === null) {
    throw new Error(
      `provider exchange ${input.exchangeId}: a budget account named for a session with no workspace`,
    );
  }
  return {
    callId: input.exchangeId,
    workspaceId: session.workspaceId,
    choice,
    reserve: {
      costUsd: reservationCostUsd(input.reserve),
      tokens: reservationTokens(input.reserve),
    },
    unmetered: session.unmetered,
  };
}

/**
 * Locks, in the one order every writer of a budgeted call takes them: the
 * exchange's advisory lock; then the open's session advisory lock, or the
 * report's session and attempt rows; then budget-accounts.ts's call lock,
 * the reservation row and the account row, last. The open takes no session
 * or attempt row, and nothing holding an account row waits on one, so the
 * account row closes no cycle.
 */
export function createProviderExchangeLedger(
  db: Database,
  options: {
    /**
     * Whether the session may hold one more call: see admitsReservations.
     * Asked before each open's transaction, so a saved limit applies to the
     * next call; a failed read fails that open.
     */
    admits: () => Promise<(held: HeldSpend) => boolean>;
  },
): ProviderExchangeLedger {
  return {
    async open(input): Promise<ProviderExchangeOpenResult> {
      // Read before the transaction, never on its connection; a failure
      // refuses only a new row, so a replay still lands.
      const admission = await options.admits().then(
        (admits) => ({ admits }),
        (error: unknown) => ({ error }),
      );
      return db.transaction(async (tx) => {
        await lockProviderExchange(tx, input.exchangeId);
        await lockProviderExchangeSession(tx, input.sessionId);
        const standing = await standingOf(tx, input);
        if (standing.kind === "row") {
          if (!standing.sameOwner) return { outcome: "conflict" };
          // A release came first: the proxy gave up on this call.
          if (standing.released) return { outcome: "released" };
          // The same open again was judged when it first came: its lease is
          // extended and its opened_at kept; another reserve changes nothing.
          if (!standing.sameReserve) return { outcome: "conflict" };
          if (standing.budgeted !== (input.budget !== undefined)) {
            return { outcome: "conflict" };
          }
          if (input.budget !== undefined) {
            const [session] = await tx
              .select({
                workspaceId: sessions.workspaceId,
                unmetered: sessions.unmetered,
              })
              .from(sessions)
              .where(eq(sessions.id, input.sessionId));
            if (!session) return { outcome: "unknown_attempt" };
            // The row's reservation exists, so this only compares.
            const replay = await reserveBudgetIn(
              tx,
              budgetReserveOf(input, input.budget, session),
            );
            if (replay.outcome === "conflict") return { outcome: "conflict" };
            if (replay.outcome !== "replayed") {
              throw new Error(
                `provider exchange ${input.exchangeId}: an open row with no budget reservation`,
              );
            }
          }
          await tx
            .update(providerExchanges)
            .set({
              leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
              noticedAt: null,
            })
            .where(eq(providerExchanges.exchangeId, input.exchangeId));
          // The lease is alive again, so its end is no longer unknown.
          if (input.budget !== undefined) {
            await markBudgetUnknownIn(tx, input.exchangeId, false);
          }
          return { outcome: "open" };
        }
        if (standing.kind !== "none") return { outcome: standing.kind };
        // One statement, so one snapshot: a report commits its cost and the
        // removal of its row together, and this sees either both or neither.
        const [held] = await tx
          .select({
            costUsd: sessions.costUsd,
            providerTokens: sessions.providerTokens,
            unmetered: sessions.unmetered,
            workspaceId: sessions.workspaceId,
            reserves: sql<ProviderUsage[]>`COALESCE((
              SELECT json_agg(${providerExchanges.reserve})
              FROM ${providerExchanges}
              WHERE ${providerExchanges.sessionId} = ${sessions.id}
                AND ${providerExchanges.releasedAt} IS NULL), '[]'::json)`,
          })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId));
        if (!held) return { outcome: "unknown_attempt" };
        if ("error" in admission) throw admission.error;
        if (
          !admission.admits({
            costUsd: held.costUsd,
            providerTokens: held.providerTokens,
            unmetered: held.unmetered,
            reserves: [...held.reserves, input.reserve],
          })
        ) {
          return {
            outcome: "budget_exceeded",
            by: "session",
            accountId: null,
            owner: null,
          };
        }
        // The session admitted it; the account judges it next, in this
        // transaction, so a refusal there leaves nothing on either side.
        let budget: {
          budgetRootKind: BudgetChoice["rootKind"];
          budgetAccountId: BudgetAccountId | null;
        } | null = null;
        if (input.budget !== undefined) {
          const reserved = await reserveBudgetIn(
            tx,
            budgetReserveOf(input, input.budget, held),
          );
          switch (reserved.outcome) {
            case "refused":
              return {
                outcome: "budget_exceeded",
                by: "account",
                accountId: reserved.accountId,
                owner: input.budget.owner?.kind ?? null,
              };
            case "conflict":
              return { outcome: "conflict" };
            case "replayed":
              // A reservation that outlived its exchange row, whose release
              // mark the reconciler deleted: what became of it stands. An
              // operator's resolve released the row, as the proxy's would.
              return reserved.state === "reserved"
                ? { outcome: "conflict" }
                : {
                    outcome:
                      reserved.state === "resolved"
                        ? "released"
                        : reserved.state,
                  };
            case "reserved":
              budget = {
                budgetRootKind: reserved.rootKind,
                budgetAccountId: reserved.accountId,
              };
          }
        }
        await tx.insert(providerExchanges).values({
          exchangeId: input.exchangeId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          reserve: input.reserve,
          leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
          ...budget,
        });
        return { outcome: "created" };
      });
    },

    renew(exchangeId) {
      return db.transaction(async (tx) => {
        // Under the exchange's lock, as the open and the report: the call's
        // lock comes after the row here, as it does in the report.
        await lockProviderExchange(tx, exchangeId);
        const [renewed] = await tx
          .update(providerExchanges)
          .set({
            leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
            noticedAt: null,
          })
          .where(
            and(
              eq(providerExchanges.exchangeId, exchangeId),
              isNull(providerExchanges.releasedAt),
            ),
          )
          .returning({
            budgeted: sql<boolean>`${providerExchanges.budgetRootKind} IS NOT NULL`,
          });
        if (!renewed) return "gone";
        if (renewed.budgeted) {
          await markBudgetUnknownIn(tx, exchangeId, false);
        }
        return "open";
      });
    },

    release(input): Promise<ProviderExchangeReleaseResult> {
      return db.transaction(async (tx) => {
        // Under the exchange's lock, so an open still in flight is ordered
        // with it: one that lands later finds the mark and counts nothing.
        await lockProviderExchange(tx, input.exchangeId);
        const standing = await standingOf(tx, input);
        if (standing.kind === "row") {
          if (!standing.sameOwner) return "conflict";
          if (standing.budgeted && !standing.released) {
            await releaseBudgetIn(tx, input.exchangeId);
          }
          await tx
            .update(providerExchanges)
            .set({
              releasedAt: sql`COALESCE(${providerExchanges.releasedAt}, clock_timestamp())`,
            })
            .where(eq(providerExchanges.exchangeId, input.exchangeId));
          return "released";
        }
        if (standing.kind !== "none") return standing.kind;
        await tx.insert(providerExchanges).values({
          exchangeId: input.exchangeId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          reserve: input.reserve,
          leaseExpiresAt: fromDbNow(0),
          releasedAt: sql`clock_timestamp()`,
        });
        return "released";
      });
    },
  };
}

export type ExpiredProviderExchange = {
  exchangeId: string;
  sessionId: string;
  attemptId: string;
  openedAt: Date;
};

/**
 * The reconciler's pass over rows whose lease ran out, each step limited to
 * `limit` rows and skipping rows another transaction holds. Every write
 * repeats its condition, so a row renewed meanwhile is left.
 */
export async function reconcileProviderExchanges(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<{
  /**
   * Rows a usage report of the same owner already settled (one an older API
   * replica took, which deletes nothing), deleted unlogged.
   */
  settled: number;
  /**
   * The unreleased rest not yet logged, marked and returned to be logged
   * once; a renewal clears the mark.
   */
  noticed: ExpiredProviderExchange[];
  /** Rows released more than PROVIDER_EXCHANGE_KEEP_DAYS ago, deleted. */
  deleted: number;
  /**
   * Budgeted rows past their lease (noticed now or in an earlier pass) whose
   * reservation's end was marked unknown: still held until a report, a
   * release or a renewal clears it.
   */
  unknown: number;
}> {
  const expired = sql`${providerExchanges.leaseExpiresAt} < clock_timestamp()`;
  const reportedBySameOwner = sql`EXISTS (
    SELECT 1 FROM ${providerUsage}
    WHERE ${providerUsage.exchangeId} = ${providerExchanges.exchangeId}
      AND ${providerUsage.sessionId} = ${providerExchanges.sessionId}
      AND ${providerUsage.attemptId} = ${providerExchanges.attemptId})`;
  const old = sql`${providerExchanges.releasedAt} < clock_timestamp() - make_interval(days => ${PROVIDER_EXCHANGE_KEEP_DAYS}::int)`;
  const candidates = (where: ReturnType<typeof sql>) => sql`
    SELECT ${providerExchanges.exchangeId} FROM ${providerExchanges}
    WHERE ${where}
    ORDER BY ${providerExchanges.leaseExpiresAt}
    LIMIT ${input.limit}`;
  // ARRAY() runs the pick once, as an init plan. Under IN the planner may run
  // it again for every row, and each run skips the rows this statement
  // already wrote and locks fresh ones, past the limit.
  const picked = (where: ReturnType<typeof sql>) =>
    sql`${providerExchanges.exchangeId} = ANY(ARRAY(${candidates(where)} FOR UPDATE SKIP LOCKED)) AND ${where}`;

  const settledWhere = sql`${expired} AND ${reportedBySameOwner}`;
  const noticeWhere = sql`${expired} AND ${providerExchanges.releasedAt} IS NULL AND ${providerExchanges.noticedAt} IS NULL AND NOT ${reportedBySameOwner}`;

  if (input.dryRun) {
    const settledIds = rowsOf<{ exchange_id: string }>(
      await db.execute(candidates(settledWhere)),
    ).map((row) => row.exchange_id);
    const noticed = await db
      .select({
        exchangeId: providerExchanges.exchangeId,
        sessionId: providerExchanges.sessionId,
        attemptId: providerExchanges.attemptId,
        openedAt: providerExchanges.openedAt,
      })
      .from(providerExchanges)
      .where(noticeWhere)
      .orderBy(providerExchanges.leaseExpiresAt)
      .limit(input.limit);
    // A row the settled step takes is not counted again here, as the
    // writes would not find it; a settled row beyond its limit still is.
    const deleted = rowsOf<{ exchange_id: string }>(
      await db.execute(
        candidates(
          settledIds.length === 0
            ? old
            : sql`${old} AND ${providerExchanges.exchangeId} NOT IN (${sql.join(
                settledIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
        ),
      ),
    ).length;
    const unknown = rowsOf<{ exchange_id: string }>(
      await db.execute(unknownCandidates(input.limit)),
    ).length;
    return { settled: settledIds.length, noticed, deleted, unknown };
  }

  const settled = await db
    .delete(providerExchanges)
    .where(picked(settledWhere))
    .returning({ exchangeId: providerExchanges.exchangeId });
  const noticed = await db
    .update(providerExchanges)
    .set({ noticedAt: sql`clock_timestamp()` })
    .where(picked(noticeWhere))
    .returning({
      exchangeId: providerExchanges.exchangeId,
      sessionId: providerExchanges.sessionId,
      attemptId: providerExchanges.attemptId,
      openedAt: providerExchanges.openedAt,
    });
  const deleted = await db
    .delete(providerExchanges)
    .where(picked(old))
    .returning({ exchangeId: providerExchanges.exchangeId });
  let unknown = 0;
  for (const { exchange_id: id } of rowsOf<{ exchange_id: string }>(
    await db.execute(unknownCandidates(input.limit)),
  )) {
    const marked = await db.transaction(async (tx) => {
      // Takes the call's lock first, so a renewal or a report that holds it
      // is seen whole by the read below.
      await lockBudgetCall(tx, id);
      const [still] = rowsOf<{ exchange_id: string }>(
        await tx.execute(unknownCandidates(1, id)),
      );
      return still ? markBudgetUnknownIn(tx, id, true) : false;
    });
    if (marked) unknown++;
  }
  return {
    settled: settled.length,
    noticed,
    deleted: deleted.length,
    unknown,
  };
}

// Rows past their lease and not released whose reservation is reserved and
// not yet marked: noticed in this pass or an earlier one, so a dry run
// counts what the writes would mark.
function unknownCandidates(limit: number, exchangeId?: string) {
  return sql`
    SELECT ${providerExchanges.exchangeId} FROM ${providerExchanges}
    JOIN ${budgetReservations}
      ON ${budgetReservations.callId} = ${providerExchanges.exchangeId}
    WHERE ${providerExchanges.releasedAt} IS NULL
      AND ${providerExchanges.leaseExpiresAt} < clock_timestamp()
      AND ${budgetReservations.state} = 'reserved'
      AND ${budgetReservations.unknownAt} IS NULL
      ${exchangeId === undefined ? sql`` : sql`AND ${providerExchanges.exchangeId} = ${exchangeId}`}
    ORDER BY ${providerExchanges.leaseExpiresAt}
    LIMIT ${limit}`;
}
