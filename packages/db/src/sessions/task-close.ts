import { randomUUID } from "node:crypto";
import type { TaskClosedReason } from "@werft-ai/contracts";
import type {
  Principal,
  RequesterCloseReason,
  TaskCloseOutcome,
  TaskCloses,
} from "@werft-ai/platform";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { sessions } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { closeAtomic, PULL_REQUEST_EVENT } from "./close-control.ts";

// A session that moves between the read and the close is read again.
const REVISION_ATTEMPTS = 3;

/**
 * The owner's close (closeAtomic) of a task with its closed reason in the
 * same transaction, on whatever revision the session is at. With no
 * principal it closes under the session owner's partition, as the system.
 */
async function closeTask(
  db: Database,
  input: {
    principal: Principal | null;
    sessionId: string;
    reason: TaskClosedReason;
    by?: typeof PULL_REQUEST_EVENT;
  },
): Promise<TaskCloseOutcome> {
  const sessionId = input.sessionId.toLowerCase();
  for (let attempt = 1; ; attempt++) {
    const [row] = await db
      .select({
        ownerId: sessions.ownerId,
        revision: sessions.revision,
        taskClosing: sessions.taskClosing,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return "not_found";
    if (row.taskClosing === null) return "not_task";
    const result = await closeAtomic(db, {
      principal: input.principal ?? { ownerId: row.ownerId },
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: `task_close:${input.reason}`,
      expectedRevision: row.revision,
      reason: null,
      now: new Date(),
      ...(input.by === undefined ? {} : { by: input.by }),
      taskClosedReason: input.reason,
    });
    switch (result.outcome) {
      case "accepted":
        if (result.into === undefined) {
          throw new Error("close accepted without its admission state");
        }
        return result.into;
      case "revision_conflict":
        if (attempt < REVISION_ATTEMPTS) continue;
        return "refused";
      case "rejected":
        return result.admissionState === "closed" ||
          result.admissionState === "closing"
          ? "already_closed"
          : "refused";
      case "not_found":
        return "not_found";
      case "replayed":
      case "conflict":
        // A fresh key each time: nothing to replay or conflict with.
        throw new Error(`unexpected close outcome ${result.outcome}`);
      default:
        return "refused";
    }
  }
}

export function createPostgresTaskCloses(db: Database): TaskCloses {
  return {
    close(input: {
      principal: Principal;
      sessionId: string;
      reason: RequesterCloseReason;
    }) {
      return closeTask(db, input);
    },

    async closeOnPullRequests(limit) {
      // Driven by the pull requests that settled: few next to the sessions.
      // The states listed are the ones closeAtomic closes from.
      const due = rowsOf<{ id: string; reason: TaskClosedReason }>(
        await db.execute(sql`
          SELECT s.id, CASE WHEN bool_or(o.state = 'merged')
            THEN 'completed' ELSE 'cancelled' END AS reason
          FROM ${sessions} s
          JOIN session_outcomes o ON o.session_id = s.id
            AND o.type = 'github_pull_request'
          WHERE s.task_closed_reason IS NULL
            AND s.admission_state IN ('active', 'paused', 'stopped')
            AND (s.task_closing ->> 'eventRules')::boolean
          GROUP BY s.id
          HAVING bool_or(o.state = 'merged')
            OR (bool_or(o.state = 'closed') AND NOT bool_or(o.state = 'open'))
          ORDER BY s.id
          LIMIT ${limit}`),
      );
      let closed = 0;
      let failure: unknown;
      // One session failing leaves the others to close; the pass reports it.
      for (const row of due) {
        try {
          const outcome = await closeTask(db, {
            principal: null,
            sessionId: row.id,
            reason: row.reason,
            by: PULL_REQUEST_EVENT,
          });
          if (outcome === "closing" || outcome === "closed") closed += 1;
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return closed;
    },
  };
}
