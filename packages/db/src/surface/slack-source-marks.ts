import { type SQL, sql } from "drizzle-orm";
import {
  dropBufferedMessage,
  dropChannelSummaryLinesOf,
  editBufferedMessage,
  JUDGMENT_BUFFER_TTL_MS,
  lockSlackChannelDeletes,
  lockSlackSourceMark,
  sourceSetHoldsMark,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { stopSessionsOnDeletedSource } from "../sessions/index.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * How long a mark of a message nothing points at is kept: the judgment
 * buffer's lifetime and an hour's grace, in which the message itself may
 * still arrive after its delete or edit.
 */
export const SLACK_SOURCE_MARK_UNKNOWN_RETENTION_MS =
  JUDGMENT_BUFFER_TTL_MS + 60 * 60_000;

/** A Slack message in one workspace and the time Slack gives its change. */
export type SlackSourceMark = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  ts: string;
  at: Date;
};

/** The columns of one mark row, for a judgment over it. */
export type SlackSourceMarkColumns = {
  workspaceId: SQL;
  teamId: SQL;
  channelId: SQL;
  ts: SQL;
};

/**
 * Whether Werft keeps something that points at the marked message, so its
 * mark stays: an input or engagement row of any agent in the workspace, or a
 * turn, Slack outbox row or channel summary line with it among its sources.
 */
export function knownSlackSource(mark: SlackSourceMarkColumns): SQL {
  return sql`(EXISTS (
    SELECT 1 FROM conversation_inputs i
    WHERE i.workspace_id = ${mark.workspaceId}
      AND i.slack_team_id = ${mark.teamId}
      AND i.slack_channel_id = ${mark.channelId}
      AND i.slack_ts = ${mark.ts})
    OR EXISTS (
    SELECT 1 FROM conversation_engagements e
    WHERE e.workspace_id = ${mark.workspaceId}
      AND e.team_id = ${mark.teamId}
      AND e.channel_id = ${mark.channelId}
      AND e.ts = ${mark.ts})
    OR ${sourceSetHoldsMark(mark)}
    OR EXISTS (
    SELECT 1 FROM channel_summary_line_sources s
    WHERE s.workspace_id = ${mark.workspaceId}
      AND s.team_id = ${mark.teamId}
      AND s.channel_id = ${mark.channelId}
      AND s.ts = ${mark.ts}))`;
}

export { lockSlackSourceMark };

export function createPostgresSlackSourceMarkStore(db: Database): {
  markDeleted(mark: SlackSourceMark): Promise<"recorded" | "duplicate">;
  markEdited(
    mark: SlackSourceMark,
    body?: string,
  ): Promise<"recorded" | "deleted">;
} {
  const key = (mark: SlackSourceMark) =>
    sql`${mark.workspaceId}::uuid, ${mark.teamId}, ${mark.channelId}, ${mark.ts}`;
  return {
    async markDeleted(mark) {
      const recorded = await db.transaction(async (tx) => {
        await tx.execute(lockSlackChannelDeletes(mark, "shared"));
        await tx.execute(lockSlackSourceMark(mark));
        const inserted = await tx.execute(sql`
          INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at)
          VALUES (${key(mark)}, ${mark.at.toISOString()}::timestamptz)
          ON CONFLICT (workspace_id, team_id, channel_id, ts) DO UPDATE
            SET reason = 'slack_deleted', deleted_at = EXCLUDED.deleted_at
            WHERE deleted_sources.reason = 'admin_deleted'
          RETURNING ts`);
        await tx.execute(sql`
          DELETE FROM edited_sources
          WHERE (workspace_id, team_id, channel_id, ts) = (${key(mark)})`);
        await dropChannelSummaryLinesOf(tx, mark);
        // Ahead of its lifetime: a deleted message leaves no buffered row.
        await dropBufferedMessage(tx, mark);
        return rowsOf(inserted).length > 0 ? "recorded" : "duplicate";
      });
      // After the mark commits, each session in its own transaction under
      // the control lock order (launch, then session), never inside the
      // mark lock. A redelivered delete reaches here as a duplicate and
      // stops whatever a failure left running.
      await stopSessionsOnDeletedSource(db, mark);
      return recorded;
    },
    markEdited(mark, body) {
      return db.transaction(async (tx) => {
        await tx.execute(lockSlackSourceMark(mark));
        const written = await tx.execute(sql`
        INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at)
        SELECT ${key(mark)}, ${mark.at.toISOString()}::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM deleted_sources
          WHERE (workspace_id, team_id, channel_id, ts) = (${key(mark)})
        )
        ON CONFLICT (workspace_id, team_id, channel_id, ts) DO UPDATE
          SET edited_at = GREATEST(edited_sources.edited_at, EXCLUDED.edited_at),
              marked_at = now()
        RETURNING ts`);
        // An edited source leaves the summary as a deleted one does.
        await dropChannelSummaryLinesOf(tx, mark);
        // A buffered message is judged by its latest text, kept only there;
        // an edit Slack gave with no text leaves none to judge (a1/J6), as a
        // marked message is never held.
        if (rowsOf(written).length > 0) {
          if (body !== undefined) {
            await editBufferedMessage(tx, { ...mark, body });
          } else {
            await dropBufferedMessage(tx, mark);
          }
        }
        return rowsOf(written).length > 0 ? "recorded" : "deleted";
      });
    },
  };
}

/**
 * Removes delete and edit marks made more than `retentionMs` ago whose
 * message nothing points at (`known`, knownSlackSource by default), up to
 * `limit` of each. Returns how many of each it removed; a dry run counts
 * them. The reconciler runs it every pass.
 */
export async function purgeUnknownSlackSourceMarks(
  db: Database,
  options: {
    limit: number;
    dryRun: boolean;
    retentionMs?: number;
    known?: (mark: SlackSourceMarkColumns) => SQL;
  },
): Promise<{ deleted: number; edited: number }> {
  const retentionMs =
    options.retentionMs ?? SLACK_SOURCE_MARK_UNKNOWN_RETENTION_MS;
  const known = options.known ?? knownSlackSource;
  const purge = async (table: "deleted_sources" | "edited_sources") => {
    const name = sql.raw(table);
    const expired = sql`
      SELECT m.workspace_id, m.team_id, m.channel_id, m.ts FROM ${name} m
      WHERE m.marked_at < now() - make_interval(secs => ${retentionMs / 1000})
        AND NOT (${known({
          workspaceId: sql.raw("m.workspace_id"),
          teamId: sql.raw("m.team_id"),
          channelId: sql.raw("m.channel_id"),
          ts: sql.raw("m.ts"),
        })})
      ORDER BY m.marked_at
      LIMIT ${options.limit}`;
    const result = await db.execute(
      options.dryRun
        ? expired
        : sql`
      DELETE FROM ${name}
      WHERE (workspace_id, team_id, channel_id, ts) IN (${expired} FOR UPDATE OF m SKIP LOCKED)
      RETURNING ts`,
    );
    return rowsOf(result).length;
  };
  return {
    deleted: await purge("deleted_sources"),
    edited: await purge("edited_sources"),
  };
}
