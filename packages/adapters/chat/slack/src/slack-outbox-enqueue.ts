import {
  DEFAULT_USER_LOCALE,
  eventText,
  eventToolCall,
  SLACK_NOTICE_MESSAGES,
  slackMirrorCorrelationIdSchema,
} from "@werft-ai/contracts";
import type {
  SurfaceOutboxStore,
  SurfacePendingPrompt,
  SurfaceUnansweredTurn,
} from "@werft-ai/platform";
import type { SlackNoticeSink } from "./slack-notice-sink.ts";
import {
  SLACK_OUTBOX_MESSAGES,
  sessionUrl,
  slackInstructionSender,
} from "./slack-outbox-render.ts";
import { slackPromptMessage } from "./slack-prompts.ts";

/** Enqueues the instructions sent from the web or the API, once each. */
export async function enqueueSlackInstructions(deps: {
  outbox: Pick<SurfaceOutboxStore, "unpostedInstructions" | "enqueue">;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unpostedInstructions(deps.limit);
  for (const turn of turns) {
    const username = slackInstructionSender(
      turn.channel,
      turn.senderName,
      turn.locale ?? DEFAULT_USER_LOCALE,
    );
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind: "instruction",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: null,
      sessionId: turn.sessionId,
      sessionLinkId: turn.sessionLinkId,
      body: {
        text: turn.message,
        sender:
          turn.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: turn.senderSlackUserId },
      },
      dedupeKey: `instruction:${turn.sessionLinkId}:${turn.turnId}`,
      sources: turn.sources,
      sourcesTurn: turn.turnId,
    });
  }
  return turns.length;
}

/**
 * Enqueues each web input owed a Slack mirror, once: shown as an instruction
 * from the web is, its sources the input itself.
 */
export async function enqueueSlackInputMirrors(deps: {
  outbox: Pick<SurfaceOutboxStore, "unmirroredInputs" | "enqueue">;
  limit: number;
}): Promise<number> {
  const inputs = await deps.outbox.unmirroredInputs(deps.limit);
  for (const input of inputs) {
    const username = slackInstructionSender(
      "web",
      input.senderName,
      input.locale ?? DEFAULT_USER_LOCALE,
    );
    await deps.outbox.enqueue({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      slackAppId: input.slackAppId,
      installationId: input.installationId,
      kind: "input_mirror",
      channelId: input.channelId,
      threadTs: input.threadTs,
      slackUserId: null,
      sessionId: null,
      sessionLinkId: null,
      body: {
        text: input.body,
        sender:
          input.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: input.senderSlackUserId },
      },
      dedupeKey: `input_mirror:${input.inputId}`,
      sources: { direct: [{ input_id: input.inputId }], inherited: [] },
      inputId: input.inputId,
      correlationId: slackMirrorCorrelationIdSchema.parse(crypto.randomUUID()),
    });
  }
  return inputs.length;
}

/** One outbox row per turn and kind: what makes a turn answered. */
export function slackTurnDedupeKey(
  state: SurfaceUnansweredTurn["state"],
  sessionLinkId: string,
  turnId: number,
): string {
  return `${state === "completed" ? "reply" : "failure"}:${sessionLinkId}:${turnId}`;
}

export function slackPromptDedupeKey(
  kind: SurfacePendingPrompt["prompt"]["kind"],
  sessionLinkId: string,
  requestId: string,
): string {
  return `${kind === "push" ? "push" : "prompt"}:${sessionLinkId}:${requestId}`;
}

/**
 * The text the model wrote after its last tool call: what it said once the
 * work was done. Read whole, unlike presentTurnEvent's clipped summary.
 */
