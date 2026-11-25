import {
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeVersion,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
} from "@werft-ai/contracts";
import type { SurfaceChannelNoticeTarget } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Channels whose every message the agent now reads and that have no
 * `channel_notice` row under the latest notice version that asked for
 * approval, oldest binding first, at most `limit`. What "reads" means is
 * `stillListened`'s: an active agent with its switch raised, a `ready`
 * binding that is `on`, listening `free` and not shared with another
 * organization. Besides, the bot is in the channel, the channel is not
 * archived or deleted, the app and its install are live, and every Slack
 * team of the agent's live installs has a counted approval, as
 * `judgeSlackNotice` asks. Whichever of these turned true last, the next
 * pass finds the channel, so joining, listening `free` and raising the
 * switch all lead here.
 */
export async function unnoticedSlackChannels(
  db: Database,
  options: {
    limit: number;
    versions?: readonly SlackNoticeVersionEntry[];
  },
): Promise<SurfaceChannelNoticeTarget[]> {
  const window = slackNoticeWindow(options.versions ?? SLACK_NOTICE_VERSIONS);
  if (window === null) return [];
  // The key the adapter's slackChannelNoticeDedupeKey makes, spelled in SQL.
  const key = sql`'channel-notice:' || b.agent_id || ':' || i.team_id || ':' || b.external_surface_id || ':' || ${window.oldestCounted}::int`;
  const rows = rowsOf<Omit<SurfaceChannelNoticeTarget, "noticeVersion">>(
    await db.execute(sql`
      SELECT b.workspace_id AS "workspaceId", b.agent_id AS "agentId",
        sa.id AS "slackAppId", b.installation_id AS "installationId",
        i.team_id AS "teamId", b.external_surface_id AS "channelId"
      FROM surface_bindings b
      JOIN agents a ON a.id = b.agent_id AND a.workspace_id = b.workspace_id
      JOIN agent_identities ai ON ai.installation_id = b.installation_id
        AND ai.agent_id = b.agent_id AND ai.status = 'active'
      JOIN slack_installations i ON i.id = b.installation_id
      JOIN slack_apps sa ON sa.app_id = i.app_id
      WHERE b.surface = 'slack' AND b.status = 'ready' AND b.mode = 'on'
        AND b.listen = 'free' AND NOT b.external_shared
        AND b.revoked_at IS NULL AND b.membership = 'joined'
        AND b.external_surface_id IS NOT NULL AND b.surface_kind <> 'dm'
        AND a.status = 'active' AND a.deleted_at IS NULL
        AND a.conversation_rollout IN ('shadow', 'on')
        AND i.status <> 'revoked' AND sa.state <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.agent_id = b.agent_id AND c.kind = 'channel'
            AND c.team_id = i.team_id AND c.channel_id = b.external_surface_id
            AND c.channel_state <> 'active')
        AND NOT EXISTS (
          SELECT 1 FROM agent_identities ai2
          JOIN slack_installations i2 ON i2.id = ai2.installation_id
            AND i2.workspace_id = ai2.workspace_id
          WHERE ai2.workspace_id = b.workspace_id
            AND ai2.agent_id = b.agent_id AND ai2.status = 'active'
            AND i2.status <> 'revoked'
            AND NOT EXISTS (
              SELECT 1 FROM slack_notice_approvals n
              WHERE n.workspace_id = b.workspace_id
                AND n.agent_id = b.agent_id
                AND n.slack_team_id = i2.team_id
                AND n.revoked_at IS NULL
                AND n.notice_version BETWEEN ${window.oldestCounted}::int
                  AND ${window.current}::int))
        AND NOT EXISTS (
          SELECT 1 FROM slack_outbox o WHERE o.dedupe_key = ${key})
      ORDER BY b.created_at, b.id
      LIMIT ${options.limit}`),
  );
  const noticeVersion: SlackNoticeVersion = window.oldestCounted;
  return rows.map((row) => ({ ...row, noticeVersion }));
}
