import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  RecoveryDecisionResult as RecoveryDecisionReceiptResult,
  RecoveryDecisionRequest,
  ResumeReceiptResult,
} from "@werft-ai/contracts";
import type {
  RecoveryDecisionInput,
  RecoveryDecisionResult,
  ResumeSessionInput,
  ResumeSessionResult,
} from "@werft-ai/platform";
import { publicStatus, receiptActorOf } from "@werft-ai/platform";
import { isUnsupportedFeaturesReason } from "@werft-ai/runtime-core";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  controlClock,
  controlReplay,
  earliestUnknownTurn,
  findIdempotent,
  type IdempotencyScope,
  INPUT_RECEIPT_OPERATIONS,
  lockIdempotencyScope,
  lockSessionForControl,
  openControl,
  parseTurnSequence,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  queuedTurnCount,
  RESUME,
  resumePauseFamily,
} from "./resume-control.ts";
import {
  checkpoints,
  executions,
  idempotencyKeys,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turnContinuations,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { pinRefusesLive } from "./session-spec-pin.ts";
import {
  contextCoverage,
  contextGap,
  ranAfter,
} from "./sessions/context-gap.ts";
import { enqueueWithin } from "./sessions/enqueue.ts";
import { closeParkedGroup } from "./sessions/parked-group.ts";
import {
  hasRestorePoint,
  restoreBaseRevision,
} from "./sessions/pause-policy.ts";
import { cancelParkedRequests } from "./sessions/pending-requests.ts";
import { awaitingInputAt } from "./sessions/pending-status.ts";
import { lockPreviewFeed, lockRequester } from "./sessions/requester-locks.ts";
import {
  INCOMPATIBLE_CHECKPOINT_REASON,
  RESTORE_FAILURE_LIMIT,
  RESTORE_FAILURES_CLEARED,
  RUNTIME_RETIRED_REASON,
} from "./sessions/restore-failures.ts";
import { recordEvent, recordStatus } from "./sessions/session-events.ts";
import { emergencyStopHolds } from "./surface/emergency-stop-hold.ts";

const RECOVERY_DECISION = "recovery_decision";
// The terminal reason of an unknown turn a start_fresh runs again as a new turn.
export const START_FRESH_RERUN_REASON = "operator_start_fresh";
// Control receipts a close supersedes: whichever of these is still open
// was waiting on an outcome the close makes irrelevant.
const SUPERSEDED_CONTROL_OPERATIONS = ["terminate", "resume", "pause", "close"];

type SessionRow = typeof sessions.$inferSelect;

async function turnBySequence(tx: Database, sessionId: string, turnId: string) {
  const sequence = parseTurnSequence(turnId);
  if (sequence === null) return null;
  const [turn] = await tx
    .select({
      id: turns.id,
      sequence: turns.sequence,
      status: turns.status,
      resultJson: turns.resultJson,
    })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
    .limit(1);
  return turn ?? null;
}

/**
 * Where a recovery close applies: a session waiting on an operator
 * (recovery_required), one whose terminate is still waiting on the kill
 * (stopping), and a stopped one that cannot be resumed — no restore point,
 * or an unknown turn left. Anything else is an ordinary close, which this
 * endpoint must not stand in for.
 */
async function closableByRecovery(
  tx: Database,
  session: SessionRow,
): Promise<boolean> {
  if (
    session.admissionState === "recovery_required" ||
    session.admissionState === "stopping"
  ) {
    return true;
  }
  if (session.admissionState !== "stopped") return false;
  return !(await resumableFromStopped(tx, session));
}

/**
 * Whether a stopped session can simply be resumed: a trusted checkpoint to
 * restore, no turn whose outcome is unknown, and no turn that ran after that
 * checkpoint — a resume would bring the session back without it
 * and nobody would be told. start_fresh is the way on for one that cannot.
 */
export async function resumableFromStopped(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
    | "contextResetTurnSequence"
  >,
): Promise<boolean> {
  return (
    hasRestorePoint(session) &&
    (await earliestUnknownTurn(tx, session.id)) === null &&
    !contextGap(session, await contextCoverage(tx, session))
  );
}

/**
 * confirm_completed needs a consistent checkpoint up
 * to the input's watermark. The pointer is only ever moved by finalize, so
 * "consistent" means the committed checkpoint the session's state is based
 * on — the pointer's, or the earlier one a fallback restored — was taken at
 * or after the target turn. An older one would resume the session without
 * the work the operator is confirming.
 */
async function checkpointCovers(
  tx: Database,
  session: SessionRow,
  turnSequence: number,
): Promise<boolean> {
  if (!hasRestorePoint(session)) return false;
  const [row] = await tx
    .select({ sequence: turns.sequence })
    .from(checkpoints)
    .innerJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(
          checkpoints.revision,
          restoreBaseRevision(session) ?? session.checkpointRevision,
        ),
      ),
    )
    .limit(1);
  return row !== undefined && row.sequence >= turnSequence;
}

