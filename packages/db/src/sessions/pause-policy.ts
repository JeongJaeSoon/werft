import type {
  PauseBlockedReason,
  PauseReceiptResult,
} from "@werft-ai/contracts";
import {
  type ResumeSessionResult,
  storedPendingReasonBlocks,
} from "@werft-ai/platform";

type RestorePoint = {
  checkpointRevision: number | null;
  checkpointPendingReason: string | null;
  contextResetCheckpointRevision: number | null;
};

/**
 * Advisory capture failures leave the previous pointer trusted. A missing
 * mirror batch or an unknown reason does not; neither does a checkpoint
 * retired by start_fresh. A later checkpoint can restore trust.
 * Checkpoints do not record their attempt, so even an earlier healthy
 * pointer is conservatively distrusted after a mirror gap.
 */
export function hasRestorePoint<T extends RestorePoint>(
  session: T,
): session is T & { checkpointRevision: number } {
  return (
    session.checkpointRevision !== null &&
    !storedPendingReasonBlocks(session.checkpointPendingReason) &&
    (session.contextResetCheckpointRevision === null ||
      session.checkpointRevision > session.contextResetCheckpointRevision)
  );
}

/** A fallback is the state actually restored, even while the pointer is newer. */
export function restoreBaseRevision(session: {
  checkpointRevision: number | null;
  checkpointFallbackRevision: number | null;
}): number | null {
  return session.checkpointFallbackRevision ?? session.checkpointRevision;
}

export function pauseCoverageBlocker(coverage: {
  lastRanTurn: number | null;
  checkpointedTurn: number | null;
}): PauseBlockedReason | null {
  if (coverage.lastRanTurn === null) return null;
  // A turn-less checkpoint proves no turn it was taken after.
  return coverage.checkpointedTurn !== null &&
    coverage.checkpointedTurn >= coverage.lastRanTurn
    ? null
    : "checkpoint_unavailable";
}

export function pausedReceiptResult(
  session: {
    checkpointRevision: number | null;
    checkpointFallbackRevision: number | null;
  },
  queuedTurnCount: number,
): PauseReceiptResult {
  return {
    resulting_admission_state: "paused",
    checkpoint_revision: restoreBaseRevision(session),
    queued_turn_count: queuedTurnCount,
  };
}

export function pausedResumeRefusal(
  session: RestorePoint & { podId: string | null },
  unknownTurnId: string | null,
): Extract<
  ResumeSessionResult,
  { outcome: "recovery_required" | "checkpoint_unavailable" | "unsupported" }
> | null {
  if (unknownTurnId !== null) {
    return { outcome: "recovery_required", unconfirmedTurnId: unknownTurnId };
  }
  if (!hasRestorePoint(session)) return { outcome: "checkpoint_unavailable" };
  if (session.podId !== null) return { outcome: "unsupported" };
  return null;
}
