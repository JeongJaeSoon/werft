import { JUDGMENT_BUFFER_LIMIT_PER_CHANNEL } from "@werft-ai/contracts";
import type { BoundReplyStore, TaskReplyRoute } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  dropBufferedInputs,
  holdBufferedInput,
  JUDGMENT_BUFFER_TTL_MS,
  sessionWorkClosed,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { m1GateOpenForWrite } from "./m1-judgments.ts";

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

type Ended = { outcome: string | null; decision: string | null };

/** Only a judgment that kept quiet keeps the reply from its work (PM Q2). */
const routeOf = (ended: Ended): TaskReplyRoute =>
  ended.outcome === "judged" && ended.decision === "quiet"
    ? "quiet"
    : "session";

/**
 * A bound thread's replies once the rollout is on (v1-b/U1) over
 * PostgreSQL. A reply of work going on is held in the buffer for its
 * `m1_to_task` judgment; the turn that takes it then takes the held row.
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

    async taskReply(reply) {
      const [held] = rowsOf<{
        id: string;
        held: boolean;
        judgment_id: string | null;
        outcome: string | null;
        decision: string | null;
        lapsed: boolean | null;
      }>(
        await db.execute(sql`
          SELECT i.id, i.buffer_expires_at IS NOT NULL AS held,
            j.id AS judgment_id, j.outcome, j.decision,
            j.created_at <= now() - ${secs(reply.waitMs)} AS lapsed
          FROM conversation_inputs i
          LEFT JOIN conversation_judgments j ON j.input_id = i.id
          WHERE i.agent_id = ${reply.agentId}::uuid
            AND i.slack_team_id = ${reply.teamId}
            AND i.slack_channel_id = ${reply.channelId}
            AND i.slack_ts = ${reply.ts}`),
      );
      if (held !== undefined) {
        // A turn took it already, or its judgment went unwritten: given up,
        // voided, or dropped by a judge that could not judge it.
        if (!held.held || held.judgment_id === null) return "session";
        let ended: Ended | undefined = held;
        if (held.outcome === null) {
          if (held.lapsed !== true) return "waiting";
          const given = rowsOf(
            await db.execute(sql`
              DELETE FROM conversation_judgments
              WHERE id = ${held.judgment_id}::uuid AND outcome IS NULL
              RETURNING id`),
          );
          if (given.length > 0) return "session";
          // Its judge wrote it first.
          [ended] = rowsOf<Ended>(
            await db.execute(sql`
              SELECT outcome, decision FROM conversation_judgments
              WHERE id = ${held.judgment_id}::uuid`),
          );
          if (ended === undefined) return "session";
        }
        const route = routeOf(ended);
        if (route === "quiet") {
          await db.transaction((tx) => dropBufferedInputs(tx, [held.id]));
        }
        return route;
      }
      // Nothing held: never asked, or kept quiet and its text let go since.
      const quiet = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM conversation_judgments
          WHERE agent_id = ${reply.agentId}::uuid
            AND slack_team_id = ${reply.teamId}
            AND slack_channel_id = ${reply.channelId}
            AND grade = 'm1_to_task' AND refs = ARRAY[${reply.ts}]::text[]
            AND outcome = 'judged' AND decision = 'quiet'
            AND created_at > now() - ${secs(JUDGMENT_BUFFER_TTL_MS)}
          LIMIT 1`),
      );
      if (quiet.length > 0) return "quiet";
      const limit = await bufferLimit();
      const outcome = await db.transaction(async (tx) => {
        // As the inbox's completion holds a reply: the gate under the
        // agent's lock, then the topic, then the hold.
        if (!(await m1GateOpenForWrite(tx, reply))) return "not_held";
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
        return hold.outcome;
      });
      return outcome === "held" ? "waiting" : "session";
    },
  };
}