async function writeReceipt(
  tx: Database,
  input: {
    scope: IdempotencyScope;
    payloadHash: string;
    turnId: string | null;
    result: unknown;
    now: Date;
  },
): Promise<ControlAcceptedResponse> {
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.scope.principal,
    actor: input.scope.actor,
    requestId: input.scope.requestId,
    operation: input.scope.operation,
    targetRef: {
      session_id: input.scope.resource,
      turn_id: input.turnId,
      request_id: null,
    },
    // Complete as soon as it is durable: nothing outside the transaction
    // has to happen for the decision itself to hold.
    status: "succeeded",
    result: input.result,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await tx.insert(idempotencyKeys).values({
    principal: input.scope.principal,
    operation: input.scope.operation,
    resource: input.scope.resource,
    key: input.scope.key,
    payloadHash: input.payloadHash,
    receiptId,
  });
  return { receipt_id: receiptId, receipt_status: "succeeded" };
}

export async function cancelQueuedInput(
  tx: Database,
  input: {
    sessionId: string;
    terminalReason: string;
    error: { code: "SESSION_CLOSED" | "CONTROL_SUPERSEDED"; message: string };
    now: Date;
    /**
     * A stop's cut: input only, no turn that carries on a parked one (the
     * platform's). Every queued turn when unset.
     */
    inputOnly?: boolean;
  },
) {
  const cancelled = await tx
    .update(turns)
    .set({
      status: "cancelled",
      endedAt: input.now,
      terminalReason: input.terminalReason,
    })
    .where(
      and(
        eq(turns.sessionId, input.sessionId),
        eq(turns.status, "queued"),
        input.inputOnly
          ? sql`NOT EXISTS (SELECT 1 FROM ${turnContinuations} c WHERE c.turn_id = ${turns.id})`
          : undefined,
      ),
    )
    .returning({ id: turns.id, sequence: turns.sequence });
  if (cancelled.length === 0) return cancelled;
  await tx.delete(queueMessages).where(
    inArray(
      queueMessages.turnId,
      cancelled.map((turn) => turn.id),
    ),
  );
  // `result` stays for the same reason as in terminate: a retry of the
  // original request replays its acceptance from it.
  await tx
    .update(receipts)
    .set({ status: "failed", error: input.error, updatedAt: input.now })
    .where(
      and(
        inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
        eq(receipts.status, "accepted"),
        sql`${receipts.targetRef}->>'session_id' = ${input.sessionId}`,
        inArray(
          sql`${receipts.targetRef}->>'turn_id'`,
          cancelled.map((turn) => String(turn.sequence)),
        ),
      ),
    );
  return cancelled;
}

