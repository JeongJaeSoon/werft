import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationInputId,
  type ConversationTopicId,
  type JudgmentBatchId,
  judgmentBatchIdSchema,
} from "@werft-ai/contracts";
import {
  type ClosedJudgmentBatch,
  JUDGMENT_BATCH_DEADLINE_MS,
  JUDGMENT_BATCH_MAX_WAIT_MS,
  JUDGMENT_BATCH_QUIET_MS,
  type JudgmentBatchInput,
  type JudgmentBatchStore,
  M1_CHANNEL_WINDOW_MS,
  M1_JUDGMENTS_PER_CHANNEL_WINDOW,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import {
  engagedJudgmentsInWindow,
  heldForReply,
} from "./conversation-judgments.ts";
import { channelMarksSettledAt } from "./deleted-sources.ts";
import { rowColumns, stillListened } from "./judgment-buffer.ts";

/** Channels a close looks at in one call; the rest wait for the next. */
const CLOSE_CANDIDATES = 20;

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * The batches (alias `b`) that count against M1's cap: one that called the
 * model, or may have (judging, or failed whatever it reached). One stopped
 * before the model (budget, the concurrency cap, its size) or past the cap
 * does not.
 */
const countsAgainstM1Cap = sql`(b.state = 'judging' OR (b.state IN ('judged', 'failed') AND b.model_called IS NOT FALSE))`;

/**
 * Rows (alias `i`, batch `b` left-joined) a close may take: live, in no
 * batch or in one past the cap, and not held for a reply's own judgment.
 */
const takeable = (at: SQL) =>
  sql`i.buffer_expires_at IS NOT NULL AND i.buffer_expires_at > ${at} AND (i.judgment_batch_id IS NULL OR b.state = 'rate_limited') AND NOT ${heldForReply}`;

type Channel = {
  workspace_id: string;
  agent_id: string;
  slack_team_id: string;
  slack_channel_id: string;
};

type HeldRow = {
  id: string;
  topic_id: string;
  slack_ts: string;
  requester_id: string;
  body: string;
  received_at: Date | string;
  rate_limited: boolean;
  edit_mark: string | null;
};

const dateOf = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);

const atOf = (now: Date | undefined) =>
  now === undefined ? sql`now()` : sql`${now.toISOString()}::timestamptz`;

/**
 * Ends the judging batches past their deadline as failed: their judge died.
 * Their messages stay in them and expire unjudged.
 */
async function failOverdue(tx: Database, at: SQL) {
  await tx.execute(sql`
    UPDATE judgment_batches SET state = 'failed', ended_at = ${at}
    WHERE state = 'judging'
      AND closed_at <= ${at} - ${secs(JUDGMENT_BATCH_DEADLINE_MS)}`);
}

/**
 * Closes one channel's batch under its lock, or returns null when the
 * channel is not due after all: another caller closed it, its judgment is
 * still running, or it stopped being heard.
 */
