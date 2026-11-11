import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  TerminateReceiptResult,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  CloseSessionInput,
  PauseSessionInput,
  RecoveryDecisionInput,
  RenameSessionInput,
  ResumeSessionInput,
  SessionControl,
  TerminateSessionInput,
  TerminateSessionResult,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { renameAtomic } from "./agents/rename-control.ts";
import { logControlResult } from "./control-observability.ts";
import {
  BindingMoved,
  type ControlStageMeasure,
  controlClock,
  controlReplay,
  earliestUnknownTurn,
  expireOverdueReceipts,
  findIdempotent,
  type IdempotencyScope,
  INPUT_RECEIPT_OPERATIONS,
  lockIdempotencyScope,
  lockSessionForControl,
} from "./control-shared.ts";
import { dbNow, fromDbNow } from "./db-clock.ts";
import {
  awaitingInputAt,
  cancelParkedRequests,
  closeWorkerRequests,
  publicStatus,
  recordLostInputWait,
} from "./decision/pending-requests.ts";
import type { Database } from "./queries.ts";
import { decideRecoveryAtomic, resumeAtomic } from "./recovery-control.ts";
import { openResumeReceipt } from "./resume-control.ts";
import * as schema from "./schema.ts";
import {
  executions,
  idempotencyKeys,
  permissionGrants,
  pushIntents,
  queueMessages,
  receipts,
  sessions,
  turnContinuations,
  turns,
  workerLaunches,
} from "./schema.ts";
import { closeAtomic } from "./sessions/close-control.ts";
import { drainOf, openDrainReceipt } from "./sessions/drain.ts";
import { pauseAtomic } from "./sessions/pause-control.ts";
import {
  announceInputWaitEnded,
  inputWaitBefore,
  recordStatus,
} from "./sessions/session-events.ts";

const TERMINATE = "terminate";
export const REVOKE_EXECUTION = "revoke_execution";
// Receipts that settle on the observed absence of the execution they asked
// to kill, and go `unknown` when that is not observed in time. A session
// cannot be bound again while either is open (terminate stops dispatch, a
// revocation blocks it), so the session identifies the execution.
export const KILL_RECEIPT_OPERATIONS = [TERMINATE, REVOKE_EXECUTION];

export { earliestUnknownTurn } from "./control-shared.ts";

/**
 * The receipt a terminate settles with once its execution is gone; the same
 * shape is written by confirmExecutionGoneAtomic, so a reader sees one
 * result whether the kill was immediate or observed later.
 */
export function terminateReceiptResult(input: {
  checkpointRevision: number | null;
  unconfirmedTurnId: string | null;
}): TerminateReceiptResult {
  return {
    execution_gone: true,
    checkpoint_revision: input.checkpointRevision,
    unconfirmed_turn_id: input.unconfirmedTurnId,
    external_effects_reverted: false,
  };
}

/**
 * A kill not observed within the deadline is reported unknown, not
 * left pending. The intent stays on the executions row, so reconciliation
 * continues and confirmExecutionGoneAtomic still settles the receipt later.
 * Both the scheduler pass and the DB-only reconciler run this, so a Docker
 * outage that stalls the former does not stall the answer.
 */
export async function expireOverdueTerminations(
  db: Database,
  input: {
    now: Date;
    deadlineMs: number;
    dryRun?: boolean;
    limit?: number;
    logger?: Pick<StructuredLogger, "info">;
  },
): Promise<number> {
  return expireOverdueReceipts(db, {
    overdue: and(
      inArray(receipts.operation, KILL_RECEIPT_OPERATIONS),
      // The receipt was stamped by the database clock, so the deadline is
      // measured on it too; `now` only stamps the update.
      lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
    ),
    message: `execution termination not observed within ${Math.round(input.deadlineMs / 1000)}s; reconciliation continues`,
    onExpired: (expired) => {
      for (const receipt of expired) {
        if (receipt.operation !== TERMINATE) continue;
        const sessionId = sessionIdFromTarget(receipt.targetRef);
        if (sessionId === undefined) continue;
        logControlResult(input.logger, {
          acceptedAt: receipt.createdAt,
          controlId: receipt.id,
          effectiveAt: input.now,
          operation: "terminate",
          outcome: "unknown",
          reasonCode: "deadline_exceeded",
          sessionId,
        });
      }
    },
    ...input,
  });
}