// The input receipt an unknown turn left behind. Only `unknown` rows are
// touched: an `accepted` one belongs to input that never ran, and a decision
// never rewrites `result`, which the idempotent retry of the original request
// replays (see for the same defect in finalize).
function unknownInputReceiptOf(sessionId: string, turnSequence: number) {
  return and(
    inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
    eq(receipts.status, "unknown"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
    sql`${receipts.targetRef}->>'turn_id' = ${String(turnSequence)}`,
  );
}

// What the turn keeps once an operator settles it. The worker's finalize
// identity (finalize_key/finalize_hash) goes: a late finalize replay must
// meet a conflict, not a status the worker vocabulary cannot parse. The
// SDK result and usage, if the worker got that far, stay.
function settledResultJson(
  existing: unknown,
  decision: { decision: string; evidence_ref: string | null; reason: string },
): Record<string, unknown> {
  const {
    finalize_key: _key,
    finalize_hash: _hash,
    ...kept
  } = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
  return { ...kept, operator_decision: decision };
}

/**
 * abandon and confirm_completed settle one
 * outcome_unknown turn and leave the session `stopped`, where queued input
 * waits for an explicit resume and the decision receipt says whether one is
 * possible; close ends it. start_fresh and retry_restore put the session
 * back to work and dispatch its queued input.
 */
export function decideRecoveryAtomic(
  db: Database,
  input: RecoveryDecisionInput,
): Promise<RecoveryDecisionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    requestId: input.principal.requestId ?? null,
    operation: RECOVERY_DECISION,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();
  const decision = input.decision;

  return transactionWithBindingRetry(db, async (tx, attempt) => {
    const opened = await openControl(tx, attempt, scope, {
      payloadHash: input.payloadHash,
      // The turn a byTurn start_fresh names pins what it decides.
      expectedRevision:
        input.byTurn &&
        decision.decision === "start_fresh" &&
        decision.target_turn_id !== undefined
          ? null
          : decision.expected_revision,
      now: input.now,
      startedAt,
    });
    if ("done" in opened) return opened.done;
    const { session, now } = opened;
    // Same refusal as terminate: a pod-lifecycle session has no execution
    // whose absence could be confirmed and no kill a close could record.
    if (session.podId !== null && session.executionId === null) {
      return { outcome: "unsupported" };
    }
    // Both put the session back to work, which only turning its channel on
    // again allows.
    if (
      (decision.decision === "start_fresh" ||
        decision.decision === "retry_restore") &&
      (await emergencyStopHolds(tx, sessionId))
    ) {
      return { outcome: "emergency_stopped" };
    }

    let targetTurnRowId: number | null = null;
    let reset: ContextReset | null = null;
    if (decision.decision === "start_fresh") {
      const started = await startFresh(
        tx,
        session,
        decision.target_turn_id ?? null,
        decision.reason,
        now,
      );
      if (started.outcome !== "reset") return started;
      reset = started.reset;
      // The checkpoint a parked turn would resume from is retired with the
      // rest.
      await cancelParkedRequests(tx, { sessionId }, now);
    } else if (decision.decision === "retry_restore") {
      const refused = await retryRestore(tx, session, now);
      if (refused !== null) return refused;
    } else if (decision.decision === "close") {
      if (!(await closableByRecovery(tx, session))) {
        return {
          outcome: "not_in_recovery",
          admissionState: session.admissionState,
        };
      }
      await closeSessionRow(tx, session, now);
    } else {
      // The exit that made the turn unknown must be observed before its
      // outcome is decided: until then the executions row is the only
      // record of what is still running, and confirmExecutionGone may yet
      // write to the same turn.
      if (session.executionId !== null) {
        return { outcome: "execution_unconfirmed" };
      }
      const turn = await turnBySequence(tx, sessionId, decision.target_turn_id);
      if (!turn || turn.status !== "outcome_unknown") {
        return {
          outcome: "turn_not_unknown",
          turnStatus: turn?.status ?? null,
        };
      }
      if (
        decision.decision === "confirm_completed" &&
        !(await checkpointCovers(tx, session, turn.sequence))
      ) {
        return { outcome: "checkpoint_not_covering" };
      }
      targetTurnRowId = turn.id;
      if (decision.decision === "abandon") {
        await abandon(tx, sessionId, turn, decision.reason, now);
      } else {
        await confirmCompleted(tx, sessionId, turn, decision, now);
      }
      await tx
        .update(sessions)
        .set({
          revision: sql`${sessions.revision} + 1`,
          admissionState: "stopped",
          status: "stopped",
          updatedAt: now,
        })
        .where(eq(sessions.id, sessionId));
    }

    const [after] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!after) throw new Error(`Session ${sessionId} vanished mid-decision`);
    // start_fresh announced its own; the others, retry_restore included,
    // put the admission they reached on the stream, as announceStopped does
    // for a stop.
    if (
      reset === null &&
      (after.admissionState !== session.admissionState ||
        after.status !== session.status)
    ) {
      await recordStatus(tx, {
        sessionId,
        phase: publicStatus(
          after.status,
          await awaitingInputAt(tx, sessionId, await dbNow(tx)),
        ),
        extra: {
          admission_state: after.admissionState,
          decision: decision.decision,
          actor: { owner_id: input.principal.ownerId },
        },
        turnRowId: null,
        now,
      });
    }
    const result: RecoveryDecisionReceiptResult = {
      resulting_admission_state: after.admissionState,
      // The revision a resume would restore from, as `resumable` judges it;
      // none once start_fresh retired it.
      checkpoint_revision: reset === null ? restoreBaseRevision(after) : null,
      resumable:
        after.admissionState === "stopped" &&
        after.sourceDeletedAt === null &&
        (await resumableFromStopped(tx, after)),
    };
    // Every control decision leaves its audit record on the session's event
    // stream, where the operator and the SSE reader both find it.
    await recordEvent(tx, {
      sessionId,
      type: "system",
      payload: {
        type: "system",
        subtype: RECOVERY_DECISION,
        decision: decision.decision,
        target_turn_id: targetTurnIdOf(decision),
        evidence_ref:
          decision.decision === "confirm_completed"
            ? decision.evidence_ref
            : null,
        reason: decision.reason,
        actor: { owner_id: input.principal.ownerId },
        ...(reset === null
          ? {}
          : {
              context_reset_turn_id:
                reset.turnSequence === null ? null : String(reset.turnSequence),
              retired_checkpoint_revision: reset.retiredCheckpointRevision,
              cleared_checkpoint_pending_reason: reset.clearedPendingReason,
            }),
        ...result,
      },
      turnRowId: targetTurnRowId,
      now,
    });
    const response = await writeReceipt(tx, {
      scope,
      payloadHash: input.payloadHash,
      turnId: targetTurnIdOf(decision),
      result,
      now,
    });
    return { outcome: "accepted", response };
  });
}

