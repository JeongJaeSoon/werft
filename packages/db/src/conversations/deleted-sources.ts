import {
  type SourceKey,
  type SourcePlace,
  sourceSetOf,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { lockSlackSourceMark } from "./source-mark-lock.ts";

const placeOrder = (place: SourcePlace) =>
  `${place.teamId}|${place.channelId}|${place.ts}`;

/**
 * The first source Slack deleted, of a set as a turn or an outbox row stores
 * it, direct and inherited alike; null when none was. A key naming only a
 * web input is judged at that input's Slack alias, once it has one. A set that overflowed
 * is judged by the direct sources of its turn and its session's turns before
 * it as well.
 *
 * Each source's mark lock is taken first, in one order (as a summary write
 * takes them), and held to the end of the caller's transaction: a delete
 * under way is waited for and seen, and one that comes later finds the send
 * begun or the turn in. The one check of every place a deleted source stops
 * work: a send, and a turn's insert.
 */
export async function lockedDeletedSource(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string | null;
    sources: unknown;
    /** The set's own turn (public id); null when every turn is before it. */
    throughTurn: number | null;
  },
): Promise<SourcePlace | null> {
  const set = sourceSetOf(input.sources);
  const keys: SourceKey[] = [...set.direct, ...set.inherited];
  if (set.overflow && input.sessionId !== null) {
    const earlier = rowsOf<{ sources: unknown }>(
      await tx.execute(sql`
        SELECT sources FROM turns
        WHERE session_id = ${input.sessionId}::uuid AND sources IS NOT NULL
          AND (${input.throughTurn}::int IS NULL
            OR sequence <= ${input.throughTurn}::int)`),
    );
    for (const row of earlier) keys.push(...sourceSetOf(row.sources).direct);
  }
  const places = new Map<string, SourcePlace>();
  for (const key of keys) {
    if (key.slack !== null) places.set(placeOrder(key.slack), key.slack);
  }
  // A web input's key names no place: its Slack alias, once its mirror was
  // posted, is where it is. Held for share, so an alias being written is
  // waited for and seen; that write takes the row before the marks.
  const unplaced = [
    ...new Set(
      keys.flatMap((key) =>
        key.slack === null && key.inputId !== null ? [key.inputId] : [],
      ),
    ),
  ].sort();
  if (unplaced.length > 0) {
    const aliases = rowsOf<{
      slack_team_id: string | null;
      slack_channel_id: string | null;
      slack_ts: string | null;
    }>(
      await tx.execute(sql`
        SELECT slack_team_id, slack_channel_id, slack_ts
        FROM conversation_inputs
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND id IN (${sql.join(
            unplaced.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        ORDER BY id
        FOR SHARE`),
    );
    for (const alias of aliases) {
      if (
        alias.slack_team_id !== null &&
        alias.slack_channel_id !== null &&
        alias.slack_ts !== null
      ) {
        const place = {
          teamId: alias.slack_team_id,
          channelId: alias.slack_channel_id,
          ts: alias.slack_ts,
        };
        places.set(placeOrder(place), place);
      }
    }
  }
  if (places.size === 0) return null;
  const ordered = [...places.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, place]) => place);
  for (const place of ordered) {
    await tx.execute(
      lockSlackSourceMark({ workspaceId: input.workspaceId, ...place }),
    );
  }
  const [deleted] = rowsOf<{ team_id: string; channel_id: string; ts: string }>(
    await tx.execute(sql`
      SELECT team_id, channel_id, ts FROM deleted_sources
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND (team_id, channel_id, ts) IN (${sql.join(
          ordered.map(
            (place) =>
              sql`(${place.teamId}::text, ${place.channelId}::text, ${place.ts}::text)`,
          ),
          sql`, `,
        )})
      LIMIT 1`),
  );
  return deleted === undefined
    ? null
    : {
        teamId: deleted.team_id,
        channelId: deleted.channel_id,
        ts: deleted.ts,
      };
}
