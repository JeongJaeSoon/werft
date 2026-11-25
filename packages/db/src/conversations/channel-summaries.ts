import { randomUUID } from "node:crypto";
import {
  CHANNEL_SUMMARY_LINE_TEXT_MAX,
  type ChannelSummaryLineId,
  type ConversationInputId,
} from "@werft-ai/contracts";
import {
  CHANNEL_SUMMARY_HISTORY_MS,
  type ChannelSummary,
  type ChannelSummaryPlace,
  type ChannelSummarySource,
  type ChannelSummarySourceKey,
  type ChannelSummaryStore,
  type ChannelSummaryWriteResult,
  type NewChannelSummaryLine,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { lockSlackSourceMark } from "./source-mark-lock.ts";

const placeKey = (place: ChannelSummaryPlace) =>
  sql`(${place.workspaceId}::uuid, ${place.teamId}::text, ${place.channelId}::text)`;

const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const validText = (text: string) =>
  text.trim().length > 0 && text.length <= CHANNEL_SUMMARY_LINE_TEXT_MAX;

/** Lines of the summary in the version, by their alias `l`. */
const liveAt = (version: number, alias = "l") => {
  const a = sql.raw(alias);
  return sql`${a}.from_version <= ${version} AND (${a}.to_version IS NULL OR ${a}.to_version > ${version})`;
};

/** A Slack ts as the time it names. */
const tsTime = (ts: string) => new Date(Math.floor(Number(ts) * 1000));

/**
 * Locks the channel's summary row and returns its version, first making it
 * at version 0 when `create` and there is none. Null when there is none.
 */
async function lockSummary(
  tx: Database,
  place: ChannelSummaryPlace,
  create: boolean,
): Promise<number | null> {
  if (create) {
    await tx.execute(sql`
      WITH made AS (
        INSERT INTO channel_summaries (workspace_id, team_id, channel_id)
        VALUES (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId})
        ON CONFLICT DO NOTHING
        RETURNING workspace_id, team_id, channel_id)
      INSERT INTO channel_summary_versions (workspace_id, team_id, channel_id, version)
      SELECT workspace_id, team_id, channel_id, 0 FROM made`);
  }
  const [row] = rowsOf<{ version: string }>(
    await tx.execute(sql`
      SELECT version::text FROM channel_summaries
      WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
      FOR UPDATE`),
  );
  return row === undefined ? null : Number(row.version);
}

async function setVersion(
  tx: Database,
  place: ChannelSummaryPlace,
  version: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE channel_summaries SET version = ${version}, updated_at = now()
    WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}`);
  await tx.execute(sql`
    INSERT INTO channel_summary_versions (workspace_id, team_id, channel_id, version)
    VALUES (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId}, ${version})
    ON CONFLICT DO NOTHING`);
}

/** A new line row; `writtenAt` is kept by a revert's copy. */
async function insertLine(
  tx: Database,
  place: ChannelSummaryPlace,
  line: { text: string; agentId: string; version: number; copyOf?: string },
): Promise<ChannelSummaryLineId> {
  const id = randomUUID() as ChannelSummaryLineId;
  const original = line.copyOf;
  await tx.execute(sql`
    INSERT INTO channel_summary_lines (
      id, origin_id, workspace_id, team_id, channel_id, text,
      written_by_agent_id, written_at, ordinal, from_version
    ) VALUES (
      ${id}::uuid,
      ${original === undefined ? sql`${id}::uuid` : sql`(SELECT origin_id FROM channel_summary_lines WHERE id = ${original}::uuid)`},
      ${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId},
      ${line.text}, ${line.agentId}::uuid,
      ${original === undefined ? sql`now()` : sql`(SELECT written_at FROM channel_summary_lines WHERE id = ${original}::uuid)`},
      ${original === undefined ? sql`DEFAULT` : sql`(SELECT ordinal FROM channel_summary_lines WHERE id = ${original}::uuid)`},
      ${line.version}
    )`);
  return id;
}

/** Gives `lineId` every source of the lines `from`, each input once. */
async function copySources(
  tx: Database,
  lineId: ChannelSummaryLineId,
  from: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO channel_summary_line_sources (
      line_id, input_id, workspace_id, team_id, channel_id, ts,
      speaker_kind, speaker_id, edited_at
    )
    SELECT DISTINCT ON (input_id) ${lineId}::uuid, input_id, workspace_id,
      team_id, channel_id, ts, speaker_kind, speaker_id, edited_at
    FROM channel_summary_line_sources
    WHERE line_id IN (${uuids(from)})
    -- Of two reads of one message, the older text's: an edit removes it.
    ORDER BY input_id, edited_at ASC NULLS FIRST`);
}