function targetTurnIdOf(decision: RecoveryDecisionRequest): string | null {
  return decision.decision === "abandon" ||
    decision.decision === "confirm_completed"
    ? decision.target_turn_id
    : decision.decision === "start_fresh"
      ? (decision.target_turn_id ?? null)
      : null;
}

type ContextReset = {
  turnSequence: number | null;
  retiredCheckpointRevision: number | null;
  clearedPendingReason: string | null;
};

/**
 * start_fresh: the operator accepts that the turns so far will not
 * be in the engine's context and lets the session go on without them. Every
 * checkpoint up to the current pointer is retired — the next worker starts a
 * new engine session and restores nothing, not even an older checkpoint,
 * which would also roll the workspace back — and the turns that ran stop
 * counting as a gap. A pending checkpoint reason goes with them: it was about
 * the transcript being given up. Queued input is dispatched as on a resume.
 *
 * Offered where the session is out of dispatch waiting on an operator
 * (recovery_required) or stopped without a way to resume; never over an
 * unknown turn, which abandon or confirm_completed settles first, and never
 * while the last execution may still be running.
 */
type StartFreshRefusal = Exclude<
  RecoveryDecisionResult,
  { outcome: "accepted" | "replayed" }
>;

/**
 * A session that never committed a checkpoint, or whose checkpoints a
 * start_fresh retired with nothing but unknown turns run since: no context
 * is there to lose, so an unknown turn is not the operator's to settle
 * first. start_fresh runs it again instead. forgetLostCheckpoints retires
 * the pointer as well but writes no turn off; the turns that ran on the lost
 * checkpoint keep such a session with the operator.
 */
async function noCommittedCheckpoint(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "contextResetCheckpointRevision"
    | "contextResetTurnSequence"
  >,
): Promise<boolean> {
  if (session.checkpointRevision === null) return true;
  if (
    session.contextResetCheckpointRevision === null ||
    session.checkpointRevision > session.contextResetCheckpointRevision
  ) {
    return false;
  }
  const after = session.contextResetTurnSequence ?? 0;
  // A start_fresh writes off every turn its retired checkpoint covers.
  const [covered] = await tx
    .select({ sequence: turns.sequence })
    .from(checkpoints)
    .innerJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(checkpoints.revision, session.checkpointRevision),
        gt(turns.sequence, after),
      ),
    )
    .limit(1);
  return covered === undefined && !(await ranAfter(tx, session.id, after));
}

/**
 * Why start_fresh would be refused now, or the unknown turns it would run
 * again; read by the decision and by the session detail's
 * start_fresh_available. targetTurnId, when given, has to name the earliest
 * unknown turn.
 */
async function startFreshPlan(
  tx: Database,
  session: SessionRow,
  targetTurnId: string | null,
): Promise<{ refused: StartFreshRefusal } | { rerun: number[] }> {
  const eligible =
    session.admissionState === "recovery_required" ||
    (session.admissionState === "stopped" &&
      !(await resumableFromStopped(tx, session)));
  if (!eligible) {
    return {
      refused: {
        outcome: "not_in_recovery",
        admissionState: session.admissionState,
      },
    };
  }
  if (session.executionId !== null) {
    return { refused: { outcome: "execution_unconfirmed" } };
  }
  // start_fresh dispatches queued input like a resume does.
  if (session.executionRevokedAt !== null) {
    return { refused: { outcome: "execution_revoked" } };
  }
  if (session.sourceDeletedAt !== null) {
    return { refused: { outcome: "source_deleted" } };
  }
  const unknown = await earliestUnknownTurn(tx, session.id);
  if (targetTurnId !== null && unknown !== targetTurnId) {
    const turn = await turnBySequence(tx, session.id, targetTurnId);
    return {
      refused: {
        outcome: "turn_not_unknown",
        turnStatus: turn?.status ?? null,
      },
    };
  }
  if (unknown !== null && !(await noCommittedCheckpoint(tx, session))) {
    return { refused: { outcome: "unknown_turn_left", turnId: unknown } };
  }
  // Same as resume: an active session must not have its workspace
  // removed underneath the worker the reset launches.
  if (session.workspaceReclaimId !== null) {
    return { refused: { outcome: "workspace_reclaiming" } };
  }
  if (pinRefusesLive(session)) return { refused: { outcome: "pin_required" } };
  if (unknown === null) return { rerun: [] };
  const rows = await tx
    .select({ sequence: turns.sequence })
    .from(turns)
    .where(
      and(eq(turns.sessionId, session.id), eq(turns.status, "outcome_unknown")),
    )
    .orderBy(turns.sequence);
  return { rerun: rows.map((row) => row.sequence) };
}

