import type { SlackOutboxSettle } from "../ports/slack-outbox-store.ts";
import type { Approvable } from "../surface/ports/approvable.ts";
import type {
  ClaimedOutboxRow,
  DeliveryInput,
  DeliveryOutcome,
} from "../surface/ports/delivery.ts";
import type { Notifiable } from "../surface/ports/notifiable.ts";
import { SlackApiError, type SlackBotSender } from "./slack-config-api.ts";
import { slackInboundBackoffMs } from "./slack-inbox.ts";
import {
  sessionUrl,
  slackInstructionFallbackText,
  slackOutboxPresentation,
  slackOutboxSettleFor,
  slackOutboxText,
} from "./slack-outbox.ts";
import { SLACK_SEND_MAX_ATTEMPTS } from "./slack-send-result.ts";

/**
 * The outbox sender's way out to the channel. `notifiable` and `approvable`
 * are the ports; `direct` carries the rows no port exists for (an
 * instruction, a reply, a welcome), which the sender has always posted itself.
 */
export type RowDelivery = {
  notifiable: Notifiable;
  approvable: Approvable;
  direct: (input: DeliveryInput) => Promise<DeliveryOutcome>;
};

export type RowDeliveryDeps = {
  slack: Pick<SlackBotSender, "postMessage" | "postEphemeral" | "userImage">;
  /** Null when the app has no readable token: the row waits, unsent. */
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  consoleOrigin: string | null;
};

/** The row settle each outcome stands for, and back: one to one. */
function outcomeOf(settle: SlackOutboxSettle): DeliveryOutcome {
  switch (settle.status) {
    case "sent":
      return { kind: "sent", ref: settle.slackTs };
    case "pending":
      return {
        kind: "retry",
        code: settle.errorCode,
        retryAfterMs: settle.retryInMs,
      };
    case "failed":
      return { kind: "failed", code: settle.errorCode };
    case "uncertain":
      return { kind: "uncertain", code: settle.errorCode };
  }
}

export function createRowDelivery(deps: RowDeliveryDeps): RowDelivery {
  // An instruction goes under its sender's name and profile image. An app
  // installed before chat:write.customize may be refused the name; Slack
  // posted nothing then, so it goes once more as the app.
  // Read before begin, so a slow users.info spends no send lease.
  const senderImage = (botToken: string, claim: ClaimedOutboxRow) =>
    claim.kind !== "instruction" ||
    claim.body.sender?.slack_user_id === undefined
      ? Promise.resolve(null)
      : deps.slack
          .userImage(botToken, claim.body.sender.slack_user_id)
          .catch(() => null);
  const postMessage = async (
    botToken: string,
    claim: ClaimedOutboxRow,
    text: string,
    iconUrl: string | null,
  ) => {
    const target = {
      channelId: claim.channelId,
      threadTs: claim.threadTs,
      text,
    };
    const presentation = slackOutboxPresentation(claim);
    if (presentation.kind !== "instruction") {
      if (presentation.kind === "text") {
        return deps.slack.postMessage(botToken, target);
      }
      const response = await deps.slack.postMessage(botToken, {
        ...target,
        blocks: presentation.blocks,
      });
      if (!presentation.fallback) return response;
      // Slack posted nothing when it refused the blocks (an app or workspace
      // without table support); the same reply goes once more as plain text.
      const error =
        typeof response.body === "object" && response.body !== null
          ? (response.body as { error?: unknown }).error
          : undefined;
      return error === "invalid_blocks" || error === "msg_blocks_too_long"
        ? deps.slack.postMessage(botToken, target)
        : response;
    }
    const { sender } = presentation;
    const response = await deps.slack.postMessage(botToken, {
      ...target,
      username: sender.username,
      ...(iconUrl === null ? {} : { iconUrl }),
    });
    const refused =
      typeof response.body === "object" &&
      response.body !== null &&
      (response.body as { error?: unknown }).error === "missing_scope";
    if (!refused) return response;
    // Posted as the app, the sender's name moves into the text; a row queued
    // before the name left the text has it there already.
    return deps.slack.postMessage(botToken, {
      ...target,
      text: slackInstructionFallbackText(claim.body, text, sender.username),
    });
  };

  const deliver = async (input: DeliveryInput): Promise<DeliveryOutcome> => {
    const { row: claim, attempts } = input;
    let botToken: string | null;
    try {
      botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
    } catch {
      botToken = null;
    }
    if (botToken === null) {
      return attempts >= SLACK_SEND_MAX_ATTEMPTS
        ? { kind: "failed", code: "no_bot_token" }
        : {
            kind: "retry",
            code: "no_bot_token",
            retryAfterMs: slackInboundBackoffMs(attempts),
          };
    }
    const iconUrl = await senderImage(botToken, claim);
    if (!(await input.begin())) return { kind: "lease_lost" };

    // A card's text is its own, escaped and linked already.
    // A model notice is a direct message with no thread: it opens the
    // session instead.
    const modelLink =
      claim.kind === "model_notice" && claim.sessionId !== null
        ? sessionUrl(deps.consoleOrigin, claim.sessionId)
        : undefined;
    const text =
      claim.kind === "input_notice" && claim.body.blocks !== undefined
        ? claim.body.text
        : slackOutboxText(
            modelLink === undefined
              ? claim.body
              : { ...claim.body, link_url: modelLink },
          );
    try {
      const response =
        claim.kind === "notice" && claim.slackUserId !== null
          ? await deps.slack.postEphemeral(botToken, {
              channelId: claim.channelId,
              userId: claim.slackUserId,
              threadTs: claim.threadTs,
              text,
            })
          : await postMessage(botToken, claim, text, iconUrl);
      return outcomeOf(slackOutboxSettleFor(attempts, response));
    } catch (error) {
      // No answer came: the request may have reached Slack.
      return {
        kind: "uncertain",
        code: error instanceof SlackApiError ? error.code : "send_threw",
      };
    }
  };

  return {
    notifiable: { notify: deliver },
    approvable: { requestDecision: deliver },
    direct: deliver,
  };
}
