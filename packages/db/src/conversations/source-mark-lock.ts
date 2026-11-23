import { type SQL, sql } from "drizzle-orm";

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
