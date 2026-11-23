import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import {
  dropBufferedInputs,
  dropChannelSummary,
  lockSlackSourceMark,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { receipts } from "../schema.ts";
import { stopSessionsOnDeletedSource } from "../sessions/index.ts";
import { rowsOf } from "../statement-rows.ts";

/** What one admin delete removes, or would remove on a dry run. */
export type ConversationRecordCounts = {
  engagements: number;
  /** Line rows of every version, the history with them. */
  summaryLines: number;
  buffered: number;
  /** Messages newly marked deleted. */
  marked: number;
};

export type ConversationRecordsDeletion =
  | { outcome: "not_found" | "dm_not_supported" | "not_admin" }
  | {
      outcome: "deleted" | "unchanged" | "dry_run";
      workspaceId: string;
      counts: ConversationRecordCounts;
      /** Sessions stopped for a message an admin delete marked, this call. */
      sessionsStopped: string[];
    };

type Conversation = {
  id: string;
  workspace_id: string;
  agent_id: string;
  kind: "channel" | "dm";
  team_id: string | null;
  channel_id: string | null;
};

type ChannelConversation = Conversation & {
  team_id: string;
  channel_id: string;
};

/** The records of a channel conversation, as one statement each sees them. */
type Records = {
  engagementTs: string[];
  bufferedIds: string[];
  /** Every message the records name, sorted. */
  touched: string[];
  /** Of those, the ones no turn or web input row holds: the ones marked. */
  marks: string[];
  summaryLines: number;
};

/** A record written between the first look and the locks: start again. */
class RecordsMoved extends Error {}

const ATTEMPTS = 3;

const texts = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  );

async function recordsOf(
  tx: Database,
  c: ChannelConversation,
): Promise<Records> {
  const channel = sql`${c.workspace_id}::uuid, ${c.team_id}::text, ${c.channel_id}::text`;
  const engagementTs = rowsOf<{ ts: string }>(
    await tx.execute(sql`
      SELECT ts FROM conversation_engagements
      WHERE (workspace_id, team_id, channel_id) = (${channel})
        AND agent_id = ${c.agent_id}::uuid
      ORDER BY ts`),
  ).map((row) => row.ts);
  const buffered = rowsOf<{ id: string; slack_ts: string }>(
    await tx.execute(sql`
      SELECT i.id, i.slack_ts FROM conversation_inputs i
      JOIN conversation_topics t ON t.id = i.topic_id
      WHERE t.conversation_id = ${c.id}::uuid
        AND i.agent_id = ${c.agent_id}::uuid
        AND i.buffer_expires_at IS NOT NULL
      ORDER BY i.id`),
  );
  const summary = rowsOf<{ ts: string | null; lines: string }>(
    await tx.execute(sql`
      SELECT s.ts, (SELECT count(*) FROM channel_summary_lines l
        WHERE (l.workspace_id, l.team_id, l.channel_id) = (${channel}))::text AS lines
      FROM (SELECT 1) one
      LEFT JOIN (SELECT DISTINCT ts FROM channel_summary_line_sources
        WHERE (workspace_id, team_id, channel_id) = (${channel})) s ON true`),
  );
  const touched = [
    ...new Set([
      ...engagementTs,
      ...buffered.map((row) => row.slack_ts),
      ...summary.flatMap((row) => (row.ts === null ? [] : [row.ts])),
    ]),
  ].sort();
  // A turn's input, or a web input, is the session's: it stays, and so does
  // the message it was, unmarked (its session goes on). A turn names its
  // message as a direct source before its input row is written, in another
  // transaction, so the turn counts too; a turn inserted later takes the
  // message's mark lock first.
  const held = new Set(
    touched.length === 0
      ? []
      : rowsOf<{ ts: string }>(
          await tx.execute(sql`
            SELECT m.ts FROM unnest(ARRAY[${texts(touched)}]) AS m(ts)
            WHERE EXISTS (
                SELECT 1 FROM conversation_inputs i
                WHERE (i.workspace_id, i.slack_team_id, i.slack_channel_id) = (${channel})
                  AND i.buffer_expires_at IS NULL AND i.slack_ts = m.ts)
              OR EXISTS (
                SELECT 1 FROM turns st JOIN sessions ss ON ss.id = st.session_id
                WHERE ss.workspace_id = ${c.workspace_id}::uuid
                  AND st.sources @> jsonb_build_object('direct', jsonb_build_array(
                    jsonb_build_object('team_id', ${c.team_id}::text,
                      'channel_id', ${c.channel_id}::text, 'ts', m.ts))))`),
        ).map((row) => row.ts),
  );
  return {
    engagementTs,
    bufferedIds: buffered.map((row) => row.id),
    touched,
    marks: touched.filter((ts) => !held.has(ts)),
    summaryLines: Number(summary[0]?.lines ?? 0),
  };
}

