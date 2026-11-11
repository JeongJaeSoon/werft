import type { SessionAttention } from "@werft-ai/contracts";
import { and, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { openResumeReceipt } from "../resume-control.ts";
import {
  checkpoints,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "../schema.ts";
import { hasRestorePoint } from "./pause-policy.ts";
import { recordEvent, recordStatus } from "./session-events.ts";

type SessionRow = typeof sessions.$inferSelect;

// Terminals a worker reached by running the turn: each changed the engine's
// conversation and possibly the workspace. `outcome_unknown` keeps the
// session in recovery on its own account. `cancelled` is input that never
// ran, or a turn an operator abandoned: resuming from the checkpoint before
// it is what abandon decides, recorded in its audit, not a silent loss —
// counting it would leave start_fresh as the only way past an abandon, since
// no checkpoint ever covers a turn whose outcome was unknown. A turn counts
// only once it was delivered: one the scheduler failed for want of a launch
// never reached an engine.
const RAN_TURN_STATUSES = ["completed", "failed", "interrupted"];

/**
 * The facts a restore rests on: the last turn that ran, and the turn the
 * trusted pointer's checkpoint was taken at. A turn-less checkpoint records
 * no turn it came after, so it covers none; the inner join leaves it out.
 *
 * `revision` names another checkpoint to judge coverage on, still only when
 * the pointer is a restore point. A pause passes the base a fallback restore
 * left the session on, since that is what a resume would restore.
 * The gap check keeps the pointer: turns a fallback dropped were reported
 * by the fallback itself, so they are not a loss nobody was told about.
 */
export type ContextCoverage = {
  lastRanTurn: number | null;
  checkpointedTurn: number | null;
};

export async function contextCoverage(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
  >,
  revision?: number | null,
): Promise<ContextCoverage> {
  const [ran] = await tx
    .select({ sequence: max(turns.sequence) })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, session.id),
        inArray(turns.status, RAN_TURN_STATUSES),
        isNotNull(turns.deliveryStartedAt),
      ),
    );
  const lastRanTurn = ran?.sequence ?? null;
  if (!hasRestorePoint(session)) return { lastRanTurn, checkpointedTurn: null };
  const [pointer] = await tx
    .select({ sequence: turns.sequence })
    .from(checkpoints)
    .innerJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(checkpoints.revision, revision ?? session.checkpointRevision),
      ),
    )
    .limit(1);
  return { lastRanTurn, checkpointedTurn: pointer?.sequence ?? null };
}

/**
 * Whether a new engine session would silently lose turns: a turn
 * ran that neither the trusted checkpoint covers nor a start_fresh decision
 * already wrote off. Turn sequences start at 1, so 0 stands for "none".
 */
export function contextGap(
  session: Pick<SessionRow, "contextResetTurnSequence">,
  coverage: ContextCoverage,
): boolean {
  if (coverage.lastRanTurn === null) return false;
  const covered = Math.max(
    coverage.checkpointedTurn ?? 0,
    session.contextResetTurnSequence ?? 0,
  );
  return coverage.lastRanTurn > covered;
}

/**
 * Takes a session whose next worker could only start without its context
 * out of dispatch and hands it to an operator, inside the caller's
 * transaction and under its session lock. Queued input and its accepted
 * receipts stay as they are: a start_fresh decision runs them, a close
 * cancels them.
 */
export async function raiseContextGap(
  tx: Database,
  input: {
    session: Pick<SessionRow, "id" | "checkpointRevision">;
    coverage: ContextCoverage;
    detectedAt: "claim" | "execution_gone";
    now: Date;
  },
) {
  const { session, coverage, now } = input;
  await tx
    .update(sessions)
    .set({
      admissionState: "recovery_required",
      status: "failed",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  // A resume still waiting on its first ready ends here as well.
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "RECOVERY_REQUIRED",
        message:
          "The checkpoint does not cover the last turn that ran; an operator decides how to go on",
      },
      updatedAt: now,
    })
    .where(openResumeReceipt(session.id));
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  await recordStatus(tx, {
    sessionId: session.id,
    phase: "failed",
    extra: {
      admission_state: "recovery_required",
      reason: "context_gap",
    },
    turnRowId: null,
    now,
  });
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: {
      type: "system",
      subtype: "context_gap_detected",
      last_ran_turn_id: turnIdOf(coverage.lastRanTurn),
      checkpointed_turn_id: turnIdOf(coverage.checkpointedTurn),
      checkpoint_revision:
        coverage.checkpointedTurn === null ? null : session.checkpointRevision,
      detected_at: input.detectedAt,
    },
    turnRowId: null,
    now,
  });
}

/** CONTEXT_GAP for a session held back, or stopped, on a context gap. */
export async function contextGapAttention(
  db: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "admissionState"
    | "checkpointRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
    | "contextResetTurnSequence"
  >,
): Promise<SessionAttention | null> {
  if (
    session.admissionState !== "recovery_required" &&
    session.admissionState !== "stopped"
  ) {
    return null;
  }
  const coverage = await contextCoverage(db, session);
  if (!contextGap(session, coverage)) return null;
  return {
    code: "CONTEXT_GAP",
    last_ran_turn_id: String(coverage.lastRanTurn),
    checkpointed_turn_id: turnIdOf(coverage.checkpointedTurn),
  };
}

function turnIdOf(sequence: number | null): string | null {
  return sequence === null ? null : String(sequence);
}
