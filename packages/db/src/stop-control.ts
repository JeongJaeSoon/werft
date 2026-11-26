import type {
  SessionStops,
  StopQueuedInput,
  StopQueuedResult,
} from "@werft-ai/platform";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  lockSessionForControl,
  OPEN_TURN_STATUSES,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { cancelQueuedInput } from "./recovery-control.ts";
import { turns } from "./schema.ts";
import { touchSlackThreadStatus } from "./surface/slack-thread-status.ts";

export function createPostgresSessionStops(db: Database): SessionStops {
  return {
    cancelQueuedBefore(input: StopQueuedInput): Promise<StopQueuedResult> {
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
          queuedBefore: now,
        });
        if (cancelled.length > 0) await touchSlackThreadStatus(tx, sessionId);
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
        return {
          outcome: "cancelled",
          cancelled: cancelled.length,
          runningTurnId:
            running === undefined ? null : String(running.sequence),
        };
      });
    },
  };
}