export function finalReplyText(
  events: SurfaceUnansweredTurn["events"],
): string {
  let parts: string[] = [];
  for (const event of events) {
    if (eventToolCall(event.payload) !== null) parts = [];
    else {
      const text = eventText(event.payload);
      if (text !== null) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Refusal notices become ephemeral outbox rows, one per onceKey, in the
 * language of the user the reader's Slack account is linked to.
 */
export function createOutboxSlackNoticeSink(
  outbox: Pick<SurfaceOutboxStore, "enqueue" | "readerLocale">,
): SlackNoticeSink {
  return {
    async record(notice) {
      const locale =
        (await outbox.readerLocale({
          workspaceId: notice.workspaceId,
          teamId: notice.teamId,
          slackUserId: notice.slackUserId,
        })) ?? DEFAULT_USER_LOCALE;
      const { message, ...link } = notice.notice;
      await outbox.enqueue({
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        slackAppId: notice.slackAppId,
        installationId: notice.installationId,
        kind: "notice",
        channelId: notice.channelId,
        threadTs: notice.threadTs,
        slackUserId: notice.slackUserId,
        sessionId: null,
        sessionLinkId: null,
        body: { text: SLACK_NOTICE_MESSAGES[locale][message], locale, ...link },
        dedupeKey: `notice:${notice.onceKey}`,
      });
    },
    // Posted like a turn that could not go on: in the thread, for everyone
    // there, in the deployment's language since no one reader is named.
    async recordInThread(notice) {
      const locale = DEFAULT_USER_LOCALE;
      const { message, ...link } = notice.notice;
      await outbox.enqueue({
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        slackAppId: notice.slackAppId,
        installationId: notice.installationId,
        kind: "failure_notice",
        channelId: notice.channelId,
        threadTs: notice.threadTs,
        slackUserId: null,
        sessionId: notice.sessionId,
        sessionLinkId: notice.sessionLinkId,
        body: { text: SLACK_NOTICE_MESSAGES[locale][message], locale, ...link },
        dedupeKey: `thread_notice:${notice.onceKey}`,
      });
    },
  };
}

/** Enqueues the reply or failure notice of turns that lack one. */
export async function enqueueSlackTurnAnswers(deps: {
  outbox: Pick<SurfaceOutboxStore, "unansweredTurns" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unansweredTurns(deps.limit);
  for (const turn of turns) {
    const link_url = sessionUrl(deps.consoleOrigin, turn.sessionId);
    const locale = turn.locale ?? DEFAULT_USER_LOCALE;
    const text =
      turn.state === "completed"
        ? finalReplyText(turn.events) ||
          SLACK_OUTBOX_MESSAGES[locale].emptyReply
        : SLACK_NOTICE_MESSAGES[locale].failed;
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind: turn.state === "completed" ? "reply" : "failure_notice",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: null,
      sessionId: turn.sessionId,
      sessionLinkId: turn.sessionLinkId,
      body: {
        text,
        locale,
        ...(link_url === undefined ? {} : { link_url }),
        ...(turn.requesterSlackUserId === null
          ? {}
          : { mention_user_ids: [turn.requesterSlackUserId] }),
      },
      dedupeKey: slackTurnDedupeKey(
        turn.state,
        turn.sessionLinkId,
        turn.turnId,
      ),
      sources: turn.sources,
      sourcesTurn: turn.turnId,
    });
  }
  return turns.length;
}

export async function enqueueSlackPrompts(deps: {
  outbox: Pick<SurfaceOutboxStore, "unpromptedRequests" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const pending = await deps.outbox.unpromptedRequests(deps.limit);
  for (const row of pending) {
    const locale = row.locale ?? DEFAULT_USER_LOCALE;
    const link_url = sessionUrl(deps.consoleOrigin, row.sessionId);
    const message = slackPromptMessage(
      { ...row.prompt, sessionId: row.sessionId },
      {
        locale,
        requesterSlackUserId: row.requesterSlackUserId,
        ...(link_url === undefined ? {} : { linkUrl: link_url }),
      },
    );
    await deps.outbox.enqueue({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      installationId: row.installationId,
      kind: "input_notice",
      channelId: row.channelId,
      threadTs: row.threadTs,
      slackUserId: null,
      sessionId: row.sessionId,
      sessionLinkId: row.sessionLinkId,
      body: {
        text: message.text,
        locale,
        blocks: message.blocks,
        ...(link_url === undefined ? {} : { link_url }),
        ...(row.requesterSlackUserId === null
          ? {}
          : { mention_user_ids: [row.requesterSlackUserId] }),
      },
      dedupeKey: slackPromptDedupeKey(
        row.prompt.kind,
        row.sessionLinkId,
        row.prompt.requestId,
      ),
      sources: row.sources,
      sourcesTurn: row.sourcesTurn,
    });
  }
  return pending.length;
}
