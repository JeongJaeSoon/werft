import { randomUUID } from "node:crypto";
import type { ConversationInputId } from "@werft-ai/contracts";
import type {
  BufferedInputReceipt,
  ChannelConversationKey,
  JudgmentBufferPlace,
  JudgmentBufferStore,
} from "@werft-ai/platform";
import {
  ENGAGED_THREAD_WINDOW_MS,
  M1_CHANNEL_WINDOW_MS,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import { ownerlessPastGrace } from "../agents.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import {
  heldForReply,
  requestReplyJudgment,
} from "./conversation-judgments.ts";
import { lockSlackSourceMark } from "./source-mark-lock.ts";

/** How long an unmentioned message stays in the judgment buffer (decision 24). */
export const JUDGMENT_BUFFER_TTL_MS = 10 * 60_000;

/** One Slack channel in one workspace, with what else names the row. */
type SlackChannelOf<T> = T & {
  workspaceId: string;
  teamId: string;
  channelId: string;
};

/** One Slack message in one workspace. */
type SlackMessage = SlackChannelOf<{ ts: string }>;

/**
 * Whether the agent still holds unmentioned messages of the channel: it is
 * active with its switch `shadow` or `on`, the channel is bound in use
 * (`ready`, mode `on`, listening `free`, or `mention` for a reply held for
 * its own judgment, `heldForReply`) and not shared with another
 * organization, and its conversation is not archived or deleted. The receive path asks the same through the
 * handling table; this is its database side, for what changes afterwards.
 */
export function stillListened(row: {
  agentId: SQL;
  channelId: SQL;
  topicId: SQL;
  heldForReply?: SQL;
}) {
  const listens =
    row.heldForReply === undefined
      ? sql`b.listen = 'free'`
      : sql`(b.listen = 'free' OR (b.listen = 'mention' AND ${row.heldForReply}))`;
  return sql`(EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = ${row.agentId} AND a.status = 'active'
      AND a.conversation_rollout IN ('shadow', 'on'))
  AND EXISTS (
    SELECT 1 FROM surface_bindings b
    WHERE b.agent_id = ${row.agentId} AND b.surface = 'slack'
      AND b.external_surface_id = ${row.channelId}
      AND b.status = 'ready' AND b.mode = 'on' AND ${listens}
      AND NOT b.external_shared)
  AND NOT EXISTS (
    SELECT 1 FROM conversation_topics t
    JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = ${row.topicId} AND c.channel_state <> 'active'))`;
}

export const rowColumns = {
  agentId: sql.raw("i.agent_id"),
  channelId: sql.raw("i.slack_channel_id"),
  topicId: sql.raw("i.topic_id"),
  heldForReply,
};

/**
 * Removes the buffered rows `where` picks (over alias `i`) whole, and the
 * topics they leave with no input. A topic another transaction holds is
 * left: it is taking an input. Returns how many rows went.
 */
async function dropBuffered(tx: Database, where: SQL): Promise<number> {
  return (await dropBufferedRows(tx, where)).length;
}

type DroppedRow = SlackChannelOf<{
  topic_id: string;
  agentId: string;
  judged: boolean;
}>;

async function dropBufferedRows(
  tx: Database,
  where: SQL,
): Promise<DroppedRow[]> {
  const gone = rowsOf<DroppedRow>(
    await tx.execute(sql`
      DELETE FROM conversation_inputs i
      WHERE i.buffer_expires_at IS NOT NULL AND ${where}
      RETURNING i.topic_id, i.workspace_id AS "workspaceId",
        i.agent_id AS "agentId", i.slack_team_id AS "teamId",
        i.slack_channel_id AS "channelId",
        EXISTS (
          SELECT 1 FROM judgment_batches b
          WHERE b.id = i.judgment_batch_id AND b.state = 'judged'
            AND b.model_called) AS judged`),
  );
  if (gone.length === 0) return gone;
  // In one order, so two removals never wait on each other.
  const topics = [...new Set(gone.map((row) => row.topic_id))].sort();
  for (const topicId of topics) await dropTopicIfEmpty(tx, topicId);
  return gone;
}

