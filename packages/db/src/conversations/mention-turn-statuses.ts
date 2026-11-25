import type { ConversationTurnId } from "@werft-ai/contracts";
import type {
  MentionThreadDue,
  MentionTurnDue,
  MentionTurnStatusStore,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

// A mention turn of the thread `s` whose "processing" is still due: as due()
// finds them, by the thread's own place, so it holds with no turn left.
const threadProcessing = (s: SQL) => sql`EXISTS (
  SELECT 1 FROM conversation_turns t
  JOIN conversation_topics tp ON tp.id = t.topic_id
  WHERE t.agent_id = ${s}.agent_id AND t.origin = 'm2'
    AND t.slack_installation_id IS NOT NULL
    AND t.slack_status_reset_at IS NULL
    AND tp.slack_team_id = ${s}.team_id
    AND tp.slack_channel_id = ${s}.channel_id
    AND tp.slack_thread_ts = ${s}.thread_ts
    AND EXISTS (SELECT 1 FROM conversation_engagements e
      WHERE e.conversation_turn_id = t.id AND e.kind = 'mention'))`;

const sameThread = (thread: MentionThreadDue) => sql`
  agent_id = ${thread.agentId}::uuid AND team_id = ${thread.thread.teamId}
  AND channel_id = ${thread.thread.channelId}
  AND thread_ts = ${thread.thread.threadTs}`;

// Left again: a send under way finds its rev gone by and leaves the thread
// to the next pass, which reads the turns afresh. Its claim holds, so no
// other pass sends beside it.
const LEFT_AGAIN = sql`ON CONFLICT (agent_id, team_id, channel_id, thread_ts)
  DO UPDATE SET rev = mention_thread_statuses.rev + 1`;

// A mention turn of the thread `s` that a pass may be setting back: its
// `active` can reach Slack after whatever this thread's send says.
const threadResetHeld = (s: SQL, claimMs?: number) => sql`EXISTS (
  SELECT 1 FROM conversation_turns t
  JOIN conversation_topics tp ON tp.id = t.topic_id
  WHERE t.agent_id = ${s}.agent_id AND t.origin = 'm2'
    AND t.slack_installation_id IS NOT NULL
    AND t.slack_status_reset_at IS NULL
    AND t.slack_status_claimed_at IS NOT NULL
    ${
      claimMs === undefined
        ? sql``
        : sql`AND t.slack_status_claimed_at >= now() - ${claimMs} * interval '1 millisecond'`
    }
    AND tp.slack_team_id = ${s}.team_id
    AND tp.slack_channel_id = ${s}.channel_id
    AND tp.slack_thread_ts = ${s}.thread_ts)`;

/**
 * Leaves each thread of the conversation's mention turns still due to be
 * set again, before a delete of its records takes them away: with no turn
 * left, it is set back to `active`.
 */
export function leaveMentionThreadResets(conversationId: string): SQL {
  return sql`
    INSERT INTO mention_thread_statuses
      (workspace_id, agent_id, slack_installation_id, team_id, channel_id, thread_ts)
    SELECT DISTINCT ON (t.agent_id, tp.slack_team_id, tp.slack_channel_id, tp.slack_thread_ts)
      t.workspace_id, t.agent_id, t.slack_installation_id,
      tp.slack_team_id, tp.slack_channel_id, tp.slack_thread_ts
    FROM conversation_turns t
    JOIN conversation_topics tp ON tp.id = t.topic_id
    WHERE t.conversation_id = ${conversationId}::uuid AND t.origin = 'm2'
      AND t.slack_installation_id IS NOT NULL
      AND t.slack_status_reset_at IS NULL
      AND tp.slack_team_id IS NOT NULL AND tp.slack_channel_id IS NOT NULL
      AND tp.slack_thread_ts IS NOT NULL
      AND EXISTS (SELECT 1 FROM conversation_engagements e
        WHERE e.conversation_turn_id = t.id AND e.kind = 'mention')
    ORDER BY t.agent_id, tp.slack_team_id, tp.slack_channel_id,
      tp.slack_thread_ts, t.created_at DESC
    ${LEFT_AGAIN}`;
}

/**
 * The mention turns whose Slack thread was set to "processing": which are
 * still due to be set back, and the claim and mark that tell a thread
 * `active` once, again only when a pass dies holding the claim.
 */
export function createPostgresMentionTurnStatuses(
  db: Database,
): MentionTurnStatusStore {
  const releaseThread = async (thread: MentionThreadDue) => {
    await db.execute(sql`
      UPDATE mention_thread_statuses SET claimed_at = NULL
      WHERE ${sameThread(thread)}`);
  };
  return {
    async due(limit, claimMs) {
      const rows = rowsOf<{
        id: ConversationTurnId;
        workspace_id: string;
        agent_id: string;
        created_at: Date | string;
        team_id: string;
        channel_id: string;
        thread_ts: string;
        slack_app_id: string | null;
      }>(
        await db.execute(sql`
          SELECT t.id, t.workspace_id, t.agent_id, t.created_at,
            tp.slack_team_id AS team_id, tp.slack_channel_id AS channel_id,
            tp.slack_thread_ts AS thread_ts,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = t.slack_installation_id
                AND sa.agent_id = t.agent_id) AS slack_app_id
          FROM conversation_turns t
          JOIN conversation_topics tp ON tp.id = t.topic_id
          WHERE t.slack_status_reset_at IS NULL
            AND t.slack_installation_id IS NOT NULL
            AND t.origin = 'm2'
            AND (t.slack_status_claimed_at IS NULL
              OR t.slack_status_claimed_at
                < now() - ${claimMs} * interval '1 millisecond')
            AND tp.slack_thread_ts IS NOT NULL
            AND EXISTS (SELECT 1 FROM conversation_engagements e
              WHERE e.conversation_turn_id = t.id AND e.kind = 'mention')
          ORDER BY t.created_at
          LIMIT ${limit}`),
      );
      return rows.map(
        (row): MentionTurnDue => ({
          turnId: row.id,
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          createdAt: new Date(row.created_at),
          thread: {
            teamId: row.team_id,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
          },
          slackAppId: row.slack_app_id,
        }),
      );
    },

    async claimReset(turnId, claimMs) {
      // A newer turn of the thread still due holds its "processing": this
      // one is marked set back without being sent.
      const [claimed] = rowsOf<{ superseded: boolean }>(
        await db.execute(sql`
          UPDATE conversation_turns t SET slack_status_claimed_at = now(),
            slack_status_reset_at = CASE WHEN EXISTS (
              SELECT 1 FROM conversation_turns n
              WHERE n.topic_id = t.topic_id AND n.id <> t.id
                AND n.origin = 'm2' AND n.slack_installation_id IS NOT NULL
                AND n.slack_status_reset_at IS NULL
                AND n.created_at > t.created_at) THEN now() END
          WHERE t.id = ${turnId}::uuid AND t.slack_status_reset_at IS NULL
            AND (t.slack_status_claimed_at IS NULL
              OR t.slack_status_claimed_at
                < now() - ${claimMs} * interval '1 millisecond')
          RETURNING t.slack_status_reset_at IS NOT NULL AS superseded`),
      );
      if (claimed === undefined) return "done";
      return claimed.superseded ? "superseded" : "send";
    },

    async confirmReset(turnId) {
      await db.execute(sql`
        UPDATE conversation_turns SET slack_status_reset_at = now()
        WHERE id = ${turnId}::uuid AND slack_status_reset_at IS NULL`);
    },

    async reprocess(turnId) {
      const left = rowsOf<{ rev: number }>(
        await db.execute(sql`
          INSERT INTO mention_thread_statuses
            (workspace_id, agent_id, slack_installation_id, team_id, channel_id, thread_ts)
          SELECT t.workspace_id, t.agent_id, t.slack_installation_id,
            tp.slack_team_id, tp.slack_channel_id, tp.slack_thread_ts
          FROM conversation_turns t
          JOIN conversation_topics tp ON tp.id = t.topic_id
          WHERE t.id = ${turnId}::uuid AND t.slack_installation_id IS NOT NULL
            AND tp.slack_team_id IS NOT NULL AND tp.slack_channel_id IS NOT NULL
            AND tp.slack_thread_ts IS NOT NULL
            AND EXISTS (SELECT 1 FROM conversation_turns n
              WHERE n.topic_id = t.topic_id AND n.id <> t.id
                AND n.origin = 'm2' AND n.slack_installation_id IS NOT NULL
                AND n.slack_status_reset_at IS NULL
                AND n.created_at > t.created_at)
          ${LEFT_AGAIN}
          RETURNING rev`),
      );
      return left.length > 0;
    },

    async claimThreads(limit, claimMs) {
      const rows = rowsOf<{
        workspace_id: string;
        agent_id: string;
        team_id: string;
        channel_id: string;
        thread_ts: string;
        rev: number;
        slack_app_id: string | null;
        processing: boolean;
      }>(
        await db.execute(sql`
          UPDATE mention_thread_statuses s SET claimed_at = now()
          FROM (SELECT agent_id, team_id, channel_id, thread_ts
            FROM mention_thread_statuses q
            WHERE (q.claimed_at IS NULL
              OR q.claimed_at < now() - ${claimMs} * interval '1 millisecond')
              AND NOT ${threadResetHeld(sql`q`, claimMs)}
            ORDER BY created_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED) d
          WHERE (s.agent_id, s.team_id, s.channel_id, s.thread_ts)
            = (d.agent_id, d.team_id, d.channel_id, d.thread_ts)
          RETURNING s.workspace_id, s.agent_id, s.team_id, s.channel_id,
            s.thread_ts, s.rev,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = s.slack_installation_id
                AND sa.agent_id = s.agent_id) AS slack_app_id,
            ${threadProcessing(sql`s`)} AS processing`),
      );
      return rows.map(
        (row): MentionThreadDue => ({
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          thread: {
            teamId: row.team_id,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
          },
          slackAppId: row.slack_app_id,
          status: row.processing ? "processing" : "active",
          rev: Number(row.rev),
        }),
      );
    },

    async threadSent(thread, sent) {
      // What the turns say now: a turn that ended, or one written, since
      // the claim read them leaves the thread for the next pass; so does
      // one a pass is setting back, whose `active` may land after this.
      const done = rowsOf(
        await db.execute(sql`
          DELETE FROM mention_thread_statuses s
          WHERE ${sameThread(thread)} AND rev = ${thread.rev}
            AND NOT ${threadResetHeld(sql`s`)}
            ${
              sent === null
                ? sql``
                : sql`AND ${threadProcessing(sql`s`)} = ${sent === "processing"}`
            }
          RETURNING rev`),
      );
      if (done.length > 0) return true;
      await releaseThread(thread);
      return false;
    },

    releaseThread,

    async releaseReset(turnId) {
      await db.execute(sql`
        UPDATE conversation_turns SET slack_status_claimed_at = NULL
        WHERE id = ${turnId}::uuid AND slack_status_reset_at IS NULL`);
    },
  };
}
