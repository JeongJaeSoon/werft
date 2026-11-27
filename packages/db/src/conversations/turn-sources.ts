import type { ConversationInputId, SlackMessageRef } from "@werft-ai/contracts";
import {
  placeSource,
  type SourceKey,
  type SourcePlace,
  type SourceSet,
  type StoredSourceSet,
  sameSource,
  sourceSetOf,
  storedSourceSet,
  turnSources,
} from "@werft-ai/platform";
import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { turns } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Gives each key the input row it lacks, of the inputs that became turns of
 * the session: complete() may have written one after the set was read.
 */
async function withInputIds(
  tx: Database,
  sessionId: string,
  set: SourceSet,
): Promise<SourceSet> {
  const unnamed = [...set.direct, ...set.inherited].filter(
    (key) => key.inputId === null && key.slack !== null,
  );
  if (unnamed.length === 0) return set;
  const found = rowsOf<{
    id: ConversationInputId;
    slack_team_id: string;
    slack_channel_id: string;
    slack_ts: string;
  }>(
    await tx.execute(sql`
      SELECT i.id, i.slack_team_id, i.slack_channel_id, i.slack_ts
      FROM conversation_inputs i
      JOIN turns t ON t.id = i.turn_id
      JOIN sessions s ON s.id = t.session_id
      WHERE t.session_id = ${sessionId}::uuid
        AND i.workspace_id = s.workspace_id
        AND (i.slack_team_id, i.slack_channel_id, i.slack_ts) IN (${sql.join(
          unnamed.map(
            (key) =>
              sql`(${key.slack?.teamId}::text, ${key.slack?.channelId}::text, ${key.slack?.ts}::text)`,
          ),
          sql`, `,
        )})`),
  );
  const name = (key: SourceKey): SourceKey => {
    if (key.inputId !== null) return key;
    const row = found.find((input) =>
      sameSource(
        key,
        placeSource({
          teamId: input.slack_team_id,
          channelId: input.slack_channel_id,
          ts: input.slack_ts,
        }),
      ),
    );
    return row === undefined ? key : { ...key, inputId: row.id };
  };
  return {
    ...set,
    direct: set.direct.map(name),
    inherited: set.inherited.map(name),
  };
}

/**
 * The sources of a turn about to be inserted in the session: the Slack
 * message it came from, if any, and every source of the turns before it,
 * all of which the latest turn with sources already holds. A continuation,
 * a push follow-up and a web or API input inherit alike. The Slack input's
 * row is written after the turn; recordSourceInput adds its id, and the
 * place alone is what a delete mark is matched on.
 */
export async function newTurnSources(
  tx: Database,
  input: {
    sessionId: string;
    slackMessage: SlackMessageRef | null;
    /**
     * The sources a conversation turn hands on with the message (v1-b/E4):
     * its direct ones stay direct, its inherited ones inherited.
     */
    carried?: StoredSourceSet | null;
  },
): Promise<StoredSourceSet | null> {
  const [latest] = await tx
    .select({ sources: turns.sources })
    .from(turns)
    .where(and(eq(turns.sessionId, input.sessionId), isNotNull(turns.sources)))
    .orderBy(desc(turns.sequence))
    .limit(1);
  const direct =
    input.slackMessage === null
      ? []
      : [
          placeSource({
            teamId: input.slackMessage.team_id,
            channelId: input.slackMessage.channel_id,
            ts: input.slackMessage.ts,
          }),
        ];
  const carried = input.carried == null ? null : sourceSetOf(input.carried);
  const set = turnSources({
    direct: [...direct, ...(carried?.direct ?? [])],
    earlier: [
      ...(carried === null ? [] : [{ ...carried, direct: [] }]),
      ...(latest === undefined ? [] : [sourceSetOf(latest.sources)]),
    ],
  });
  return storedSourceSet(await withInputIds(tx, input.sessionId, set));
}

/**
 * An outbox row's copy of its turn's sources as of now. Under a share lock
 * on the session, which complete() takes for update before it names an
 * input, so the row is either named here or there.
 */
export async function outboxSources(
  tx: Database,
  sessionId: string,
  stored: StoredSourceSet,
): Promise<StoredSourceSet | null> {
  await tx.execute(
    sql`SELECT 1 FROM sessions WHERE id = ${sessionId}::uuid FOR SHARE`,
  );
  return storedSourceSet(
    await withInputIds(tx, sessionId, sourceSetOf(stored)),
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
 * Whether a turn, a conversation turn or a Slack outbox row of the
 * workspace has the message among its sources, so the message's delete or
 * edit mark stays: a conversation turn holds what its tools read.
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
    SELECT 1 FROM conversation_turns ct
    WHERE ct.sources IS NOT NULL
      AND ${sourcesHoldPlace(sql.raw("ct.sources"), mark)}
      AND ct.workspace_id = ${mark.workspaceId})
  OR EXISTS (
    SELECT 1 FROM slack_outbox so
    WHERE so.sources IS NOT NULL
      AND ${sourcesHoldPlace(sql.raw("so.sources"), mark)}
      AND so.workspace_id = ${mark.workspaceId}))`;
}

/**
 * Waits for a turn insert or an outbox copy of the session under way, which
 * then reads the input about to be written; one after this sees it named.
 * Taken before the input row's insert, whose foreign key check share-locks
 * the turn: a finalize locks the session, then the turn.
 */
export async function lockSessionForSources(
  tx: Database,
  sessionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM sessions WHERE id = ${sessionId}::uuid FOR UPDATE`,
  );
}

/**
 * Names the input row in every source key of the session at the message's
 * place, on its turns and its outbox rows. Keys already naming a row stay.
 * The caller holds the session row for update (lockSessionForSources).
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
      key.inputId === null && sameSource(key, placeSource(input.place))
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