/** Adds the expired messages no judgment read to their channels' tallies. */
async function tallyUnjudged(tx: Database, gone: readonly DroppedRow[]) {
  const byChannel = new Map<string, DroppedRow & { count: number }>();
  for (const row of gone) {
    if (row.judged) continue;
    const key = `${row.agentId}:${row.teamId}:${row.channelId}`;
    const seen = byChannel.get(key);
    if (seen) seen.count += 1;
    else byChannel.set(key, { ...row, count: 1 });
  }
  // In one order, so two passes never wait on each other.
  for (const [, row] of [...byChannel].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await tx.execute(sql`
      INSERT INTO judgment_channel_tallies (
        workspace_id, agent_id, slack_team_id, slack_channel_id,
        unjudged_count, updated_at
      ) VALUES (
        ${row.workspaceId}::uuid, ${row.agentId}::uuid, ${row.teamId},
        ${row.channelId}, ${row.count}, now()
      )
      ON CONFLICT (agent_id, slack_team_id, slack_channel_id) DO UPDATE SET
        unjudged_count = judgment_channel_tallies.unjudged_count + EXCLUDED.unjudged_count,
        updated_at = EXCLUDED.updated_at`);
  }
  return [...byChannel.values()].reduce((sum, row) => sum + row.count, 0);
}

/**
 * Removes a topic that has no input and no conversation turn left. Two transactions emptying one
 * topic take its lock in turn, so the later one judges it after the earlier
 * one's rows are gone. A topic another transaction holds is left: it is
 * taking an input, or will judge the topic itself.
 */
async function dropTopicIfEmpty(tx: Database, topicId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('conversation_topic_drop'), hashtext(${topicId}::text))`,
  );
  await tx.execute(sql`
    DELETE FROM conversation_topics
    WHERE id IN (
      SELECT t.id FROM conversation_topics t
      WHERE t.id = ${topicId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM conversation_inputs o WHERE o.topic_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turns ct WHERE ct.topic_id = t.id)
      FOR UPDATE SKIP LOCKED)`);
}

/**
 * Removes the buffered rows of an agent, or of one of its channels, that it
 * no longer listens to: called in the transaction that archived the agent,
 * left or lost the channel, or turned its listening off.
 */
export function dropUnlistenedBuffer(
  tx: Database,
  scope: { agentId: string; channelId?: string },
): Promise<number> {
  return dropBuffered(
    tx,
    sql`i.agent_id = ${scope.agentId}::uuid${
      scope.channelId === undefined
        ? sql``
        : sql` AND i.slack_channel_id = ${scope.channelId}`
    } AND NOT ${stillListened(rowColumns)}`,
  );
}

/** Removes the buffered rows named, with the topics they leave empty. */
export function dropBufferedInputs(
  tx: Database,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return Promise.resolve(0);
  return dropBuffered(
    tx,
    sql`i.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
}

/** Removes every agent's buffered row of a message Slack deleted. */
export function dropBufferedMessage(
  tx: Database,
  message: SlackMessage,
): Promise<number> {
  return dropBuffered(
    tx,
    sql`i.workspace_id = ${message.workspaceId}::uuid
      AND i.slack_team_id = ${message.teamId}
      AND i.slack_channel_id = ${message.channelId}
      AND i.slack_ts = ${message.ts}`,
  );
}

/**
 * Gives every agent's buffered row of an edited message its new text. The
 * caller holds the message's mark lock and has just written the edit mark;
 * an edit older than the one already marked changes nothing.
 */
export async function editBufferedMessage(
  tx: Database,
  message: SlackMessage & { at: Date; body: string },
): Promise<number> {
  const rows = rowsOf(
    await tx.execute(sql`
      UPDATE conversation_inputs
      SET body = ${message.body},
        body_edited_at = ${message.at.toISOString()}::timestamptz
      WHERE buffer_expires_at IS NOT NULL
        AND workspace_id = ${message.workspaceId}::uuid
        AND slack_team_id = ${message.teamId}
        AND slack_channel_id = ${message.channelId}
        AND slack_ts = ${message.ts}
        AND EXISTS (
          SELECT 1 FROM edited_sources m
          WHERE (m.workspace_id, m.team_id, m.channel_id, m.ts) =
            (${message.workspaceId}::uuid, ${message.teamId}, ${message.channelId}, ${message.ts})
            AND m.edited_at = ${message.at.toISOString()}::timestamptz)
      RETURNING id`),
  );
  return rows.length;
}