/** Whether a start_fresh decision would be taken on the session now. */
export async function startFreshAvailable(
  tx: Database,
  sessionId: string,
): Promise<boolean> {
  const [session] = await tx
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return false;
  if (session.podId !== null && session.executionId === null) return false;
  return "rerun" in (await startFreshPlan(tx, session, null));
}

/**
 * An unknown turn start_fresh runs again: it ends cancelled and its input
 * receipt fails, and a new queued turn at the end of the queue carries the
 * same input, from the same requester and sources. What the first run did
 * outside is not undone.
 */
async function rerunUnknownTurn(
  tx: Database,
  sessionId: string,
  sequence: number,
  reason: string,
  now: Date,
): Promise<number> {
  const [old] = await tx
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
    .limit(1);
  if (!old) throw new Error(`Turn ${sequence} of ${sessionId} vanished`);
  const [last] = await tx
    .select({ sequence: sql<number>`max(${turns.sequence})` })
    .from(turns)
    .where(eq(turns.sessionId, sessionId));
  const next = (last?.sequence ?? sequence) + 1;
  await tx
    .update(turns)
    .set({
      status: "cancelled",
      terminalReason: START_FRESH_RERUN_REASON,
      endedAt: now,
      resultJson: settledResultJson(old.resultJson, {
        decision: "start_fresh",
        evidence_ref: null,
        reason,
      }),
    })
    .where(eq(turns.id, old.id));
  await tx.delete(queueMessages).where(eq(queueMessages.turnId, old.id));
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "CONTROL_SUPERSEDED",
        message: `input run again as turn ${next} by a start_fresh decision; effects the first run had outside are not reverted`,
      },
      updatedAt: now,
    })
    .where(unknownInputReceiptOf(sessionId, sequence));
  const [turn] = await tx
    .insert(turns)
    .values({
      sessionId,
      sequence: next,
      message: old.message,
      status: "queued",
      createdAt: sql`clock_timestamp()`,
      actorId: old.actorId,
      channel: old.channel,
      // The Slack message stays the first turn's: the new one is no reply to it.
      slackMessage: null,
      traceContext: old.traceContext,
      usageBasis: old.usageBasis,
      usageTeamId: old.usageTeamId,
      requesterKind: old.requesterKind,
      requesterId: old.requesterId,
      requesterAuth: old.requesterAuth,
      callerChannel: old.callerChannel,
      callerLimitDigest: old.callerLimitDigest,
      sources: old.sources,
      // What the first delivery put in front of the input is put there again.
      prependedTurn: old.prependedTurn,
      prependSkipReason: old.prependSkipReason,
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert turn");
  await enqueueWithin(tx, {
    sessionId,
    turnId: turn.id,
    payload: { message: old.message },
  });
  return next;
}

async function startFresh(
  tx: Database,
  session: SessionRow,
  targetTurnId: string | null,
  reason: string,
  now: Date,
): Promise<{ outcome: "reset"; reset: ContextReset } | StartFreshRefusal> {
  const plan = await startFreshPlan(tx, session, targetTurnId);
  if ("refused" in plan) return plan.refused;
  // Read before the reruns: the unknown turns ran, and their context goes too.
  const { lastRanTurn } = await contextCoverage(tx, session);
  for (const sequence of plan.rerun) {
    await rerunUnknownTurn(tx, session.id, sequence, reason, now);
  }
  const gaveUp = Math.max(
    lastRanTurn ?? session.contextResetTurnSequence ?? 0,
    ...plan.rerun,
  );
  const reset: ContextReset = {
    turnSequence: gaveUp === 0 ? null : gaveUp,
    retiredCheckpointRevision:
      session.checkpointRevision ?? session.contextResetCheckpointRevision,
    clearedPendingReason: session.checkpointPendingReason,
  };
  const queued = await queuedTurnCount(tx, session.id);
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
      admissionState: "active",
      status: queued > 0 ? "queued" : "idle",
      contextResetTurnSequence: reset.turnSequence,
      contextResetCheckpointRevision: reset.retiredCheckpointRevision,
      checkpointPendingReason: null,
      checkpointPendingAttemptId: null,
      // A fallback base is at or below the retired pointer, so it
      // goes with it.
      checkpointFallbackRevision: null,
      checkpointRestoreAttemptId: null,
      // The failing restore was of a checkpoint that is retired now.
      ...RESTORE_FAILURES_CLEARED,
      updatedAt: now,
      workspaceReclaimedAt: null,
    })
    .where(eq(sessions.id, session.id));
  await signalQueuedInput(tx, session, queued, now);
  await recordStatus(tx, {
    sessionId: session.id,
    phase: queued > 0 ? "queued" : "idle",
    extra: {
      admission_state: "active",
      context_reset_turn_id:
        reset.turnSequence === null ? null : String(reset.turnSequence),
    },
    turnRowId: null,
    now,
  });
  return { outcome: "reset", reset };
}

