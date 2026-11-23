import type { ConversationInputId, SlackMessageRef } from "@werft-ai/contracts";
import {
  type SourceKey,
  type SourcePlace,
  type StoredSourceSet,
  sameSource,
  slackSource,
  sourceSetOf,
  storedSourceSet,
  turnSources,
} from "@werft-ai/platform";
import { and, asc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { turns } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * The sources of a turn about to be inserted in the session: the Slack
 * message it came from, if any, and every source of the turns before it.
 * A continuation, a push follow-up and a web or API input inherit alike.
 * The Slack input's row is written after the turn; recordSourceInput adds
 * its id, and the place alone is what a delete mark is matched on.
 */
export async function newTurnSources(
  tx: Database,
  input: { sessionId: string; slackMessage: SlackMessageRef | null },
): Promise<StoredSourceSet | null> {
  const earlier = await tx
    .select({ sources: turns.sources })
    .from(turns)
    .where(and(eq(turns.sessionId, input.sessionId), isNotNull(turns.sources)))
    .orderBy(asc(turns.sequence));
  const direct =
    input.slackMessage === null
      ? []
      : [
          slackSource({
            teamId: input.slackMessage.team_id,
            channelId: input.slackMessage.channel_id,
            ts: input.slackMessage.ts,
          }),
        ];
  return storedSourceSet(
    turnSources({
      direct,
      earlier: earlier.map((row) => sourceSetOf(row.sources)),
    }),
  );
}

const placeJson = (place: {
  teamId: SQL | string;
  channelId: SQL | string;
  ts: SQL | string;
}) =>
  sql`jsonb_build_array(jsonb_build_object('team_id', ${place.teamId}::text, 'channel_id', ${place.channelId}::text, 'ts', ${place.ts}::text))`;

/**
 * Whether a source set column lists the place, directly or inherited: two
 * containment tests, the only shape a jsonb_path_ops index answers.
 */
export function sourcesHoldPlace(
  column: SQL,
  place: { teamId: SQL | string; channelId: SQL | string; ts: SQL | string },
): SQL {
  const one = placeJson(place);
  return sql`(${column} @> jsonb_build_object('direct', ${one}) OR ${column} @> jsonb_build_object('inherited', ${one}))`;
}

/**
 * Whether a turn or a Slack outbox row of the workspace has the message
 * among its sources, so the message's delete or edit mark stays.
 */
export function sourceSetHoldsMark(mark: {
  workspaceId: SQL;
  teamId: SQL;
  channelId: SQL;
  ts: SQL;
}): SQL {
  return sql`(EXISTS (
    SELECT 1 FROM turns st JOIN sessions ss ON ss.id = st.session_id
    WHERE st.sources IS NOT NULL
      AND ${sourcesHoldPlace(sql.raw("st.sources"), mark)}
      AND ss.workspace_id = ${mark.workspaceId})
  OR EXISTS (
    SELECT 1 FROM slack_outbox so
    WHERE so.sources IS NOT NULL
      AND ${sourcesHoldPlace(sql.raw("so.sources"), mark)}
      AND so.workspace_id = ${mark.workspaceId}))`;
}

/**
 * Names the input row in every source key of the session at the message's
 * place, on its turns and its outbox rows. Keys already naming a row stay.
 * A turn inserted while this runs may keep a key without the id; the place
 * still finds it.
 */
export async function recordSourceInput(
  tx: Database,
  input: {
    sessionId: string;
    inputId: ConversationInputId;
    place: SourcePlace;
  },
): Promise<void> {
  const name = (stored: unknown) => {
    const set = sourceSetOf(stored);
    const fill = (key: SourceKey): SourceKey =>
      key.inputId === null && sameSource(key, slackSource(input.place))
        ? { ...key, inputId: input.inputId }
        : key;
    return storedSourceSet({
      ...set,
      direct: set.direct.map(fill),
      inherited: set.inherited.map(fill),
    });
  };
  for (const table of ["turns", "slack_outbox"] as const) {
    const t = sql.raw(table);
    const rows = rowsOf<{ id: string; sources: unknown }>(
      await tx.execute(sql`
        SELECT id::text, sources FROM ${t}
        WHERE session_id = ${input.sessionId}::uuid AND sources IS NOT NULL
          AND ${sourcesHoldPlace(sql.raw(`${table}.sources`), input.place)}
        FOR UPDATE`),
    );
    for (const row of rows) {
      await tx.execute(sql`
        UPDATE ${t} SET sources = ${JSON.stringify(name(row.sources))}::jsonb
        WHERE id = ${row.id}::${sql.raw(table === "turns" ? "bigint" : "uuid")}`);
    }
  }
}