async function closeChannel(
  tx: Database,
  channel: Channel,
  at: SQL,
): Promise<ClosedJudgmentBatch | null> {
  const [locked] = rowsOf<{ locked: boolean }>(
    await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('judgment_batch'), hashtext(${`${channel.agent_id}:${channel.slack_team_id}:${channel.slack_channel_id}`}::text)) AS locked`,
    ),
  );
  if (!locked?.locked) return null;
  const same = sql`agent_id = ${channel.agent_id}::uuid
    AND slack_team_id = ${channel.slack_team_id}
    AND slack_channel_id = ${channel.slack_channel_id}`;
  const [judging] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM judgment_batches WHERE ${same} AND state = 'judging'`),
  );
  if (judging !== undefined) return null;
  // The switch, the agent, the binding and the channel's state, as the
  // buffer holds and keeps a message; and a release to judge with.
  // What the batch's keys point at, key-share locked before any message row,
  // so the insert's key checks wait on nothing: one that a delete or an
  // archive holds is skipped this time, like a held row.
  const [agent] = rowsOf<{ release_id: string | null }>(
    await tx.execute(sql`
      SELECT active_release_id AS release_id FROM agents
      WHERE id = ${channel.agent_id}::uuid
      FOR KEY SHARE SKIP LOCKED`),
  );
  if (!agent?.release_id) return null;
  const [keys] = rowsOf<{ conversation_id: string }>(
    await tx.execute(sql`
      SELECT c.id AS conversation_id
      FROM conversations c, agent_releases r
      WHERE c.agent_id = ${channel.agent_id}::uuid AND c.kind = 'channel'
        AND c.team_id = ${channel.slack_team_id}
        AND c.channel_id = ${channel.slack_channel_id}
        AND r.agent_id = ${channel.agent_id}::uuid AND r.id = ${agent.release_id}
      FOR KEY SHARE SKIP LOCKED`),
  );
  if (keys === undefined) return null;
  const rows = rowsOf<HeldRow>(
    await tx.execute(sql`
      SELECT i.id, i.topic_id, i.slack_ts, i.requester_id,
        i.body, i.received_at, i.judgment_batch_id IS NOT NULL AS rate_limited,
        -- Read with the text, for the write's check (a1/J6).
        (SELECT m.marked_at::text FROM edited_sources m
          WHERE m.workspace_id = i.workspace_id
            AND m.team_id = i.slack_team_id
            AND m.channel_id = i.slack_channel_id
            AND m.ts = i.slack_ts) AS edit_mark
      FROM conversation_inputs i
      LEFT JOIN judgment_batches b ON b.id = i.judgment_batch_id
      WHERE i.agent_id = ${channel.agent_id}::uuid
        AND i.slack_team_id = ${channel.slack_team_id}
        AND i.slack_channel_id = ${channel.slack_channel_id}
        AND ${takeable(at)}
        AND ${stillListened(rowColumns)}
      ORDER BY i.received_at, i.id
      FOR UPDATE OF i SKIP LOCKED`),
  );
  const fresh = rows.filter((row) => !row.rate_limited);
  const [clock] = rowsOf<{ at: Date | string }>(
    await tx.execute(sql`SELECT ${at} AS at`),
  );
  const now = dateOf(clock?.at ?? new Date()).getTime();
  const received = fresh.map((row) => dateOf(row.received_at).getTime());
  const freshDue =
    fresh.length > 0 &&
    (now - Math.max(...received) >= JUDGMENT_BATCH_QUIET_MS ||
      now - Math.min(...received) >= JUDGMENT_BATCH_MAX_WAIT_MS);
  const [window] = rowsOf<{ counted: number | string }>(
    await tx.execute(sql`
      SELECT (SELECT count(*) FROM judgment_batches b
        WHERE ${same} AND b.closed_at > ${at} - ${secs(M1_CHANNEL_WINDOW_MS)}
          AND ${countsAgainstM1Cap}) + ${engagedJudgmentsInWindow({
            agentId: sql`${channel.agent_id}::uuid`,
            teamId: sql`${channel.slack_team_id}`,
            channelId: sql`${channel.slack_channel_id}`,
            at,
          })} AS counted`),
  );
  const room = Number(window?.counted ?? 0) < M1_JUDGMENTS_PER_CHANNEL_WINDOW;
  // Messages past the cap go with the first batch the window has room for.
  const taken = room
    ? freshDue || fresh.length < rows.length
      ? rows
      : []
    : freshDue
      ? fresh
      : [];
  if (taken.length === 0) return null;
  const state = room ? "judging" : "rate_limited";
  const id = judgmentBatchIdSchema.parse(randomUUID());
  await tx.execute(sql`
    INSERT INTO judgment_batches (
      id, workspace_id, agent_id, conversation_id, slack_team_id,
      slack_channel_id, release_id, state, closed_at, ended_at
    ) VALUES (
      ${id}::uuid, ${channel.workspace_id}::uuid, ${channel.agent_id}::uuid,
      ${keys.conversation_id}::uuid, ${channel.slack_team_id},
      ${channel.slack_channel_id}, ${agent.release_id}, ${state}, ${at},
      ${state === "judging" ? null : at}
    )`);
  await tx.execute(sql`
    UPDATE conversation_inputs SET judgment_batch_id = ${id}::uuid
    WHERE id IN (${sql.join(
      taken.map((row) => sql`${row.id}::uuid`),
      sql`, `,
    )})`);
  if (state === "rate_limited") {
    await tx.execute(sql`
      INSERT INTO judgment_channel_tallies (
        workspace_id, agent_id, slack_team_id, slack_channel_id,
        rate_limited_count, updated_at
      ) VALUES (
        ${channel.workspace_id}::uuid, ${channel.agent_id}::uuid,
        ${channel.slack_team_id}, ${channel.slack_channel_id}, 1, ${at}
      )
      ON CONFLICT (agent_id, slack_team_id, slack_channel_id) DO UPDATE SET
        rate_limited_count = judgment_channel_tallies.rate_limited_count + 1,
        updated_at = EXCLUDED.updated_at`);
  }
  const inputs: JudgmentBatchInput[] = taken.map((row) => ({
    inputId: row.id as ConversationInputId,
    topicId: row.topic_id as ConversationTopicId,
    ts: row.slack_ts,
    slackUserId: row.requester_id,
    body: row.body,
    receivedAt: dateOf(row.received_at),
    editMark: row.edit_mark,
  }));
  return {
    outcome: state,
    batch: {
      id,
      workspaceId: channel.workspace_id,
      agentId: channel.agent_id,
      conversationId: keys.conversation_id as ConversationId,
      teamId: channel.slack_team_id,
      channelId: channel.slack_channel_id,
      releaseId: agent.release_id,
      inputs,
    },
  };
}

