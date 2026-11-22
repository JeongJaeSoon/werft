import type { SlackSourceMark, SlackSourceMarkStore } from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * How long a mark of a message nothing points at is kept: the judgment
 * buffer's lifetime (10 minutes) and an hour's grace, in which the message
 * itself may still arrive after its delete or edit.
 */
export const SLACK_SOURCE_MARK_UNKNOWN_RETENTION_MS = (10 + 60) * 60_000;

/** The columns of one mark row, for a judgment over it. */
export type SlackSourceMarkColumns = {
  workspaceId: SQL;
  teamId: SQL;
  channelId: SQL;
  ts: SQL;
};

/**
 * Whether Werft keeps something that points at the marked message, so its
 * mark stays. Nothing does yet: the input, engagement, source-set and
 * summary records each add their own test here as they come.
 */
export function knownSlackSource(_mark: SlackSourceMarkColumns): SQL {
  return sql`false`;
}

export function createPostgresSlackSourceMarkStore(
  db: Database,
): SlackSourceMarkStore {
  const key = (mark: SlackSourceMark) =>
    sql`${mark.workspaceId}::uuid, ${mark.teamId}, ${mark.channelId}, ${mark.ts}`;
  return {
    markDeleted(mark) {
      return db.transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at)
          VALUES (${key(mark)}, ${mark.at.toISOString()}::timestamptz)
          ON CONFLICT DO NOTHING
          RETURNING ts`);
        await tx.execute(sql`
          DELETE FROM edited_sources
          WHERE (workspace_id, team_id, channel_id, ts) = (${key(mark)})`);
        return rowsOf(inserted).length > 0 ? "recorded" : "duplicate";
      });
    },
    async markEdited(mark) {
      const written = await db.execute(sql`
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
      return rowsOf(written).length > 0 ? "recorded" : "deleted";
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
