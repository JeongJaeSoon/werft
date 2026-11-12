import { randomUUID } from "node:crypto";
import {
  type ControlAcceptedResponse,
  terminalTurnStatusSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  InterruptTurnInput,
  InterruptTurnResult,
  TurnInterrupts,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import { and, eq, isNull } from "drizzle-orm";
import {
  type ControlResultEvent,
  logControlResult,
} from "../control-observability.ts";
import {
  controlReplay,
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
  OPEN_TURN_STATUSES,
  parseTurnSequence,
} from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import { cancelParkedRequests } from "../decision/pending-requests.ts";
import type { Database } from "../queries.ts";
import {
  controlIntents,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turnContinuations,
  turns,
} from "../schema.ts";
import { closeParkedGroup } from "./parked-group.ts";
import { announceInputWaitEnded, inputWaitBefore } from "./session-events.ts";
import { interruptReceiptResult } from "./turn-interrupts.ts";

const INTERRUPT = "interrupt";

export function createPostgresTurnInterrupts(
  db: Database,
  options: { logger?: StructuredLogger } = {},
): TurnInterrupts {
  return {
    async interruptAtomic(
      input: InterruptTurnInput,
    ): Promise<InterruptTurnResult> {
      const sessionId = input.sessionId.toLowerCase();
      let completed: ControlResultEvent | undefined;
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: INTERRUPT,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      const result: InterruptTurnResult = await db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        const replay = controlReplay(existing, input.payloadHash);
        if (replay) return replay;

        // The session row lock is what finalize and the execution-gone path
        // take before they give a turn its terminal, so the turn read below
        // cannot change until this commits: either it is already terminal
        // and this is a no-op, or the intent is stored before the terminal
        // and settled by it.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        const sequence = parseTurnSequence(input.targetTurnId);
        const [turn] =
          sequence === null
            ? []
            : await tx
                .select({
                  id: turns.id,
                  sequence: turns.sequence,
                  status: turns.status,
                  attemptId: turns.attemptId,
                })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, sessionId),
                    eq(turns.sequence, sequence),
                  ),
                )
                .limit(1);
        if (!turn) return { outcome: "not_found" };
        if (turn.status === "queued") return { outcome: "not_started" };
        const open = OPEN_TURN_STATUSES.includes(turn.status);
        // A turn running with no attempt was handed out by the legacy pod
        // lifecycle; nothing there polls for control, so the intent would
        // wait forever.
        if (open && turn.attemptId === null) return { outcome: "unsupported" };
        // An ended turn's interrupt closes its parked group, which may resume
        // an answered one onto the workspace GC is removing. Checked before
        // anything is written, so the same request goes through afterwards.
        if (
          !open &&
          session.admissionState === "paused" &&
          session.workspaceReclaimId !== null
        ) {
          return { outcome: "workspace_reclaiming" };
        }

        const at = await dbNow(tx);
        const receiptId = randomUUID();
        const response: ControlAcceptedResponse = {
          receipt_id: receiptId,
          receipt_status: open ? "accepted" : "succeeded",
        };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          actor: scope.actor,
          requestId: scope.requestId,
          operation: INTERRUPT,
          targetRef: {
            session_id: sessionId,
            turn_id: String(turn.sequence),
            request_id: null,
          },
          status: response.receipt_status,
          // A turn that already ended answers at once, naming how it ended.
          result: open
            ? null
            : interruptReceiptResult(
                turn.sequence,
                terminalTurnStatusSchema.parse(turn.status),
                false,
              ),
          createdAt: at,
          updatedAt: at,
        });
        const waitingBefore = await inputWaitBefore(tx, session, at);
        if (open) {
          await tx.insert(controlIntents).values({
            id: randomUUID(),
            sessionId,
            kind: INTERRUPT,
            targetTurnId: turn.id,
            attemptId: turn.attemptId,
            receiptId,
            issuedAt: at,
          });
          // An answer given from here on would reach a turn that is being
          // stopped; the requests close now, and the worker cancels the
          // callbacks it still holds.
          await tx
            .update(pendingRequests)
            .set({ resolvedAt: at })
            .where(
              and(
                eq(pendingRequests.turnId, turn.id),
                isNull(pendingRequests.resolvedAt),
              ),
            );
        } else {
          // A parked turn has already ended; interrupting it gives up the
          // resume its requests wait for. Once it is carried on, its
          // answers and grants may already be with a worker: the turn
          // carrying it on is the one to interrupt.
          const [carried] = await tx
            .select({ turnId: turnContinuations.turnId })
            .from(turnContinuations)
            .where(eq(turnContinuations.parkedTurnId, turn.id))
            .limit(1);
          if (!carried) {
            await cancelParkedRequests(
              tx,
              { sessionId, turnRowId: turn.id },
              at,
            );
            await closeParkedGroup(tx, session, {
              by: "interrupt",
              at,
              actor: scope.actor,
            });
          }
        }
        await announceInputWaitEnded(tx, {
          sessionId,
          waitingBefore,
          turnRowId: turn.id,
          at,
        });
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: scope.operation,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        if (!open) {
          completed = {
            acceptedAt: at,
            controlId: receiptId,
            effectiveAt: at,
            operation: "interrupt",
            outcome: turn.status,
            reasonCode: "no_op",
            sessionId,
          };
        }
        return { outcome: "accepted", response };
      });
      if (completed !== undefined) {
        logControlResult(options.logger, completed);
      }
      return result;
    },
  };
}
