import {
  DEFAULT_USER_LOCALE,
  SLACK_INPUT_MIRROR_EVENT_TYPE,
  SLACK_USER_CHANNEL_CODE,
  slackOutboxChannelRefused,
} from "@werft-ai/contracts";
import type {
  Approvable,
  DeliveryInput,
  DeliveryOutcome,
  Notifiable,
  SurfaceOutboxClaim,
  SurfaceOutboxPostedAs,
  SurfaceOutboxSettle,
} from "@werft-ai/platform";
import {
  SlackApiError,
  type SlackBotSender,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { type SlackInboxLogger, slackInboundBackoffMs } from "./slack-inbox.ts";
import {
  SLACK_OUTBOX_MESSAGES,
  type SlackTextGuard,
  sessionUrl,
  slackAgentSender,
  slackInstructionFallbackText,
  slackOutboxGuard,
  slackOutboxPresentation,
  slackOutboxText,
} from "./slack-outbox-render.ts";
import {
  classifySlackSendResult,
  SLACK_SEND_MAX_ATTEMPTS,
} from "./slack-send-result.ts";

/** The longest Retry-After the outbox honours before asking again. */
export const SLACK_RETRY_AFTER_MAX_MS = 5 * 60_000;
/** Claims, rate-limited ones included, before a row gives up. */
export const SLACK_OUTBOX_MAX_ATTEMPTS = 10;

export function slackOutboxSettleFor(
  attempts: number,
  response: SlackSendResponse,
): SurfaceOutboxSettle {
  // A 2xx or 5xx whose answer could not be read: Slack may hold the
  // message, so this is no failure to retry. A 4xx, 429 included, is
  // judged by its status and Retry-After alone.
  if (
    response.body === null &&
    ((response.httpStatus >= 200 && response.httpStatus < 300) ||
      response.httpStatus >= 500)
  ) {
    return { status: "uncertain", errorCode: "unreadable_answer" };
  }
  const outcome = classifySlackSendResult({
    httpStatus: response.httpStatus,
    retryAfterHeader: response.retryAfterHeader,
    body: response.body,
    attempts,
  });
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", slackTs: outcome.ts };
    case "failed":
      return { status: "failed", errorCode: outcome.code };
    case "retry_after":
      return attempts >= SLACK_OUTBOX_MAX_ATTEMPTS
        ? { status: "failed", errorCode: "ratelimited" }
        : {
            status: "pending",
            errorCode: "ratelimited",
            retryInMs: Math.min(outcome.waitMs, SLACK_RETRY_AFTER_MAX_MS),
          };
    case "retry":
      return {
        status: "pending",
        errorCode: outcome.code,
        retryInMs: slackInboundBackoffMs(attempts),
      };
  }
}

/**
 * The outbox sender's way out to the channel. `notifiable` and `approvable`
 * are the ports; `direct` carries the rows no port exists for (an
 * instruction, a reply, a welcome), which the sender has always posted itself.
 */
export type RowDelivery = {
  notifiable: Notifiable<SurfaceOutboxClaim> & {
    notify: (input: RowDeliveryInput) => Promise<DeliveryOutcome>;
  };
  approvable: Approvable<SurfaceOutboxClaim> & {
    requestDecision: (input: RowDeliveryInput) => Promise<DeliveryOutcome>;
  };
  direct: (input: RowDeliveryInput) => Promise<DeliveryOutcome>;
};

/**
 * A row's delivery, whose begin may also say who the row goes out as, read
 * when its send began (`beginSend`); `true` posts as the app.
 */
export type RowDeliveryInput = Omit<
  DeliveryInput<SurfaceOutboxClaim>,
  "begin"
> & { begin: () => Promise<boolean | SurfaceOutboxPostedAs> };

export type RowDeliveryDeps = {
  slack: Pick<SlackBotSender, "postMessage" | "postEphemeral" | "userImage">;
  /**
   * Whether a session's direct message would reach someone outside its
   * private channels (`readerOutsideChannels`); such a row never goes out.
   */
  readerOutside?: (claim: SurfaceOutboxClaim) => Promise<boolean>;
  /** Null when the app has no readable token: the row waits, unsent. */
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  consoleOrigin: string | null;
  /** Told of the Slack references a row's text lost to its scope. */
  logger?: Pick<SlackInboxLogger, "warn">;
};

