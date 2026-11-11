import type { FenceRejection, WorkerFence } from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { ENDED_ATTEMPT_STATES } from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
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

// Locks the session and attempt rows and classifies why the fence does not
// hold: an expired lease on the current epoch is LEASE_EXPIRED, anything
// else (bumped epoch, ended attempt, unknown binding) is STALE_EPOCH.
export async function acquireFence(
  tx: Database,
  fence: WorkerFence,
): Promise<Fenced> {
  const [row] = await tx
    .select({ session: sessions, attempt: attempts })
    .from(sessions)
    .innerJoin(attempts, eq(attempts.sessionId, sessions.id))
    .where(
      and(eq(sessions.id, fence.sessionId), eq(attempts.id, fence.attemptId)),
    )
    .limit(1)
    .for("update");
  if (!row) return { outcome: "stale_epoch" };
  const at = await dbNow(tx);
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
  if (!leaseHeld(attempt, at)) return { outcome: "lease_expired" };
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
