import {
  type ConversationInputId,
  type ConversationJudgmentId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
import type {
  BoundReplyStore,
  SurfaceInboundFence,
  TaskReplyRoute,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import {
  dropBufferedInputs,
  holdBufferedInput,
  JUDGMENT_BUFFER_TTL_MS,
  lockSlackSourceMark,
  sessionWorkClosed,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { m1GateOpenForWrite } from "./m1-judgments.ts";

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

type Post = { agentId: string; teamId: string; channelId: string; ts: string };

/** The post's channel, over alias `a`. */
const atPost = (post: Post, alias: string) => {
  const a = sql.raw(alias);
  return sql`${a}.agent_id = ${post.agentId}::uuid
    AND ${a}.slack_team_id = ${post.teamId}
    AND ${a}.slack_channel_id = ${post.channelId}`;
};

/** The post's `m1_to_task` records still in the buffer's time (alias `j`). */
const taskJudgmentsOf = (post: Post): SQL => sql`${atPost(post, "j")}
  AND j.grade = 'm1_to_task' AND j.refs = ARRAY[${post.ts}]::text[]
  AND j.created_at > now() - ${secs(JUDGMENT_BUFFER_TTL_MS)}`;

type Ended = {
  outcome: string | null;
  decision: string | null;
  in_time: boolean | null;
};

/**
 * Only a judgment that kept quiet within the wait keeps the reply from its
 * work (PM Q2): a verdict past it, or any other, is the work's.
 */
const kept = (ended: Ended) =>
  ended.outcome === "judged" &&
  ended.decision === "quiet" &&
  ended.in_time === true;

/** Holds the inbox row as its completion does; false: the claim is lost. */
async function claimHeld(tx: Database, fence: SurfaceInboundFence) {
  const rows = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM slack_inbound_events
      WHERE id = ${fence.id}::uuid AND claim_token = ${fence.claimToken}::uuid
        AND lease_expires_at > now()
      FOR UPDATE`),
  );
  return rows.length > 0;
}

/**
 * A bound thread's replies once the rollout is on (v1-b/U1) over
 * PostgreSQL. A reply of work going on is held in the buffer for its
 * `m1_to_task` judgment; the turn that takes it then takes the held row.
 * The held row keeps a judgment record until then, ended or not, so M1's
 * batches never take it.
 */
export function createPostgresBoundReplyStore(
  db: Database,
  options: { bufferLimit?: () => Promise<number> } = {},
): BoundReplyStore {
  const bufferLimit =
    options.bufferLimit ?? (async () => JUDGMENT_BUFFER_LIMIT_PER_CHANNEL);
  return {
    async work(sessionId) {
      const [session] = rowsOf<{ admission_state: string }>(
        await db.execute(sql`
          SELECT admission_state FROM sessions WHERE id = ${sessionId}::uuid`),
      );
      return sessionWorkClosed(session?.admission_state) ? "closed" : "open";
    },

    async heldForWork(post) {
      // Its held row's, or one whose text went (kept quiet, or evicted); a
      // record beside a row a session took is the shadow's, not a hold.
      const rows = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM conversation_judgments j
          WHERE ${taskJudgmentsOf(post)}
            AND NOT EXISTS (
              SELECT 1 FROM conversation_inputs i
              WHERE i.id = j.input_id AND i.buffer_expires_at IS NULL)
          LIMIT 1`),
      );
      return rows.length > 0;
    },

    async taskReply(reply) {
      const limit = await bufferLimit();
      return db.transaction(async (tx): Promise<TaskReplyRoute> => {
        // The inbox row first, as its completion takes it: a claim lost
        // writes nothing, and its defer then finds it lost. Two owners of
        // one event never hold, give up or append its post at once.
        if (!(await claimHeld(tx, reply.fence))) return "waiting";
        // The rollout as of now, held against a switch until this ends: one
        // lowered since the event's read takes the current path (the work).
        const [agent] = rowsOf<{ on: boolean }>(
          await tx.execute(sql`
            SELECT conversation_rollout = 'on' AS on FROM agents
            WHERE id = ${reply.agentId}::uuid FOR SHARE`),
        );
        if (agent?.on !== true) return "session";
        const session = (body: string | null): TaskReplyRoute =>
          body !== null && body !== reply.body ? { edited: body } : "session";
        const [held] = rowsOf<
          {
            id: ConversationInputId;
            held: boolean;
            body: string | null;
            judgment_id: ConversationJudgmentId | null;
            grade: string | null;
            lapsed: boolean | null;
          } & Ended
        >(
          await tx.execute(sql`
            SELECT i.id, i.buffer_expires_at IS NOT NULL AS held, i.body,
              j.id AS judgment_id, j.grade, j.outcome, j.decision,
              j.created_at <= now() - ${secs(reply.waitMs)} AS lapsed,
              j.judged_at <= j.created_at + ${secs(reply.waitMs)} AS in_time
            FROM conversation_inputs i
            LEFT JOIN conversation_judgments j ON j.input_id = i.id
            WHERE ${atPost(reply, "i")} AND i.slack_ts = ${reply.ts}`),
        );
        if (held !== undefined) {
          // A turn took it already, its judgment went with its text (a
          // delete), or it was held for another grade.
          if (
            !held.held ||
            held.judgment_id === null ||
            held.grade !== "m1_to_task"
          ) {
            return "session";
          }
          let ended: Ended | undefined = held;
          if (held.outcome === null) {
            if (held.lapsed !== true) return "waiting";
            // Given up at the wait: the record ends failed and stays, so
            // a verdict after it writes nothing.
            const given = rowsOf(
              await tx.execute(sql`
                UPDATE conversation_judgments SET outcome = 'failed',
                  decision = 'quiet', reason = 'timed_out', judged_at = now()
                WHERE id = ${held.judgment_id}::uuid AND outcome IS NULL
                RETURNING id`),
            );
            if (given.length > 0) return session(held.body);
            // Its judge wrote it first.
            [ended] = rowsOf<Ended>(
              await tx.execute(sql`
                SELECT outcome, decision,
                  judged_at <= created_at + ${secs(reply.waitMs)} AS in_time
                FROM conversation_judgments
                WHERE id = ${held.judgment_id}::uuid`),
            );
            if (ended === undefined) return session(held.body);
          }
          if (!kept(ended)) return session(held.body);
          await dropBufferedInputs(tx, [held.id]);
          return "quiet";
        }
        // Nothing held: kept quiet and its text let go since, or the
        // buffer's limit took it. Held once, it is not held again.
        const [before] = rowsOf<Ended & { id: ConversationJudgmentId }>(
          await tx.execute(sql`
            SELECT j.id, j.outcome, j.decision,
              j.judged_at <= j.created_at + ${secs(reply.waitMs)} AS in_time
            FROM conversation_judgments j
            WHERE ${taskJudgmentsOf(reply)}
            ORDER BY j.created_at DESC LIMIT 1`),
        );
        if (before !== undefined) {
          if (kept(before)) return "quiet";
          // The work takes it; a judge would judge it for no one.
          await tx.execute(sql`
            DELETE FROM conversation_judgments
            WHERE id = ${before.id}::uuid AND outcome IS NULL`);
          return "session";
        }
        // The gate under the agent's lock, then the post's mark before its
        // topic, the order a session's append of the post takes them in.
        if (!(await m1GateOpenForWrite(tx, reply))) return "session";
        await tx.execute(
          lockSlackSourceMark({
            workspaceId: reply.workspaceId,
            teamId: reply.teamId,
            channelId: reply.channelId,
            ts: reply.ts,
          }),
        );
        const topic = rowsOf(
          await tx.execute(sql`
            SELECT id FROM conversation_topics
            WHERE id = ${reply.topicId}::uuid
              AND workspace_id = ${reply.workspaceId}::uuid
              AND agent_id = ${reply.agentId}::uuid
            FOR UPDATE`),
        );
        if (topic.length === 0) {
          throw new Error(
            `topic ${reply.topicId} is no topic of the reply's agent`,
          );
        }
        const hold = await holdBufferedInput(
          tx,
          reply,
          {
            topicId: reply.topicId,
            channelId: reply.channelId,
            ts: reply.ts,
            buffered: { body: reply.body, slackUserId: reply.slackUserId },
            judgment: { grade: "m1_to_task", rule: reply.rule },
          },
          limit,
        );
        if (hold.outcome === "marked") return "session";
        const [still] = rowsOf(
          await tx.execute(sql`
            SELECT 1 FROM conversation_inputs i
            WHERE ${atPost(reply, "i")} AND i.slack_ts = ${reply.ts}
              AND i.buffer_expires_at IS NOT NULL`),
        );
        if (still !== undefined) return "waiting";
        // The channel's limit took it at once, newer posts filling the
        // buffer: no wait would end, so the work takes it now.
        if (hold.outcome === "held") {
          await tx.execute(sql`
            DELETE FROM conversation_judgments j
            WHERE ${taskJudgmentsOf(reply)} AND j.outcome IS NULL
              AND j.input_id IS NULL`);
        }
        return "session";
      });
    },
  };
}