/**
 * retry_restore: the restores that stopped the session failed on
 * something outside it — a proxy damaging the read in transit, a wrong store
 * path — which the operator has since fixed. The count starts over and the
 * next claim restores what the failing ones did: the pointer is not touched.
 * Queued input is dispatched as on a resume.
 *
 * Only for a session its failed restores stopped. Any other hold
 * — an unknown turn, a context gap, a startup with nothing to restore — is
 * not answered by restoring the same checkpoint again.
 */
async function retryRestore(
  tx: Database,
  session: SessionRow,
  now: Date,
): Promise<Exclude<
  RecoveryDecisionResult,
  { outcome: "accepted" | "replayed" }
> | null> {
  if (
    session.admissionState !== "recovery_required" ||
    (session.restoreFailureCount < RESTORE_FAILURE_LIMIT &&
      session.restoreFailureReason !== INCOMPATIBLE_CHECKPOINT_REASON &&
      session.restoreFailureReason !== RUNTIME_RETIRED_REASON &&
      !isUnsupportedFeaturesReason(session.restoreFailureReason ?? "")) ||
    !hasRestorePoint(session)
  ) {
    return {
      outcome: "not_restore_failed",
      admissionState: session.admissionState,
    };
  }
  if (session.executionId !== null) return { outcome: "execution_unconfirmed" };
  if (session.executionRevokedAt !== null) {
    return { outcome: "execution_revoked" };
  }
  if (session.sourceDeletedAt !== null) return { outcome: "source_deleted" };
  const unknown = await earliestUnknownTurn(tx, session.id);
  if (unknown !== null) {
    return { outcome: "unknown_turn_left", turnId: unknown };
  }
  if (session.workspaceReclaimId !== null) {
    return { outcome: "workspace_reclaiming" };
  }
  if (pinRefusesLive(session)) return { outcome: "pin_required" };
  const queued = await queuedTurnCount(tx, session.id);
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
      admissionState: "active",
      status: queued > 0 ? "queued" : "idle",
      ...RESTORE_FAILURES_CLEARED,
      updatedAt: now,
      workspaceReclaimedAt: null,
    })
    .where(eq(sessions.id, session.id));
  await signalQueuedInput(tx, session, queued, now);
  return null;
}

/**
 * Puts a session that admits work again back in line for a worker when it
 * has input waiting, in its partition; the row may still be
 * there from before, in which case it is re-dated. With nothing queued a
 * leftover signal would launch a worker with no input, so it goes; the next
 * message re-signals.
 */
async function signalQueuedInput(
  tx: Database,
  session: Pick<SessionRow, "id" | "partition">,
  queued: number,
  now: Date,
) {
  if (queued === 0) {
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.id));
    return;
  }
  await tx
    .insert(unassignedSessions)
    .values({
      sessionId: session.id,
      signaledAt: now,
      partition: session.partition,
    })
    .onConflictDoUpdate({
      target: unassignedSessions.sessionId,
      set: { signaledAt: now, partition: session.partition },
    });
}

