import {
  DEFAULT_USER_LOCALE,
  eventText,
  eventToolCall,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import type {
  SlackOutboxStore,
  SlackPendingPrompt,
  SlackUnansweredTurn,
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
  outbox: Pick<SlackOutboxStore, "unpostedInstructions" | "enqueue">;
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
      body: {
        text: turn.message,
        sender:
          turn.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: turn.senderSlackUserId },
      },
      dedupeKey: `instruction:${turn.sessionLinkId}:${turn.turnId}`,
    });
  }
  return turns.length;
}

/** One outbox row per turn and kind: what makes a turn answered. */
export function slackTurnDedupeKey(
  state: SlackUnansweredTurn["state"],
  sessionLinkId: string,
  turnId: number,
): string {
  return `${state === "completed" ? "reply" : "failure"}:${sessionLinkId}:${turnId}`;
}

export function slackPromptDedupeKey(
  kind: SlackPendingPrompt["prompt"]["kind"],
  sessionLinkId: string,
  requestId: string,
): string {
  return `${kind === "push" ? "push" : "prompt"}:${sessionLinkId}:${requestId}`;
}

/**
 * The text the model wrote after its last tool call: what it said once the
 * work was done. Read whole, unlike presentTurnEvent's clipped summary.
 */
export function finalReplyText(events: SlackUnansweredTurn["events"]): string {
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
  outbox: Pick<SlackOutboxStore, "enqueue" | "readerLocale">,
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
        body: { text: SLACK_NOTICE_MESSAGES[locale][message], locale, ...link },
        dedupeKey: `notice:${notice.onceKey}`,
      });
    },
  };
}

/** Enqueues the reply or failure notice of turns that lack one. */
export async function enqueueSlackTurnAnswers(deps: {
  outbox: Pick<SlackOutboxStore, "unansweredTurns" | "enqueue">;
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
    });
  }
  return turns.length;
}

export async function enqueueSlackPrompts(deps: {
  outbox: Pick<SlackOutboxStore, "unpromptedRequests" | "enqueue">;
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
    });
  }
  return pending.length;
}