/**
 * Keeps the agent's `limit` newest held messages of the channel (by Slack
 * ts) and removes the rest whole, adding how many went to the channel's
 * overflow count. Holds of one agent and channel take this in turn, so
 * however many commit at once the channel never keeps more than `limit`.
 */
async function keepChannelLimit(
  tx: Database,
  channel: SlackChannelOf<{ agentId: string }>,
  limit: number,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('judgment_buffer_limit'), hashtext(${`${channel.agentId}:${channel.teamId}:${channel.channelId}`}::text))`,
  );
  const dropped = await dropBuffered(
    tx,
    sql`i.id IN (
      SELECT o.id FROM conversation_inputs o
      WHERE o.buffer_expires_at IS NOT NULL
        AND o.agent_id = ${channel.agentId}::uuid
        AND o.slack_team_id = ${channel.teamId}
        AND o.slack_channel_id = ${channel.channelId}
      ORDER BY o.slack_ts::numeric DESC, o.id DESC
      OFFSET ${limit})`,
  );
  if (dropped === 0) return 0;
  await tx.execute(sql`
    INSERT INTO judgment_buffer_overflows (
      workspace_id, agent_id, slack_team_id, slack_channel_id,
      dropped_count, last_dropped_at
    ) VALUES (
      ${channel.workspaceId}::uuid, ${channel.agentId}::uuid,
      ${channel.teamId}, ${channel.channelId}, ${dropped}, now()
    )
    ON CONFLICT (agent_id, slack_team_id, slack_channel_id) DO UPDATE SET
      dropped_count = judgment_buffer_overflows.dropped_count + EXCLUDED.dropped_count,
      last_dropped_at = EXCLUDED.last_dropped_at`);
  return dropped;
}

/** What a hold did, and how many older messages the channel's limit took. */
export type HoldOutcome = {
  outcome: "held" | "marked" | "not_held";
  dropped: number;
};

/**
 * Holds a message in the buffer, in the transaction that completes its inbox
 * row, then keeps the channel within `limit`. Nothing is held when the
 * message has a delete or an edit mark already (its event came late; an
 * edit's text is kept nowhere), when the agent already has the message, or
 * when the channel stopped listening since the receive path judged it.
 */
export async function holdBufferedInput(
  tx: Database,
  row: { workspaceId: string; agentId: string; teamId: string },
  input: BufferedInputReceipt,
  limit: number,
): Promise<HoldOutcome> {
  const message = {
    workspaceId: row.workspaceId,
    teamId: row.teamId,
    channelId: input.channelId,
    ts: input.ts,
  };
  await tx.execute(lockSlackSourceMark(message));
  const key = sql`(${row.workspaceId}::uuid, ${row.teamId}, ${input.channelId}, ${input.ts})`;
  const [marked] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM deleted_sources
      WHERE (workspace_id, team_id, channel_id, ts) = ${key}
      UNION ALL
      SELECT 1 FROM edited_sources
      WHERE (workspace_id, team_id, channel_id, ts) = ${key}
      LIMIT 1`),
  );
  // The topic was found or made for this message; one left with no input
  // goes with it.
  const dropEmptyTopic = () => dropTopicIfEmpty(tx, input.topicId);
  if (marked !== undefined) {
    await dropEmptyTopic();
    return { outcome: "marked", dropped: 0 };
  }
  // What stops the listening updates one of these rows: shared, they make
  // that change wait for this hold, or this hold see it once committed, so
  // its removal of the channel's buffer never misses the row held here.
  await tx.execute(sql`
    SELECT 1 FROM agents WHERE id = ${row.agentId}::uuid FOR SHARE`);
  await tx.execute(sql`
    SELECT 1 FROM surface_bindings
    WHERE agent_id = ${row.agentId}::uuid AND surface = 'slack'
      AND external_surface_id = ${input.channelId}
    ORDER BY id FOR SHARE`);
  await tx.execute(sql`
    SELECT 1 FROM conversations c
    JOIN conversation_topics t ON t.conversation_id = c.id
    WHERE t.id = ${input.topicId}::uuid FOR SHARE OF c`);
  const [heldRow] = rowsOf<{ id: ConversationInputId }>(
    await tx.execute(sql`
      INSERT INTO conversation_inputs (
        id, workspace_id, agent_id, topic_id, seq,
        slack_team_id, slack_channel_id, slack_ts,
        requester_kind, requester_id, body, buffer_expires_at
      )
      SELECT ${randomUUID()}::uuid, ${row.workspaceId}::uuid,
        ${row.agentId}::uuid, ${input.topicId}::uuid,
        COALESCE(MAX(i.seq), 0) + 1,
        ${row.teamId}, ${input.channelId}, ${input.ts},
        'slack_user', ${input.buffered.slackUserId}, ${input.buffered.body},
        now() + make_interval(secs => ${JUDGMENT_BUFFER_TTL_MS / 1000})
      FROM conversation_inputs i WHERE i.topic_id = ${input.topicId}::uuid
      HAVING ${stillListened({
        agentId: sql`${row.agentId}::uuid`,
        channelId: sql`${input.channelId}`,
        topicId: sql`${input.topicId}::uuid`,
        ...(input.judgment === undefined ? {} : { heldForReply: sql`true` }),
      })}
      ON CONFLICT (agent_id, slack_team_id, slack_channel_id, slack_ts)
        DO NOTHING
      RETURNING id`),
  );
  if (heldRow !== undefined) {
    if (input.judgment !== undefined) {
      await requestReplyJudgment(tx, {
        ...message,
        agentId: row.agentId,
        topicId: input.topicId,
        inputId: heldRow.id,
        sessionId: null,
        rule: { decision: "none", reason: "stray_reply" },
      });
    }
    const dropped = await keepChannelLimit(
      tx,
      { ...message, agentId: row.agentId },
      limit,
    );
    return { outcome: "held", dropped };
  }
  await dropEmptyTopic();
  return { outcome: "not_held", dropped: 0 };
}