// The input is given up: it will not run again and its queue head goes,
// but the outcome flag stays true because what the execution did outside
// before it vanished is still unknown. Nothing here undoes those effects.
async function abandon(
  tx: Database,
  sessionId: string,
  turn: { id: number; sequence: number; resultJson: unknown },
  reason: string,
  now: Date,
) {
  await tx
    .update(turns)
    .set({
      status: "cancelled",
      terminalReason: "operator_abandoned",
      endedAt: now,
      resultJson: settledResultJson(turn.resultJson, {
        decision: "abandon",
        evidence_ref: null,
        reason,
      }),
    })
    .where(eq(turns.id, turn.id));
  await tx.delete(queueMessages).where(eq(queueMessages.turnId, turn.id));
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "SESSION_STOPPED",
        message:
          "input abandoned by an operator recovery decision; it will not run again and effects it already had outside are not reverted",
      },
      updatedAt: now,
    })
    .where(unknownInputReceiptOf(sessionId, turn.sequence));
}

// The operator vouches, with evidence, that the turn's work is done. The
// turn ends completed and its input receipt succeeds. The checkpoint pointer
// is not moved (only finalizeAtomic commits one); the caller has already
// checked that it reaches this turn.
async function confirmCompleted(
  tx: Database,
  sessionId: string,
  turn: { id: number; sequence: number; resultJson: unknown },
  decision: { evidence_ref: string; reason: string },
  now: Date,
) {
  await tx
    .update(turns)
    .set({
      status: "completed",
      outcomeUnknown: false,
      terminalReason: "operator_confirmed",
      endedAt: now,
      resultJson: settledResultJson(turn.resultJson, {
        decision: "confirm_completed",
        evidence_ref: decision.evidence_ref,
        reason: decision.reason,
      }),
    })
    .where(eq(turns.id, turn.id));
  await tx.delete(queueMessages).where(eq(queueMessages.turnId, turn.id));
  await tx
    .update(receipts)
    .set({ status: "succeeded", error: null, updatedAt: now })
    .where(unknownInputReceiptOf(sessionId, turn.sequence));
}

// The session ends unrecoverable. Queued input is cancelled and pending
// requests invalidated as for terminate; an execution still bound gets the
// same kill outbox, and whatever control receipt was waiting on that kill
// or on a resume is closed as superseded so nothing stays `accepted`.
// outcome_unknown turns keep that status: closing does not answer them.
export async function closeSessionRow(
  tx: Database,
  session: SessionRow,
  now: Date,
  supersededBy = "superseded by an operator close decision",
): Promise<{ cancelledTurnCount: number }> {
  const cancelled = await cancelQueuedInput(tx, {
    sessionId: session.id,
    terminalReason: "closed",
    error: {
      code: "SESSION_CLOSED",
      message: "input cancelled by close before it ran",
    },
    now,
  });
  await cancelParkedRequests(tx, { sessionId: session.id }, now);
  await tx
    .update(pendingRequests)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(pendingRequests.sessionId, session.id),
        isNull(pendingRequests.resolvedAt),
      ),
    );
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  if (session.executionId !== null) {
    const outbox = await tx
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, session.executionId))
      .returning({ id: executions.id });
    if (outbox.length !== 1) {
      throw new Error(
        `Session ${session.id} points at execution ${session.executionId} which has no row`,
      );
    }
    // As in terminate: a rebuild the scheduler still intends
    // would otherwise follow the kill.
    await tx
      .update(workerLaunches)
      .set({ replacementReason: null })
      .where(eq(workerLaunches.executionId, session.executionId));
  }
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "CONTROL_SUPERSEDED",
        message: supersededBy,
      },
      updatedAt: now,
    })
    .where(
      and(
        inArray(receipts.operation, SUPERSEDED_CONTROL_OPERATIONS),
        inArray(receipts.status, ["accepted", "unknown"]),
        sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
      ),
    );
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      // The epoch moves whether or not something is bound: a worker that
      // was still up is fenced out from here.
      leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
      admissionState: "closed",
      status: "stopped",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  return { cancelledTurnCount: cancelled.length };
}

/**
 * A stopped session admits input
 * again from its committed checkpoint. Unknown turns and unconfirmed exits
 * are the operator's to settle first, and a session with no checkpoint has
 * nothing to restore. Cancelled input stays cancelled; what is still
 * queued is signalled for a new worker. `paused` and `pausing` are handed
 * to resumePauseFamily.
 */
