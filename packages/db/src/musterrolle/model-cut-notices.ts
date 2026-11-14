import { randomUUID } from "node:crypto";
import {
  MODEL_NOT_ALLOWED_EVENT_CODE,
  type ModelCutCause,
} from "@werft-ai/contracts";
import {
  modelCutDedupeKey,
  modelCutEventMessage,
  modelCutNoticeText,
  sessionModelMoveDedupeKey,
  sessionModelMoveNoticeText,
} from "@werft-ai/platform";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  agents,
  linkedAccounts,
  memberships,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  users,
} from "../schema.ts";
import { recordEvent } from "../sessions/session-events.ts";
import { administers } from "./administers.ts";

/**
 * The stream's `MODEL_NOT_ALLOWED` error event and the DMs that go with it,
 * for the caller's transaction, which already holds the session's lock. The
 * attempt is null when no attempt ran yet: a claim that gives the session up.
 */
export async function writeModelCut(
  tx: Database,
  input: {
    sessionId: string;
    attemptId: string | null;
    model: string;
    cause: ModelCutCause;
  },
): Promise<void> {
  await recordEvent(tx, {
    sessionId: input.sessionId,
    type: "error",
    payload: {
      code: MODEL_NOT_ALLOWED_EVENT_CODE,
      message: modelCutEventMessage(input.model, input.cause),
      model: input.model,
      cause: input.cause,
    },
    turnRowId: null,
    ...(input.attemptId === null ? {} : { attemptId: input.attemptId }),
    now: await dbNow(tx),
  });
  await enqueueModelCutNotices(tx, input);
}

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
  input: { sessionId: string; model: string; cause?: ModelCutCause },
): Promise<number> {
  const session = await noticedSession(tx, input.sessionId);
  if (session === null) return 0;
  const { workspaceId, agentId } = session;
  const recipients = await slackRecipientsOf(tx, {
    workspaceId,
    agentId,
    userId: session.createdByUserId,
  });
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
          text: modelCutNoticeText(person.locale, input.model, input.cause),
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

/**
 * Writes one `model_notice` row telling whoever created the session that its
 * model moved to the next model of its series, in the move's transaction.
 * The agent's administrators are told of the agent's own move instead
 * (`enqueueModelMoveNotices`), so they are not told again per session.
 */
export async function enqueueSessionModelMoveNotices(
  tx: Database,
  input: { sessionId: string; from: string; to: string },
): Promise<number> {
  const session = await noticedSession(tx, input.sessionId);
  if (session === null || session.createdByUserId === null) return 0;
  const { workspaceId, agentId } = session;
  const recipients = await slackRecipientsOf(tx, {
    workspaceId,
    agentId,
    userId: session.createdByUserId,
    administrators: false,
  });
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
          text: sessionModelMoveNoticeText(person.locale, {
            agent: session.agentName,
            from: input.from,
            to: input.to,
          }),
          ...(person.locale === null ? {} : { locale: person.locale }),
        },
        dedupeKey: sessionModelMoveDedupeKey(
          workspaceId,
          input.sessionId,
          input.from,
          input.to,
          person.slackUserId,
        ),
      })
      .onConflictDoNothing({ target: slackOutbox.dedupeKey })
      .returning({ id: slackOutbox.id });
    if (row) enqueued += 1;
  }
  return enqueued;
}

async function noticedSession(tx: Database, sessionId: string) {
  const [session] = await tx
    .select({
      workspaceId: sessions.workspaceId,
      createdByUserId: sessions.createdByUserId,
      agentId: agentReleases.agentId,
      agentName: agents.name,
    })
    .from(sessions)
    .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session || session.workspaceId === null) return null;
  return { ...session, workspaceId: session.workspaceId };
}

export async function slackRecipientsOf(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string | null;
    /** Defaults to true: the agent's administrators are told as well. */
    administrators?: boolean;
  },
) {
  const { workspaceId, agentId } = input;
  return await tx
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
          input.userId === null
            ? undefined
            : eq(linkedAccounts.userId, input.userId),
          input.administrators === false
            ? undefined
            : administers(tx, workspaceId, linkedAccounts.userId, agentId),
        ),
      ),
    );
}
