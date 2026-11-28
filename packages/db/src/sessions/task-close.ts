import { randomUUID } from "node:crypto";
import type { TaskClosedReason } from "@werft-ai/contracts";
import type {
  Principal,
  RequesterCloseReason,
  TaskCloseOutcome,
  TaskCloses,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { sessionOutcomes, sessions } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import {
  closeAtomic,
  PULL_REQUEST_EVENT,
  taskClosePayloadHash,
} from "./close-control.ts";

// A session that moves between the read and the close is read again.
const REVISION_ATTEMPTS = 3;

/** A task its pull requests, read under its lock, no longer close. */
class NotDue extends Error {}

/**
 * The reason a task's pull requests close it with: any merged, completed;
 * else closed with none open, cancelled. Read under the session's lock,
 * which saving a pull request takes first too, so one saved before the close
 * is seen. The rows are not locked: a refresh holds its row while it waits
 * on the session (queueAchievementJudgment), and one not committed yet
 * settles after the close.
 */
async function pullRequestReason(
  tx: Database,
  sessionId: string,
): Promise<TaskClosedReason> {
  const states = (
    await tx
      .select({ state: sessionOutcomes.state })
      .from(sessionOutcomes)
      .where(
        and(
          eq(sessionOutcomes.sessionId, sessionId),
          eq(sessionOutcomes.type, "github_pull_request"),
        ),
      )
  ).map(({ state }) => state);
  if (states.includes("merged")) return "completed";
  if (states.includes("closed") && !states.includes("open")) return "cancelled";
  throw new NotDue();
}

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
    reason: TaskClosedReason | typeof pullRequestReason;
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
    let result: Awaited<ReturnType<typeof closeAtomic>>;
    try {
      result = await closeAtomic(db, {
        principal: input.principal ?? { ownerId: row.ownerId },
        sessionId,
        idempotencyKey: randomUUID(),
        // closeAtomic stores the reason's own hash once it is judged.
        payloadHash:
          typeof input.reason === "function"
            ? "task_close"
            : taskClosePayloadHash(input.reason),
        expectedRevision: row.revision,
        reason: null,
        now: new Date(),
        ...(input.by === undefined ? {} : { by: input.by }),
        taskClosedReason: input.reason,
      });
    } catch (error) {
      if (error instanceof NotDue) return "refused";
      throw error;
    }
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
  // Where the next pass goes on from, so tasks closeAtomic keeps refusing
  // never hold the ones after them out of every pass.
  let after: string | null = null;
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
      // Candidates only: each close judges its reason again under its lock.
      const due = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT s.id
          FROM ${sessions} s
          JOIN session_outcomes o ON o.session_id = s.id
            AND o.type = 'github_pull_request'
          WHERE s.task_closed_reason IS NULL
            AND s.admission_state IN ('active', 'paused', 'stopped')
            AND (s.task_closing ->> 'eventRules')::boolean
            AND (${after}::uuid IS NULL OR s.id > ${after}::uuid)
          GROUP BY s.id
          HAVING bool_or(o.state = 'merged')
            OR (bool_or(o.state = 'closed') AND NOT bool_or(o.state = 'open'))
          ORDER BY s.id
          LIMIT ${limit}`),
      );
      after = due.length < limit ? null : (due.at(-1)?.id ?? null);
      let closed = 0;
      let failure: unknown;
      // One session failing leaves the others to close; the pass reports it.
      for (const row of due) {
        try {
          const outcome = await closeTask(db, {
            principal: null,
            sessionId: row.id,
            reason: pullRequestReason,
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
