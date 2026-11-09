import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  PauseBlockedReason,
  PauseReceiptResult,
} from "@werft-ai/contracts";
import type { PauseSessionInput, PauseSessionResult } from "@werft-ai/platform";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { contextCoverage } from "./context-gap.ts";
import {
  controlClock,
  controlReplay,
  findIdempotent,
  hasRestorePoint,
  type IdempotencyScope,
  liveDrainer,
  lockIdempotencyScope,
  lockSessionForControl,
  OPEN_TURN_STATUSES,
  receiptActorOf,
  restoreBaseRevision,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import { pauseCoverageBlocker, pausedReceiptResult } from "./pause-policy.ts";
import { awaitingInputAt, publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  executions,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
  workerLaunches,
} from "./schema.ts";
import { recordStatus } from "./session-events.ts";

export const PAUSE = "pause";

/**
 * api.md § 일시 중지와 저장 상태: the initial drain observation deadline.
 * Past it a pause still short of its safe boundary shows why; nothing is
 * killed on account of it.
 */
export const PAUSE_DRAIN_DEADLINE_MS = 60_000;

type SessionRow = typeof sessions.$inferSelect;

/**
 * Why the session cannot be called paused yet, or null when it can: no turn
 * is open, and a trusted committed checkpoint exists that was taken at or
 * after the last turn that ran. A close (`closing`) needs no restore point
 * for a session that never ran a turn: nothing will be restored.
 */
export async function pauseBlocker(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "checkpointFallbackRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
    | "pauseReason"
  >,
  options: { closing?: boolean } = {},
): Promise<PauseBlockedReason | null> {
  // A dropped mirror batch outranks everything: no amount of waiting makes
  // this run's transcript restorable.
  if (session.checkpointPendingReason === "mirror_error") {
    return "mirror_error";
  }
  const [open] = await tx
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, session.id),
        inArray(turns.status, OPEN_TURN_STATUSES),
      ),
    )
    .limit(1);
  if (open) {
    // A park pauses on the open requests themselves; what it still waits
    // for is the turn they are in to end.
    if (session.pauseReason === "awaiting_input") return "long_turn";
    const [asking] = await tx
      .select({ id: pendingRequests.requestId })
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.sessionId, session.id),
          eq(pendingRequests.turnId, open.id),
          isNull(pendingRequests.resolvedAt),
        ),
      )
      .limit(1);
    return asking ? "pending_request" : "long_turn";
  }
  // Every pause stands on a committed checkpoint, a session that never ran
  // a turn included: a paused receipt promises a restore point. An advisory
  // pending reason does not block by itself: a refused drain
  // checkpoint leaves the pointer short of the last turn and the coverage
  // check below refuses it; a pointer that covers every turn is enough.
  // checkpoint_pending_reason already tells the owner which one it was, so
  // PAUSE_BLOCKED gets no reason of its own for it.
  // A start_fresh watermark does not count here: a pause needs a checkpoint
  // to resume from, not a gap an operator already accepted.
  if (!hasRestorePoint(session)) {
    return options.closing &&
      (await contextCoverage(tx, session)).lastRanTurn === null
      ? null
      : "checkpoint_unavailable";
  }
  // After a fallback restore it is the earlier revision the session runs
  // on that has to cover the last turn, not the damaged pointer.
  const coverage = await contextCoverage(
    tx,
    session,
    restoreBaseRevision(session),
  );
  return pauseCoverageBlocker(coverage);
}

export async function pauseReceiptResult(
  tx: Database,
  session: Pick<
    SessionRow,
    "id" | "checkpointRevision" | "checkpointFallbackRevision"
  >,
): Promise<PauseReceiptResult> {
  const [queued] = await tx
    .select({ count: count() })
    .from(turns)
    .where(and(eq(turns.sessionId, session.id), eq(turns.status, "queued")));
  return pausedReceiptResult(session, queued?.count ?? 0);
}

/**
 * The pause receipt still waiting on its execution, if the session has one.
 * Only looked up while the session is `pausing`, the one state that can
 * hold it, since the target_ref match reads receipts without an index. A
 * partial index like receipts_open_terminate_idx is the upgrade once pauses
 * are frequent enough for that read to show.
 */
