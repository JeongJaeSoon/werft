import {
  checkpointBlockReasonSchema,
  type SessionAttention,
  type SessionDurability,
} from "@werft-ai/contracts";
import {
  type CheckpointBlockReason,
  type CheckpointPreparation,
  TRANSCRIPT_LIMITS,
  type TranscriptLimits,
  transcriptWarnBytes,
} from "@werft-ai/runtime-core";

/** What each refusal means for the session, once the runtime reports it. */
export type CheckpointReasonKind =
  /**
   * The run was not quiescent — a tool still running, a background task (a
   * dev server may run for hours, §1.1), or another checkpoint holding the
   * lease. The previous generation stays the one to resume from and the
   * reason is recorded so it is visible, but work goes on: holding turns back
   * for a server the agent was asked to keep running would stall the session.
   * Any later commit clears it, from this attempt or another.
   * `publish_failed` is the same for a run that was ready but whose
   * checkpoint could not be written — a workspace the capture refused, a
   * manifest over the limits, a store that failed. The ones that persist (a
   * workspace too large to capture) are not fixed by holding turns back, and
   * a replaced worker still refuses to go on past turns no checkpoint covers.
   */
  | "advisory"
  /**
   * A dropped mirror batch. The stored transcript is short entries nobody can
   * enumerate and every later turn builds on a session that cannot be
   * restored, so it is recorded and holds work back until a checkpoint from
   * *another* attempt commits (this run's transcript never recovers).
   */
  | "blocking"
  /**
   * The transcript is past `TRANSCRIPT_LIMITS`, and it only ever grows, so no
   * later checkpoint of this engine session can carry it. New turns are
   * refused, as for `blocking`, but the session is not broken: the turn that
   * crossed the limit ran and is recorded completed without a checkpoint, and
   * the last committed checkpoint is still the one to resume from. It is
   * cleared the way a blocking reason is, or by start_fresh.
   */
  | "exhausted"
  /**
   * A turn in flight, or a run that has not started one. The next safe
   * boundary checkpoints as usual; nothing is recorded.
   */
  | "ordinary";

const CHECKPOINT_REASONS: Record<CheckpointBlockReason, CheckpointReasonKind> =
  {
    background_writer: "advisory",
    checkpoint_lease_held: "advisory",
    mirror_error: "blocking",
    no_engine_session: "ordinary",
    publish_failed: "advisory",
    tool_in_flight: "advisory",
    transcript_part_too_large: "exhausted",
    transcript_too_large: "exhausted",
    turn_in_flight: "ordinary",
  };

// Which reason a session keeps when another is reported over it.
const RANK: Record<CheckpointReasonKind, number> = {
  ordinary: 0,
  advisory: 1,
  exhausted: 2,
  blocking: 3,
};

/** Whether a stored pending reason refuses new turns. */
export function checkpointReasonHoldsWork(
  reason: CheckpointBlockReason | null,
): boolean {
  return reason !== null && RANK[CHECKPOINT_REASONS[reason]] >= RANK.exhausted;
}

/**
 * Whether a stored pending reason also distrusts the pointer: the session has
 * no restore point and a completed turn is recorded only with a checkpoint.
 */
export function checkpointReasonBlocks(
  reason: CheckpointBlockReason | null,
): boolean {
  return reason !== null && CHECKPOINT_REASONS[reason] === "blocking";
}

/**
 * checkpointReasonHoldsWork for the reason as the session row stores it
 * (text). A value this build does not know counts as blocking: trusting a
 * pointer on an unrecognised reason is the unsafe direction.
 */
export function storedPendingReasonHoldsWork(stored: string | null): boolean {
  if (stored === null) return false;
  const parsed = checkpointBlockReasonSchema.safeParse(stored);
  return !parsed.success || checkpointReasonHoldsWork(parsed.data);
}

