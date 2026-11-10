import {
  auditIdOf,
  INVALID_TOOL_NAME,
  mcpServerOf,
  type PendingSettlement,
  postSessionAnswerRequestSchema,
  surfaceKindSchema,
} from "@werft-ai/contracts";
import type {
  InvalidateApprovalCheckpointInput,
  InvalidateApprovalCheckpointResult,
  ParkDeclinedInput,
  ParkDeclinedResult,
  PendingControlInput,
  PendingControlResult,
  RegisterPendingInput,
  RegisterPendingResult,
  RequestParkInput,
  RequestParkResult,
  WorkerFence,
  WorkerPendingStore,
} from "@werft-ai/platform";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { runtimeColumns } from "./checkpoint-runtime.ts";
import { OPEN_TURN_STATUSES, parseTurnSequence } from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import { DRAINING_STATES, drainOf, openDrainReceipt } from "./drain.ts";
import { acquireFence, leaseHeld } from "./fence.ts";
import { lockDeliveredParked, settleParkedDeliveries } from "./parked-group.ts";
import { openPauseReceipt, openSystemPark } from "./pause-control.ts";
import { awaitingInputAt, publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  approvalCheckpoints,
  approvalCheckpointVoids,
  pendingRequests,
  receipts,
  sessions,
  turns,
} from "./schema.ts";
import {
  announceInputWaitEnded,
  inputWaitBefore,
  recordEvent,
  recordStatus,
} from "./session-events.ts";
import { insertAskedToolCallAudit } from "./tool-call-audit.ts";
import { openInterruptFor, turnInterruptPending } from "./turn-interrupts.ts";

const CANCELLED_BEFORE_ANSWER = {
  park: "the turn was parked before the answer reached the request",
  shutdown: "the worker shut down before the answer reached the request",
  interrupt: "the turn was interrupted before the answer reached the request",
  refused: "the worker refused the answer for this request",
} satisfies Record<NonNullable<PendingSettlement["reason"]>, string>;

// What the worker's word does to the answer's receipt. `answered` means the
// callback got it, whatever it decided, unless the run could not say it held
// the request: then nobody knows whether the engine acted on it. The others
// mean the answer was dropped, so the person who gave it learns it did
// nothing, and why when the worker said.
function receiptEffect(settlement: PendingSettlement) {
  if (settlement.outcome === "answered") {
    return settlement.answer_result === "unknown"
      ? {
          status: "unknown" as const,
          error: {
            code: "REQUEST_STALE",
            message:
              "the engine did not know the request when the answer reached it, so it may or may not have acted on it",
          },
        }
      : { status: "succeeded" as const, error: null };
  }
  if (settlement.outcome === "expired") {
    return {
      status: "failed" as const,
      error: {
        code: "REQUEST_EXPIRED",
        message:
          "the request timed out on the worker before the answer reached it",
      },
    };
  }
  return {
    status: "failed" as const,
    error: {
      code: "REQUEST_STALE",
      message:
        settlement.answer_result === "stale"
          ? "the engine had already closed the request when the answer reached it"
          : settlement.reason !== undefined
            ? CANCELLED_BEFORE_ANSWER[settlement.reason]
            : "the request's callback was gone before the answer reached it",
    },
  };
}

// The event a worker that hands publication over would have published: the
// display copy it registered, which is already redacted, plus the expiry
// only the control plane knows.
function questionEvent(
  requestId: string,
  request: RegisterPendingInput["request"],
  announce: NonNullable<RegisterPendingInput["announce"]>,
  expiresAt: Date,
) {
  return {
    request_id: requestId,
    tool_use_id: announce.tool_use_id,
    kind: request.kind,
    // A permission names its tool in the request, which is what the
    // callback and the pending list act on; the announce cannot restate it.
    tool: request.kind === "permission" ? request.tool : announce.tool,
    input:
      request.kind === "permission"
        ? request.input
        : { questions: request.questions },
    expires_at: expiresAt.toISOString(),
  };
}

// A parked request's answer is not for the attempt that asked, even one
// still up between the park's finalize and its release: it goes to the turn
// that resumes the park.
function undelivered(fence: WorkerFence) {
  return and(
    eq(pendingRequests.sessionId, fence.sessionId),
    eq(pendingRequests.attemptId, fence.attemptId),
    isNotNull(pendingRequests.answeredAt),
    isNull(pendingRequests.settledAt),
    isNull(pendingRequests.parkedAt),
  );
}

