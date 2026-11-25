import { type SQL, sql } from "drizzle-orm";

/**
 * Holds one channel's delete and edit marks against a write that cannot name
 * every message it read (its sources overflowed): a mark takes it shared
 * before its mark lock, that write exclusive before its marks, so a mark it
 * does not name is either seen or comes after the write.
 */
export function lockSlackChannelMarks(
  channel: { workspaceId: string; teamId: string; channelId: string },
  mode: "shared" | "exclusive",
): SQL {
  const key = sql`hashtext('slack_channel_marks'), hashtext(concat_ws('|', ${channel.workspaceId}::text, ${channel.teamId}::text, ${channel.channelId}::text))`;
  return mode === "shared"
    ? sql`SELECT pg_advisory_xact_lock_shared(${key})`
    : sql`SELECT pg_advisory_xact_lock(${key})`;
}

/**
 * Holds one message's delete and edit marks until the transaction ends. A
 * mark takes it, and so does a write of anything naming the message: an edit
 * that cannot see a delete not committed yet would otherwise leave its mark
 * beside it, and a summary line could be written beside a mark.
 */
export function lockSlackSourceMark(message: {
  workspaceId: string;
  teamId: string;
  channelId: string;
  ts: string;
}): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext('slack_source_marks'), hashtext(concat_ws('|', ${message.workspaceId}::text, ${message.teamId}::text, ${message.channelId}::text, ${message.ts}::text)))`;
}
