import type { SessionAttention } from "@werft-ai/contracts";
import { launchRetryDelayMs } from "@werft-ai/platform";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import {
  hasRestorePoint,
  LAUNCHABLE_ADMISSION_STATES,
  restoreBaseRevision,
} from "./control-shared.ts";
import { DB_NOW, fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { recordEvent, recordStatus } from "./sessions/session-events.ts";

type SessionRow = typeof sessions.$inferSelect;

/**
 * Claimed launches an active session may spend on a worker that ends before
 * it is ready for input, as a resume may
 * (RESUME_LAUNCH_LIMIT). One such exit says little — a deploy's SIGTERM, a
 * read damaged in transit — so the next launch waits out the startup backoff
 * (30s, then 60s) and tries again; a startup that keeps failing, whether it
 * restores a checkpoint or clones the repository, is for an operator.
 */
export const RESTORE_FAILURE_LIMIT = 3;

/** A deterministic runtime mismatch cannot succeed on another launch. */
export const INCOMPATIBLE_CHECKPOINT_REASON = "incompatible_checkpoint";

const INCOMPATIBLE_CHECKPOINT_PREFIX =
  "Checkpoint restore refused (INCOMPATIBLE_CHECKPOINT):";

/** Leaves room for the worker's error while keeping it one line of a row. */
const REASON_MAX_CHARS = 500;

/** Nothing is launched for a session while its restore backoff runs. */
export function restoreRetryDue() {
  return or(
    isNull(sessions.restoreRetryAt),
    lte(sessions.restoreRetryAt, DB_NOW),
  );
}

/** A worker ready for input, or a checkpoint given up: the count starts over. */
export const RESTORE_FAILURES_CLEARED = {
  restoreAttemptId: null,
  restoreFailureCount: 0,
  restoreRetryAt: null,
  restoreFailureReason: null,
} as const;

/**
 * A session with a restore point hands every claim a checkpoint, so its
 * failed startups are failed restores; one without has only the workspace
 * and the engine to start. Judged on the row alone: a checkpoint commits
 * only from a worker that took input, which clears the count.
 */
function startupFailure(
  session: Pick<
    SessionRow,
    | "checkpointPendingReason"
    | "checkpointRevision"
    | "contextResetCheckpointRevision"
  >,
): "restore" | "startup" {
  return hasRestorePoint(session) ? "restore" : "startup";
}

/**
 * Counts the `attemptId` that ended before it was ready for input, in the
 * caller's gone transaction and after the session row there has cleared its
 * binding. Below the limit the session stays active and is signalled again
 * as usual, but not launched before its backoff ends. At the limit it waits
 * in recovery_required with its input kept, like a context gap: start_fresh
 * goes on (without the checkpoint, if there is one), close ends the session.
 */
export async function recordStartupFailure(
  tx: Database,
  input: { session: SessionRow; attemptId: string; now: Date },
): Promise<"backing_off" | "recovery_required"> {
  const { session, now } = input;
  const [attempt] = await tx
    .select({ endReason: attempts.endReason })
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
    .limit(1);
  const endReason = attempt?.endReason ?? "execution_gone";
  const restoring = startupFailure(session) === "restore";
  const incompatible =
    restoring &&
    (endReason === INCOMPATIBLE_CHECKPOINT_REASON ||
      endReason.startsWith(INCOMPATIBLE_CHECKPOINT_PREFIX));
  const reason = incompatible
    ? INCOMPATIBLE_CHECKPOINT_REASON
    : boundedReason(endReason);
  const failures = session.restoreFailureCount + 1;
  const stopped = incompatible || failures >= RESTORE_FAILURE_LIMIT;
  const [updated] = await tx
    .update(sessions)
    .set({
      restoreFailureCount: failures,
      restoreFailureReason: reason,
      restoreRetryAt: stopped ? null : fromDbNow(launchRetryDelayMs(failures)),
      ...(stopped
        ? {
            status: "failed" as const,
            admissionState: "recovery_required" as const,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id))
    .returning({ retryAt: sessions.restoreRetryAt });
  const failure = {
    type: "system",
    subtype: restoring ? "checkpoint_restore_failed" : "startup_failed",
    ...(restoring
      ? {
          // What the attempt was restoring: a fallback's base when
          // its plan fell back, the pointer otherwise.
          checkpoint_revision:
            session.checkpointRestoreAttemptId === input.attemptId
              ? restoreBaseRevision(session)
              : session.checkpointRevision,
        }
      : {}),
    failures,
    limit: RESTORE_FAILURE_LIMIT,
    reason,
    retry_at: updated?.retryAt?.toISOString() ?? null,
  };
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: failure,
    attemptId: input.attemptId,
    turnRowId: null,
    now,
  });
  if (!stopped) return "backing_off";
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  await recordStatus(tx, {
    sessionId: session.id,
    phase: "failed",
    extra: {
      admission_state: "recovery_required",
      reason: incompatible
        ? INCOMPATIBLE_CHECKPOINT_REASON
        : restoring
          ? "restore_failed"
          : "startup_failed",
    },
    turnRowId: null,
    now,
  });
  return "recovery_required";
}

/**
 * What a restore refusing the checkpoint as incompatible records, before
 * anything is launched: no configured worker image can resume it. Stale
 * when the session left launchable admission, its pointer moved past
 * `checkpointRevision`, or a launch holds a slot for it.
 */
export async function holdIncompatibleBeforeLaunch(
  db: Database,
  input: {
    sessionId: string;
    checkpointRevision: number;
    detail: string;
    now: Date;
  },
): Promise<"held" | "stale"> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1)
      .for("update");
    if (
      session === undefined ||
      !LAUNCHABLE_ADMISSION_STATES.includes(session.admissionState) ||
      // start_fresh keeps the revision and retires the checkpoint instead.
      !hasRestorePoint(session) ||
      session.checkpointRevision !== input.checkpointRevision
    ) {
      return "stale";
    }
    const [open] = await tx
      .select({ executionId: workerLaunches.executionId })
      .from(workerLaunches)
      .where(
        and(
          eq(workerLaunches.sessionId, input.sessionId),
          isNull(workerLaunches.slotReleasedAt),
        ),
      )
      .limit(1);
    if (open !== undefined) return "stale";
    const failures = session.restoreFailureCount + 1;
    await tx
      .update(sessions)
      .set({
        restoreFailureCount: failures,
        restoreFailureReason: INCOMPATIBLE_CHECKPOINT_REASON,
        restoreRetryAt: null,
        status: "failed",
        admissionState: "recovery_required",
        updatedAt: input.now,
      })
      .where(eq(sessions.id, input.sessionId));
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, input.sessionId));
    await recordEvent(tx, {
      sessionId: input.sessionId,
      type: "system",
      payload: {
        type: "system",
        subtype: "checkpoint_restore_failed",
        checkpoint_revision: input.checkpointRevision,
        detected_at: "launch",
        detail: boundedReason(input.detail),
        failures,
        limit: RESTORE_FAILURE_LIMIT,
        reason: INCOMPATIBLE_CHECKPOINT_REASON,
        retry_at: null,
      },
      turnRowId: null,
      now: input.now,
    });
    await recordStatus(tx, {
      sessionId: input.sessionId,
      phase: "failed",
      extra: {
        admission_state: "recovery_required",
        reason: INCOMPATIBLE_CHECKPOINT_REASON,
      },
      turnRowId: null,
      now: input.now,
    });
    return "held";
  });
}

