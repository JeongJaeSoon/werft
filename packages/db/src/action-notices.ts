import { randomUUID } from "node:crypto";
import type { UserLocale } from "@werft-ai/contracts";
import {
  type ActionNotice,
  actionNoticeDedupeKey,
  actionNoticeText,
  intentNoticeDedupeKey,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  pushIntents,
  sessionLinks,
  slackApps,
  slackInstallations,
  slackOutbox,
} from "./schema.ts";

/**
 * Writes the `action_notice` row of a push or pull request result in the
 * caller's transaction, so the state change and its notice commit together
 * or not at all. The thread is the session's primary live Slack link; a
 * session with none (started from the web or the API) gets no row. The
 * dedupe key `action:<push request id>:<result>` makes a repeat a no-op.
 *
 * The language is the one of whoever started the session, the thread's own
 * rule. The text is built from platform-made values only (see
 * `ActionNotice`), so nothing an agent or a forge wrote is stored.
 */
export async function enqueueActionNotice(
  tx: Database,
  input: { sessionId: string; pushRequestId: string; notice: ActionNotice },
): Promise<"enqueued" | "duplicate" | "no_thread"> {
  return enqueueNotice(tx, {
    sessionId: input.sessionId,
    notice: input.notice,
    dedupeKey: actionNoticeDedupeKey(input.pushRequestId, input.notice.result),
  });
}

/**
 * Tells the thread about each push intent that ended (`failed` or
 * `cancelled`) before it became a push request, in the caller's transaction.
 * Every writer that ends an intent calls this with the ids it ended; ids
 * that are not ended, or already told, write nothing.
 */
export async function enqueueEndedIntentNotices(
  tx: Database,
  intentIds: readonly string[],
): Promise<void> {
  if (intentIds.length === 0) return;
  const ended = await tx
    .select({
      id: pushIntents.id,
      sessionId: pushIntents.sessionId,
      repositoryId: pushIntents.repositoryId,
      targetBranch: pushIntents.targetBranch,
      refusalCode: pushIntents.refusalCode,
    })
    .from(pushIntents)
    .where(
      and(
        inArray(pushIntents.id, [...intentIds]),
        inArray(pushIntents.status, ["failed", "cancelled"]),
      ),
    );
  for (const intent of ended) {
    await enqueueNotice(tx, {
      sessionId: intent.sessionId,
      notice: {
        result: "push_cancelled",
        repository: intent.repositoryId,
        branch: intent.targetBranch,
        ...(intent.refusalCode === null ? {} : { reason: intent.refusalCode }),
      },
      dedupeKey: intentNoticeDedupeKey(intent.id),
    });
  }
}

async function enqueueNotice(
  tx: Database,
  input: { sessionId: string; notice: ActionNotice; dedupeKey: string },
): Promise<"enqueued" | "duplicate" | "no_thread"> {
  const [link] = await tx
    .select({
      workspaceId: sessionLinks.workspaceId,
      agentId: sessionLinks.agentId,
      slackAppId: slackApps.id,
      installationId: sessionLinks.installationId,
      channelId: sessionLinks.channelId,
      threadTs: sessionLinks.threadId,
      locale: sql<UserLocale | null>`(
        SELECT su.locale FROM users su
        WHERE su.id = coalesce(
          (SELECT st.actor_id FROM turns st
           WHERE st.session_id = ${sessionLinks.sessionId} AND st.sequence = 1),
          ${sessionLinks.createdBy}
        )
      )`,
    })
    .from(sessionLinks)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, sessionLinks.installationId),
    )
    .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
    .where(
      and(
        eq(sessionLinks.sessionId, input.sessionId),
        eq(sessionLinks.role, "primary"),
        isNull(sessionLinks.revokedAt),
        eq(sessionLinks.muted, false),
        eq(sessionLinks.visibility, "full"),
        ne(slackInstallations.status, "revoked"),
      ),
    )
    .orderBy(asc(sessionLinks.createdAt))
    .limit(1);
  if (!link) return "no_thread";
  const [row] = await tx
    .insert(slackOutbox)
    .values({
      id: randomUUID(),
      workspaceId: link.workspaceId,
      agentId: link.agentId,
      slackAppId: link.slackAppId,
      installationId: link.installationId,
      kind: "action_notice",
      channelId: link.channelId,
      threadTs: link.threadTs,
      slackUserId: null,
      sessionId: input.sessionId,
      body: {
        text: actionNoticeText(link.locale, input.notice),
        ...(input.notice.url === undefined
          ? {}
          : { link_url: input.notice.url }),
        ...(link.locale === null ? {} : { locale: link.locale }),
      },
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: slackOutbox.dedupeKey })
    .returning({ id: slackOutbox.id });
  return row ? "enqueued" : "duplicate";
}
