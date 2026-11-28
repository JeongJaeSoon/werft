import { randomUUID } from "node:crypto";
import type { TaskClosedReason } from "@werft-ai/contracts";
import type {
  Principal,
  RequesterCloseReason,
  TaskCloseOutcome,
  TaskCloses,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { sessionWorkClosed } from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { sessionOutcomes, sessions } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import {
  closeAtomic,
  IDLE_RULE,
  PULL_REQUEST_EVENT,
  taskClosePayloadHash,
} from "./close-control.ts";

// A session that moves between the read and the close is read again.
const REVISION_ATTEMPTS = 3;

/** A task its pull requests or its time rules, read under its lock, no longer close. */
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
 * A task's time rules (v1-b/C2), on the database clock, over sessions `s`
 * joined to their turns as `a` (`TURN_CLOCK`): no activity for the idle
 * days of its closing rules, or for the quiet days once its turns or their
 * working hours reached its limits. Never while a turn is queued or running.
 * A session without closing rules is no task and is never due.
 */
const TIME_RULE_DUE = sql`
  s.task_closing IS NOT NULL
  AND s.task_closed_reason IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM turns q
    WHERE q.session_id = s.id AND q.status IN ('queued', 'running'))
  AND (
    a.at <= now() - make_interval(days => (s.task_closing ->> 'idleDays')::int)
    OR (
      a.at <= now() - make_interval(
        days => (s.task_closing ->> 'quietAfterLimitDays')::int)
      AND (
        a.turns >= (s.task_interpretation -> 'limits' ->> 'turns')::int
        OR a.worked >= make_interval(
          hours => (s.task_interpretation -> 'limits' ->> 'hours')::int))))`;

/**
 * A session's last activity, its turns, and the time they ran. Activity is
 * its creation, a turn queued, started or ended, a request of it answered,
 * an input taken into its thread's topic (a reply held for M1's judgment is
 * one before it is a turn, bound-replies.ts), and a Slack event of its
 * thread the inbox has not processed yet (a reply the buffer let go of
 * waits there for its retry to hand it to the task). Through its open link
 * only: one closes after its session does. Turns and answers are written
 * under the session's lock; posts and events are not, so one committed
 * before the read under the lock is seen, and one after comes to a closed task.
 */
const TURN_CLOCK = sql`
  CROSS JOIN LATERAL (
    SELECT
      greatest(s.created_at, s.last_turn_at,
        max(greatest(t.created_at, t.started_at, t.ended_at)),
        (SELECT max(p.answered_at) FROM pending_requests p
          WHERE p.session_id = s.id),
        (SELECT max(i.received_at) FROM session_links l
          JOIN slack_installations si ON si.id = l.installation_id
          JOIN conversation_topics tp ON tp.agent_id = l.agent_id
            AND tp.slack_team_id = si.team_id
            AND tp.slack_channel_id = l.channel_id
            AND tp.slack_thread_ts = l.thread_id
          JOIN conversation_inputs i ON i.topic_id = tp.id
          WHERE l.session_id = s.id AND l.closed_at IS NULL),
        (SELECT max(e.received_at) FROM session_links l
          JOIN slack_installations si ON si.id = l.installation_id
          JOIN slack_apps sa ON sa.app_id = si.app_id
          JOIN slack_inbound_events e ON e.status = 'received'
            AND e.conversation_key =
              sa.id::text || ':' || l.channel_id || ':' || l.thread_id
          WHERE l.session_id = s.id AND l.closed_at IS NULL)) AS at,
      count(t.id) AS turns,
      coalesce(sum(t.ended_at - t.started_at), interval '0') AS worked
    FROM turns t WHERE t.session_id = s.id) a`;

/** A task its time rules, read under its lock, close as abandoned. */
async function timeRuleReason(
  tx: Database,
  sessionId: string,
): Promise<TaskClosedReason> {
  const due = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT s.id FROM ${sessions} s ${TURN_CLOCK}
      WHERE s.id = ${sessionId}::uuid AND ${TIME_RULE_DUE}`),
  );
  if (due.length === 0) throw new NotDue();
  return "abandoned";
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
    reason: TaskClosedReason | typeof pullRequestReason | typeof timeRuleReason;
    by?: typeof PULL_REQUEST_EVENT | typeof IDLE_RULE;
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
        // A session gone (no row) is not_found above, not closed work.
        return sessionWorkClosed(result.admissionState)
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

    async closeOnTimeRules(limit) {
      // The states closeAtomic closes from; one settling (pausing,
      // stopping, resuming, recovery_required decided) is taken once it is
      // in one. The sweep is made anew each pass (reconcileOnce) and a pass
      // child can be replaced, so no cursor carries over: a random order
      // keeps tasks the close keeps refusing from holding the others out
      // of every pass.
      const due = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT s.id FROM ${sessions} s ${TURN_CLOCK}
          WHERE s.admission_state IN ('active', 'paused', 'stopped')
            AND ${TIME_RULE_DUE}
          ORDER BY random()
          LIMIT ${limit}`),
      );
      let closed = 0;
      let failure: unknown;
      for (const row of due) {
        try {
          const outcome = await closeTask(db, {
            principal: null,
            sessionId: row.id,
            reason: timeRuleReason,
            by: IDLE_RULE,
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
