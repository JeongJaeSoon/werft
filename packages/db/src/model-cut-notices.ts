import { randomUUID } from "node:crypto";
import { modelCutDedupeKey, modelCutNoticeText } from "@werft-ai/platform";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { administers } from "./administers.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  linkedAccounts,
  memberships,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  users,
} from "./schema.ts";

/**
 * Writes one `model_notice` row per person who should hear that a session's
 * model left the agent's allowed list, in the caller's transaction so the
 * error event and its notices commit together. Told: whoever created the
 * session and the agent's administrators (`administers`), each only if still
 * an enabled member with a Slack account linked in the team the agent's app
 * is installed in. A session without a workspace, creator or agent release
 * (rows from before them) tells only whom it can resolve.
 *
 * The key is per person and session, so a later attempt cut for the same
 * reason adds nothing for someone already told; a person who became an
 * administrator since is told at that cut.
 * The notice goes as a direct message: the person's Slack user id is the
 * channel and there is no thread.
 */
export async function enqueueModelCutNotices(
  tx: Database,
  input: { sessionId: string; model: string },
): Promise<number> {
  const [session] = await tx
    .select({
      workspaceId: sessions.workspaceId,
      createdByUserId: sessions.createdByUserId,
      agentId: agentReleases.agentId,
    })
    .from(sessions)
    .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session || session.workspaceId === null) return 0;
  const { workspaceId, agentId } = session;
  const recipients = await tx
    .select({
      slackUserId: linkedAccounts.externalUserId,
      locale: users.locale,
      slackAppId: slackApps.id,
      installationId: slackInstallations.id,
    })
    .from(linkedAccounts)
    .innerJoin(users, eq(users.id, linkedAccounts.userId))
    .innerJoin(
      memberships,
      and(
        eq(memberships.workspaceId, linkedAccounts.workspaceId),
        eq(memberships.userId, linkedAccounts.userId),
        isNull(memberships.disabledAt),
      ),
    )
    .innerJoin(
      slackInstallations,
      and(
        eq(slackInstallations.workspaceId, workspaceId),
        eq(slackInstallations.teamId, linkedAccounts.externalTenant),
        eq(slackInstallations.status, "verified"),
      ),
    )
    .innerJoin(
      slackApps,
      and(
        eq(slackApps.appId, slackInstallations.appId),
        eq(slackApps.workspaceId, workspaceId),
        eq(slackApps.kind, "agent"),
        eq(slackApps.agentId, agentId),
        eq(slackApps.state, "created"),
      ),
    )
    .where(
      and(
        eq(linkedAccounts.workspaceId, workspaceId),
        eq(linkedAccounts.provider, "slack"),
        ne(linkedAccounts.status, "revoked"),
        isNull(users.disabledAt),
        or(
          session.createdByUserId === null
            ? undefined
            : eq(linkedAccounts.userId, session.createdByUserId),
          administers(tx, workspaceId, linkedAccounts.userId, agentId),
        ),
      ),
    );
  let enqueued = 0;
  for (const person of recipients) {
    const [row] = await tx
      .insert(slackOutbox)
      .values({
        id: randomUUID(),
        workspaceId,
        agentId,
        slackAppId: person.slackAppId,
        installationId: person.installationId,
        kind: "model_notice",
        channelId: person.slackUserId,
        threadTs: "",
        slackUserId: null,
        sessionId: input.sessionId,
        body: {
          text: modelCutNoticeText(person.locale, input.model),
          ...(person.locale === null ? {} : { locale: person.locale }),
        },
        dedupeKey: modelCutDedupeKey(
          workspaceId,
          input.sessionId,
          person.slackUserId,
        ),
      })
      .onConflictDoNothing({ target: slackOutbox.dedupeKey })
      .returning({ id: slackOutbox.id });
    if (row) enqueued += 1;
  }
  return enqueued;
}