/**
 * Batches of the judgment buffer. Each channel is closed under a lock of its
 * own that a second caller skips, and a channel has one judging batch at a
 * time (a partial unique index), so however many replicas close at once one
 * judgment runs per channel. A close never waits on a message's row: one a
 * Slack edit, a delete or a removal holds is skipped and goes to a later
 * batch, if it is still there, with its new text. Waiting on none, a close
 * is in no deadlock with the removals, which lock rows in no set order.
 */
export function createPostgresJudgmentBatchStore(
  db: Database,
): JudgmentBatchStore {
  return {
    async closeNext(options = {}) {
      const at = atOf(options.now);
      const closed = await db.transaction(async (tx) => {
        await failOverdue(tx, at);
        // Cheap first look; each channel is judged again under its lock.
        const channels = rowsOf<Channel>(
          await tx.execute(sql`
            SELECT i.workspace_id, i.agent_id, i.slack_team_id,
              i.slack_channel_id
            FROM conversation_inputs i
            LEFT JOIN judgment_batches b ON b.id = i.judgment_batch_id
            WHERE ${takeable(at)}
              AND ${stillListened(rowColumns)}
              AND EXISTS (
                SELECT 1 FROM agents a
                WHERE a.id = i.agent_id AND a.active_release_id IS NOT NULL)
              AND NOT EXISTS (
                SELECT 1 FROM judgment_batches j
                WHERE j.agent_id = i.agent_id
                  AND j.slack_team_id = i.slack_team_id
                  AND j.slack_channel_id = i.slack_channel_id
                  AND j.state = 'judging')
            GROUP BY 1, 2, 3, 4
            HAVING (bool_or(i.judgment_batch_id IS NOT NULL) AND (
                SELECT count(*) FROM judgment_batches b
                WHERE b.agent_id = i.agent_id
                  AND b.slack_team_id = i.slack_team_id
                  AND b.slack_channel_id = i.slack_channel_id
                  AND b.closed_at > ${at} - ${secs(M1_CHANNEL_WINDOW_MS)}
                  AND ${countsAgainstM1Cap}) + ${engagedJudgmentsInWindow({
                    agentId: sql`i.agent_id`,
                    teamId: sql`i.slack_team_id`,
                    channelId: sql`i.slack_channel_id`,
                    at,
                  })} < ${M1_JUDGMENTS_PER_CHANNEL_WINDOW})
              -- New messages only: those past the cap make no batch of their own.
              OR max(i.received_at) FILTER (WHERE i.judgment_batch_id IS NULL)
                <= ${at} - ${secs(JUDGMENT_BATCH_QUIET_MS)}
              OR min(i.received_at) FILTER (WHERE i.judgment_batch_id IS NULL)
                <= ${at} - ${secs(JUDGMENT_BATCH_MAX_WAIT_MS)}
            ORDER BY min(i.received_at)
            LIMIT ${CLOSE_CANDIDATES}`),
        );
        for (const channel of channels) {
          const closed = await closeChannel(tx, channel, at);
          if (closed !== null) return closed;
        }
        return null;
      });
      if (closed?.outcome !== "judging") return closed;
      // Before the judgment reads its context (a1/J6).
      return {
        ...closed,
        batch: {
          ...closed.batch,
          readAt: await channelMarksSettledAt(db, closed.batch),
        },
      };
    },

    async finish(id: JudgmentBatchId, result, options = {}) {
      const at = atOf(options.now);
      return db.transaction(async (tx) => {
        const ended = rowsOf(
          await tx.execute(sql`
            UPDATE judgment_batches
            SET state = 'judged', model_called = ${result.modelCalled},
              ended_at = ${at}
            WHERE id = ${id}::uuid AND state = 'judging'
            RETURNING id`),
        );
        if (ended.length === 0) return "late";
        if (result.left.length > 0) {
          await tx.execute(sql`
            UPDATE conversation_inputs SET judgment_batch_id = NULL
            WHERE judgment_batch_id = ${id}::uuid
              AND id IN (${sql.join(
                result.left.map((input) => sql`${input}::uuid`),
                sql`, `,
              )})`);
        }
        return "finished";
      });
    },

    async fail(id: JudgmentBatchId, options = {}) {
      await db.execute(sql`
        UPDATE judgment_batches SET state = 'failed', ended_at = ${atOf(options.now)}
        WHERE id = ${id}::uuid AND state = 'judging'`);
    },
  };
}
