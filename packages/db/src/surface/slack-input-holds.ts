import type { ConversationInputId } from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import { linkInputAlias } from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * The thread a web input's mirror is in, once Slack has it: its topic's,
 * or, for a topic left unplaced (another topic took the thread first), the
 * one its own sent post opened or went into. Null while neither is known.
 */
export async function inputMirrorThread(
  tx: Database,
  inputId: ConversationInputId,
): Promise<{ channelId: string; threadTs: string } | null> {
  const [thread] = rowsOf<{ channel_id: string; thread_ts: string }>(
    await tx.execute(sql`
      SELECT x.channel_id, x.thread_ts FROM (
        SELECT 1 AS rank, tp.slack_channel_id AS channel_id,
          tp.slack_thread_ts AS thread_ts
        FROM conversation_inputs i
        JOIN conversation_topics tp ON tp.id = i.topic_id
        WHERE i.id = ${inputId}::uuid AND tp.slack_thread_ts IS NOT NULL
        UNION ALL
        (SELECT 2, so.channel_id,
          CASE WHEN so.thread_ts = '' THEN so.slack_ts ELSE so.thread_ts END
         FROM slack_outbox so
         WHERE so.input_id = ${inputId}::uuid AND so.status = 'sent'
         ORDER BY so.seq LIMIT 1)
      ) x ORDER BY x.rank LIMIT 1`),
  );
  return thread === undefined
    ? null
    : { channelId: thread.channel_id, threadTs: thread.thread_ts };
}

/** The rows held for the input's thread go there, now that it is known. */
async function releaseHeld(tx: Database, inputId: ConversationInputId) {
  const thread = await inputMirrorThread(tx, inputId);
  if (thread === null) return;
  await tx.execute(sql`
    UPDATE slack_outbox SET
      channel_id = ${thread.channelId},
      thread_ts = ${thread.threadTs},
      held_for_input_id = NULL
    WHERE held_for_input_id = ${inputId}::uuid AND status = 'pending'`);
}

/**
 * Closes the rows held for an input whose mirror failed for good, unless
 * another of its mirrors may still be in Slack or on its way.
 */
export async function closeHeldOfFailedMirror(
  tx: Database,
  inputId: ConversationInputId,
) {
  // Waits for an enqueue holding the input, so its row is closed too.
  await tx.execute(sql`
    SELECT 1 FROM conversation_inputs
    WHERE id = ${inputId}::uuid FOR UPDATE`);
  await tx.execute(sql`
    UPDATE slack_outbox SET status = 'failed', error_code = 'input_unplaced',
      claim_token = NULL, lease_expires_at = NULL
    WHERE held_for_input_id = ${inputId}::uuid AND status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM slack_outbox m
        WHERE m.input_id = ${inputId}::uuid
          AND m.status IN ('pending', 'sending', 'uncertain'))`);
}

/**
 * A mirror of the input was tried and none is in Slack or on its way: a
 * row enqueued for its thread after it failed closes at once.
 */
export async function mirrorFailed(
  tx: Database,
  inputId: ConversationInputId,
): Promise<boolean> {
  const [row] = rowsOf<{ failed: boolean }>(
    await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM slack_outbox WHERE input_id = ${inputId}::uuid
      ) AND NOT EXISTS (
        SELECT 1 FROM slack_outbox
        WHERE input_id = ${inputId}::uuid
          AND status IN ('pending', 'sending', 'uncertain', 'sent')
      ) AS failed`),
  );
  return row?.failed === true;
}

/** Slack may or may not hold the input's post: a person may send it again. */
export async function markMirrorUnconfirmed(
  tx: Database,
  inputIds: readonly ConversationInputId[],
) {
  if (inputIds.length === 0) return;
  const ids = `{${[...new Set(inputIds)].join(",")}}`;
  // In id order, as every path that takes several inputs does.
  await tx.execute(sql`
    SELECT 1 FROM conversation_inputs
    WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`);
  await tx.execute(sql`
    UPDATE conversation_inputs SET slack_mirror = 'unconfirmed'
    WHERE id = ANY(${ids}::uuid[])
      AND slack_mirror = 'pending' AND slack_ts IS NULL`);
}

/**
 * In the transaction that records a mirror's post: the input takes it as
 * its alias (and its topic, when the post opened the thread), it is no
 * longer unconfirmed, and the rows held for its thread go.
 */
export async function mirrorPosted(
  tx: Database,
  row: {
    workspaceId: string;
    inputId: ConversationInputId;
    installationId: string;
    channelId: string;
    threadTs: string;
  },
  ts: string,
): Promise<"linked" | "already_linked" | "topic_alias_taken"> {
  const linked = await linkInputAlias(tx, { ...row, ts });
  await tx.execute(sql`
    UPDATE conversation_inputs SET slack_mirror = 'pending'
    WHERE id = ${row.inputId}::uuid AND slack_mirror = 'unconfirmed'`);
  await releaseHeld(tx, row.inputId);
  return linked;
}
