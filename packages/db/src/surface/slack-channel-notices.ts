import {
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeVersion,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
} from "@werft-ai/contracts";
import type { SurfaceChannelNoticeTarget } from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * How many rows one (agent, channel, version) may take: a row that failed
 * never reached Slack, so the channel was not told and the next pass tries
 * again under the next key, up to this many in all.
 */
export const SLACK_CHANNEL_NOTICE_ATTEMPTS = 5;

// The binding `b` of the agent `a`, through its live identity `ai`, its
// install `i` and app `sa`.
const LISTENING_FROM = sql`surface_bindings b
  JOIN agents a ON a.id = b.agent_id AND a.workspace_id = b.workspace_id
  JOIN agent_identities ai ON ai.installation_id = b.installation_id
    AND ai.agent_id = b.agent_id AND ai.status = 'active'
  JOIN slack_installations i ON i.id = b.installation_id
  JOIN slack_apps sa ON sa.app_id = i.app_id`;

// `stillListened`'s reading of every message, with the bot in the channel,
// the channel neither archived nor deleted, and the app and install live.
const LISTENS_TO_EVERY_MESSAGE = sql`b.surface = 'slack' AND b.status = 'ready'
  AND b.mode = 'on' AND b.listen = 'free' AND NOT b.external_shared
  AND b.revoked_at IS NULL AND b.membership = 'joined'
  AND b.external_surface_id IS NOT NULL AND b.surface_kind <> 'dm'
  AND a.status = 'active' AND a.deleted_at IS NULL
  AND a.conversation_rollout IN ('shadow', 'on')
  AND i.status <> 'revoked' AND sa.state <> 'deleted'
  AND NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.agent_id = b.agent_id AND c.kind = 'channel'
      AND c.team_id = i.team_id AND c.channel_id = b.external_surface_id
      AND c.channel_state <> 'active')`;

/**
 * Whether the channel of a `channel_notice` outbox row (alias `row`) is still
 * one its agent reads every message of: a row that no longer is closes
 * unsent, and the channel is told once it is again.
 */
export function channelNoticeAddressed(row: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${LISTENING_FROM}
    WHERE b.agent_id = ${row}.agent_id
      AND b.installation_id = ${row}.installation_id
      AND b.external_surface_id = ${row}.channel_id
      AND ${LISTENS_TO_EVERY_MESSAGE})`;
}

/**
 * Channels whose every message the agent now reads that were not told so
 * under the latest notice version that asked for approval, oldest binding
 * first, at most `limit`. Every Slack team of the agent's live installs has
 * a counted approval, as `judgeSlackNotice` asks. Whichever condition
 * turned true last, the next pass finds the channel, so joining, listening
 * `free` and raising the switch all lead here. A row pending, being sent,
 * sent or of unknown outcome counts as told; one that failed does not, and
 * `attempt` numbers the next row's key.
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
  // The keys the adapter's slackChannelNoticeDedupeKey makes, spelled in SQL.
  const base = sql`'channel-notice:' || b.agent_id || ':' || i.team_id || ':' || b.external_surface_id || ':' || ${window.oldestCounted}::int`;
  const keys = sql`ARRAY(
    SELECT ${base} || CASE WHEN n = 0 THEN '' ELSE ':' || n END
    FROM generate_series(0, ${SLACK_CHANNEL_NOTICE_ATTEMPTS - 1}::int) n)`;
  const rows = rowsOf<Omit<SurfaceChannelNoticeTarget, "noticeVersion">>(
    await db.execute(sql`
      SELECT * FROM (
        SELECT b.workspace_id AS "workspaceId", b.agent_id AS "agentId",
          sa.id AS "slackAppId", b.installation_id AS "installationId",
          i.team_id AS "teamId", b.external_surface_id AS "channelId",
          b.created_at, b.id,
          (SELECT count(*)::int FROM slack_outbox o
            WHERE o.dedupe_key = ANY(${keys})) AS attempt,
          EXISTS (
            SELECT 1 FROM slack_outbox o
            WHERE o.dedupe_key = ANY(${keys}) AND o.status <> 'failed') AS told
        FROM ${LISTENING_FROM}
        WHERE ${LISTENS_TO_EVERY_MESSAGE}
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
      ) due
      WHERE NOT due.told AND due.attempt < ${SLACK_CHANNEL_NOTICE_ATTEMPTS}::int
      ORDER BY due.created_at, due.id
      LIMIT ${options.limit}`),
  );
  const noticeVersion: SlackNoticeVersion = window.oldestCounted;
  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    slackAppId: row.slackAppId,
    installationId: row.installationId,
    teamId: row.teamId,
    channelId: row.channelId,
    attempt: row.attempt,
    noticeVersion,
  }));
}