export function resumeAtomic(
  db: Database,
  input: ResumeSessionInput,
): Promise<ResumeSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    requestId: input.principal.requestId ?? null,
    operation: RESUME,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();

  return transactionWithBindingRetry(db, async (tx, attempt) => {
    await lockIdempotencyScope(tx, scope);
    const existing = await findIdempotent(tx, scope);
    const replay = controlReplay(existing, input.payloadHash);
    if (replay) return replay;
    // Fixed at create, so read before the session lock: a preview's requester
    // rows are taken first, in the order requester-locks.ts gives.
    const [kind] = await tx
      .select({
        preview: sessions.preview,
        workspaceId: sessions.workspaceId,
        agentReleaseId: sessions.agentReleaseId,
      })
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.ownerId, scope.principal)),
      )
      .limit(1);
    const requester = kind?.preview
      ? await lockRequester(tx, input.principal, "sessions:write")
      : null;
    const session = await lockSessionForControl(tx, {
      sessionId,
      ownerId: scope.principal,
      attempt,
    });
    if (!session) return { outcome: "not_found" };
    if (
      kind?.preview &&
      !(await lockPreviewFeed(tx, input.principal, requester, kind))
    ) {
      return { outcome: "preview_refused" };
    }
    const now = controlClock(input.now, startedAt);
    if (session.admissionState === "closed") {
      return { outcome: "rejected", admissionState: "closed" };
    }
    if (session.revision !== input.expectedRevision) {
      return {
        outcome: "revision_conflict",
        currentRevision: session.revision,
      };
    }
    // whatever state the revocation left, the owner cannot bring
    // the execution back; only the operator's restore lifts it.
    if (session.executionRevokedAt !== null) {
      return { outcome: "execution_revoked" };
    }
    // Stopped for a deleted source: nothing brings it back, close ends it.
    if (session.sourceDeletedAt !== null) return { outcome: "source_deleted" };
    // An admin stopped the agent in the session's channel: only turning the
    // channel on again lets it go on.
    if (await emergencyStopHolds(tx, sessionId)) {
      return { outcome: "emergency_stopped" };
    }
    // stopping: the kill is not yet observed. recovery_required: a turn is
    // unknown. Both are RECOVERY_REQUIRED to the caller.
    if (
      session.admissionState === "stopping" ||
      session.admissionState === "recovery_required"
    ) {
      return {
        outcome: "recovery_required",
        unconfirmedTurnId: await earliestUnknownTurn(tx, sessionId),
      };
    }
    if (
      session.admissionState === "paused" ||
      session.admissionState === "pausing"
    ) {
      return resumePauseFamily(tx, session, {
        scope,
        payloadHash: input.payloadHash,
        ownerId: input.principal.ownerId,
        now,
      });
    }
    if (session.admissionState !== "stopped") {
      return { outcome: "rejected", admissionState: session.admissionState };
    }
    const unknown = await earliestUnknownTurn(tx, sessionId);
    if (unknown !== null) {
      return { outcome: "recovery_required", unconfirmedTurnId: unknown };
    }
    // Resuming onto an untrusted pointer would also wedge an idle session:
    // appends stay refused while the blocker stands, and only a new run's
    // checkpoint clears it. Resuming onto one that predates a turn that ran
    // would bring the session back without that turn. start_fresh
    // or close is the way out instead.
    if (
      !hasRestorePoint(session) ||
      !(await resumableFromStopped(tx, session))
    ) {
      return { outcome: "checkpoint_unavailable" };
    }
    if (session.podId !== null) return { outcome: "unsupported" };
    // Checked last, so a refusal that retrying cannot fix is the one given.
    if (session.workspaceReclaimId !== null) {
      return { outcome: "workspace_reclaiming" };
    }
    if (pinRefusesLive(session)) return { outcome: "pin_required" };

    // As from a pause: a parked turn the stop left waiting goes on once
    // nothing it asked is still open.
    const parked = await closeParkedGroup(tx, session, {
      by: "resume",
      at: await dbNow(tx),
    });
    if (parked.outcome === "pending_requests_open") return parked;

    const queued = await queuedTurnCount(tx, sessionId);
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
        admissionState: "active",
        status: queued > 0 ? "queued" : "idle",
        updatedAt: now,
        workspaceReclaimedAt: null,
      })
      .where(eq(sessions.id, sessionId));
    await signalQueuedInput(tx, session, queued, now);
    // The revision the next worker restores: after a fallback, not the
    // damaged pointer.
    const restoredFrom =
      session.checkpointFallbackRevision ?? session.checkpointRevision;
    const result: ResumeReceiptResult = {
      resulting_admission_state: "active",
      checkpoint_revision: restoredFrom,
      queued_turn_count: queued,
    };
    await recordStatus(tx, {
      sessionId,
      phase: queued > 0 ? "queued" : "idle",
      extra: {
        admission_state: "active",
        resumed_from_checkpoint_revision: restoredFrom,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    const response = await writeReceipt(tx, {
      scope,
      payloadHash: input.payloadHash,
      turnId: null,
      result,
      now,
    });
    return { outcome: "accepted", response };
  });
}
