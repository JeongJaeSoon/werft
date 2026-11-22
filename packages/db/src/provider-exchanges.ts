import type {
  HeldSpend,
  ProviderExchangeInput,
  ProviderExchangeLedger,
  ProviderExchangeOpenResult,
  ProviderExchangeReleaseResult,
  ProviderUsage,
} from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  providerExchanges,
  providerUsage,
  sessions,
} from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";

/**
 * How long an open row stands without a renewal or a report before the
 * reconciler logs it. Covers the proxy's slowest normal path: an authorizer
 * outage cuts the exchange about 120 seconds after the last good regrant,
 * and the report's retries take up to about 61 seconds more. A row past it
 * still counts as a reservation until a report or a release.
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
  input: { exchangeId: string; sessionId: string; attemptId: string },
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
  if (deleted.length > 0) return { foreignRow: false };
  const [other] = await tx
    .select({ exchangeId: providerExchanges.exchangeId })
    .from(providerExchanges)
    .where(eq(providerExchanges.exchangeId, input.exchangeId))
    .limit(1);
  return { foreignRow: other !== undefined };
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
  | { kind: "row"; sameOwner: boolean; sameReserve: boolean; released: boolean }
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
    })
    .from(providerExchanges)
    .where(eq(providerExchanges.exchangeId, input.exchangeId))
    .limit(1);
  return row ? { kind: "row", ...row } : { kind: "none" };
}

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
          await tx
            .update(providerExchanges)
            .set({
              leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
              noticedAt: null,
            })
            .where(eq(providerExchanges.exchangeId, input.exchangeId));
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
          return { outcome: "budget_exceeded" };
        }
        await tx.insert(providerExchanges).values({
          exchangeId: input.exchangeId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          reserve: input.reserve,
          leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
        });
        return { outcome: "created" };
      });
    },

    async renew(exchangeId) {
      const [renewed] = await db
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
        .returning({ exchangeId: providerExchanges.exchangeId });
      return renewed ? "open" : "gone";
    },

    release(input): Promise<ProviderExchangeReleaseResult> {
      return db.transaction(async (tx) => {
        // Under the exchange's lock, so an open still in flight is ordered
        // with it: one that lands later finds the mark and counts nothing.
        await lockProviderExchange(tx, input.exchangeId);
        const standing = await standingOf(tx, input);
        if (standing.kind === "row") {
          if (!standing.sameOwner) return "conflict";
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
    return { settled: settledIds.length, noticed, deleted };
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
  return {
    settled: settled.length,
    noticed,
    deleted: deleted.length,
  };
}
