import { and, asc, eq, sql } from "drizzle-orm";
import { sessionNoticeThread } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import { slackOutbox } from "../schema.ts";

export type ModelNoticesMovedOffPeople = {
  /** Rows still waiting that now go to their session's thread. */
  moved: number;
  /** Rows deleted, by the status they had. */
  deleted: Record<string, number>;
  /** Rows a send holds now: the next start looks at them again. */
  sending: number;
  failed: { rowId: string; error: unknown }[];
};

const toPerson = and(
  eq(slackOutbox.kind, "model_notice"),
  sql`${slackOutbox.channelId} ~ '^[UW]'`,
);

/**
 * The person a release before 94S-2040 wrote a model notice to is the end of
 * its dedupe key (`:<installation>:<Slack user>`, or `:<Slack user>` from
 * before installations were in it); what is left names the notice, and with
 * the thread's link it is the key a writer now gives it.
 */
function noticeOf(row: {
  dedupeKey: string;
  installationId: string;
  channelId: string;
}): string | null {
  for (const person of [
    `:${row.installationId}:${row.channelId}`,
    `:${row.channelId}`,
  ]) {
    if (row.dedupeKey.endsWith(person)) {
      return row.dedupeKey.slice(0, -person.length);
    }
  }
  return null;
}

/**
 * Takes model notices off people: a release before this one wrote each as a
 * direct message, one row per person told, with the person's Slack user id
 * as the channel (design v3 decision 45). A row still waiting whose session
 * has a thread (`sessionNoticeThread`) goes there, once per notice: the
 * first row of a notice is moved, its copies for other people are deleted.
 * Every other such row is deleted: sent and failed ones, and waiting ones
 * with no thread to go to, whose session's history on the web keeps the same
 * notice as an event. Each row in a transaction of its own; one being sent
 * is left for the next start. Run at each host start, it finds nothing once
 * done, but rows an earlier image beside this one writes.
 */
export async function moveModelNoticesOffPeople(
  db: Database,
): Promise<ModelNoticesMovedOffPeople> {
  const result: ModelNoticesMovedOffPeople = {
    moved: 0,
    deleted: {},
    sending: 0,
    failed: [],
  };
  const rows = await db
    .select({ id: slackOutbox.id, sessionId: slackOutbox.sessionId })
    .from(slackOutbox)
    .where(toPerson)
    .orderBy(asc(slackOutbox.seq));
  for (const { id, sessionId } of rows) {
    try {
      const outcome = await db.transaction(async (tx) => {
        // The link before the row: a writer locks them in that order.
        const link =
          sessionId === null
            ? undefined
            : await sessionNoticeThread(tx, sessionId);
        const [row] = await tx
          .select({
            status: slackOutbox.status,
            dedupeKey: slackOutbox.dedupeKey,
            installationId: slackOutbox.installationId,
            channelId: slackOutbox.channelId,
          })
          .from(slackOutbox)
          .where(and(eq(slackOutbox.id, id), toPerson))
          .for("update");
        if (!row) return null;
        if (row.status === "sending") return "sending" as const;
        const notice = noticeOf(row);
        if (row.status === "pending" && link !== undefined) {
          const dedupeKey =
            notice === null ? row.dedupeKey : `${notice}:${link.id}`;
          const [told] = await tx
            .select({ id: slackOutbox.id })
            .from(slackOutbox)
            .where(eq(slackOutbox.dedupeKey, dedupeKey))
            .limit(1);
          if (told === undefined || told.id === id) {
            await tx
              .update(slackOutbox)
              .set({
                slackAppId: link.slackAppId,
                installationId: link.installationId,
                channelId: link.channelId,
                threadTs: link.threadTs,
                sessionLinkId: link.id,
                dedupeKey,
              })
              .where(eq(slackOutbox.id, id));
            return "moved" as const;
          }
        }
        await tx.delete(slackOutbox).where(eq(slackOutbox.id, id));
        return { deleted: row.status };
      });
      if (outcome === "moved") result.moved += 1;
      else if (outcome === "sending") result.sending += 1;
      else if (outcome !== null) {
        result.deleted[outcome.deleted] =
          (result.deleted[outcome.deleted] ?? 0) + 1;
      }
    } catch (error) {
      result.failed.push({ rowId: id, error });
    }
  }
  return result;
}
