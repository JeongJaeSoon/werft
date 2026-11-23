import { randomUUID } from "node:crypto";
import {
  CHANNEL_SUMMARY_LINE_TEXT_MAX,
  type ChannelSummaryLineId,
  type ConversationInputId,
} from "@werft-ai/contracts";
import type {
  ChannelSummary,
  ChannelSummaryPlace,
  ChannelSummarySource,
  ChannelSummaryStore,
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
      INSERT INTO channel_summaries (workspace_id, team_id, channel_id)
      VALUES (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId})
      ON CONFLICT DO NOTHING`);
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
      speaker_kind, speaker_id
    )
    SELECT DISTINCT ON (input_id) ${lineId}::uuid, input_id, workspace_id,
      team_id, channel_id, ts, speaker_kind, speaker_id
    FROM channel_summary_line_sources
    WHERE line_id IN (${uuids(from)})
    ORDER BY input_id`);
}

/**
 * Removes, from every version, each summary line with the message among its
 * sources, and moves the summary one version on if any went. The delete and
 * edit marks call it in their transaction, which holds the message's mark
 * lock: a write naming the message waits for it, then sees the mark. The
 * summary row is locked before the delete, whose statement then sees a
 * line a fold or revert committed while it waited.
 */
export async function dropChannelSummaryLinesOf(
  tx: Database,
  mark: { workspaceId: string; teamId: string; channelId: string; ts: string },
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
          WHERE s.line_id = l.id AND s.ts = ${mark.ts})
      RETURNING l.id`),
  ).length;
  if (gone > 0) await setVersion(tx, place, version + 1);
  return gone;
}

/**
 * Deletes the channel's summary: every version's lines, their sources and
 * the summary row. The channel's context row stays, as its conversations
 * point at it. Zero lines when it has none, so a second call changes nothing.
 */
export async function deleteChannelSummary(
  tx: Database,
  place: ChannelSummaryPlace,
): Promise<{ lines: number }> {
  if ((await lockSummary(tx, place, false)) === null) return { lines: 0 };
  const lines = rowsOf(
    await tx.execute(sql`
      DELETE FROM channel_summary_lines
      WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
      RETURNING id`),
  ).length;
  await tx.execute(sql`
    DELETE FROM channel_summaries
    WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}`);
  return { lines };
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
        }[];
      }>(
        await db.execute(sql`
          SELECT s.version::text AS current, (${asOf})::text AS as_of,
            l.id, l.text, l.written_by_agent_id, l.written_at,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'input_id', x.input_id, 'team_id', x.team_id,
                'channel_id', x.channel_id, 'ts', x.ts,
                'speaker_kind', x.speaker_kind, 'speaker_id', x.speaker_id)
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
                    }),
                  ),
                },
              ],
        ),
      };
      return result;
    },

    async append(request) {
      const { place } = request;
      if (!request.lines.every((line) => validText(line.text))) {
        return { outcome: "invalid_text" };
      }
      return db.transaction(async (tx) => {
        const wanted = [...new Set(request.lines.map((line) => line.inputId))];
        const inputs =
          wanted.length === 0
            ? []
            : rowsOf<{
                id: ConversationInputId;
                slack_ts: string;
                requester_kind: string;
                requester_id: string;
              }>(
                await tx.execute(sql`
                  SELECT id, slack_ts, requester_kind, requester_id
                  FROM conversation_inputs
                  WHERE id IN (${uuids(wanted)})
                    AND workspace_id = ${place.workspaceId}::uuid
                    AND agent_id = ${request.agentId}::uuid
                    AND slack_team_id = ${place.teamId}
                    AND slack_channel_id = ${place.channelId}`),
              );
        const missing = wanted.find(
          (id) => !inputs.some((input) => input.id === id),
        );
        if (missing !== undefined) {
          return { outcome: "invalid_source", inputId: missing };
        }
        // In one order, so two writes never wait on each other's marks.
        for (const ts of [...new Set(inputs.map((i) => i.slack_ts))].sort()) {
          await tx.execute(lockSlackSourceMark({ ...place, ts }));
        }
        const marked = new Set(
          wanted.length === 0
            ? []
            : rowsOf<{ ts: string }>(
                await tx.execute(sql`
                  SELECT ts FROM deleted_sources
                  WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
                    AND ts IN (${sql.join(
                      inputs.map((input) => sql`${input.slack_ts}`),
                      sql`, `,
                    )})
                  UNION
                  SELECT ts FROM edited_sources
                  WHERE (workspace_id, team_id, channel_id) = ${placeKey(place)}
                    AND ts IN (${sql.join(
                      inputs.map((input) => sql`${input.slack_ts}`),
                      sql`, `,
                    )})`),
              ).map((row) => row.ts),
        );
        const version = await lockSummary(tx, place, true);
        // Gone under a channel delete that this write waited for.
        if (version === null) return { outcome: "conflict", version: 0 };
        if (version !== request.expectedVersion) {
          return { outcome: "conflict", version };
        }
        const inputOf = (id: ConversationInputId) =>
          inputs.find((input) => input.id === id) as (typeof inputs)[number];
        const kept = request.lines.filter(
          (line) => !marked.has(inputOf(line.inputId).slack_ts),
        );
        const skipped = wanted.filter((id) => marked.has(inputOf(id).slack_ts));
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
          const input = inputOf(line.inputId);
          await tx.execute(sql`
            INSERT INTO channel_summary_line_sources (
              line_id, input_id, workspace_id, team_id, channel_id, ts,
              speaker_kind, speaker_id
            ) VALUES (
              ${id}::uuid, ${input.id}::uuid, ${place.workspaceId}::uuid,
              ${place.teamId}, ${place.channelId}, ${input.slack_ts},
              ${input.requester_kind}, ${input.requester_id}
            )`);
          lineIds.push(id);
        }
        await setVersion(tx, place, next);
        return { outcome: "written", version: next, lineIds, skipped };
      });
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
      return db.transaction((tx) => deleteChannelSummary(tx, place));
    },
  };
}