/**
 * Removes, from every version, each summary line with the message among its
 * sources, and moves the summary one version on if any went. The delete and
 * edit marks call it in their transaction, which holds the message's mark
 * lock: a write naming the message waits for it, then sees the mark. The
 * summary row is locked before the delete, whose statement then sees a
 * line a fold or revert committed while it waited. An edit mark (`editedAt`)
 * removes only the lines made from text older than the edit: one made from
 * the edited text stays.
 */
export async function dropChannelSummaryLinesOf(
  tx: Database,
  mark: { workspaceId: string; teamId: string; channelId: string; ts: string },
  editedAt?: Date,
): Promise<number> {
  const place = {
    workspaceId: mark.workspaceId,
    teamId: mark.teamId,
    channelId: mark.channelId,
  };
  const version = await lockSummary(tx, place, false);
  if (version === null) return 0;
  const gone = rowsOf(
    await tx.execute(sql`
      DELETE FROM channel_summary_lines l
      WHERE (l.workspace_id, l.team_id, l.channel_id) = ${placeKey(place)}
        AND EXISTS (
          SELECT 1 FROM channel_summary_line_sources s
          WHERE s.line_id = l.id AND s.ts = ${mark.ts}
            ${
              editedAt === undefined
                ? sql``
                : sql`AND COALESCE(s.edited_at, to_timestamp(s.ts::numeric)) < ${editedAt.toISOString()}::timestamptz`
            })
      RETURNING l.id`),
  ).length;
  if (gone > 0) await setVersion(tx, place, version + 1);
  return gone;
}

/**
 * Deletes the channel's summary: every version's lines, their sources and
 * the summary row, under the summary's lock. The channel's context row
 * stays, as its conversations point at it. Returns how many line rows went and the Slack ts
 * of every source they had, so a caller that marked those messages first
 * can tell a line written since it looked.
 */
export async function deleteChannelSummary(
  tx: Database,
  place: ChannelSummaryPlace,
): Promise<{ lines: number; sourceTs: string[] }> {
  if ((await lockSummary(tx, place, false)) === null) {
    return { lines: 0, sourceTs: [] };
  }
  const sourceTs = rowsOf<{ ts: string }>(
    await tx.execute(sql`
      SELECT DISTINCT ts FROM channel_summary_line_sources
      WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
      ORDER BY ts`),
  ).map((row) => row.ts);
  const lines = rowsOf(
    await tx.execute(sql`
      DELETE FROM channel_summary_lines
      WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
      RETURNING id`),
  ).length;
  await tx.execute(sql`
    DELETE FROM channel_summaries
    WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}`);
  return { lines, sourceTs };
}

type ResolvedSource = {
  inputId: ConversationInputId;
  ts: string;
  speakerKind: string;
  speakerId: string;
  editedAt: Date | null;
};

const dateOrNull = (value: Date | string | null) =>
  value === null ? null : new Date(value);

/**
 * Who said each source and when the text read was written: off the writing
 * agent's input row in the channel, else off a source row of the channel's
 * summary (the call read a line of it). The edit time is the caller's, as it
 * read the text; unset on a summary source, the row's. Null names a key
 * neither knows.
 */