/** What one purge of the judgment buffer removed. */
export type JudgmentBufferPurge = {
  expired: number;
  /** Of `expired`, the messages no judgment that called the model read. */
  unjudged: number;
  unlistened: number;
  /** Ended judgment batches past M1's cap window. */
  batches: number;
};

/**
 * Removes buffered rows whose time is up (by `now`, the database clock when
 * unset) or whose channel the agent no longer listens to, up to `limit`,
 * with the topics they leave empty, adding the expired ones no judgment
 * read to their channels' tallies; then ended judgment batches past M1's
 * window, which no buffered row outlives. Returns how many of each it
 * removed; a dry run counts them. The reconciler runs it every pass.
 */
export async function purgeJudgmentBuffer(
  db: Database,
  options: { limit: number; dryRun: boolean; now?: Date },
): Promise<JudgmentBufferPurge> {
  const now =
    options.now === undefined
      ? sql`now()`
      : sql`${options.now.toISOString()}::timestamptz`;
  const pick = (which: SQL) => sql`
    SELECT i.id FROM conversation_inputs i
    WHERE i.buffer_expires_at IS NOT NULL AND ${which}
    ORDER BY i.buffer_expires_at
    LIMIT ${options.limit}`;
  const expiredRows = sql`i.buffer_expires_at <= ${now}`;
  const unlistenedRows = sql`i.buffer_expires_at > ${now} AND NOT ${stillListened(rowColumns)}`;
  // A batch a buffered message still points at stays, so the message keeps
  // whether it was judged until it goes.
  const endedBatches = sql`
    SELECT b.id FROM judgment_batches b
    WHERE b.state <> 'judging'
      AND NOT EXISTS (
        SELECT 1 FROM conversation_inputs i WHERE i.judgment_batch_id = b.id)
      AND b.closed_at <= ${now} - make_interval(secs => ${M1_CHANNEL_WINDOW_MS / 1000})
    ORDER BY b.closed_at
    LIMIT ${options.limit}`;
  if (options.dryRun) {
    const count = async (which: SQL) =>
      rowsOf(await db.execute(pick(which))).length;
    const [unjudged] = rowsOf<{ count: number | string }>(
      await db.execute(sql`
        SELECT count(*) AS count FROM conversation_inputs i
        WHERE i.id IN (${pick(expiredRows)})
          AND NOT EXISTS (
            SELECT 1 FROM judgment_batches b
            WHERE b.id = i.judgment_batch_id AND b.state = 'judged'
              AND b.model_called)`),
    );
    return {
      expired: await count(expiredRows),
      unjudged: Number(unjudged?.count ?? 0),
      unlistened: await count(unlistenedRows),
      batches: rowsOf(await db.execute(endedBatches)).length,
    };
  }
  const locked = (which: SQL) =>
    sql`i.id IN (${pick(which)} FOR UPDATE OF i SKIP LOCKED)`;
  const expired = await db.transaction(async (tx) => {
    // The agents the tallies' keys point at, key-share locked before any
    // row goes, so their insert waits on nothing; an agent an archive holds
    // is skipped, and the archive removes its rows itself.
    const agents = rowsOf<{ id: string }>(
      await tx.execute(sql`
        SELECT a.id FROM agents a
        WHERE a.id IN (SELECT i.agent_id FROM (${pick(expiredRows)}) p
          JOIN conversation_inputs i ON i.id = p.id)
        ORDER BY a.id
        FOR KEY SHARE SKIP LOCKED`),
    );
    if (agents.length === 0) return { expired: 0, unjudged: 0 };
    const gone = await dropBufferedRows(
      tx,
      locked(
        sql`${expiredRows} AND i.agent_id IN (${sql.join(
          agents.map((agent) => sql`${agent.id}::uuid`),
          sql`, `,
        )})`,
      ),
    );
    return { expired: gone.length, unjudged: await tallyUnjudged(tx, gone) };
  });
  const unlistened = await db.transaction((tx) =>
    dropBuffered(tx, locked(unlistenedRows)),
  );
  const batches = rowsOf(
    await db.execute(sql`
      DELETE FROM judgment_batches
      WHERE id IN (${endedBatches} FOR UPDATE OF b SKIP LOCKED)
      RETURNING id`),
  ).length;
  return { ...expired, unlistened, batches };
}

