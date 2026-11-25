import type { ConversationTurnId } from "@werft-ai/contracts";
import type {
  MentionTurnDue,
  MentionTurnStatusStore,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * The mention turns whose Slack thread was set to "processing": which are
 * still due to be set back, and the claim and mark that tell a thread
 * `active` once, again only when a pass dies holding the claim.
 */
export function createPostgresMentionTurnStatuses(
  db: Database,
): MentionTurnStatusStore {
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

    async newerDue(turnId) {
      const [row] = rowsOf<{ due: boolean }>(
        await db.execute(sql`
          SELECT EXISTS (SELECT 1 FROM conversation_turns t
            JOIN conversation_turns n ON n.topic_id = t.topic_id
            WHERE t.id = ${turnId}::uuid AND n.id <> t.id
              AND n.origin = 'm2' AND n.slack_installation_id IS NOT NULL
              AND n.slack_status_reset_at IS NULL
              AND n.created_at > t.created_at) AS due`),
      );
      return row?.due === true;
    },

    async releaseReset(turnId) {
      await db.execute(sql`
        UPDATE conversation_turns SET slack_status_claimed_at = NULL
        WHERE id = ${turnId}::uuid AND slack_status_reset_at IS NULL`);
    },
  };
}