const within = (inner: readonly string[], outer: readonly string[]) => {
  const all = new Set(outer);
  return inner.every((ts) => all.has(ts));
};

/**
 * An admin's delete of one channel conversation's records (C8): the agent's
 * engagement rows in the channel, the channel's summary with its history,
 * and the agent's buffered messages of the conversation. Sessions, their
 * turns, inputs, events, transcripts and checkpoints stay; so does the
 * conversation row, which takes who and when.
 *
 * Before anything goes, every message the records name that no turn or web
 * input holds is marked deleted (reason `admin_deleted`): a send or a turn
 * with it among its sources is refused from then, and after the commit each
 * session holding it stops (stopSessionsOnDeletedSource). A session with only
 * its own input goes on. A receipt keeps who, which conversation and how many
 * rows. Calling again removes nothing more and writes nothing, but stops what
 * a failure after an earlier commit left running. `by` is the email of an
 * owner or admin of the conversation's workspace.
 */
export async function deleteConversationRecords(
  db: Database,
  input: { conversationId: ConversationId; by: string; dryRun?: boolean },
): Promise<ConversationRecordsDeletion> {
  const find = async (tx: Database, lock: boolean) =>
    rowsOf<Conversation>(
      await tx.execute(sql`
        SELECT id, workspace_id, agent_id, kind, team_id, channel_id
        FROM conversations WHERE id = ${input.conversationId.toLowerCase()}::uuid
        ${lock ? sql`FOR UPDATE` : sql``}`),
    )[0];
  const first = await find(db, false);
  if (first === undefined) return { outcome: "not_found" };
  if (first.kind !== "channel") return { outcome: "dm_not_supported" };
  const conversation = first as ChannelConversation;
  const adminOf = async (tx: Database) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`
        SELECT u.id FROM users u
        JOIN memberships m ON m.user_id = u.id
        WHERE u.email = ${input.by.toLowerCase()}
          AND m.workspace_id = ${conversation.workspace_id}::uuid
          AND m.role IN (${texts(WORKSPACE_MANAGER_ROLES)})
          AND m.disabled_at IS NULL AND u.disabled_at IS NULL
        FOR SHARE OF m`),
    )[0]?.id;
  if ((await adminOf(db)) === undefined) return { outcome: "not_admin" };

  const place = {
    workspaceId: conversation.workspace_id,
    teamId: conversation.team_id,
    channelId: conversation.channel_id,
  };
  if (input.dryRun === true) {
    const records = await recordsOf(db, conversation);
    const marked =
      records.marks.length === 0
        ? 0
        : rowsOf(
            await db.execute(sql`
            SELECT 1 FROM unnest(ARRAY[${texts(records.marks)}]) AS m(ts)
            WHERE NOT EXISTS (
              SELECT 1 FROM deleted_sources d
              WHERE (d.workspace_id, d.team_id, d.channel_id, d.ts) =
                (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId}, m.ts))`),
          ).length;
    return {
      outcome: "dry_run",
      workspaceId: place.workspaceId,
      counts: {
        engagements: records.engagementTs.length,
        summaryLines: records.summaryLines,
        buffered: records.bufferedIds.length,
        marked,
      },
      sessionsStopped: [],
    };
  }

  let counts: ConversationRecordCounts | undefined;
  for (let attempt = 1; counts === undefined; attempt++) {
    try {
      counts =
        (await db.transaction(async (tx) => {
          const seen = await recordsOf(tx, conversation);
          // The order every write naming a message takes: its mark lock, then
          // the conversation (a buffer hold), then the summary row.
          for (const ts of seen.touched) {
            await tx.execute(lockSlackSourceMark({ ...place, ts }));
          }
          await find(tx, true);
          const admin = await adminOf(tx);
          if (admin === undefined) return null;
          const records = await recordsOf(tx, conversation);
          if (!within(records.touched, seen.touched)) throw new RecordsMoved();
          const marked =
            records.marks.length === 0
              ? 0
              : rowsOf(
                  await tx.execute(sql`
                  INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at, reason)
                  SELECT ${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId}, m.ts, now(), 'admin_deleted'
                  FROM unnest(ARRAY[${texts(records.marks)}]) AS m(ts)
                  ON CONFLICT DO NOTHING
                  RETURNING ts`),
                ).length;
          if (records.marks.length > 0) {
            await tx.execute(sql`
            DELETE FROM edited_sources
            WHERE (workspace_id, team_id, channel_id) =
                (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId})
              AND ts IN (${texts(records.marks)})`);
          }
          // An engagement is written without the conversation's lock: all of
          // the conversation's go, and one not seen before starts again.
          const engagementTs = rowsOf<{ ts: string }>(
            await tx.execute(sql`
            DELETE FROM conversation_engagements
            WHERE (workspace_id, team_id, channel_id) =
                (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId})
              AND agent_id = ${conversation.agent_id}::uuid
            RETURNING ts`),
          ).map((row) => row.ts);
          if (!within(engagementTs, seen.touched)) throw new RecordsMoved();
          const engagements = engagementTs.length;
          const buffered = await dropBufferedInputs(tx, records.bufferedIds);
          const summary = await dropChannelSummary(tx, place);
          if (!within(summary.sourceTs, seen.touched)) throw new RecordsMoved();
          const result = {
            engagements,
            summaryLines: summary.lines,
            buffered,
            marked,
          };
          if (engagements + summary.lines + buffered + marked === 0) {
            return result;
          }
          await tx.execute(sql`
          UPDATE conversations
          SET records_deleted_at = now(), records_deleted_by_user_id = ${admin}::uuid
          WHERE id = ${conversation.id}::uuid`);
          await tx.insert(receipts).values({
            id: randomUUID(),
            ownerId: place.workspaceId,
            operation: "delete_conversation_records",
            targetRef: {
              resource: { kind: "conversation", id: conversation.id },
              workspace_id: place.workspaceId,
            },
            status: "succeeded",
            result: {
              conversation_id: conversation.id,
              engagements,
              summary_lines: summary.lines,
              buffered,
              marked,
              by: "operator_cli",
            },
            actor: {
              principal: { kind: "user", id: admin },
              actor_user_id: admin,
              agent_id: null,
            },
          });
          return result;
        })) ?? undefined;
      if (counts === undefined) return { outcome: "not_admin" };
    } catch (error) {
      if (!(error instanceof RecordsMoved) || attempt >= ATTEMPTS) throw error;
    }
  }

  // After the commit, each session in its own transaction, as a Slack delete
  // does. Every admin mark of the channel, so a call again finishes what an
  // earlier one's failure left.
  const adminMarks = rowsOf<{ ts: string }>(
    await db.execute(sql`
      SELECT ts FROM deleted_sources
      WHERE (workspace_id, team_id, channel_id) =
          (${place.workspaceId}::uuid, ${place.teamId}, ${place.channelId})
        AND reason = 'admin_deleted'
      ORDER BY ts`),
  );
  const sessionsStopped: string[] = [];
  for (const { ts } of adminMarks) {
    sessionsStopped.push(
      ...(await stopSessionsOnDeletedSource(db, { ...place, ts })),
    );
  }
  const removed =
    counts.engagements + counts.summaryLines + counts.buffered + counts.marked;
  return {
    outcome: removed > 0 ? "deleted" : "unchanged",
    workspaceId: place.workspaceId,
    counts,
    sessionsStopped,
  };
}
