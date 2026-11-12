import type {
  ProviderExchangeLedger,
  ProviderExchangeOpenResult,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { attempts, providerExchanges, providerUsage } from "./schema.ts";
import { rowsOf } from "./statement-rows.ts";

/**
 * How long an open row stands without a renewal or a report. Covers the
 * proxy's slowest normal path: an authorizer outage cuts the exchange about
 * 120 seconds after the last good regrant, and the report's retries take up
 * to about 61 seconds more.
 */
export const PROVIDER_EXCHANGE_LEASE_MS = 300_000;

/** Rows whose lease ran out this long ago are deleted, settled or not. */
export const PROVIDER_EXCHANGE_KEEP_DAYS = 7;

/**
 * The first key of the two-key advisory lock the open and the usage report
 * take on an exchange. Every other advisory lock in this repository is the
 * one-key form, a key space PostgreSQL keeps apart from this one, so this
 * lock never waits on or for any of them.
 */
const LOCK_SPACE = 1_380_271_442;

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

export function createProviderExchangeLedger(
  db: Database,
): ProviderExchangeLedger {
  return {
    open(input): Promise<ProviderExchangeOpenResult> {
      return db.transaction(async (tx) => {
        await lockProviderExchange(tx, input.exchangeId);
        // A read, no row lock: the fence and the model cut lock these rows
        // in their own orders, and the ledger stays out of that.
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
        if (!pair) return { outcome: "unknown_attempt" };
        // The owner compared in SQL: a session id is a uuid, which the
        // database reads in either case.
        const [reported] = await tx
          .select({
            sameOwner: sql<boolean>`${providerUsage.sessionId} = ${input.sessionId}::uuid AND ${providerUsage.attemptId} = ${input.attemptId}`,
          })
          .from(providerUsage)
          .where(eq(providerUsage.exchangeId, input.exchangeId))
          .limit(1);
        if (reported) {
          return reported.sameOwner
            ? { outcome: "settled" }
            : { outcome: "conflict" };
        }
        const [inserted] = await tx
          .insert(providerExchanges)
          .values({
            exchangeId: input.exchangeId,
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            reserve: input.reserve,
            leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
          })
          .onConflictDoNothing({ target: providerExchanges.exchangeId })
          .returning({ exchangeId: providerExchanges.exchangeId });
        if (inserted) return { outcome: "created" };
        // The same open again extends the lease and keeps the first opened_at;
        // another owner or another reserve under the id changes nothing.
        const [again] = await tx
          .update(providerExchanges)
          .set({
            leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
            noticedAt: null,
          })
          .where(
            and(
              eq(providerExchanges.exchangeId, input.exchangeId),
              eq(providerExchanges.sessionId, input.sessionId),
              eq(providerExchanges.attemptId, input.attemptId),
              sql`${providerExchanges.reserve} = ${JSON.stringify(input.reserve)}::jsonb`,
            ),
          )
          .returning({ exchangeId: providerExchanges.exchangeId });
        return again ? { outcome: "open" } : { outcome: "conflict" };
      });
    },

    async renew(exchangeId) {
      const [renewed] = await db
        .update(providerExchanges)
        .set({
          leaseExpiresAt: fromDbNow(PROVIDER_EXCHANGE_LEASE_MS),
          noticedAt: null,
        })
        .where(eq(providerExchanges.exchangeId, exchangeId))
        .returning({ exchangeId: providerExchanges.exchangeId });
      return renewed ? "open" : "gone";
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
 * `limit` rows and skipping rows another transaction holds:
 *
 * - `settled`: rows a usage report of the same owner already settled (one an
 *   older API replica took, which deletes nothing) are deleted unlogged;
 * - `noticed`: the rest not yet logged are marked and returned to be logged
 *   once; a renewal clears the mark;
 * - `deleted`: rows expired more than PROVIDER_EXCHANGE_KEEP_DAYS ago go.
 *
 * Every write repeats its condition, so a row renewed meanwhile is left.
 */
export async function reconcileProviderExchanges(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<{
  settled: number;
  noticed: ExpiredProviderExchange[];
  deleted: number;
}> {
  const expired = sql`${providerExchanges.leaseExpiresAt} < clock_timestamp()`;
  const reportedBySameOwner = sql`EXISTS (
    SELECT 1 FROM ${providerUsage}
    WHERE ${providerUsage.exchangeId} = ${providerExchanges.exchangeId}
      AND ${providerUsage.sessionId} = ${providerExchanges.sessionId}
      AND ${providerUsage.attemptId} = ${providerExchanges.attemptId})`;
  const old = sql`${providerExchanges.leaseExpiresAt} < clock_timestamp() - make_interval(days => ${PROVIDER_EXCHANGE_KEEP_DAYS}::int)`;
  const candidates = (where: ReturnType<typeof sql>) => sql`
    SELECT ${providerExchanges.exchangeId} FROM ${providerExchanges}
    WHERE ${where}
    ORDER BY ${providerExchanges.leaseExpiresAt}
    LIMIT ${input.limit}`;

  const settledWhere = sql`${expired} AND ${reportedBySameOwner}`;
  const noticeWhere = sql`${expired} AND ${providerExchanges.noticedAt} IS NULL AND NOT ${reportedBySameOwner}`;

  if (input.dryRun) {
    const settled = rowsOf<{ exchange_id: string }>(
      await db.execute(candidates(settledWhere)),
    ).length;
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
    // writes would not find it.
    const deleted = rowsOf<{ exchange_id: string }>(
      await db.execute(candidates(sql`${old} AND NOT ${reportedBySameOwner}`)),
    ).length;
    return { settled, noticed, deleted };
  }

  const settled = await db
    .delete(providerExchanges)
    .where(
      sql`${providerExchanges.exchangeId} IN (${candidates(settledWhere)} FOR UPDATE SKIP LOCKED) AND ${settledWhere}`,
    )
    .returning({ exchangeId: providerExchanges.exchangeId });
  const noticed = await db
    .update(providerExchanges)
    .set({ noticedAt: sql`clock_timestamp()` })
    .where(
      sql`${providerExchanges.exchangeId} IN (${candidates(noticeWhere)} FOR UPDATE SKIP LOCKED) AND ${noticeWhere}`,
    )
    .returning({
      exchangeId: providerExchanges.exchangeId,
      sessionId: providerExchanges.sessionId,
      attemptId: providerExchanges.attemptId,
      openedAt: providerExchanges.openedAt,
    });
  const deleted = await db
    .delete(providerExchanges)
    .where(
      sql`${providerExchanges.exchangeId} IN (${candidates(old)} FOR UPDATE SKIP LOCKED) AND ${old}`,
    )
    .returning({ exchangeId: providerExchanges.exchangeId });
  return {
    settled: settled.length,
    noticed,
    deleted: deleted.length,
  };
}
