import { randomUUID } from "node:crypto";
import type {
  BufferedInputReceipt,
  ChannelConversationKey,
  JudgmentBufferPlace,
  JudgmentBufferStore,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
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
 * (`ready`, mode `on`, listening `free`) and not shared with another
 * organization, and its conversation is not archived or deleted. The receive path asks the same through the
 * handling table; this is its database side, for what changes afterwards.
 */
function stillListened(row: { agentId: SQL; channelId: SQL; topicId: SQL }) {
  return sql`(EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = ${row.agentId} AND a.status = 'active'
      AND a.conversation_rollout IN ('shadow', 'on'))
  AND EXISTS (
    SELECT 1 FROM surface_bindings b
    WHERE b.agent_id = ${row.agentId} AND b.surface = 'slack'
      AND b.external_surface_id = ${row.channelId}
      AND b.status = 'ready' AND b.mode = 'on' AND b.listen = 'free'
      AND NOT b.external_shared)
  AND NOT EXISTS (
    SELECT 1 FROM conversation_topics t
    JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = ${row.topicId} AND c.channel_state <> 'active'))`;
}

const rowColumns = {
  agentId: sql.raw("i.agent_id"),
  channelId: sql.raw("i.slack_channel_id"),
  topicId: sql.raw("i.topic_id"),
};

/**
 * Removes the buffered rows `where` picks (over alias `i`) whole, and the
 * topics they leave with no input. A topic another transaction holds is
 * left: it is taking an input. Returns how many rows went.
 */
async function dropBuffered(tx: Database, where: SQL): Promise<number> {
  const gone = rowsOf<{ topic_id: string }>(
    await tx.execute(sql`
      DELETE FROM conversation_inputs i
      WHERE i.buffer_expires_at IS NOT NULL AND ${where}
      RETURNING i.topic_id`),
  );
  if (gone.length === 0) return 0;
  // In one order, so two removals never wait on each other.
  const topics = [...new Set(gone.map((row) => row.topic_id))].sort();
  for (const topicId of topics) await dropTopicIfEmpty(tx, topicId);
  return gone.length;
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
      UPDATE conversation_inputs SET body = ${message.body}
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
  const held = rowsOf(
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
      })}
      ON CONFLICT (agent_id, slack_team_id, slack_channel_id, slack_ts)
        DO NOTHING
      RETURNING id`),
  );
  if (held.length > 0) {
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

/**
 * Removes buffered rows whose time is up (by `now`, the database clock when
 * unset) or whose channel the agent no longer listens to, up to `limit`,
 * with the topics they leave empty. Returns how many of each it removed; a
 * dry run counts them. The reconciler runs it every pass.
 */
export async function purgeJudgmentBuffer(
  db: Database,
  options: { limit: number; dryRun: boolean; now?: Date },
): Promise<{ expired: number; unlistened: number }> {
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
  if (options.dryRun) {
    const count = async (which: SQL) =>
      rowsOf(await db.execute(pick(which))).length;
    return {
      expired: await count(expiredRows),
      unlistened: await count(unlistenedRows),
    };
  }
  const purge = (which: SQL) =>
    db.transaction((tx) =>
      dropBuffered(
        tx,
        sql`i.id IN (${pick(which)} FOR UPDATE OF i SKIP LOCKED)`,
      ),
    );
  return {
    expired: await purge(expiredRows),
    unlistened: await purge(unlistenedRows),
  };
}

export function createPostgresJudgmentBufferStore(
  db: Database,
): JudgmentBufferStore {
  return {
    async place(key: ChannelConversationKey): Promise<JudgmentBufferPlace> {
      const [row] = rowsOf<{
        rollout: JudgmentBufferPlace["rollout"];
        status: string;
        channel_state: JudgmentBufferPlace["channelState"] | null;
      }>(
        await db.execute(sql`
          SELECT a.conversation_rollout AS rollout, a.status,
            (SELECT c.channel_state FROM conversations c
              WHERE c.agent_id = a.id AND c.kind = 'channel'
                AND c.team_id = ${key.teamId}
                AND c.channel_id = ${key.channelId}) AS channel_state
          FROM agents a
          WHERE a.id = ${key.agentId}::uuid
            AND a.workspace_id = ${key.workspaceId}::uuid`),
      );
      if (row === undefined) {
        return { rollout: "off", agentActive: false, channelState: "active" };
      }
      return {
        rollout: row.rollout,
        agentActive: row.status === "active",
        channelState: row.channel_state ?? "active",
      };
    },
  };
}
