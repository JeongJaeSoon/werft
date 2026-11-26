import { ENDED_ATTEMPT_STATES } from "@werft-ai/contracts";
import type { FenceRejection, WorkerFence } from "@werft-ai/platform";
import { and, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { DB_NOW_EPOCH_MS, parseDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { attempts, sessions } from "../schema.ts";

export type SessionRow = typeof sessions.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;

export type Fenced =
  // `at` is the database clock once the row lock was granted.
  | { outcome: "ok"; session: SessionRow; attempt: AttemptRow; at: Date }
  | FenceRejection;

// The fence is taken once, but the checks that follow it are several round
// trips and any of them can block on a lock. The lease is therefore judged
// again just before the first write, so nothing commits — and no work is
// handed out — under a lease that ended mid-transaction.
export function leaseHeld(attempt: AttemptRow, at: Date): boolean {
  return attempt.leaseExpiresAt.getTime() > at.getTime();
}

// Why the fence does not hold, or null when it does: an expired lease on
// the current epoch is LEASE_EXPIRED, anything else (bumped epoch, ended
// attempt) is STALE_EPOCH. `leaseHeld` is judged on the database clock.
export function fenceRejection(
  row: {
    session: Pick<
      SessionRow,
      "leaseEpoch" | "executionGeneration" | "authRevision"
    >;
    attempt: Pick<
      AttemptRow,
      "leaseEpoch" | "executionGeneration" | "authRevision" | "state"
    >;
  },
  fence: WorkerFence,
  leaseHeld: boolean,
): FenceRejection | null {
  const { session, attempt } = row;
  const epochMatches =
    session.leaseEpoch === fence.leaseEpoch &&
    session.executionGeneration === fence.executionGeneration &&
    session.authRevision === fence.authRevision &&
    attempt.leaseEpoch === fence.leaseEpoch &&
    attempt.executionGeneration === fence.executionGeneration &&
    attempt.authRevision === fence.authRevision &&
    !ENDED_ATTEMPT_STATES.includes(attempt.state);
  if (!epochMatches) return { outcome: "stale_epoch" };
  if (!leaseHeld) return { outcome: "lease_expired" };
  return null;
}

// Both tables have an `id`; the CTE's output columns need unique names.
function prefixed<T extends Record<string, PgColumn>>(
  columns: T,
  prefix: string,
) {
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [
      key,
      sql`${column}`.mapWith(column).as(`${prefix}${column.name}`),
    ]),
  ) as { [K in keyof T]: SQL.Aliased<T[K]["_"]["data"]> };
}

// Locks the session and attempt rows and judges the fence on them; an
// unknown binding is STALE_EPOCH. One statement: the clock is read in the
// outer SELECT, above the CTE's row lock, so it is taken after any lock wait
// and judges the rows the lock returned (94S-2244).
export async function acquireFence(
  tx: Database,
  fence: WorkerFence,
): Promise<Fenced> {
  const locked = tx.$with("fence_locked").as(
    tx
      .select({
        session: prefixed(getTableColumns(sessions), "s_"),
        attempt: prefixed(getTableColumns(attempts), "a_"),
      })
      .from(sessions)
      .innerJoin(attempts, eq(attempts.sessionId, sessions.id))
      .where(
        and(eq(sessions.id, fence.sessionId), eq(attempts.id, fence.attemptId)),
      )
      .limit(1)
      .for("update"),
  );
  const [row] = await tx
    .with(locked)
    .select({
      session: locked.session,
      attempt: locked.attempt,
      epochMs: DB_NOW_EPOCH_MS,
    })
    .from(locked);
  if (!row) return { outcome: "stale_epoch" };
  const at = parseDbNow(row.epochMs);
  const { session, attempt } = row;
  const rejected = fenceRejection(row, fence, leaseHeld(attempt, at));
  if (rejected) return rejected;
  // The token has now been accepted for something, whatever that was: an
  // event on no turn, a poll that found nothing. That closes the one-shot
  // bootstrap replay, which would otherwise hand this binding to whoever
  // still holds the nonce and fence the working worker out.
  if (attempt.state === "allocated") {
    await tx
      .update(attempts)
      .set({ state: "starting" })
      .where(eq(attempts.id, attempt.id));
    return {
      outcome: "ok",
      session,
      attempt: { ...attempt, state: "starting" },
      at,
    };
  }
  return { outcome: "ok", session, attempt, at };
}