export function createPostgresJudgmentBufferStore(
  db: Database,
): JudgmentBufferStore {
  return {
    async place(key: ChannelConversationKey): Promise<JudgmentBufferPlace> {
      const [row] = rowsOf<{
        rollout: JudgmentBufferPlace["rollout"];
        status: string;
        ownerless: boolean;
        channel_state: JudgmentBufferPlace["channelState"] | null;
      }>(
        await db.execute(sql`
          SELECT a.conversation_rollout AS rollout, a.status,
            ${ownerlessPastGrace(db, {
              id: sql.raw("a.id"),
              workspaceId: sql.raw("a.workspace_id"),
              ownerlessSince: sql.raw("a.ownerless_since"),
            })} AS ownerless,
            (SELECT c.channel_state FROM conversations c
              WHERE c.agent_id = a.id AND c.kind = 'channel'
                AND c.team_id = ${key.teamId}
                AND c.channel_id = ${key.channelId}) AS channel_state
          FROM agents a
          WHERE a.id = ${key.agentId}::uuid
            AND a.workspace_id = ${key.workspaceId}::uuid`),
      );
      if (row === undefined) {
        return {
          rollout: "off",
          agentActive: false,
          agentOwnerless: false,
          channelState: "active",
        };
      }
      return {
        rollout: row.rollout,
        agentActive: row.status === "active",
        agentOwnerless: row.ownerless,
        channelState: row.channel_state ?? "active",
      };
    },

    async engagedThread(key) {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM conversation_engagements e
          WHERE e.agent_id = ${key.agentId}::uuid
            AND e.workspace_id = ${key.workspaceId}::uuid
            AND e.team_id = ${key.teamId} AND e.channel_id = ${key.channelId}
            AND e.created_at > now() - make_interval(secs => ${ENGAGED_THREAD_WINDOW_MS / 1000})
            AND (e.ts = ${key.threadTs} OR EXISTS (
              SELECT 1 FROM conversation_inputs i
              JOIN conversation_topics t ON t.id = i.topic_id
              WHERE i.agent_id = e.agent_id AND i.slack_team_id = e.team_id
                AND i.slack_channel_id = e.channel_id AND i.slack_ts = e.ts
                AND t.slack_thread_ts = ${key.threadTs}))
          LIMIT 1`),
      );
      return rows.length > 0;
    },
  };
}
