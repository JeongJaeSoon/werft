import type { ConversationInputId } from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import { findPgError } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { lockSlackSourceMark } from "./source-mark-lock.ts";

/**
 * Gives a web input the Slack post that mirrored it as its alias, and its
 * topic too when the post opened the thread (`threadTs` "") and the topic
 * had none. Called in the transaction that records the post. An input with
 * an alias already keeps it.
 *
 * The input row is written before the message's mark lock is taken: a
 * delete check holds the row for share before it takes the marks. A delete
 * or edit mark Slack sent ahead of this (one of a message nothing named,
 * kept a while) then names a known message, which every later check finds.
 *
 * `topic_alias_taken`: a reply in the new thread was taken first and made a
 * topic of its own there; the two are not merged and this topic stays
 * unplaced.
 */
export async function linkInputAlias(
  tx: Database,
  input: {
    workspaceId: string;
    inputId: ConversationInputId;
    installationId: string;
    channelId: string;
    threadTs: string;
    ts: string;
  },
): Promise<"linked" | "already_linked" | "topic_alias_taken"> {
  const [installation] = rowsOf<{ team_id: string }>(
    await tx.execute(sql`
      SELECT team_id FROM slack_installations
      WHERE id = ${input.installationId}::uuid`),
  );
  if (installation === undefined) {
    throw new Error(`installation ${input.installationId} is missing`);
  }
  const place = {
    teamId: installation.team_id,
    channelId: input.channelId,
    ts: input.ts,
  };
  const [linked] = rowsOf<{ topic_id: string; agent_id: string }>(
    await tx.execute(sql`
      UPDATE conversation_inputs SET
        slack_team_id = ${place.teamId},
        slack_channel_id = ${place.channelId},
        slack_ts = ${place.ts}
      WHERE id = ${input.inputId}::uuid
        AND workspace_id = ${input.workspaceId}::uuid
        AND slack_ts IS NULL
      RETURNING topic_id, agent_id`),
  );
  if (linked === undefined) return "already_linked";
  await tx.execute(
    lockSlackSourceMark({ workspaceId: input.workspaceId, ...place }),
  );
  if (input.threadTs !== "") return "linked";
  const placeTopic = sql`
    UPDATE conversation_topics SET
      slack_team_id = ${place.teamId},
      slack_channel_id = ${place.channelId},
      slack_thread_ts = ${place.ts}
    WHERE id = ${linked.topic_id}::uuid AND slack_thread_ts IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM conversation_topics o
        WHERE o.agent_id = ${linked.agent_id}::uuid
          AND o.slack_team_id = ${place.teamId}
          AND o.slack_channel_id = ${place.channelId}
          AND o.slack_thread_ts = ${place.ts})
    RETURNING id`;
  try {
    // A savepoint: a reply's topic committed after the NOT EXISTS read
    // fails the update on the unique key, and the input's alias stays.
    const placed = await tx.transaction(async (sp) =>
      rowsOf(await sp.execute(placeTopic)),
    );
    if (placed.length > 0) return "linked";
  } catch (error) {
    if (!findPgError(error, "23505")) throw error;
    return "topic_alias_taken";
  }
  // Placed already, or another topic holds the thread.
  const [own] = rowsOf<{ slack_thread_ts: string | null }>(
    await tx.execute(sql`
      SELECT slack_thread_ts FROM conversation_topics
      WHERE id = ${linked.topic_id}::uuid`),
  );
  return own?.slack_thread_ts == null ? "topic_alias_taken" : "linked";
}
