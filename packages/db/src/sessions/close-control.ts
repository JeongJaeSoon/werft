import { randomUUID } from "node:crypto";
import type {
  CloseReceiptResult,
  ControlAcceptedResponse,
} from "@werft-ai/contracts";
import {
  type CloseSessionInput,
  type CloseSessionResult,
  receiptActorOf,
  storedPendingReasonBlocks,
  storedPendingReasonHoldsWork,
} from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  controlClock,
  controlReplay,
  findIdempotent,
  type IdempotencyScope,
  liveDrainer,
  lockIdempotencyScope,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import { awaitingInputAt, publicStatus } from "../decision/pending-status.ts";
import type { Database } from "../queries.ts";
import {
  cancelQueuedInput,
  resumableFromStopped,
} from "../recovery-control.ts";
import {
  executions,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "../schema.ts";
import { CLOSE } from "./drain.ts";
import { closeParkedGroup } from "./parked-group.ts";
import { pauseBlocker } from "./pause-control.ts";
import { hasRestorePoint, restoreBaseRevision } from "./pause-policy.ts";
import { recordEvent, recordStatus } from "./session-events.ts";

const SESSION_CLOSED_SUBTYPE = "session_closed";

type SessionRow = typeof sessions.$inferSelect;

/**
 * What the transaction that makes a session `closed` writes besides the
 * session row and the close receipt: queued input is cancelled, questions
 * left open are closed, the session leaves the dispatch queue, and the
 * stream gets the `session_closed` record. Returns the receipt result.
 */
export async function finishClose(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "checkpointFallbackRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
  >,
  input: { receiptId: string; now: Date },
): Promise<CloseReceiptResult> {
  const cancelled = await cancelQueuedInput(tx, {
    sessionId: session.id,
    terminalReason: "closed",
    error: {
      code: "SESSION_CLOSED",
      message: "input cancelled by close before it ran",
    },
    now: input.now,
  });
  await closeParkedGroup(tx, session, { by: "close", at: input.now });
  await tx
    .update(pendingRequests)
    .set({ resolvedAt: input.now })
    .where(
      and(
        eq(pendingRequests.sessionId, session.id),
        isNull(pendingRequests.resolvedAt),
      ),
    );
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  const result: CloseReceiptResult = {
    resulting_admission_state: "closed",
    // Null only when the session never ran a turn (closeBlocker allows no
    // other session without a restore point).
    checkpoint_revision: hasRestorePoint(session)
      ? restoreBaseRevision(session)
      : null,
    cancelled_turn_count: cancelled.length,
  };
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: {
      type: "system",
      subtype: SESSION_CLOSED_SUBTYPE,
      closed_by: CLOSE,
      close_receipt_id: input.receiptId,
      checkpoint_revision: result.checkpoint_revision,
      cancelled_turn_count: result.cancelled_turn_count,
    },
    turnRowId: null,
    now: input.now,
  });
  return result;
}

/**
 * The owner's ordinary close (POST /v1/sessions/{id}/close). An active
 * session with a live worker goes `closing`: the worker drains as for a
 * pause and confirmExecutionGone settles it `closed`. Any other session that
 * may close is closed here; a bound one without a drainer gets the kill
 * intent, and its receipt succeeds once the execution is seen gone.
 */
export function closeAtomic(
  db: Database,
  input: CloseSessionInput,
): Promise<CloseSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    requestId: input.principal.requestId ?? null,
    operation: CLOSE,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();

  return transactionWithBindingRetry(db, async (tx, attempt) => {
    await lockIdempotencyScope(tx, scope);
    const existing = await findIdempotent(tx, scope);
    const replay = controlReplay(existing, input.payloadHash);
    if (replay) return replay;
    const session = await lockSessionForControl(tx, {
      sessionId,
      ownerId: scope.principal,
      attempt,
    });
    if (!session) return { outcome: "not_found" };
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
    switch (session.admissionState) {
      case "active":
      case "paused":
        break;
      case "stopped":
        if (!(await resumableFromStopped(tx, session))) {
          return { outcome: "recovery_required" };
        }
        break;
      case "recovery_required":
        return { outcome: "recovery_required" };
      default:
        return { outcome: "rejected", admissionState: session.admissionState };
    }
    if (session.executionId === null && session.podId !== null) {
      return { outcome: "unsupported" };
    }

    // A transcript past the limits ended its last turn without a checkpoint,
    // and no drain by this attempt can commit one: refuse as for a session
    // with no drainer, rather than hold it closing until the execution goes.
    if (
      session.admissionState === "active" &&
      storedPendingReasonHoldsWork(session.checkpointPendingReason) &&
      !storedPendingReasonBlocks(session.checkpointPendingReason)
    ) {
      return { outcome: "checkpoint_unavailable" };
    }
    const drainer =
      session.admissionState === "active"
        ? await liveDrainer(tx, session.executionId)
        : undefined;
    if (drainer === undefined) {
      // Nothing will run again, so the checkpoint there is now is the one
      // the close ends the session on. paused and a resumable stopped were
      // judged on it already when they got there.
      if (
        session.admissionState === "active" &&
        (await pauseBlocker(tx, session, { closing: true })) !== null
      ) {
        return { outcome: "checkpoint_unavailable" };
      }
      if (session.executionId !== null) {
        // The kill intent, as pause writes it for a session with no
        // drainer; the launch row is locked (lockSessionForControl).
        await tx
          .update(executions)
          .set({ desiredState: "terminated" })
          .where(eq(executions.id, session.executionId));
        await tx
          .update(workerLaunches)
          .set({ replacementReason: null })
          .where(eq(workerLaunches.executionId, session.executionId));
      }
    }
    const into = drainer === undefined ? "closed" : "closing";
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        // A draining worker keeps its epoch until it commits the drain by
        // releasing; anything else bound is fenced out from here.
        ...(drainer === undefined
          ? { leaseEpoch: sql`${sessions.leaseEpoch} + 1` }
          : {}),
        admissionState: into,
        ...(into === "closed" ? { status: "stopped" as const } : {}),
        updatedAt: now,
      })
      .where(eq(sessions.id, sessionId));

    const receiptId = randomUUID();
    // Waiting on an execution, whether drained or killed: the receipt
    // succeeds when confirmExecutionGone sees it gone.
    const pending = session.executionId !== null;
    const response: ControlAcceptedResponse = {
      receipt_id: receiptId,
      receipt_status: pending ? "accepted" : "succeeded",
    };
    const at = await dbNow(tx);
    await recordStatus(tx, {
      sessionId,
      phase:
        into === "closed"
          ? "stopped"
          : publicStatus(
              session.status,
              await awaitingInputAt(tx, sessionId, at),
            ),
      extra: {
        admission_state: into,
        reason: input.reason,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    // Closed now, so the result is known now; a receipt still waiting on its
    // execution keeps it until that is seen gone.
    const result =
      into === "closed"
        ? await finishClose(tx, session, { receiptId, now })
        : null;
    await tx.insert(receipts).values({
      id: receiptId,
      ownerId: scope.principal,
      actor: scope.actor,
      requestId: scope.requestId,
      operation: CLOSE,
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: response.receipt_status,
      result,
      // The drain deadline counts from durable acceptance, on the database
      // clock the attention check reads it with.
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
    await tx.insert(idempotencyKeys).values({
      principal: scope.principal,
      operation: scope.operation,
      resource: scope.resource,
      key: scope.key,
      payloadHash: input.payloadHash,
      receiptId,
    });
    return { outcome: "accepted", response };
  });
}