function sessionIdFromTarget(target: unknown): string | undefined {
  if (target === null || typeof target !== "object") return undefined;
  const sessionId = (target as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" ? sessionId : undefined;
}

type SessionRow = typeof sessions.$inferSelect;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("Database statement returned no rows");
}

/**
 * What stopping a session's execution writes, apart from the session row:
 * the terminate transaction and the operator's
 * execution revocation make the same writes. Queued input is
 * cancelled, open questions are closed, the bound generation's kill intent
 * is recorded and a pause or resume still in flight is superseded. The
 * caller holds the launch and session row locks (lockSessionForControl),
 * moves the session's epoch in the same transaction and then hands
 * `inputWait` to announceStopped, once the session row says where it now
 * is; `by` names the command in the errors the superseded
 * receipts carry.
 */
export async function stopExecution(
  tx: Database,
  session: SessionRow,
  input: {
    now: Date;
    by: "terminate" | "execution revocation";
    measure?: ControlStageMeasure;
  },
): Promise<{
  pendingKill: boolean;
  inputWait: { waitingBefore: boolean; at: Date };
}> {
  const { now, by } = input;
  const measure = input.measure ?? (async (_stage, work) => work());
  const sessionId = session.id;
  // Queued input will never run: its turns end as cancelled, its queue
  // rows go, and whoever submitted it learns so through the receipt.
  const cancelled = await measure("cancel_queued_turns_ms", () =>
    tx
      .update(turns)
      .set({
        status: "cancelled",
        endedAt: now,
        terminalReason: "terminated",
      })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")))
      .returning({ id: turns.id, sequence: turns.sequence }),
  );
  if (cancelled.length > 0) {
    const cancelledIds = cancelled.map((turn) => turn.id);
    await measure("delete_queue_messages_ms", () =>
      tx
        .delete(queueMessages)
        .where(inArray(queueMessages.turnId, cancelledIds)),
    );
    // A turn that would have carried a park on never ran: its group opens
    // again with the answers it holds, for the next resume to carry on, or
    // for a terminate's cancel below to end.
    await tx
      .delete(permissionGrants)
      .where(inArray(permissionGrants.turnId, cancelledIds));
    // The push intents the park left deferred moved to that turn with it
    // (carryPushIntents); a turn that never ran made none of its own, so
    // whatever is deferred on it goes back to the parked turn.
    const carrying = await tx
      .select({
        turnId: turnContinuations.turnId,
        parkedTurnId: turnContinuations.parkedTurnId,
      })
      .from(turnContinuations)
      .where(inArray(turnContinuations.turnId, cancelledIds));
    for (const { turnId, parkedTurnId } of carrying) {
      await tx
        .update(pushIntents)
        .set({ turnId: parkedTurnId, updatedAt: sql`now()` })
        .where(
          and(
            eq(pushIntents.turnId, turnId),
            eq(pushIntents.status, "deferred"),
          ),
        );
    }
    await tx
      .delete(turnContinuations)
      .where(inArray(turnContinuations.turnId, cancelledIds));
    await measure("fail_input_receipts_ms", () =>
      tx
        .update(receipts)
        .set({
          status: "failed",
          error: {
            code: "SESSION_STOPPED",
            message: `input cancelled by ${by} before it ran`,
          },
          // `result` stays the acceptance response (receiptSchema.result).
          updatedAt: now,
        })
        .where(
          and(
            inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
            eq(receipts.status, "accepted"),
            sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
            inArray(
              sql`${receipts.targetRef}->>'turn_id'`,
              cancelled.map((turn) => String(turn.sequence)),
            ),
          ),
        ),
    );
  }
  // Judged on the database clock, which is what the projection reads with;
  // the caller's clock only stamps the rows.
  const at = await measure("database_clock_ms", () => dbNow(tx));
  const waitingBefore = await measure("wait_before_stop_ms", () =>
    inputWaitBefore(tx, session, at),
  );
  // A question nobody can answer any more: the worker that asked is being
  // fenced out, so an answer would land on nothing. A parked one waits for
  // no worker and outlives the fence; a person's terminate ends the turn it
  // would resume, as it does queued input.
  const closed = await measure("resolve_pending_requests_ms", () =>
    closeWorkerRequests(tx, sessionId, now),
  );
  // A revoked execution loses its waits the way a dead worker does; a
  // terminate is a person ending them.
  if (by !== "terminate") {
    await recordLostInputWait(tx, { sessionId, closed, measure, now });
  }
  if (by === "terminate") {
    await measure("cancel_parked_requests_ms", () =>
      cancelParkedRequests(tx, { sessionId }, now),
    );
  }
  // The kill outbox. An executions row is one generation, so asking for this
  // row is asking for exactly the generation the session is bound to. The
  // scheduler carries it out and confirmExecutionGone settles the session
  // and the receipt once the resource is absent.
  const pendingKill = session.executionId !== null;
  if (session.executionId !== null) {
    const executionId = session.executionId;
    const outbox = await measure("execution_stop_intent_ms", () =>
      tx.execute<{ id: string }>(sql`
        WITH stopped AS (
          UPDATE ${executions}
          SET desired_state = 'terminated'
          WHERE ${executions.id} = ${executionId}
          RETURNING ${executions.id} AS id
        ), cleared_replacement AS (
          UPDATE ${workerLaunches}
          SET replacement_reason = NULL
          WHERE ${workerLaunches.executionId} = ${executionId}
            AND EXISTS (SELECT 1 FROM stopped)
        )
        SELECT id FROM stopped
      `),
    );
    // A bound session without its executions row is a broken invariant,
    // not evidence that nothing is running.
    if (rowsOf<{ id: string }>(outbox).length !== 1) {
      throw new Error(
        `Session ${sessionId} points at execution ${session.executionId} which has no row`,
      );
    }
    // A launch the scheduler meant to rebuild would otherwise be
    // rebuilt after the kill, and confirmExecutionGone would refuse the exit
    // as "the rebuild in progress". The intent is cancelled under the launch
    // row lock the caller took; replacement_count is the scheduler's CAS and
    // stays as it is.
  }
  // A pause or close still draining is overtaken: the kill ends the
  // execution before any checkpoint the drain was waiting for. Likewise a
  // resume still waiting on its worker's restore.
  const drain = drainOf(session.admissionState);
  if (drain !== undefined) {
    await measure("supersede_pause_receipt_ms", () =>
      tx
        .update(receipts)
        .set({
          status: "failed",
          error: {
            code: "CONTROL_SUPERSEDED",
            message: `superseded by ${by} before the ${drain.operation} completed`,
          },
          updatedAt: now,
        })
        .where(openDrainReceipt(sessionId)),
    );
  }
  if (session.admissionState === "resuming") {
    await measure("supersede_resume_receipt_ms", () =>
      tx
        .update(receipts)
        .set({
          status: "failed",
          error: {
            code: "CONTROL_SUPERSEDED",
            message: `superseded by ${by} before the resume completed`,
          },
          updatedAt: now,
        })
        .where(openResumeReceipt(sessionId)),
    );
  }
  return { pendingKill, inputWait: { waitingBefore, at } };
}