export function openPauseReceipt(sessionId: string) {
  return and(
    eq(receipts.operation, PAUSE),
    eq(receipts.status, "accepted"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
  );
}

/**
 * api.md § 일시 중지와 저장 상태. A bound session goes `pausing`: its worker
 * learns of it through pendingControl, stops taking input, finishes the
 * turn in flight with its checkpoint and releases; the receipt succeeds when
 * the execution is observed gone (confirmExecutionGoneAtomic). A session with
 * nothing running has nothing to drain and is paused in this transaction.
 * Queued input and open questions are left as they are either way.
 */
export function pauseAtomic(
  db: Database,
  input: PauseSessionInput,
): Promise<PauseSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    requestId: input.principal.requestId ?? null,
    operation: PAUSE,
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
    // A person's pause takes over a park: the session stays where the park
    // took it, but as their pause, which only they resume.
    if (session.pauseReason === "awaiting_input") {
      return takeOverPark(tx, session, { scope, input, now });
    }
    if (session.admissionState !== "active") {
      return { outcome: "rejected", admissionState: session.admissionState };
    }
    if (session.executionId === null && session.podId !== null) {
      return { outcome: "unsupported" };
    }

    const drainer = await liveDrainer(tx, session.executionId);
    const bound = session.executionId !== null;
    if (drainer === undefined) {
      // Nothing will run again before a resume, so the checkpoint there is
      // now is the one the pause stands on.
      if ((await pauseBlocker(tx, session)) !== null) {
        return { outcome: "checkpoint_unavailable" };
      }
      if (session.executionId !== null) {
        // The stop intent right away, as terminate writes it: the launch
        // row is locked (lockSessionForControl), so a rebuild the scheduler
        // intended is cancelled with it.
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
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        // With the stop intent the epoch goes too; a draining worker keeps
        // its own until it commits the pause by releasing.
        ...(bound && drainer === undefined
          ? { leaseEpoch: sql`${sessions.leaseEpoch} + 1` }
          : {}),
        admissionState: bound ? "pausing" : "paused",
        updatedAt: now,
      })
      .where(eq(sessions.id, sessionId));

    const receiptId = randomUUID();
    const response: ControlAcceptedResponse = {
      receipt_id: receiptId,
      receipt_status: bound ? "accepted" : "succeeded",
    };
    await tx.insert(receipts).values({
      id: receiptId,
      ownerId: scope.principal,
      actor: scope.actor,
      requestId: scope.requestId,
      operation: PAUSE,
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: response.receipt_status,
      result: bound ? null : await pauseReceiptResult(tx, session),
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
    // Pause moves admission only, so the status it reports is the one the
    // session reads as now — after the epoch above moved, which ends any
    // wait for input that the fenced attempt had open.
    const at = await dbNow(tx);
    await recordStatus(tx, {
      sessionId,
      phase: publicStatus(
        session.status,
        await awaitingInputAt(tx, sessionId, at),
      ),
      extra: {
        admission_state: bound ? "pausing" : "paused",
        reason: input.reason,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    return { outcome: "accepted", response };
  });
}

/**
 * pauseAtomic on a session pausing or paused for a park. A paused one is
 * paused already and the receipt says so at once. A pausing one hands its
 * worker a plain pause in place of the park: the park's receipt is
 * superseded, so the person's is the open one pendingControl delivers, and
 * the drain commits under it.
 */
async function takeOverPark(
  tx: Database,
  session: SessionRow,
  context: {
    scope: IdempotencyScope;
    input: PauseSessionInput;
    now: Date;
  },
): Promise<PauseSessionResult> {
  const { scope, input, now } = context;
  const pausing = session.admissionState === "pausing";
  if (pausing) {
    await tx
      .update(receipts)
      .set({
        status: "failed",
        error: {
          code: "CONTROL_SUPERSEDED",
          message: "superseded by a pause before the park completed",
        },
        updatedAt: now,
      })
      .where(openPauseReceipt(session.id));
  }
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      pauseReason: null,
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  const receiptId = randomUUID();
  const response: ControlAcceptedResponse = {
    receipt_id: receiptId,
    receipt_status: pausing ? "accepted" : "succeeded",
  };
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: scope.principal,
    actor: scope.actor,
    requestId: scope.requestId,
    operation: PAUSE,
    targetRef: { session_id: session.id, turn_id: null, request_id: null },
    status: response.receipt_status,
    result: pausing ? null : await pauseReceiptResult(tx, session),
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  });
  await tx.insert(idempotencyKeys).values({
    principal: scope.principal,
    operation: scope.operation,
    resource: scope.resource,
    key: input.idempotencyKey,
    payloadHash: input.payloadHash,
    receiptId,
  });
  const at = await dbNow(tx);
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(
      session.status,
      await awaitingInputAt(tx, session.id, at),
    ),
    extra: {
      admission_state: session.admissionState,
      reason: input.reason,
      actor: { owner_id: input.principal.ownerId },
    },
    turnRowId: null,
    now,
  });
  return { outcome: "accepted", response };
}

/**
 * The pause the platform opens to park a turn whose requests went
 * unanswered: `pausing` with `pause_reason = awaiting_input` and an open
 * pause receipt no person asked for, so pendingControl hands the worker a
 * `park` and its release commits under the receipt's id. The draining
 * worker keeps its epoch and lease. The caller holds the session row lock
 * and has checked the session is active.
 */
export async function openSystemPark(
  tx: Database,
  session: SessionRow,
  now: Date,
): Promise<string> {
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      admissionState: "pausing",
      pauseReason: "awaiting_input",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: session.ownerId,
    actor: null,
    requestId: null,
    operation: PAUSE,
    targetRef: { session_id: session.id, turn_id: null, request_id: null },
    status: "accepted",
    result: null,
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  });
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(
      session.status,
      await awaitingInputAt(tx, session.id, await dbNow(tx)),
    ),
    extra: { admission_state: "pausing", pause_reason: "awaiting_input" },
    turnRowId: null,
    now,
  });
  return receiptId;
}