async function resolveSources(
  tx: Database,
  place: ChannelSummaryPlace,
  agentId: string,
  keys: readonly ChannelSummarySourceKey[],
): Promise<{ resolved: (ResolvedSource | null)[] }> {
  const inPlace = (key: ChannelSummarySourceKey) =>
    key.slack === null ||
    (key.slack.teamId === place.teamId &&
      key.slack.channelId === place.channelId);
  const ids = [
    ...new Set(
      keys.flatMap((key) => (key.inputId === null ? [] : [key.inputId])),
    ),
  ];
  const tss = [
    ...new Set(
      keys.flatMap((key) =>
        key.slack !== null && inPlace(key) ? [key.slack.ts] : [],
      ),
    ),
  ];
  const either = (idColumn: string, tsColumn: string) =>
    sql.join(
      [
        ...(ids.length === 0
          ? []
          : [sql`${sql.raw(idColumn)} IN (${uuids(ids)})`]),
        ...(tss.length === 0
          ? []
          : [
              sql`${sql.raw(tsColumn)} IN (${sql.join(
                tss.map((ts) => sql`${ts}`),
                sql`, `,
              )})`,
            ]),
      ],
      sql` OR `,
    );
  if (ids.length === 0 && tss.length === 0) {
    return { resolved: keys.map(() => null) };
  }
  const inputs = rowsOf<{
    id: ConversationInputId;
    slack_ts: string;
    requester_kind: string;
    requester_id: string;
  }>(
    await tx.execute(sql`
      SELECT id, slack_ts, requester_kind, requester_id
      FROM conversation_inputs
      WHERE workspace_id = ${place.workspaceId}::uuid
        AND agent_id = ${agentId}::uuid
        AND slack_team_id = ${place.teamId}
        AND slack_channel_id = ${place.channelId}
        AND slack_ts IS NOT NULL
        AND (${either("id", "slack_ts")})`),
  );
  const summed = rowsOf<{
    input_id: ConversationInputId;
    ts: string;
    speaker_kind: string;
    speaker_id: string;
    edited_at: Date | string | null;
  }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (ts) input_id, ts, speaker_kind, speaker_id, edited_at
      FROM channel_summary_line_sources
      WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
        AND (${either("input_id", "ts")})
      ORDER BY ts, edited_at ASC NULLS FIRST`),
  );
  return {
    resolved: keys.map((key): ResolvedSource | null => {
      if (!inPlace(key)) return null;
      const input = inputs.find((row) =>
        key.inputId === null
          ? row.slack_ts === key.slack?.ts
          : row.id === key.inputId,
      );
      if (input !== undefined) {
        return {
          inputId: input.id,
          ts: input.slack_ts,
          speakerKind: input.requester_kind,
          speakerId: input.requester_id,
          editedAt: key.editedAt ?? null,
        };
      }
      const source = summed.find(
        (row) => row.input_id === key.inputId || row.ts === key.slack?.ts,
      );
      if (source === undefined) return null;
      return {
        inputId: source.input_id,
        ts: source.ts,
        speakerKind: source.speaker_kind,
        speakerId: source.speaker_id,
        editedAt:
          key.editedAt === undefined
            ? dateOrNull(source.edited_at)
            : key.editedAt,
      };
    }),
  };
}

/**
 * Adds lines to the channel's summary as one version, if it is at
 * `expectedVersion`, in the caller's transaction. Each line's sources are
 * everything its call read, resolved by the server (G8). A line with a
 * source deleted, or edited after the text read, is not added.
 */
export async function appendChannelSummaryLines(
  tx: Database,
  request: {
    place: ChannelSummaryPlace;
    expectedVersion: number;
    agentId: string;
    lines: readonly NewChannelSummaryLine[];
  },
): Promise<ChannelSummaryWriteResult> {
  const { place } = request;
  if (!request.lines.every((line) => validText(line.text))) {
    return { outcome: "invalid_text" };
  }
  const resolved: ResolvedSource[][] = [];
  for (const line of request.lines) {
    if (line.sources.length === 0) {
      return {
        outcome: "invalid_source",
        source: { inputId: null, slack: null },
      };
    }
    const found = (
      await resolveSources(tx, place, request.agentId, line.sources)
    ).resolved;
    const missing = found.indexOf(null);
    if (missing !== -1) {
      const key = line.sources[missing] as ChannelSummarySourceKey;
      return {
        outcome: "invalid_source",
        source: { inputId: key.inputId, slack: key.slack },
      };
    }
    // One row per message: the oldest text of it read.
    const byTs = new Map<string, ResolvedSource>();
    const timeOf = (source: ResolvedSource) =>
      (source.editedAt ?? tsTime(source.ts)).getTime();
    for (const source of found as ResolvedSource[]) {
      const seen = byTs.get(source.ts);
      if (seen === undefined || timeOf(source) < timeOf(seen)) {
        byTs.set(source.ts, source);
      }
    }
    resolved.push([...byTs.values()]);
  }
  const allTs = [...new Set(resolved.flat().map((source) => source.ts))].sort();
  // In one order, so two writes never wait on each other's marks.
  for (const ts of allTs) {
    await tx.execute(lockSlackSourceMark({ ...place, ts }));
  }
  const tsList = sql.join(
    allTs.map((ts) => sql`${ts}`),
    sql`, `,
  );
  const deleted = new Set(
    allTs.length === 0
      ? []
      : rowsOf<{ ts: string }>(
          await tx.execute(sql`
            SELECT ts FROM deleted_sources
            WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
              AND ts IN (${tsList})`),
        ).map((row) => row.ts),
  );
  const edited = new Map(
    allTs.length === 0
      ? []
      : rowsOf<{ ts: string; edited_at: Date | string }>(
          await tx.execute(sql`
            SELECT ts, edited_at FROM edited_sources
            WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
              AND ts IN (${tsList})`),
        ).map((row) => [row.ts, new Date(row.edited_at)] as const),
  );
  const marked = (source: ResolvedSource) => {
    if (deleted.has(source.ts)) return true;
    const edit = edited.get(source.ts);
    // An edit at or before the text read is the text read.
    return (
      edit !== undefined &&
      edit.getTime() > (source.editedAt ?? tsTime(source.ts)).getTime()
    );
  };
  const version = await lockSummary(tx, place, true);
  // Gone under a channel delete that this write waited for.
  if (version === null) return { outcome: "conflict", version: 0 };
  if (version !== request.expectedVersion) {
    return { outcome: "conflict", version };
  }
  const kept = request.lines.flatMap((line, i) => {
    const sources = resolved[i] as ResolvedSource[];
    return sources.some(marked) ? [] : [{ text: line.text, sources }];
  });
  const skipped = [
    ...new Set(
      resolved
        .flat()
        .filter(marked)
        .map((source) => source.inputId),
    ),
  ];
  if (kept.length === 0) {
    return { outcome: "written", version, lineIds: [], skipped };
  }
  const next = version + 1;
  const lineIds: ChannelSummaryLineId[] = [];
  for (const line of kept) {
    const id = await insertLine(tx, place, {
      text: line.text,
      agentId: request.agentId,
      version: next,
    });
    for (const source of line.sources) {
      await tx.execute(sql`
        INSERT INTO channel_summary_line_sources (
          line_id, input_id, workspace_id, team_id, channel_id, ts,
          speaker_kind, speaker_id, edited_at
        ) VALUES (
          ${id}::uuid, ${source.inputId}::uuid, ${place.workspaceId}::uuid,
          ${place.teamId}, ${place.channelId}, ${source.ts},
          ${source.speakerKind}, ${source.speakerId},
          ${source.editedAt === null ? null : source.editedAt.toISOString()}::timestamptz
        )
        ON CONFLICT (line_id, input_id) DO NOTHING`);
    }
    lineIds.push(id);
  }
  await setVersion(tx, place, next);
  return { outcome: "written", version: next, lineIds, skipped };
}

export type ChannelSummaryHistoryPrune = {
  channels: number;
  versions: number;
  lines: number;
};

/**
 * Removes the summaries' old versions: each no longer current at any time
 * in the last `historyMs`, with the lines no kept version holds. Up to
 * `limit` channels, each under its summary's lock; a dry run counts them.
 */
export async function pruneChannelSummaryHistory(
  db: Database,
  options: {
    limit: number;
    dryRun: boolean;
    historyMs?: number;
    now?: Date;
  },
): Promise<ChannelSummaryHistoryPrune> {
  const historyMs = options.historyMs ?? CHANNEL_SUMMARY_HISTORY_MS;
  const cutoff = sql`${(options.now ?? new Date()).toISOString()}::timestamptz - make_interval(secs => ${historyMs / 1000})`;
  // A version stops being current when the next one is made.
  const due = rowsOf<{
    workspace_id: string;
    team_id: string;
    channel_id: string;
  }>(
    await db.execute(sql`
      SELECT s.workspace_id, s.team_id, s.channel_id FROM channel_summaries s
      WHERE EXISTS (
        SELECT 1 FROM channel_summary_versions n
        WHERE (n.workspace_id, n.team_id, n.channel_id) =
            (s.workspace_id, s.team_id, s.channel_id)
          AND n.version <= s.version AND n.version > 0
          AND n.made_at < ${cutoff}
          AND EXISTS (
            SELECT 1 FROM channel_summary_versions o
            WHERE (o.workspace_id, o.team_id, o.channel_id) =
                (s.workspace_id, s.team_id, s.channel_id)
              AND o.version < n.version))
      ORDER BY s.updated_at
      LIMIT ${options.limit}`),
  );
  const total = { channels: 0, versions: 0, lines: 0 };
  for (const row of due) {
    const place = {
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      channelId: row.channel_id,
    };
    const counted = await db.transaction(async (tx) => {
      const current = await lockSummary(tx, place, false);
      if (current === null) return null;
      // The oldest kept: the one current when the first recent one was made.
      const [first] = rowsOf<{ kept_from: string }>(
        await tx.execute(sql`
          SELECT (COALESCE(min(version), ${current + 1}) - 1)::text AS kept_from
          FROM channel_summary_versions
          WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
            AND made_at >= ${cutoff}`),
      );
      const keptFrom = Number(first?.kept_from ?? current);
      const lineWhere = sql`(workspace_id, team_id, channel_id) = ${placeKey(place)}
        AND to_version IS NOT NULL AND to_version <= ${keptFrom}`;
      const versionWhere = sql`(workspace_id, team_id, channel_id) = ${placeKey(place)}
        AND version < ${keptFrom}`;
      if (options.dryRun) {
        const [lines] = rowsOf<{ n: string }>(
          await tx.execute(
            sql`SELECT count(*)::text AS n FROM channel_summary_lines WHERE ${lineWhere}`,
          ),
        );
        const [versions] = rowsOf<{ n: string }>(
          await tx.execute(
            sql`SELECT count(*)::text AS n FROM channel_summary_versions WHERE ${versionWhere}`,
          ),
        );
        return {
          versions: Number(versions?.n ?? 0),
          lines: Number(lines?.n ?? 0),
        };
      }
      const lines = rowsOf(
        await tx.execute(
          sql`DELETE FROM channel_summary_lines WHERE ${lineWhere} RETURNING id`,
        ),
      ).length;
      const versions = rowsOf(
        await tx.execute(
          sql`DELETE FROM channel_summary_versions WHERE ${versionWhere} RETURNING version`,
        ),
      ).length;
      return { versions, lines };
    });
    if (counted === null) continue;
    total.channels += 1;
    total.versions += counted.versions;
    total.lines += counted.lines;
  }
  return total;
}

export function createPostgresChannelSummaryStore(
  db: Database,
): ChannelSummaryStore {
  return {
    async read(place, version) {
      // One statement, so one snapshot even inside a caller's transaction:
      // a line is never read without the sources a delete took with it.
      const asOf =
        version === undefined ? sql`s.version` : sql`${version}::bigint`;
      const rows = rowsOf<{
        current: string;
        as_of: string;
        id: ChannelSummaryLineId | null;
        text: string;
        written_by_agent_id: string;
        written_at: Date | string;
        sources: {
          input_id: ConversationInputId;
          team_id: string;
          channel_id: string;
          ts: string;
          speaker_kind: string;
          speaker_id: string;
          edited_at: string | null;
        }[];
        kept: boolean;
      }>(
        await db.execute(sql`
          SELECT s.version::text AS current, (${asOf})::text AS as_of,
            EXISTS (
              SELECT 1 FROM channel_summary_versions v
              WHERE (v.workspace_id, v.team_id, v.channel_id) =
                  (s.workspace_id, s.team_id, s.channel_id)
                AND v.version = ${asOf}) AS kept,
            l.id, l.text, l.written_by_agent_id, l.written_at,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'input_id', x.input_id, 'team_id', x.team_id,
                'channel_id', x.channel_id, 'ts', x.ts,
                'speaker_kind', x.speaker_kind, 'speaker_id', x.speaker_id,
                'edited_at', x.edited_at)
                ORDER BY x.ts, x.input_id)
              FROM channel_summary_line_sources x WHERE x.line_id = l.id
            ), '[]'::jsonb) AS sources
          FROM channel_summaries s
          LEFT JOIN channel_summary_lines l
            ON (l.workspace_id, l.team_id, l.channel_id) =
                 (s.workspace_id, s.team_id, s.channel_id)
            AND l.from_version <= ${asOf}
            AND (l.to_version IS NULL OR l.to_version > ${asOf})
          WHERE (s.workspace_id, s.team_id, s.channel_id) = ${placeKey(place)}
          ORDER BY l.written_at, l.ordinal`),
      );
      const [first] = rows;
      if (first === undefined) return null;
      const current = Number(first.current);
      const at = Number(first.as_of);
      if (!Number.isInteger(at) || at < 0 || at > current) return null;
      // An old version past its history is gone; the current one never is.
      if (at < current && !first.kept) return null;
      const result: ChannelSummary = {
        version: at,
        lines: rows.flatMap((row) =>
          row.id === null
            ? []
            : [
                {
                  id: row.id,
                  text: row.text,
                  writtenByAgentId: row.written_by_agent_id,
                  writtenAt: new Date(row.written_at),
                  sources: row.sources.map(
                    (source): ChannelSummarySource => ({
                      inputId: source.input_id,
                      teamId: source.team_id,
                      channelId: source.channel_id,
                      ts: source.ts,
                      speaker: {
                        kind: source.speaker_kind,
                        id: source.speaker_id,
                      },
                      at:
                        source.edited_at === null
                          ? tsTime(source.ts)
                          : new Date(source.edited_at),
                    }),
                  ),
                },
              ],
        ),
      };
      return result;
    },

    append(request) {
      return db.transaction((tx) => appendChannelSummaryLines(tx, request));
    },

    async fold(request) {
      const { place } = request;
      if (!validText(request.text)) return { outcome: "invalid_text" };
      const lineIds = [...new Set(request.lineIds)];
      if (lineIds.length === 0) return { outcome: "invalid_text" };
      return db.transaction(async (tx) => {
        const version = await lockSummary(tx, place, false);
        if (version === null) {
          return {
            outcome: "line_not_found",
            lineId: lineIds[0] as ChannelSummaryLineId,
          };
        }
        if (version !== request.expectedVersion) {
          return { outcome: "conflict", version };
        }
        const live = rowsOf<{ id: string }>(
          await tx.execute(sql`
            SELECT l.id FROM channel_summary_lines l
            WHERE (l.workspace_id, l.team_id, l.channel_id) = ${placeKey(place)}
              AND l.id IN (${uuids(lineIds)}) AND l.to_version IS NULL`),
        );
        const missing = lineIds.find(
          (id) => !live.some((row) => row.id === id),
        );
        if (missing !== undefined) {
          return { outcome: "line_not_found", lineId: missing };
        }
        const next = version + 1;
        await tx.execute(sql`
          UPDATE channel_summary_lines SET to_version = ${next}
          WHERE id IN (${uuids(lineIds)})`);
        const id = await insertLine(tx, place, {
          text: request.text,
          agentId: request.agentId,
          version: next,
        });
        await copySources(tx, id, lineIds);
        await setVersion(tx, place, next);
        return {
          outcome: "written",
          version: next,
          lineIds: [id],
          skipped: [],
        };
      });
    },

    async revert(request) {
      const { place, toVersion } = request;
      return db.transaction(async (tx) => {
        const version = await lockSummary(tx, place, false);
        if (version === null) return { outcome: "version_not_found" };
        if (version !== request.expectedVersion) {
          return { outcome: "conflict", version };
        }
        if (
          !Number.isInteger(toVersion) ||
          toVersion < 0 ||
          toVersion >= version
        ) {
          return { outcome: "version_not_found" };
        }
        // Past the history (CHANNEL_SUMMARY_HISTORY_MS), its lines are gone.
        const [kept] = rowsOf(
          await tx.execute(sql`
            SELECT 1 FROM channel_summary_versions
            WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
              AND version = ${toVersion}`),
        );
        if (kept === undefined) return { outcome: "version_not_found" };
        const next = version + 1;
        const back = rowsOf<{
          id: string;
          text: string;
          written_by_agent_id: string;
        }>(
          await tx.execute(sql`
            SELECT l.id, l.text, l.written_by_agent_id FROM channel_summary_lines l
            WHERE (l.workspace_id, l.team_id, l.channel_id) = ${placeKey(place)}
              AND ${liveAt(toVersion)}
              AND NOT EXISTS (
                SELECT 1 FROM channel_summary_lines c
                WHERE (c.workspace_id, c.team_id, c.channel_id) = ${placeKey(place)}
                  AND c.origin_id = l.origin_id AND c.to_version IS NULL)
            ORDER BY l.written_at, l.ordinal`),
        );
        await tx.execute(sql`
          UPDATE channel_summary_lines l SET to_version = ${next}
          WHERE (l.workspace_id, l.team_id, l.channel_id) = ${placeKey(place)}
            AND l.to_version IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM channel_summary_lines o
              WHERE (o.workspace_id, o.team_id, o.channel_id) = ${placeKey(place)}
                AND o.origin_id = l.origin_id AND ${liveAt(toVersion, "o")})`);
        const lineIds: ChannelSummaryLineId[] = [];
        for (const line of back) {
          const id = await insertLine(tx, place, {
            text: line.text,
            agentId: line.written_by_agent_id,
            version: next,
            copyOf: line.id,
          });
          await copySources(tx, id, [line.id]);
          lineIds.push(id);
        }
        await setVersion(tx, place, next);
        return { outcome: "written", version: next, lineIds, skipped: [] };
      });
    },

    async deleteChannel(place) {
      return db.transaction(async (tx) => {
        const { lines } = await deleteChannelSummary(tx, place);
        return { lines };
      });
    },
  };
}