/**
 * Where a stopped execution leaves the session. The caller moves the epoch
 * in the same update: from then every request the old worker makes is 409
 * STALE_EPOCH, whether or not its container is still up. A session already
 * waiting on an operator keeps `recovery_required`: the kill does not answer
 * what its unknown turn did, so it must not clear that barrier.
 */
export function stoppedAdmission(
  session: Pick<SessionRow, "admissionState">,
  pendingKill: boolean,
) {
  if (session.admissionState === "recovery_required") return {};
  return pendingKill
    ? { admissionState: "stopping" as const }
    : { admissionState: "stopped" as const, status: "stopped" as const };
}

/**
 * After the session row says where stoppedAdmission moved it: a status event
 * with the new admission, so a client following the stream does not stay at
 * the state the stop left. The stop closed every open question but a
 * parked one, so the event also ends any wait for input that no park holds
 * open. A stop that moved no admission
 * only reports that end, if there was one.
 */
export async function announceStopped(
  tx: Database,
  input: {
    session: Pick<SessionRow, "id" | "admissionState" | "status">;
    into: ReturnType<typeof stoppedAdmission>;
    inputWait: { waitingBefore: boolean; at: Date };
    extra: Record<string, unknown>;
    measure?: ControlStageMeasure;
    now: Date;
  },
) {
  const { session, into } = input;
  if (
    into.admissionState === undefined ||
    into.admissionState === session.admissionState
  ) {
    await announceInputWaitEnded(tx, {
      sessionId: session.id,
      ...input.inputWait,
      turnRowId: null,
      ...(input.measure ? { measure: input.measure } : {}),
    });
    return;
  }
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(
      into.status ?? session.status,
      await awaitingInputAt(tx, session.id, input.inputWait.at),
    ),
    extra: { admission_state: into.admissionState, ...input.extra },
    ...(input.measure ? { measure: input.measure } : {}),
    turnRowId: null,
    now: input.now,
  });
}

