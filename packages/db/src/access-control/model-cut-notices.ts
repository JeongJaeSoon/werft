import { randomUUID } from "node:crypto";
import {
  MODEL_NOT_ALLOWED_EVENT_CODE,
  type ModelCutCause,
  type UserLocale,
} from "@werft-ai/contracts";
import {
  modelCutDedupeKey,
  modelCutEventMessage,
  modelCutNoticeText,
  runtimeRetiredDedupeKey,
  runtimeRetiredNoticeText,
  sessionModelMoveDedupeKey,
  sessionModelMoveNoticeText,
  workerImageReplacedDedupeKey,
  workerImageReplacedNoticeText,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { agents, slackOutbox } from "../schema.ts";
import { recordEvent } from "../sessions/index.ts";
import { sessionNoticeThread } from "./action-notices.ts";

/**
 * The stream's `MODEL_NOT_ALLOWED` error event and the notice that goes with
 * it, for the caller's transaction, which already holds the session's lock.
 * The attempt is null when no attempt ran yet: a claim that gives the session
 * up.
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
 * Writes the `model_notice` row telling the session's thread that its model
 * left the agent's allowed list, in the caller's transaction so the error
 * event and its notice commit together. Once per thread, however many
 * attempts are cut. Each writer below tells the thread
 * (`sessionNoticeThread`) and no one person: a session with no thread is
 * told on the web only, by the event its writer records (design v3 decision
 * 45, 94S-2040). Each returns the rows it wrote, 0 or 1.
 */
export function enqueueModelCutNotices(
  tx: Database,
  input: { sessionId: string; model: string; cause?: ModelCutCause },
): Promise<number> {
  return enqueueThreadNotice(tx, input.sessionId, {
    text: (locale) => modelCutNoticeText(locale, input.model, input.cause),
    dedupeKey: (workspaceId, linkId) =>
      modelCutDedupeKey(workspaceId, input.sessionId, linkId),
  });
}

/** The thread hears that the session's model moved to the next of its series. */
export function enqueueSessionModelMoveNotices(
  tx: Database,
  input: { sessionId: string; from: string; to: string },
): Promise<number> {
  return enqueueThreadNotice(tx, input.sessionId, {
    text: (locale, agent) =>
      sessionModelMoveNoticeText(locale, {
        agent,
        from: input.from,
        to: input.to,
      }),
    dedupeKey: (workspaceId, linkId) =>
      sessionModelMoveDedupeKey(
        workspaceId,
        input.sessionId,
        input.from,
        input.to,
        linkId,
      ),
  });
}

/** The thread hears that the session stopped as `runtime_retired`. */
export function enqueueRuntimeRetiredNotices(
  tx: Database,
  input: { sessionId: string; checkpointRevision: number },
): Promise<number> {
  return enqueueThreadNotice(tx, input.sessionId, {
    text: runtimeRetiredNoticeText,
    dedupeKey: (workspaceId, linkId) =>
      runtimeRetiredDedupeKey(
        workspaceId,
        input.sessionId,
        input.checkpointRevision,
        linkId,
      ),
  });
}

/** The thread hears that the session's launch moved off a retracted image. */
export function enqueueWorkerImageReplacedNotices(
  tx: Database,
  input: { sessionId: string; generation: number },
): Promise<number> {
  return enqueueThreadNotice(tx, input.sessionId, {
    text: workerImageReplacedNoticeText,
    dedupeKey: (workspaceId, linkId) =>
      workerImageReplacedDedupeKey(
        workspaceId,
        input.sessionId,
        input.generation,
        linkId,
      ),
  });
}

async function enqueueThreadNotice(
  tx: Database,
  sessionId: string,
  notice: {
    text: (locale: UserLocale | null, agent: string) => string;
    dedupeKey: (workspaceId: string, linkId: string) => string;
  },
): Promise<number> {
  const link = await sessionNoticeThread(tx, sessionId);
  if (!link) return 0;
  const [agent] = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, link.agentId))
    .limit(1);
  if (!agent) return 0;
  const [row] = await tx
    .insert(slackOutbox)
    .values({
      id: randomUUID(),
      workspaceId: link.workspaceId,
      agentId: link.agentId,
      slackAppId: link.slackAppId,
      installationId: link.installationId,
      kind: "model_notice",
      channelId: link.channelId,
      threadTs: link.threadTs,
      slackUserId: null,
      sessionId,
      sessionLinkId: link.id,
      body: {
        text: notice.text(link.locale, agent.name),
        ...(link.locale === null ? {} : { locale: link.locale }),
      },
      dedupeKey: notice.dedupeKey(link.workspaceId, link.id),
    })
    .onConflictDoNothing({ target: slackOutbox.dedupeKey })
    .returning({ id: slackOutbox.id });
  return row ? 1 : 0;
}