/** The row settle each outcome stands for, and back: one to one. */
function outcomeOf(settle: SurfaceOutboxSettle): DeliveryOutcome {
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

const missingScope = (response: SlackSendResponse) =>
  typeof response.body === "object" &&
  response.body !== null &&
  (response.body as { error?: unknown }).error === "missing_scope";

// Nothing but formatting marks left: Slack would show an empty message.
const isBlank = (text: string) => /^[\s*_~`>#|-]*$/.test(text);

/** A session's direct message held back from someone who cannot see it. */
export const SLACK_READER_OUTSIDE_CODE = "reader_outside_channel";

export function createRowDelivery(deps: RowDeliveryDeps): RowDelivery {
  // An instruction goes under its sender's name and profile image. An app
  // installed before chat:write.customize may be refused the name; Slack
  // posted nothing then, so it goes once more as the app.
  // Read before begin, so a slow users.info spends no send lease.
  const senderImage = (botToken: string, claim: SurfaceOutboxClaim) =>
    (claim.kind !== "instruction" && claim.kind !== "input_mirror") ||
    claim.body.sender?.slack_user_id === undefined
      ? Promise.resolve(null)
      : deps.slack
          .userImage(botToken, claim.body.sender.slack_user_id)
          .catch(() => null);
  const postMessage = async (
    botToken: string,
    claim: SurfaceOutboxClaim,
    text: string,
    iconUrl: string | null,
    guard: SlackTextGuard,
    postedAs: SurfaceOutboxPostedAs | null,
  ) => {
    const target = {
      channelId: claim.channelId,
      threadTs: claim.threadTs,
      text,
    };
    const presentation = slackOutboxPresentation(claim, guard);
    if (presentation.kind !== "instruction") {
      // The agent's own row goes under its name, and a task's under its
      // title too. Slack posted nothing when it refused the name to an app
      // without chat:write.customize; the row goes once more as the app.
      let username = slackAgentSender(postedAs);
      const post = async (
        input: Parameters<SlackBotSender["postMessage"]>[1],
      ) => {
        if (username === null) return deps.slack.postMessage(botToken, input);
        const named = await deps.slack.postMessage(botToken, {
          ...input,
          username,
        });
        if (!missingScope(named)) return named;
        username = null;
        return deps.slack.postMessage(botToken, input);
      };
      if (presentation.kind === "text") return post(target);
      const response = await post({ ...target, blocks: presentation.blocks });
      if (!presentation.fallback) return response;
      // Slack posted nothing when it refused the blocks (an app or workspace
      // without table support); the same reply goes once more as plain text.
      const error =
        typeof response.body === "object" && response.body !== null
          ? (response.body as { error?: unknown }).error
          : undefined;
      return error === "invalid_blocks" || error === "msg_blocks_too_long"
        ? post(target)
        : response;
    }
    const { sender } = presentation;
    // A mirror's post names its request, so the post Slack sends back can.
    const metadata =
      claim.kind === "input_mirror" && claim.correlationId != null
        ? {
            metadata: {
              event_type: SLACK_INPUT_MIRROR_EVENT_TYPE,
              event_payload: { correlation_id: claim.correlationId },
            },
          }
        : {};
    const response = await deps.slack.postMessage(botToken, {
      ...target,
      ...metadata,
      username: sender.username,
      ...(iconUrl === null ? {} : { iconUrl }),
    });
    if (!missingScope(response)) return response;
    // Posted as the app, the sender's name moves into the text; a row queued
    // before the name left the text has it there already.
    return deps.slack.postMessage(botToken, {
      ...target,
      ...metadata,
      text: slackInstructionFallbackText(
        claim.body,
        text,
        sender.username,
        guard,
      ),
    });
  };

  const deliver = async (input: RowDeliveryInput): Promise<DeliveryOutcome> => {
    const { row, attempts } = input;
    // The one guard a row's text goes through: on its Markdown here, and
    // again on the text Slack reads once rendered (the render can join
    // pieces), every way it goes out below.
    const { guard: rowGuard, dropped } = slackOutboxGuard(row);
    // A text the guard emptied still says the answer is done; one that was
    // only marks to begin with goes as it was.
    let changed = false;
    const guard = (text: string) => {
      const kept = rowGuard(text);
      if (kept !== text) changed = true;
      return kept;
    };
    const emptied = (text: string) => changed && isBlank(text);
    const empty =
      SLACK_OUTBOX_MESSAGES[row.body.locale ?? DEFAULT_USER_LOCALE].emptyReply;
    const kept = row.body.blocks === undefined ? guard(row.body.text) : "";
    const claim =
      row.body.blocks !== undefined
        ? row
        : {
            ...row,
            body: { ...row.body, text: emptied(kept) ? empty : kept },
          };
    const logDropped = () => {
      if (dropped.size === 0) return;
      deps.logger?.warn(
        "Slack send dropped references outside its conversation",
        {
          id: claim.id,
          kind: claim.kind,
          channel_id: claim.channelId,
          session_id: claim.sessionId,
          dropped: [...dropped],
        },
      );
    };
    // Before the token and any Slack call: such a row never goes out.
    if (slackOutboxChannelRefused(claim.kind, claim.channelId)) {
      return { kind: "failed", code: SLACK_USER_CHANNEL_CODE };
    }
    if (
      claim.kind === "model_notice" &&
      claim.sessionId !== null &&
      (await deps.readerOutside?.(claim))
    ) {
      return { kind: "failed", code: SLACK_READER_OUTSIDE_CODE };
    }
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
    const begun = await input.begin();
    if (begun === false) return { kind: "lease_lost" };
    const postedAs = begun === true ? null : begun;

    // A card's text is its own, escaped and linked already.
    // A model notice is a direct message with no thread: it opens the
    // session instead.
    const modelLink =
      claim.kind === "model_notice" && claim.sessionId !== null
        ? sessionUrl(deps.consoleOrigin, claim.sessionId)
        : undefined;
    const body =
      modelLink === undefined
        ? claim.body
        : { ...claim.body, link_url: modelLink };
    const rendered =
      claim.kind === "input_notice" && claim.body.blocks !== undefined
        ? claim.body.text
        : slackOutboxText(body, guard);
    const text = emptied(rendered)
      ? slackOutboxText({ ...body, text: empty }, guard)
      : rendered;
    try {
      const response =
        claim.kind === "notice" && claim.slackUserId !== null
          ? await deps.slack.postEphemeral(botToken, {
              channelId: claim.channelId,
              userId: claim.slackUserId,
              threadTs: claim.threadTs,
              text,
            })
          : await postMessage(botToken, claim, text, iconUrl, guard, postedAs);
      logDropped();
      return outcomeOf(slackOutboxSettleFor(attempts, response));
    } catch (error) {
      logDropped();
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
