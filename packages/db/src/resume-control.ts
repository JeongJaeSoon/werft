import { randomUUID } from "node:crypto";
import type {
  ApiErrorCode,
  ControlAcceptedResponse,
  ReceiptActor,
  ReceiptStatus,
  ResumeReceiptResult,
} from "@werft-ai/contracts";
import {
  type ResumeSessionResult,
  storedPendingReasonHoldsWork,
} from "@werft-ai/platform";
import { and, count, eq, gt, notInArray, sql } from "drizzle-orm";
import {
  earliestUnknownTurn,
  type IdempotencyScope,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import { awaitingInputAt, publicStatus } from "./decision/pending-status.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  executions,
  idempotencyKeys,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { pinRefusesLive } from "./session-spec-pin.ts";
import { closeParkedGroup } from "./sessions/parked-group.ts";
import { openPauseReceipt } from "./sessions/pause-control.ts";
import { pausedResumeRefusal } from "./sessions/pause-policy.ts";
import { recordStatus } from "./sessions/session-events.ts";

export const RESUME = "resume";

type SessionRow = typeof sessions.$inferSelect;
/**
 * A resume receipt's target: the session, plus, for a resume from `paused`,
 * the lease epoch it moved the session to. The receipt reader reads only the
 * session fields.
 */
type ResumeTarget = {
  session_id: string;
  turn_id: null;
  request_id: null;
  after_epoch?: number;
};
type ReceiptError = { code: ApiErrorCode; message: string };

/**
 * The resume receipt waiting on a new worker's restore. Only a `resuming`
 * session holds one, and it is looked up only then, for the same reason as
 * openPauseReceipt: the target_ref match has no index.
 */
export function openResumeReceipt(sessionId: string) {
  return and(
    eq(receipts.operation, RESUME),
    eq(receipts.status, "accepted"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
  );
}

export async function queuedTurnCount(tx: Database, sessionId: string) {
  const [row] = await tx
    .select({ queued: count() })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")));
  return row?.queued ?? 0;
}

async function resumeReceiptResult(
  tx: Database,
  session: Pick<SessionRow, "id" | "checkpointRevision">,
): Promise<ResumeReceiptResult> {
  return {
    resulting_admission_state: "active",
    checkpoint_revision: session.checkpointRevision,
    queued_turn_count: await queuedTurnCount(tx, session.id),
  };
}

/**
 * A resume that cannot complete: the session goes to recovery_required and
 * the resume receipt fails with why. Retrying from `paused` would advertise
 * a restore point that may be damaged, so an operator decides instead.
 */
export async function failResume(
  tx: Database,
  input: { sessionId: string; error: ReceiptError; now: Date },
) {
  await tx
    .update(sessions)
    .set({
      admissionState: "recovery_required",
      status: "failed",
      updatedAt: input.now,
    })
    .where(eq(sessions.id, input.sessionId));
  await tx
    .update(receipts)
    .set({ status: "failed", error: input.error, updatedAt: input.now })
    .where(openResumeReceipt(input.sessionId));
  await recordStatus(tx, {
    sessionId: input.sessionId,
    phase: "failed",
    extra: {
      admission_state: "recovery_required",
      resume_failed: input.error,
    },
    turnRowId: null,
    now: input.now,
  });
}

/**
 * Claimed launches a resume may spend before a worker reports ready. An exit
 * before ready says nothing about the checkpoint on its own (a deploy's
 * SIGTERM, a workspace fetch that timed out), and no input was handed out,
 * so the same immutable checkpoint is tried again; a restore that keeps
 * dying is damage an operator has to look at. Refusals the gateway can name
 * (restore verdict, revision mismatch) fail the resume on the first try.
 */
export const RESUME_LAUNCH_LIMIT = 3;

/**
 * How many attempts claimed the session since its open resume was accepted,
 * the one ending now included. Counted by lease epoch: the resume records
 * the epoch it moved the session to, and every claim after it moves the
 * session's own epoch past that, under the session lock, whatever generation
 * or clock the launching process supplied. A receipt without that baseline
 * counts as spent, so the resume fails closed.
 */
export async function resumeLaunchesSpent(
  tx: Database,
  sessionId: string,
): Promise<number> {
  const [open] = await tx
    .select({ targetRef: receipts.targetRef })
    .from(receipts)
    .where(openResumeReceipt(sessionId))
    .limit(1);
  const baseline = (open?.targetRef as ResumeTarget | undefined)?.after_epoch;
  if (typeof baseline !== "number") return Number.POSITIVE_INFINITY;
  const [row] = await tx
    .select({ spent: count() })
    .from(attempts)
    .where(
      and(eq(attempts.sessionId, sessionId), gt(attempts.leaseEpoch, baseline)),
    );
  return row?.spent ?? 0;
}

/**
 * The new worker restored the checkpoint and its engine loaded it: the
 * session admits input again and the resume receipt succeeds, in the
 * caller's fenced transaction. The revision is not bumped, as the pause's
 * own settlement does not bump it either.
 */
export async function completeResume(
  tx: Database,
  session: Pick<SessionRow, "id" | "checkpointRevision">,
  now: Date,
) {
  const result = await resumeReceiptResult(tx, session);
  await tx
    .update(sessions)
    .set({
      admissionState: "active",
      status: result.queued_turn_count > 0 ? "queued" : "idle",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  await tx
    .update(receipts)
    .set({ status: "succeeded", error: null, result, updatedAt: now })
    .where(openResumeReceipt(session.id));
  await recordStatus(tx, {
    sessionId: session.id,
    phase: result.queued_turn_count > 0 ? "queued" : "idle",
    extra: {
      admission_state: "active",
      resumed_from_checkpoint_revision: session.checkpointRevision,
    },
    turnRowId: null,
    now,
  });
}

async function writeResumeReceipt(
  tx: Database,
  input: {
    scope: IdempotencyScope;
    payloadHash: string;
    status: ReceiptStatus;
    result: ResumeReceiptResult | null;
    error: ReceiptError | null;
    now: Date;
    afterEpoch?: number;
  },
): Promise<ControlAcceptedResponse> {
  const receiptId = randomUUID();
  const targetRef: ResumeTarget = {
    session_id: input.scope.resource,
    turn_id: null,
    request_id: null,
    ...(input.afterEpoch === undefined
      ? {}
      : { after_epoch: input.afterEpoch }),
  };
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.scope.principal,
    actor: input.scope.actor,
    requestId: input.scope.requestId,
    operation: RESUME,
    targetRef,
    status: input.status,
    result: input.result,
    error: input.error,
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
  return { receipt_id: receiptId, receipt_status: input.status };
}

type ResumeContext = {
  scope: IdempotencyScope;
  payloadHash: string;
  ownerId: string;
  now: Date;
};

/**
 * The pause family. From `paused` the
 * session goes `resuming` and a new worker is launched to restore the
 * pause's checkpoint; the receipt succeeds only once that worker reports
 * ready. From `pausing`, before the stop intent, the resume cancels the
 * pause instead. The caller holds the session lock (lockSessionForControl)
 * and has checked the revision.
 */
export async function resumePauseFamily(
  tx: Database,
  session: SessionRow,
  context: ResumeContext,
): Promise<ResumeSessionResult> {
  return session.admissionState === "pausing"
    ? cancelPause(tx, session, context)
    : resumePaused(tx, session, context);
}

async function resumePaused(
  tx: Database,
  session: SessionRow,
  context: ResumeContext,
): Promise<ResumeSessionResult> {
  const { now } = context;
  const unknown = await earliestUnknownTurn(tx, session.id);
  const refusal = pausedResumeRefusal(session, unknown);
  if (refusal !== null) return refusal;
  // A paused session can carry the status of an ended one; the resume that
  // completes later makes it live, which an authoritative pin refuses.
  if (pinRefusesLive(session)) return { outcome: "pin_required" };
  // As from stopped, and checked last so a refusal that retrying cannot fix
  // is the one given: GC is removing the workspace a launch would mount.
  if (session.workspaceReclaimId !== null) {
    return { outcome: "workspace_reclaiming" };
  }
  // A parked turn is carried on by this resume, once nothing it asked is
  // still open: an answer or an expiry stands for each.
  const parked = await closeParkedGroup(tx, session, {
    by: "resume",
    at: await dbNow(tx),
  });
  if (parked.outcome === "pending_requests_open") return parked;

  await moveToResuming(tx, session, {
    now,
    statusActor: { owner_id: context.ownerId },
  });
  const response = await writeResumeReceipt(tx, {
    scope: context.scope,
    payloadHash: context.payloadHash,
    status: "accepted",
    result: null,
    error: null,
    now,
    afterEpoch: session.leaseEpoch + 1,
  });
  return { outcome: "accepted", response };
}

/**
 * `paused → resuming`: a new worker is launched to restore the pause's
 * checkpoint, and the open resume receipt waits on it. With `answeredBy`
 * the platform resumes on its own (an answer closed what its park waited
 * on) and writes that receipt itself, as the answerer's; otherwise the
 * caller writes the receipt of the request it serves.
 */
export async function moveToResuming(
  tx: Database,
  session: SessionRow,
  input:
    | { now: Date; statusActor: { owner_id: string } }
    | { now: Date; answeredBy: ReceiptActor | null },
) {
  const { now } = input;
  // Every caller refuses or waits while GC holds a claim; a launch now would
  // mount the volume being removed.
  if (session.workspaceReclaimId !== null) {
    throw new Error(
      `session ${session.id} cannot resume while its workspace is being reclaimed`,
    );
  }
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
      admissionState: "resuming",
      updatedAt: now,
      workspaceReclaimedAt: null,
    })
    .where(eq(sessions.id, session.id));
  // Signalled whether or not input is queued: the receipt waits on a worker
  // proving the checkpoint restores, and nothing else would launch one.
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
  await recordStatus(tx, {
    sessionId: session.id,
    phase: session.status,
    extra: {
      admission_state: "resuming",
      resuming_from_checkpoint_revision: session.checkpointRevision,
      ...("statusActor" in input
        ? { actor: input.statusActor }
        : { resumed_by: "answer" }),
    },
    turnRowId: null,
    now,
  });
  if (!("answeredBy" in input)) return;
  const targetRef: ResumeTarget = {
    session_id: session.id,
    turn_id: null,
    request_id: null,
    after_epoch: session.leaseEpoch + 1,
  };
  await tx.insert(receipts).values({
    id: randomUUID(),
    ownerId: session.ownerId,
    actor: input.answeredBy,
    requestId: null,
    operation: RESUME,
    targetRef,
    status: "accepted",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The attempt that is draining for the pause, if it still holds the
 * session: a claimed attempt that has not ended, on the current epoch,
 * with its lease running. Only such an attempt can carry on as if the
 * pause had never been asked for.
 */
async function liveDrainer(tx: Database, session: SessionRow) {
  if (session.executionId === null) return undefined;
  const [row] = await tx
    .select({
      desiredState: executions.desiredState,
      leaseEpoch: attempts.leaseEpoch,
      leaseExpiresAt: attempts.leaseExpiresAt,
    })
    .from(workerLaunches)
    .innerJoin(executions, eq(executions.id, workerLaunches.executionId))
    .innerJoin(attempts, eq(attempts.id, workerLaunches.claimedAttemptId))
    .where(
      and(
        eq(workerLaunches.executionId, session.executionId),
        notInArray(attempts.state, ["exited", "lost"]),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.desiredState === "terminated" ||
    row.leaseEpoch !== session.leaseEpoch ||
    row.leaseExpiresAt.getTime() <= (await dbNow(tx)).getTime()
  ) {
    return undefined;
  }
  return row;
}

async function cancelPause(
  tx: Database,
  session: SessionRow,
  context: ResumeContext,
): Promise<ResumeSessionResult> {
  const { now } = context;
  // Once the stop intent is written — the pause release committed it, or
  // the drainer is gone and the exit observation will settle the pause —
  // the pause can only finish; the caller resumes from `paused` after.
  if ((await liveDrainer(tx, session)) === undefined) {
    return { outcome: "pause_committing" };
  }
  const [pause] = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(openPauseReceipt(session.id))
    .limit(1);

  // A blocking reason (a dropped mirror batch, or one this build does not
  // know) is what the pause was stuck on, and cancelling it does not make
  // the transcript whole: the session cannot be carried on or restored, so
  // it goes to an operator rather than back to active.
  if (storedPendingReasonHoldsWork(session.checkpointPendingReason)) {
    const error: ReceiptError = {
      code: "CHECKPOINT_UNAVAILABLE",
      message: `the checkpoint is blocked (${session.checkpointPendingReason}); the session can neither pause nor carry on and needs an operator recovery decision`,
    };
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        admissionState: "recovery_required",
        status: "failed",
        updatedAt: now,
      })
      .where(eq(sessions.id, session.id));
    await tx
      .update(receipts)
      .set({
        status: "failed",
        error: { code: "RECOVERY_REQUIRED", message: error.message },
        updatedAt: now,
      })
      .where(openPauseReceipt(session.id));
    await recordStatus(tx, {
      sessionId: session.id,
      phase: "failed",
      extra: {
        admission_state: "recovery_required",
        pause_cancel_refused: error,
        actor: { owner_id: context.ownerId },
      },
      turnRowId: null,
      now,
    });
    const response = await writeResumeReceipt(tx, {
      scope: context.scope,
      payloadHash: context.payloadHash,
      status: "failed",
      result: null,
      error,
      now,
    });
    return { outcome: "accepted", response };
  }

  // The drainer keeps its epoch and lease: the turn in flight runs on, and
  // the worker learns the pause is gone when its pause release is refused
  // as stale.
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      admissionState: "active",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "PAUSE_CANCELLED",
        message: "cancelled by resume before the pause committed",
      },
      updatedAt: now,
    })
    .where(openPauseReceipt(session.id));
  // The drainer's questions stay open with its epoch, so a wait the pause
  // reported is still one: say what the session reads as, not its row.
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(
      session.status,
      await awaitingInputAt(tx, session.id, await dbNow(tx)),
    ),
    extra: {
      admission_state: "active",
      pause_cancelled: pause?.id ?? null,
      actor: { owner_id: context.ownerId },
    },
    turnRowId: null,
    now,
  });
  const response = await writeResumeReceipt(tx, {
    scope: context.scope,
    payloadHash: context.payloadHash,
    status: "succeeded",
    result: await resumeReceiptResult(tx, session),
    error: null,
    now,
  });
  return { outcome: "accepted", response };
}
