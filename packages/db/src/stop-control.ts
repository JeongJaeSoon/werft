import type {
  SessionStops,
  StopQueuedInput,
  StopQueuedResult,
} from "@werft-ai/platform";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  lockSessionForControl,
  OPEN_TURN_STATUSES,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { cancelQueuedInput, closeSessionRow } from "./recovery-control.ts";
import { sessionStops, type sessions, turns } from "./schema.ts";
import {
  hasRestorePoint,
  restoreBaseRevision,
} from "./sessions/pause-policy.ts";
import { recordEvent, recordStatus } from "./sessions/session-events.ts";
import { recordTaskClosedReason } from "./sessions/task-fields.ts";
import { touchSlackThreadStatus } from "./surface/slack-thread-status.ts";

/** Who closed it, on the session_closed event and the status event. */
export const STOP_BEFORE_START = "stop_before_start";

export function createPostgresSessionStops(db: Database): SessionStops {
  return {
    cancelQueued(input: StopQueuedInput): Promise<StopQueuedResult> {
      const sessionId = input.sessionId.toLowerCase();
      return transactionWithBindingRetry(db, async (tx, attempt) => {
        // The lock a dispatch and a finalize take too: no queued turn starts
        // and no running one ends while this reads and cancels.
        const session = await lockSessionForControl(tx, {
          sessionId,
          ownerId: input.principal.ownerId,
          attempt,
        });
        if (session === null) return { outcome: "not_found" };
        // A retry of this stop: what it did then, not what is running now,
        // even once the session has closed since.
        const [done] = await tx
          .select({
            cancelled: sessionStops.cancelled,
            runningTurnId: sessionStops.runningTurnId,
          })
          .from(sessionStops)
          .where(
            and(
              eq(sessionStops.sessionId, sessionId),
              eq(sessionStops.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (done !== undefined) {
          // Only that stop records a task cancelled while nothing ran.
          return {
            outcome: "cancelled",
            ...done,
            closed:
              session.admissionState === "closed" &&
              session.taskClosedReason === "cancelled" &&
              done.runningTurnId === null &&
              !(await anyTurnStarted(tx, sessionId)),
          };
        }
        if (
          session.admissionState === "closed" ||
          session.admissionState === "closing"
        ) {
          return { outcome: "closed" };
        }
        const now = await dbNow(tx);
        const cancelled = await cancelQueuedInput(tx, {
          sessionId,
          terminalReason: "stop_requested",
          error: {
            code: "CONTROL_SUPERSEDED",
            message: "input cancelled by a stop before it ran",
          },
          now,
          inputOnly: true,
        });
        const [running] = await tx
          .select({ sequence: turns.sequence })
          .from(turns)
          .where(
            and(
              eq(turns.sessionId, sessionId),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          )
          .orderBy(desc(turns.sequence))
          .limit(1);
        const closed =
          running === undefined &&
          cancelled.length > 0 &&
          session.taskClosing !== null &&
          session.admissionState === "active" &&
          !(await anyTurnStarted(tx, sessionId));
        if (closed) {
          await closeUnstartedTask(tx, session, now, cancelled.length);
        }
        if (cancelled.length > 0) await touchSlackThreadStatus(tx, sessionId);
        const result = {
          cancelled: cancelled.length,
          runningTurnId:
            running === undefined ? null : String(running.sequence),
        };
        await tx.insert(sessionStops).values({
          sessionId,
          idempotencyKey: input.idempotencyKey,
          ...result,
        });
        return { outcome: "cancelled", ...result, closed };
      });
    },
  };
}

type SessionRow = typeof sessions.$inferSelect;

async function anyTurnStarted(
  tx: Database,
  sessionId: string,
): Promise<boolean> {
  const [started] = await tx
    .select({ sequence: turns.sequence })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), isNotNull(turns.startedAt)))
    .limit(1);
  return started !== undefined;
}

/**
 * A task stopped before its first turn started: nothing ran, so nothing is
 * left to resume once its input is cancelled, and open it would hold one of
 * the open tasks its conversation and agent may have (openTaskLimit) until
 * it closed as abandoned. Closed as a recovery close leaves a session, the
 * task as cancelled.
 */
async function closeUnstartedTask(
  tx: Database,
  session: SessionRow,
  now: Date,
  cancelledTurnCount: number,
): Promise<void> {
  await closeSessionRow(
    tx,
    session,
    now,
    "superseded by a stop before the task's first turn",
  );
  await recordTaskClosedReason(tx, session.id, "cancelled");
  await recordStatus(tx, {
    sessionId: session.id,
    phase: "stopped",
    extra: { admission_state: "closed", closed_by: STOP_BEFORE_START },
    turnRowId: null,
    now,
  });
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: {
      type: "system",
      subtype: "session_closed",
      closed_by: STOP_BEFORE_START,
      checkpoint_revision: hasRestorePoint(session)
        ? restoreBaseRevision(session)
        : null,
      cancelled_turn_count: cancelledTurnCount,
    },
    turnRowId: null,
    now,
  });
}
