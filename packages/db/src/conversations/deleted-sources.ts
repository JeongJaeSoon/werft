import {
  type SourceKey,
  type SourcePlace,
  sourceSetOf,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import {
  lockSlackChannelMarks,
  lockSlackSourceMark,
} from "./source-mark-lock.ts";
import { sourcesHoldPlace } from "./turn-sources.ts";

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

/** One message a model call read, as check spot ② sees it. */
export type ReadMessage = {
  ts: string;
  /** Its edit mark as the call read it (marked_at); null for none. */
  editMark: string | null;
  /**
   * A buffered message: its row (null once it went) and the text the call
   * read. None for one whose text is kept nowhere (a reply that became a
   * turn): any edit mark changed what the call read.
   */
  buffered: { inputId: string | null; body: string } | null;
};

/** What became of the messages a call read while it ran. */
export type ReadChanges = {
  /** The ts of the messages read that Slack (or an admin) deleted. */
  deleted: string[];
  /** Whether a context message the call read was deleted. */
  contextDeleted: boolean;
  /** The ts edited since, with the buffer's new text; null when kept nowhere. */
  edited: { ts: string; body: string | null }[];
  /** Buffered messages read whose row went without a delete. */
  gone: string[];
  /** Each message's edit mark now, for one read again. */
  editMarks: Record<string, string | null>;
  /** Whether a context message the call read was edited since it read. */
  contextEdited: boolean;
};

/**
 * Check spot ② (a1/J6): what became of the messages of one channel a model
 * call read, right before its result is written. Each message's mark lock is
 * taken first, in lockedDeletedSource's order, and held to the end of the
 * caller's transaction: a delete or an edit under way is waited for and
 * seen, and one that comes later finds the result written. A buffered
 * message was edited when its row's text is no longer the text read, or
 * its edit mark is not the one read (an edit Slack gave with no text); a
 * message whose text is kept nowhere (never buffered, or its row went
 * without a delete) when it has an edit mark at all. Every write of a result a call made from Slack messages (a
 * judgment record, a summary line) asks this.
 */
export async function lockedReadChanges(
  tx: Database,
  input: {
    workspaceId: string;
    teamId: string;
    channelId: string;
    messages: readonly ReadMessage[];
    /**
     * The other sources the call read (earlier context): a delete of one
     * voids the result as well. A key naming only a web input is judged at
     * its Slack alias.
     */
    context?: readonly SourceKey[];
    /**
     * When the call read its input. A context message edited since voids
     * the result (its text as read is not kept, so its mark's time tells);
     * with `overflow` (the context's sources were cut, so those past the
     * cut are not named), so does any delete or edit in the channel since.
     */
    readAt: SQL;
    overflow?: boolean;
  },
): Promise<ReadChanges> {
  const changes: ReadChanges = {
    deleted: [],
    contextDeleted: false,
    edited: [],
    gone: [],
    editMarks: {},
    contextEdited: false,
  };
  const read = input.messages.map((message) => ({
    teamId: input.teamId,
    channelId: input.channelId,
    ts: message.ts,
  }));
  const context = input.context ?? [];
  const places = new Map<string, SourcePlace>();
  for (const place of read) places.set(placeOrder(place), place);
  for (const key of context) {
    if (key.slack !== null) places.set(placeOrder(key.slack), key.slack);
  }
  if (input.overflow === true) {
    await tx.execute(lockSlackChannelMarks(input, "exclusive"));
  }
  // As lockedDeletedSource: an alias row first, held for share, then marks.
  const unplaced = [
    ...new Set(
      context.flatMap((key) =>
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
      if (alias.slack_team_id && alias.slack_channel_id && alias.slack_ts) {
        const place = {
          teamId: alias.slack_team_id,
          channelId: alias.slack_channel_id,
          ts: alias.slack_ts,
        };
        places.set(placeOrder(place), place);
      }
    }
  }
  const ordered = [...places.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, place]) => place);
  if (ordered.length === 0) return changes;
  for (const place of ordered) {
    await tx.execute(
      lockSlackSourceMark({ workspaceId: input.workspaceId, ...place }),
    );
  }
  const tuples = (of: readonly SourcePlace[]) =>
    sql.join(
      of.map(
        (place) =>
          sql`(${place.teamId}::text, ${place.channelId}::text, ${place.ts}::text)`,
      ),
      sql`, `,
    );
  const deleted = new Set(
    rowsOf<{ team_id: string; channel_id: string; ts: string }>(
      await tx.execute(sql`
        SELECT team_id, channel_id, ts FROM deleted_sources
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND (team_id, channel_id, ts) IN (${tuples(ordered)})`),
    ).map((row) =>
      placeOrder({
        teamId: row.team_id,
        channelId: row.channel_id,
        ts: row.ts,
      }),
    ),
  );
  const readOrder = new Set(read.map(placeOrder));
  changes.contextDeleted = [...deleted].some((place) => !readOrder.has(place));
  if (!changes.contextDeleted && input.overflow === true) {
    // Sources past the cut are not named: a delete in the channel since.
    const [since] = rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM deleted_sources
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND team_id = ${input.teamId} AND channel_id = ${input.channelId}
          AND marked_at >= ${input.readAt}
        LIMIT 1`),
    );
    changes.contextDeleted = since !== undefined;
  }
  if (input.overflow === true && input.messages.length > 0) {
    // An edit there since, as with deletes.
    const [since] = rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM edited_sources
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND team_id = ${input.teamId} AND channel_id = ${input.channelId}
          AND marked_at >= ${input.readAt}
          AND ts NOT IN (${sql.join(
            input.messages.map((message) => sql`${message.ts}`),
            sql`, `,
          )})
        LIMIT 1`),
    );
    if (since !== undefined) changes.contextEdited = true;
  }
  const contextPlaces = ordered.filter(
    (place) =>
      !readOrder.has(placeOrder(place)) && !deleted.has(placeOrder(place)),
  );
  if (contextPlaces.length > 0) {
    const [edited] = rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM edited_sources
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND (team_id, channel_id, ts) IN (${tuples(contextPlaces)})
          AND marked_at >= ${input.readAt}
        LIMIT 1`),
    );
    changes.contextEdited = edited !== undefined;
  }
  const isDeleted = (ts: string) =>
    deleted.has(
      placeOrder({ teamId: input.teamId, channelId: input.channelId, ts }),
    );
  const live = input.messages.filter((message) => !isDeleted(message.ts));
  const rowIds = live.flatMap((message) =>
    message.buffered?.inputId ? [message.buffered.inputId] : [],
  );
  const bodies = new Map(
    rowIds.length === 0
      ? []
      : rowsOf<{ id: string; body: string | null }>(
          await tx.execute(sql`
            SELECT id, body FROM conversation_inputs
            WHERE id IN (${sql.join(
              rowIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}) AND buffer_expires_at IS NOT NULL`),
        ).map((row) => [row.id, row.body] as const),
  );
  const marks =
    live.length === 0
      ? []
      : rowsOf<{ ts: string; mark: string }>(
          await tx.execute(sql`
            SELECT ts, marked_at::text AS mark
            FROM edited_sources
            WHERE workspace_id = ${input.workspaceId}::uuid
              AND (team_id, channel_id, ts) IN (${tuples(
                live.map((message) => ({
                  teamId: input.teamId,
                  channelId: input.channelId,
                  ts: message.ts,
                })),
              )})`),
        );
  const marked = new Map(marks.map((row) => [row.ts, row.mark]));
  for (const message of input.messages) {
    if (isDeleted(message.ts)) {
      changes.deleted.push(message.ts);
      continue;
    }
    const now =
      message.buffered?.inputId == null
        ? undefined
        : bodies.get(message.buffered.inputId);
    if (message.buffered !== null && typeof now !== "string") {
      changes.gone.push(message.ts);
    }
    const mark = marked.get(message.ts) ?? null;
    changes.editMarks[message.ts] = mark;
    if (typeof now === "string" && now !== message.buffered?.body) {
      // The buffer holds the edit's text.
      changes.edited.push({ ts: message.ts, body: now });
    } else if (
      message.buffered === null ? mark !== null : mark !== message.editMark
    ) {
      // Marked since the read with no new text held (an edit Slack gave
      // without one), or kept nowhere: what was read is out of date.
      changes.edited.push({ ts: message.ts, body: null });
    }
  }
  return changes;
}

/**
 * Whether a turn of the session has the deleted message among its sources,
 * directly or inherited: lockedDeletedSource read the other way, from a
 * deleted place to the sessions it stops. A key naming only a web input
 * holds the place its input took as its Slack alias. `session` names the
 * sessions row's id column.
 */
export function sessionHoldsSource(session: SQL, place: SourcePlace): SQL {
  const holdsInput = (part: "direct" | "inherited") =>
    sql`st.sources @> jsonb_build_object('${sql.raw(part)}', jsonb_build_array(jsonb_build_object('input_id', ci.id::text)))`;
  return sql`EXISTS (
    SELECT 1 FROM turns st
    WHERE st.session_id = ${session} AND st.sources IS NOT NULL
      AND (${sourcesHoldPlace(sql.raw("st.sources"), place)}
        OR EXISTS (
          SELECT 1 FROM conversation_inputs ci
          WHERE ci.workspace_id = (
              SELECT ss.workspace_id FROM sessions ss WHERE ss.id = ${session})
            AND ci.slack_team_id = ${place.teamId}
            AND ci.slack_channel_id = ${place.channelId}
            AND ci.slack_ts = ${place.ts}
            AND (${holdsInput("direct")} OR ${holdsInput("inherited")}))))`;
}

/**
 * When Slack deleted a direct source of a turn: the earliest deleted_at of
 * the messages its `sources` column lists as direct, by their place or, for
 * a key naming only a web input, by the place its input took as its Slack
 * alias (as sessionHoldsSource reads it); null when none was. The read side
 * of lockedDeletedSource, for what a reader withholds: no lock, since a read
 * that misses a delete under way withholds on the next one, and no
 * inherited source, which stops a session and a send but hides nothing (a
 * later turn only inherited it).
 */
export function directSourceDeletedAt(sources: SQL, workspaceId: SQL): SQL {
  const keys = sql`jsonb_array_elements(
      CASE WHEN jsonb_typeof(${sources} -> 'direct') = 'array'
        THEN ${sources} -> 'direct' ELSE '[]'::jsonb END) AS k(key)`;
  return sql`(SELECT min(deleted_at) FROM (
    SELECT d.deleted_at FROM ${keys}
    JOIN deleted_sources d ON d.workspace_id = ${workspaceId}
      AND d.team_id = k.key ->> 'team_id'
      AND d.channel_id = k.key ->> 'channel_id'
      AND d.ts = k.key ->> 'ts'
    UNION ALL
    SELECT d.deleted_at FROM ${keys}
    JOIN conversation_inputs ci ON ci.workspace_id = ${workspaceId}
      AND ci.id = CASE WHEN k.key ->> 'input_id'
        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (k.key ->> 'input_id')::uuid END
    JOIN deleted_sources d ON d.workspace_id = ci.workspace_id
      AND d.team_id = ci.slack_team_id
      AND d.channel_id = ci.slack_channel_id
      AND d.ts = ci.slack_ts) AS deleted)`;
}

/**
 * When Slack deleted a direct source of the session's first turn, whose
 * instruction a derived or generated title was cut or made from; null when
 * none was. `session` names a sessions row as the query calls it.
 */
export function firstTurnDeletedAt(session: string): SQL {
  const s = sql.raw(session);
  return sql`(SELECT ${directSourceDeletedAt(sql.raw("tt.sources"), sql`${s}.workspace_id`)}
    FROM turns tt WHERE tt.session_id = ${s}.id AND tt.sequence = 1
      AND tt.sources IS NOT NULL)`;
}

/**
 * firstTurnDeletedAt for a derived or generated title; null for a title a
 * person gave.
 */
export function titleDeletedAt(session: string): SQL {
  const s = sql.raw(session);
  return sql`(CASE WHEN ${s}.title_source IN ('derived', 'generated')
    THEN ${firstTurnDeletedAt(session)} END)`;
}

/** The session's title as a reader is served it: none once withheld. */
export function servedTitle(session: string): SQL {
  return sql`(CASE WHEN ${titleDeletedAt(session)} IS NULL THEN ${sql.raw(session)}.title END)`;
}