/**
 * RESTORE_FAILED, or STARTUP_FAILED for a session with nothing to restore,
 * while its startups are failing, backing off or given up on.
 */
export function startupFailedAttention(
  session: Pick<
    SessionRow,
    | "admissionState"
    | "checkpointPendingReason"
    | "checkpointRevision"
    | "contextResetCheckpointRevision"
    | "restoreFailureCount"
    | "restoreFailureReason"
    | "restoreRetryAt"
  >,
): SessionAttention | null {
  if (
    session.restoreFailureCount === 0 ||
    (session.admissionState !== "active" &&
      session.admissionState !== "recovery_required")
  ) {
    return null;
  }
  return {
    code:
      startupFailure(session) === "restore"
        ? "RESTORE_FAILED"
        : "STARTUP_FAILED",
    reason: session.restoreFailureReason ?? "execution_gone",
    failures: session.restoreFailureCount,
    retry_at: session.restoreRetryAt?.toISOString() ?? null,
  };
}

/** A worker's release reason as the database keeps it: one line, bounded. */
export function boundedReason(reason: string): string {
  const line = reason.split(/[\r\n]/, 1)[0]?.trim() || "execution_gone";
  return line.length <= REASON_MAX_CHARS
    ? line
    : `${line.slice(0, REASON_MAX_CHARS - 1)}…`;
}