type TerminateTelemetryOptions = {
  connect?: () => Promise<PoolClient>;
  logger?: Pick<StructuredLogger, "info">;
};

function roundedTimings(timings: ReadonlyMap<string, number>) {
  return Object.fromEntries(
    [...timings].map(([stage, duration]) => [stage, Math.round(duration)]),
  );
}

export function createPostgresSessionControl(
  db: Database,
  options: TerminateTelemetryOptions = {},
): SessionControl {
  return {
    async terminateAtomic(
      input: TerminateSessionInput,
    ): Promise<TerminateSessionResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: TERMINATE,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      const startedAt = Date.now();
      const timings = new Map<string, number>();
      const measure: ControlStageMeasure = async (stage, work) => {
        const started = performance.now();
        try {
          return await work();
        } finally {
          timings.set(
            stage,
            (timings.get(stage) ?? 0) + performance.now() - started,
          );
        }
      };
      let client: PoolClient | undefined;
      let outcome = "error";
      let attempts = 0;
      try {
        if (options.connect) {
          client = await measure("pool_checkout_ms", options.connect);
        }
        const transactionDb = client ? drizzle(client, { schema }) : db;
        for (let attempt = 1; ; attempt += 1) {
          attempts = attempt;
          const transactionStarted = performance.now();
          let workFinished: number | undefined;
          try {
            const result = await transactionDb.transaction(async (tx) => {
              timings.set(
                "transaction_begin_ms",
                (timings.get("transaction_begin_ms") ?? 0) +
                  performance.now() -
                  transactionStarted,
              );
              try {
                return await terminateIn(tx, attempt);
              } finally {
                workFinished = performance.now();
              }
            });
            if (workFinished !== undefined) {
              timings.set(
                "commit_ms",
                (timings.get("commit_ms") ?? 0) +
                  performance.now() -
                  workFinished,
              );
            }
            outcome = result.outcome;
            if (
              result.outcome === "accepted" &&
              result.response.receipt_status === "succeeded"
            ) {
              const effectiveAt = new Date();
              logControlResult(options.logger, {
                acceptedAt: effectiveAt,
                controlId: result.response.receipt_id,
                effectiveAt,
                operation: "terminate",
                outcome: "succeeded",
                reasonCode: "already_absent",
                sessionId,
              });
            }
            return result;
          } catch (error) {
            if (workFinished !== undefined) {
              timings.set(
                "rollback_ms",
                (timings.get("rollback_ms") ?? 0) +
                  performance.now() -
                  workFinished,
              );
            }
            if (!(error instanceof BindingMoved) || attempt >= 3) throw error;
          }
        }
      } finally {
        client?.release();
        options.logger?.info("Terminate control transaction completed", {
          session_id: sessionId,
          outcome,
          attempts,
          duration_ms: Date.now() - startedAt,
          ...roundedTimings(timings),
        });
      }

      async function terminateIn(
        tx: Database,
        attempt: number,
      ): Promise<TerminateSessionResult> {
        await measure("idempotency_lock_ms", () =>
          lockIdempotencyScope(tx, scope),
        );
        const existing = await measure("idempotency_lookup_ms", () =>
          findIdempotent(tx, scope),
        );
        const replay = controlReplay(existing, input.payloadHash);
        if (replay) return replay;

        const session = await lockSessionForControl(tx, {
          sessionId,
          ownerId: scope.principal,
          attempt,
          measure,
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
        // A session on the legacy pod lifecycle (pod_id without an
        // execution) has no kill outbox and no epoch its worker honours.
        // Accepting would promise a kill nothing can deliver, so it is
        // refused with the row untouched.
        if (session.executionId === null && session.podId !== null) {
          return { outcome: "unsupported" };
        }

        const { pendingKill, inputWait } = await stopExecution(tx, session, {
          now,
          by: TERMINATE,
          measure,
        });
        const into = stoppedAdmission(session, pendingKill);
        // a stopped session with nothing to kill is already where
        // this leads. Moving its revision would only turn away the next
        // control of a client that read it, over a change that never was.
        if (session.admissionState !== "stopped" || pendingKill) {
          await measure("update_session_ms", () =>
            tx
              .update(sessions)
              .set({
                revision: sql`${sessions.revision} + 1`,
                leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
                updatedAt: now,
                ...into,
              })
              .where(eq(sessions.id, sessionId)),
          );
        }
        await announceStopped(tx, {
          session,
          into,
          inputWait,
          extra: {
            reason: input.reason,
            actor: { owner_id: input.principal.ownerId },
          },
          measure,
          now,
        });

        const receiptId = randomUUID();
        const response: ControlAcceptedResponse = {
          receipt_id: receiptId,
          receipt_status: pendingKill ? "accepted" : "succeeded",
        };
        const unconfirmedTurnId = pendingKill
          ? null
          : await measure("earliest_unknown_turn_ms", () =>
              earliestUnknownTurn(tx, sessionId),
            );
        await measure("insert_receipt_ms", () =>
          tx.insert(receipts).values({
            id: receiptId,
            ownerId: scope.principal,
            actor: scope.actor,
            requestId: scope.requestId,
            operation: TERMINATE,
            targetRef: {
              session_id: sessionId,
              turn_id: null,
              request_id: null,
            },
            status: response.receipt_status,
            // Nothing to kill: the command is complete as soon as it is durable.
            result: pendingKill
              ? null
              : terminateReceiptResult({
                  checkpointRevision: session.checkpointRevision,
                  unconfirmedTurnId,
                }),
            // The deadline counts from durable acceptance, not from when the
            // caller read its clock: lock waits inside this transaction must
            // not eat into the kill's observation window.
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          }),
        );
        await measure("insert_idempotency_key_ms", () =>
          tx.insert(idempotencyKeys).values({
            principal: scope.principal,
            operation: scope.operation,
            resource: scope.resource,
            key: scope.key,
            payloadHash: input.payloadHash,
            receiptId,
          }),
        );
        return { outcome: "accepted", response };
      }
    },

    pauseAtomic(input: PauseSessionInput) {
      return pauseAtomic(db, input);
    },

    async closeAtomic(input: CloseSessionInput) {
      const result = await closeAtomic(db, input);
      if (
        result.outcome === "accepted" &&
        result.response.receipt_status === "succeeded"
      ) {
        const effectiveAt = new Date();
        logControlResult(options.logger, {
          acceptedAt: effectiveAt,
          controlId: result.response.receipt_id,
          effectiveAt,
          operation: "close",
          outcome: "succeeded",
          reasonCode: "already_absent",
          sessionId: input.sessionId.toLowerCase(),
        });
      }
      return result;
    },

    decideRecoveryAtomic(input: RecoveryDecisionInput) {
      return decideRecoveryAtomic(db, input);
    },

    resumeAtomic(input: ResumeSessionInput) {
      return resumeAtomic(db, input);
    },
    renameAtomic(input: RenameSessionInput) {
      return renameAtomic(db, input);
    },
  };
}