/** checkpointReasonBlocks for the stored text, unknown values included. */
export function storedPendingReasonBlocks(stored: string | null): boolean {
  if (stored === null) return false;
  const parsed = checkpointBlockReasonSchema.safeParse(stored);
  return !parsed.success || checkpointReasonBlocks(parsed.data);
}

/** The reason to record for a refusal, or null when it leaves no trace. */
export function checkpointPendingReason(
  preparation: CheckpointPreparation,
): CheckpointBlockReason | null {
  if (preparation.status === "ready") return null;
  return CHECKPOINT_REASONS[preparation.reason] === "ordinary"
    ? null
    : preparation.reason;
}

/**
 * The pending reason after `reported` is recorded over `stored`. A weaker
 * refusal never replaces a stronger one: an advisory one would let the
 * session take turns again on a transcript it still cannot checkpoint, and
 * an exhausted one would trust a pointer a lost mirror batch left behind.
 */
export function nextPendingReason(
  stored: CheckpointBlockReason | null,
  reported: CheckpointBlockReason,
): CheckpointBlockReason {
  if (stored === null) return reported;
  return RANK[CHECKPOINT_REASONS[reported]] >= RANK[CHECKPOINT_REASONS[stored]]
    ? reported
    : stored;
}

export type DurabilityFacts = {
  checkpointCommittedAt: Date | null;
  checkpointFallbackRevision: number | null;
  checkpointRevision: number | null;
  contextResetTurnId: string | null;
  lastCheckpointedTurnId: string | null;
  lastCompletedTurnId: string | null;
  lastTranscriptPersistedAt: Date | null;
  pendingReason: CheckpointBlockReason | "unknown" | null;
};

export function projectDurability(facts: DurabilityFacts): SessionDurability {
  return {
    checkpoint_committed_at: facts.checkpointCommittedAt?.toISOString() ?? null,
    checkpoint_fallback_revision: facts.checkpointFallbackRevision,
    checkpoint_pending_reason: facts.pendingReason,
    checkpoint_revision: facts.checkpointRevision,
    context_reset_turn_id: facts.contextResetTurnId,
    last_checkpointed_turn_id: facts.lastCheckpointedTurnId,
    last_completed_turn_id: facts.lastCompletedTurnId,
    last_transcript_persisted_at:
      facts.lastTranscriptPersistedAt?.toISOString() ?? null,
  };
}

/**
 * TRANSCRIPT_LIMIT for a session whose pending reason is a transcript limit,
 * or whose last committed checkpoint is at the warning threshold or past it.
 */
export function transcriptLimitAttention(
  storedPendingReason: string | null,
  committedTranscriptBytes: number | null,
  limits: TranscriptLimits = TRANSCRIPT_LIMITS,
): SessionAttention | null {
  if (
    storedPendingReason === "transcript_too_large" ||
    storedPendingReason === "transcript_part_too_large"
  ) {
    return {
      code: "TRANSCRIPT_LIMIT",
      reason: storedPendingReason,
      transcript_bytes: committedTranscriptBytes,
      limit_bytes:
        storedPendingReason === "transcript_part_too_large"
          ? limits.partBytes
          : limits.totalBytes,
    };
  }
  if (
    committedTranscriptBytes === null ||
    committedTranscriptBytes < transcriptWarnBytes(limits)
  ) {
    return null;
  }
  return {
    code: "TRANSCRIPT_LIMIT",
    reason: "transcript_near_limit",
    transcript_bytes: committedTranscriptBytes,
    limit_bytes: limits.totalBytes,
  };
}

/** The system event a newly recorded transcript limit reason is announced with. */
export function transcriptLimitReachedEvent(
  reason: "transcript_part_too_large" | "transcript_too_large",
  limits: TranscriptLimits = TRANSCRIPT_LIMITS,
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "transcript_limit_reached",
    reason,
    limit_bytes:
      reason === "transcript_part_too_large"
        ? limits.partBytes
        : limits.totalBytes,
  };
}

export { TRANSCRIPT_LIMITS, transcriptWarnBytes };