export function createPostgresWorkerPendingStore(
  db: Database,
): WorkerPendingStore {
  return {
    registerAtomic(
      input: RegisterPendingInput,
    ): Promise<RegisterPendingResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const sequence = parseTurnSequence(input.turnId);
        const [turn] = sequence
          ? await tx
              .select({
                id: turns.id,
                status: turns.status,
                sequence: turns.sequence,
              })
              .from(turns)
              .where(
                and(
                  eq(turns.sessionId, fence.sessionId),
                  eq(turns.sequence, sequence),
                  eq(turns.attemptId, fence.attemptId),
                ),
              )
              .limit(1)
          : [];
        if (!turn) return { outcome: "turn_not_found" };

        const [existing] = await tx
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.requestId, input.requestId))
          .limit(1)
          .for("update");
        const at = await dbNow(tx);
        if (existing) {
          // A retry of a registration whose response was lost. It stays the
          // same registration — same expiry, answered or not, turn closed or
          // not — until the worker settles it; after that the id is spent.
          // Refusing it once the turn closed would tell the worker no row
          // exists, and it would drop the settlement the row still needs.
          const same =
            existing.sessionId === fence.sessionId &&
            existing.attemptId === fence.attemptId &&
            existing.turnId === turn.id &&
            existing.kind === input.request.kind &&
            existing.inputHash === input.inputHash &&
            existing.toolUseId === (input.announce?.tool_use_id ?? null) &&
            existing.tool === (input.announce?.tool ?? null) &&
            existing.settledAt === null;
          if (!same) return { outcome: "conflict" };
          return {
            outcome: "replayed",
            expiresAt: existing.expiresAt,
            expiresInMs: Math.max(
              0,
              existing.expiresAt.getTime() - at.getTime(),
            ),
          };
        }
        // A new registration only in the turn this attempt is running: a
        // callback belongs to the turn that raised it, and a closed turn has
        // no callback left.
        if (!OPEN_TURN_STATUSES.includes(turn.status)) {
          return { outcome: "turn_not_found" };
        }
        // Accepting the interrupt invalidated the turn's open requests; one
        // registered after it would be a callback nobody can answer.
        if (await turnInterruptPending(tx, turn.id)) {
          return { outcome: "turn_interrupted" };
        }
        if (!leaseHeld(fenced.attempt, at)) return { outcome: "lease_expired" };
        const expiresAt = new Date(at.getTime() + input.ttlMs);
        // Read before the insert: whether the stream already says this
        // session is waiting, and whether that is still true. An earlier
        // wait that lapsed with no write is reported first, so the stream
        // does not run one wait into the next.
        const waiting =
          input.announce !== undefined &&
          (await awaitingInputAt(tx, fence.sessionId, at));
        if (
          input.announce !== undefined &&
          fenced.session.inputAnnounced &&
          !waiting
        ) {
          await recordStatus(tx, {
            sessionId: fence.sessionId,
            phase: publicStatus(fenced.session.status, false),
            turnRowId: turn.id,
            now: at,
          });
        }
        const checkpoint = input.checkpoint;
        if (checkpoint !== undefined) {
          const [voided] = await tx
            .select({ at: approvalCheckpointVoids.voidedAt })
            .from(approvalCheckpointVoids)
            .where(
              and(
                eq(approvalCheckpointVoids.manifestRef, checkpoint.manifestRef),
                eq(approvalCheckpointVoids.sessionId, fence.sessionId),
                eq(approvalCheckpointVoids.attemptId, fence.attemptId),
              ),
            );
          await tx.insert(approvalCheckpoints).values({
            manifestRef: checkpoint.manifestRef,
            sessionId: fence.sessionId,
            revision: checkpoint.revision,
            manifestSha256: checkpoint.manifestSha256,
            manifestVersion: checkpoint.manifestVersion ?? null,
            versionsHeld: checkpoint.versionsHeld,
            transcriptBytes: checkpoint.transcriptBytes ?? null,
            ...runtimeColumns(checkpoint.runtime),
            attemptId: fence.attemptId,
            turnId: turn.id,
            answersThrough: checkpoint.answersThrough,
            createdAt: at,
            invalidatedAt: voided?.at ?? null,
          });
        }
        await tx.insert(pendingRequests).values({
          requestId: input.requestId,
          sessionId: fence.sessionId,
          turnId: turn.id,
          attemptId: fence.attemptId,
          kind: input.request.kind,
          payload: input.request,
          inputHash: input.inputHash,
          expiresAt,
          createdAt: at,
          toolUseId: input.announce?.tool_use_id ?? null,
          tool: input.announce?.tool ?? null,
          checkpointRef: checkpoint?.manifestRef ?? null,
        });
        if (input.request.kind === "permission" && input.announce) {
          const name = auditIdOf(input.announce.tool) ?? INVALID_TOOL_NAME;
          await insertAskedToolCallAudit(tx, {
            session: fenced.session,
            attemptId: fence.attemptId,
            turn: { id: turn.id, sequence: turn.sequence },
            requestId: input.requestId,
            toolUseId: auditIdOf(input.announce.tool_use_id),
            tool: {
              name,
              mcpServer: name === INVALID_TOOL_NAME ? null : mcpServerOf(name),
            },
          });
        }
        if (checkpoint !== undefined) {
          // The engine was still waiting on every row of the turn no answer
          // has reached yet when this was captured, so it covers them too;
          // the checkpoint they were bound to is left for collection.
          await tx
            .update(pendingRequests)
            .set({ checkpointRef: checkpoint.manifestRef })
            .where(
              and(
                eq(pendingRequests.sessionId, fence.sessionId),
                eq(pendingRequests.turnId, turn.id),
                eq(pendingRequests.attemptId, fence.attemptId),
                isNull(pendingRequests.settledAt),
                isNull(pendingRequests.deliveredAt),
                isNull(pendingRequests.parkedAt),
              ),
            );
        }
        if (input.announce !== undefined) {
          // The question first, then the status it opens, in this
          // transaction: a client never sees needs_input for a question it
          // has not been shown. The session row is locked by the fence.
          await recordEvent(tx, {
            sessionId: fence.sessionId,
            type: "question",
            payload: questionEvent(
              input.requestId,
              input.request,
              input.announce,
              expiresAt,
            ),
            turnRowId: turn.id,
            attemptId: fence.attemptId,
            now: at,
          });
          if (!(fenced.session.inputAnnounced && waiting)) {
            await recordStatus(tx, {
              sessionId: fence.sessionId,
              phase: publicStatus(fenced.session.status, true),
              turnRowId: turn.id,
              now: at,
            });
          }
        }
        return {
          outcome: "registered",
          expiresAt,
          expiresInMs: input.ttlMs,
        };
      });
    },

    invalidateApprovalCheckpointAtomic(
      input: InvalidateApprovalCheckpointInput,
    ): Promise<InvalidateApprovalCheckpointResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const at = await dbNow(tx);
        const voided = await tx
          .update(approvalCheckpoints)
          .set({
            invalidatedAt: sql`coalesce(${approvalCheckpoints.invalidatedAt}, ${at})`,
          })
          .where(
            and(
              eq(approvalCheckpoints.manifestRef, input.manifestRef),
              eq(approvalCheckpoints.sessionId, fence.sessionId),
              eq(approvalCheckpoints.attemptId, fence.attemptId),
            ),
          )
          .returning({ ref: approvalCheckpoints.manifestRef });
        if (voided.length === 0) {
          await tx
            .insert(approvalCheckpointVoids)
            .values({
              manifestRef: input.manifestRef,
              sessionId: fence.sessionId,
              attemptId: fence.attemptId,
              voidedAt: at,
            })
            .onConflictDoNothing();
        }
        return { outcome: "ok", invalidated: voided.length === 1 };
      });
    },

    pendingControlAtomic(
      input: PendingControlInput,
    ): Promise<PendingControlResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const locked =
          input.settled.length === 0
            ? []
            : await tx
                .select()
                .from(pendingRequests)
                .where(
                  and(
                    eq(pendingRequests.sessionId, fence.sessionId),
                    eq(pendingRequests.attemptId, fence.attemptId),
                    inArray(
                      pendingRequests.requestId,
                      input.settled.map((item) => item.request_id),
                    ),
                    // The answer, the expiry or a close settles a parked one.
                    isNull(pendingRequests.parkedAt),
                  ),
                )
                .orderBy(asc(pendingRequests.requestId))
                .for("update");
        const delivered = input.delivered ?? [];
        const parked =
          delivered.length === 0
            ? []
            : await lockDeliveredParked(tx, {
                fence,
                requestIds: delivered.map((item) => item.request_id),
              });
        const due = await tx
          .select({
            requestId: pendingRequests.requestId,
            sequence: pendingRequests.answerSequence,
            answer: pendingRequests.answer,
            inputHash: pendingRequests.inputHash,
            answerSurface: pendingRequests.answerSurface,
          })
          .from(pendingRequests)
          .where(
            and(
              undelivered(fence),
              gt(pendingRequests.answerSequence, input.answersAfter),
            ),
          )
          .orderBy(asc(pendingRequests.answerSequence));
        const control = await openInterruptFor(tx, {
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        });
        // The session row was locked with the fence, so this is the pause
        // as the attempt's lease sees it.
        // A close drains through the same control as a pause.
        const [pause] =
          drainOf(fenced.session.admissionState) !== undefined
            ? await tx
                .select({ id: receipts.id, createdAt: receipts.createdAt })
                .from(receipts)
                .where(openDrainReceipt(fence.sessionId))
                .limit(1)
            : [];
        // Judged after every read that can wait on a lock and before the
        // first write: returning lease_expired does not roll back, and an
        // answer handed over after the lease ended would let the engine act
        // for an owner that is gone.
        const at = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, at)) {
          return { outcome: "lease_expired" };
        }
        const byId = new Map(locked.map((row) => [row.requestId, row]));
        const waitingBefore =
          locked.length > 0 && (await inputWaitBefore(tx, fenced.session, at));
        const settledNow = new Set<string>();
        const settledTurns = new Set<number>();
        for (const settlement of input.settled) {
          const row = byId.get(settlement.request_id);
          // Unknown or already settled: the first word stands, and a
          // repeat of it is what a retried poll looks like.
          if (!row || row.settledAt !== null) continue;
          // Nothing was delivered, so there is nothing to have answered.
          if (settlement.outcome === "answered" && row.answeredAt === null) {
            continue;
          }
          await tx
            .update(pendingRequests)
            .set({
              settledAt: at,
              settledOutcome: settlement.outcome,
              settledReason: settlement.reason ?? null,
              settledAnswerResult: settlement.answer_result ?? null,
              resolvedAt: row.resolvedAt ?? at,
            })
            .where(eq(pendingRequests.requestId, row.requestId));
          row.settledAt = at;
          settledNow.add(row.requestId);
          settledTurns.add(row.turnId);
          if (row.answerReceiptId !== null) {
            const effect = receiptEffect(settlement);
            await tx
              .update(receipts)
              .set({ ...effect, updatedAt: at })
              .where(
                and(
                  eq(receipts.id, row.answerReceiptId),
                  eq(receipts.status, "accepted"),
                ),
              );
          }
        }
        if (settledNow.size > 0) {
          await announceInputWaitEnded(tx, {
            sessionId: fence.sessionId,
            waitingBefore,
            // The turn whose requests this call closed; a retried batch
            // can also carry rows an earlier call already settled.
            turnRowId:
              settledTurns.size === 1 ? ([...settledTurns][0] ?? null) : null,
            at,
          });
        }
        await settleParkedDeliveries(tx, { rows: parked, delivered, at });
        const rows = due.filter((row) => !settledNow.has(row.requestId));
        if (rows.length > 0) {
          // Handed over from here: past this commit an engine may act on
          // the answer.
          await tx
            .update(pendingRequests)
            .set({ deliveredAt: at })
            .where(
              and(
                inArray(
                  pendingRequests.requestId,
                  rows.map((row) => row.requestId),
                ),
                isNull(pendingRequests.deliveredAt),
              ),
            );
        }
        return {
          outcome: "ok",
          control:
            control !== null
              ? {
                  controlId: control.controlId,
                  kind: "interrupt",
                  turnId: String(control.turnSequence),
                  issuedAt: control.issuedAt,
                }
              : pause === undefined
                ? null
                : {
                    controlId: pause.id,
                    // pause_reason holds only while pausing or paused, so
                    // a close's drain is never a park.
                    kind:
                      fenced.session.pauseReason === "awaiting_input"
                        ? "park"
                        : "pause",
                    turnId: null,
                    issuedAt: pause.createdAt,
                  },
          answers: rows.map((row) => ({
            sequence: row.sequence as number,
            answer: postSessionAnswerRequestSchema.parse(row.answer),
            inputHash: row.inputHash,
            answerSurface:
              surfaceKindSchema.safeParse(row.answerSurface).data ?? null,
          })),
        };
      });
    },

    /**
     * The worker will not park: the session goes back to active and the turn
     * runs on, its requests still waiting. Only while the park is still the
     * open pause — a person's pause that took it over, or one already
     * superseded, stands.
     */
    parkDeclinedAtomic(input: ParkDeclinedInput): Promise<ParkDeclinedResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        if (
          session.admissionState !== "pausing" ||
          session.pauseReason !== "awaiting_input"
        ) {
          return { outcome: "ok", reverted: false };
        }
        const [pause] = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(openPauseReceipt(fence.sessionId))
          .limit(1)
          .for("update");
        if (pause?.id !== input.pauseControlId) {
          return { outcome: "ok", reverted: false };
        }
        // After the receipt lock's wait, before the first write.
        const now = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, now)) {
          return { outcome: "lease_expired" };
        }
        // The worker keeps its epoch and lease, as when a resume cancels a
        // pause still draining; pause_reason clears with the admission.
        await tx
          .update(sessions)
          .set({
            revision: sql`${sessions.revision} + 1`,
            admissionState: "active",
            updatedAt: now,
          })
          .where(eq(sessions.id, fence.sessionId));
        await tx
          .update(receipts)
          .set({
            status: "failed",
            error: {
              code: "PAUSE_CANCELLED",
              message: `the worker declined the park (${input.reason})`,
            },
            updatedAt: now,
          })
          .where(eq(receipts.id, pause.id));
        await recordStatus(tx, {
          sessionId: fence.sessionId,
          phase: publicStatus(
            session.status,
            await awaitingInputAt(tx, fence.sessionId, now),
          ),
          extra: {
            admission_state: "active",
            park_declined: { pause_control_id: pause.id, reason: input.reason },
          },
          turnRowId: null,
          now,
        });
        return { outcome: "ok", reverted: true };
      });
    },

    /**
     * The worker's own turn is about to run past its deadline waiting on
     * nobody but a person: the same system pause a timed park opens, named
     * so the worker can cut, finalize and release under it. Asked again
     * while that park is still the open pause, it names the same one.
     */
    requestParkAtomic(input: RequestParkInput): Promise<RequestParkResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        const sequence = parseTurnSequence(input.turnId);
        const [turn] =
          sequence === null
            ? []
            : await tx
                .select({ id: turns.id })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, fence.sessionId),
                    eq(turns.sequence, sequence),
                    eq(turns.attemptId, fence.attemptId),
                    inArray(turns.status, OPEN_TURN_STATUSES),
                  ),
                )
                .limit(1);
        if (!turn) return { outcome: "not_found" };
        const [pause] =
          session.admissionState === "pausing" &&
          session.pauseReason === "awaiting_input"
            ? await tx
                .select({ id: receipts.id })
                .from(receipts)
                .where(openPauseReceipt(fence.sessionId))
                .limit(1)
            : [];
        const open = await tx
          .select({ answeredAt: pendingRequests.answeredAt })
          .from(pendingRequests)
          .where(
            and(
              eq(pendingRequests.turnId, turn.id),
              eq(pendingRequests.attemptId, fence.attemptId),
              isNull(pendingRequests.settledAt),
              isNull(pendingRequests.parkedAt),
            ),
          );
        const now = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, now)) {
          return { outcome: "lease_expired" };
        }
        if (pause !== undefined) {
          return { outcome: "ok", pauseControlId: pause.id };
        }
        if (session.admissionState !== "active") {
          return {
            outcome: "refused",
            reason: `the session is ${session.admissionState}`,
          };
        }
        if (open.length === 0) {
          return { outcome: "refused", reason: "the turn waits on no request" };
        }
        // An answer already on its way would be cut off by the park.
        if (open.some((row) => row.answeredAt !== null)) {
          return {
            outcome: "refused",
            reason: "an answer has not been settled yet",
          };
        }
        return {
          outcome: "ok",
          pauseControlId: await openSystemPark(tx, session, now),
        };
      });
    },

    async hasUndelivered(fence: WorkerFence): Promise<boolean> {
      const [row] = await db
        .select({ one: sql<number>`1` })
        .from(pendingRequests)
        .where(undelivered(fence))
        .limit(1);
      if (row !== undefined) return true;
      if (
        (await openInterruptFor(db, {
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        })) !== null
      ) {
        return true;
      }
      const [draining] = await db
        .select({ one: sql<number>`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, fence.sessionId),
            inArray(sessions.admissionState, DRAINING_STATES),
          ),
        )
        .limit(1);
      return draining !== undefined;
    },
  };
}
