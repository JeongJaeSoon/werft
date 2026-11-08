import {
  DEFAULT_USER_LOCALE,
  eventText,
  eventToolCall,
  SLACK_NOTICE_MESSAGES,
  type UserLocale,
} from "@werft-ai/contracts";
import type { SlackNoticeSink } from "../ports/slack-notice-sink.ts";
import type {
  SlackCardClaim,
  SlackCardRendered,
  SlackCardSettleStore,
  SlackOutboxClaim,
  SlackOutboxEntry,
  SlackOutboxLost,
  SlackOutboxSettle,
  SlackOutboxStore,
  SlackPendingPrompt,
  SlackUnansweredTurn,
  SlackUnpostedInstruction,
} from "../ports/slack-outbox-store.ts";
import { pushApprovability } from "../sessions/push-approvability.ts";
import type { PushSource } from "../sessions/push-request-service.ts";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackBotSender,
  SlackRateLimitedError,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { type SlackInboxLogger, slackInboundBackoffMs } from "./slack-inbox.ts";
import { markdownToSlackMrkdwn, markdownToSlackParts } from "./slack-mrkdwn.ts";
import { escapeSlackControls } from "./slack-presentation.ts";
import {
  slackDoneCard,
  slackPromptMessage,
  slackRejectOnlyCard,
  slackSettledCard,
  slackSettledResult,
} from "./slack-prompts.ts";
import {
  classifySlackSendResult,
  SLACK_SEND_MAX_ATTEMPTS,
} from "./slack-send-result.ts";
import {
  reconcileSlackThreadStatuses,
  writeSlackThreadStatuses,
} from "./slack-session-status.ts";

/** chat.postMessage truncates `text` past this many characters. */
export const SLACK_TEXT_MAX = 40_000;
/** The longest Retry-After the outbox honours before asking again. */
export const SLACK_RETRY_AFTER_MAX_MS = 5 * 60_000;
/** Claims, rate-limited ones included, before a row gives up. */
export const SLACK_OUTBOX_MAX_ATTEMPTS = 10;

export const SLACK_OUTBOX_MESSAGES: Readonly<
  Record<
    UserLocale,
    Readonly<
      Record<"emptyReply" | "uncertain" | "link" | "web" | "api", string>
    >
  >
> = {
  ko: {
    emptyReply: "답변을 마쳤어요. 내용은 웹에서 확인해 주세요",
    uncertain: "답을 보냈는지 확인하지 못했어요. 웹에서 확인해 주세요",
    link: "웹에서 열기",
    web: "웹 콘솔",
    api: "API",
  },
  ja: {
    emptyReply: "回答が完了しました。内容はWebで確認してください",
    uncertain: "回答を送信できたか確認できませんでした。Webで確認してください",
    link: "Webで開く",
    web: "Webコンソール",
    api: "API",
  },
  en: {
    emptyReply: "The answer is done. See it on the web",
    uncertain: "We couldn't confirm the answer was sent. Check it on the web",
    link: "Open on the web",
    web: "Web console",
    api: "API",
  },
};

/** Slack cuts a `username` past this many characters. */
const SLACK_USERNAME_MAX = 80;

/**
 * Who an instruction came from, as its `username`; an app that cannot set
 * the name puts it on the text's first line instead.
 */
export function slackInstructionSender(
  channel: SlackUnpostedInstruction["channel"],
  senderName: string | null,
  locale: UserLocale,
): string {
  const via = SLACK_OUTBOX_MESSAGES[locale][channel];
  const name = senderName?.replace(/\s+/g, " ").trim();
  if (!name) return via;
  const suffix = ` (${via})`;
  return `${[...name].slice(0, SLACK_USERNAME_MAX - suffix.length).join("")}${suffix}`;
}

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

function isSafeLink(url: string): boolean {
  if (/[<>|\s]/.test(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * What goes to Slack: the body's Markdown as mrkdwn with every control
 * escaped, cut to fit with its link kept whole after it.
 */
function outboxLink(body: SlackOutboxEntry["body"]): string {
  return body.link_url !== undefined && isSafeLink(body.link_url)
    ? `<${body.link_url}|${SLACK_OUTBOX_MESSAGES[body.locale ?? DEFAULT_USER_LOCALE].link}>`
    : "";
}

function outboxEscaper(body: SlackOutboxEntry["body"]) {
  return (value: string) =>
    escapeSlackControls(value, {
      maskedLinks: "expand",
      ...(body.mention_user_ids === undefined
        ? {}
        : { userIds: body.mention_user_ids }),
    });
}

// A section's text may not pass 3000 characters, and a message holds 50 blocks.
const SECTION_TEXT_MAX = 3_000;

/** Whole lines, each piece within the section limit; null when that cannot be. */
function sectionPieces(text: string): string[] | null {
  const pieces: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > SECTION_TEXT_MAX) return null;
    if (current !== "" && current.length + line.length + 1 > SECTION_TEXT_MAX) {
      pieces.push(current);
      current = line;
    } else current = current === "" ? line : `${current}\n${line}`;
  }
  pieces.push(current);
  // A cut inside a code fence would leave both halves unclosed.
  return pieces.every((piece) => piece.split("```").length % 2 === 1)
    ? pieces
    : null;
}

/**
 * The reply as Slack blocks when it holds a table that fits a table block:
 * the text around it in sections, the table, then the link. Null when the
 * reply has no such table or a piece cannot fit; the plain text then carries
 * the table as one line per row.
 */
export function slackReplyBlocks(
  body: SlackOutboxEntry["body"],
): unknown[] | null {
  const parts = markdownToSlackParts(body.text);
  if (parts === null) return null;
  const escaped = outboxEscaper(body);
  const blocks: unknown[] = [];
  for (const part of parts) {
    if ("table" in part) {
      blocks.push({
        type: "table",
        column_settings: part.table.rows[0]?.map(() => ({ is_wrapped: true })),
        rows: part.table.rows.map((row) =>
          row.map((text) => ({ type: "raw_text", text })),
        ),
      });
      continue;
    }
    const pieces = sectionPieces(escaped(part.text));
    if (pieces === null) return null;
    for (const text of pieces) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    }
  }
  const link = outboxLink(body);
  if (link !== "") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: link } });
  }
  return blocks.length <= 50 ? blocks : null;
}

export function slackOutboxText(body: SlackOutboxEntry["body"]): string {
  const link = outboxLink(body) === "" ? "" : `\n\n${outboxLink(body)}`;
  const escaped = outboxEscaper(body);
  // Converted before the cut: the loop below re-escapes pieces of this text.
  const text = escaped(markdownToSlackMrkdwn(body.text));
  const room = SLACK_TEXT_MAX - link.length - 1;
  if (text.length <= room + 1) return text + link;
  let piece = text;
  let cut = room;
  while (piece.length > room) {
    // Not inside an escape such as `&lt;`, nor between a surrogate pair.
    const amp = text.lastIndexOf("&", cut);
    if (amp !== -1 && amp > cut - 6 && !text.slice(amp, cut).includes(";")) {
      cut = amp;
    }
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // A cut can open a code fence whose close fell away, and Slack shows an
    // unclosed fence as plain text: what it held must be escaped too.
    piece = escaped(text.slice(0, cut));
    cut -= piece.length - room;
  }
  return `${piece}…${link}`;
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

function sessionUrl(consoleOrigin: string | null, sessionId: string) {
  return consoleOrigin === null
    ? undefined
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
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

export type SlackOutboxDrain = {
  enqueued: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  uncertain: number;
  lost: number;
  /** Thread statuses sent. */
  statuses: number;
  /** Posted cards redrawn. */
  cards: number;
};

function settleFor(
  claim: SlackOutboxClaim,
  response: SlackSendResponse,
): SlackOutboxSettle {
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
    attempts: claim.attempts,
  });
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", slackTs: outcome.ts };
    case "failed":
      return { status: "failed", errorCode: outcome.code };
    case "retry_after":
      return claim.attempts >= SLACK_OUTBOX_MAX_ATTEMPTS
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
        retryInMs: slackInboundBackoffMs(claim.attempts),
      };
  }
}

/** Design slack-approval-ui §4: lease 60s, takeover grace 30s, W 5 min. */
export const SLACK_CARD_SETTLE_TIMING = {
  leaseMs: 60_000,
  graceMs: 30_000,
  /** The longest Slack is taken to sit on a request before applying it. */
  windowMs: 5 * 60_000,
  /** Above the 10s HTTP deadline (SLACK_HTTP_TIMEOUT_MS) with room to spare. */
  minLeaseLeftMs: 15_000,
  batchSize: 20,
  retryMs: 30_000,
  backoffMs: [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000],
  /** Failures, rate limits not counted, before a card is given up. */
  maxAttempts: 5,
} as const;

/** Answers after which Slack takes no edit of the message. */
const CARD_GONE = new Set([
  "message_not_found",
  "cant_update_message",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);
const CARD_BAD_BLOCKS = new Set(["invalid_blocks", "msg_blocks_too_long"]);

type DrawnCard = {
  rendered: SlackCardRendered;
  text: string;
  blocks: unknown[];
};

/**
 * What the card should show now, from its request as stored. Null when the
 * request is gone from the owner's sessions.
 */
async function drawCard(
  store: SlackCardSettleStore,
  claim: SlackCardClaim,
  pushSource: PushSource | undefined,
): Promise<DrawnCard | null> {
  const open = {
    rendered: "open" as const,
    text: claim.body.text,
    blocks: claim.body.blocks ?? [],
  };
  const [prefix, , ...rest] = claim.dedupeKey.split(":");
  if (prefix !== "prompt" && prefix !== "push") {
    if (await store.turnWaits(claim)) return open;
    return {
      rendered: "done",
      ...slackDoneCard(
        claim.body.locale ?? DEFAULT_USER_LOCALE,
        claim.body.link_url ?? null,
      ),
    };
  }
  const card = await store.card(claim);
  if (card === null) return null;
  const result = slackSettledResult(card.display);
  if (result !== null) {
    const settled = slackSettledCard(card);
    return settled === null ? null : { rendered: result, ...settled };
  }
  if (
    card.display.kind !== "push" ||
    claim.sessionId === null ||
    card.pushRevisions === undefined
  ) {
    return open;
  }
  const verdict = await pushApprovability(
    { id: claim.sessionId, checkpointRevision: card.pushRevisions.session },
    {
      state: card.display.state,
      checkpointRevision: card.pushRevisions.request,
      gitCommit: card.display.gitCommit,
      origin: card.pushRevisions.origin,
    },
    pushSource,
  );
  if (verdict.approvable) return open;
  return {
    rendered: "reject_only",
    ...slackRejectOnlyCard(
      { ...card, display: card.display },
      { sessionId: claim.sessionId, requestId: rest.join(":") },
    ),
  };
}

export type SlackCardSettlePass = {
  due: number;
  claimed: number;
  sent: number;
  skipped: number;
  uncertain: number;
  deferred: number;
  abandoned: number;
  lost: number;
};

/**
 * Redraws posted cards whose request moved on (design slack-approval-ui §4):
 * answered on the web, expired, closed with its session, a push decided or
 * no longer approvable. One writer per card at a time, under a lease; an
 * edit whose outcome is unknown is sent again a window later, so the card
 * converges on its request even when an old edit lands late. The press
 * path calls it for its own card with `only`.
 */
export async function settleSlackCards(deps: {
  store: SlackCardSettleStore;
  slack: Required<Pick<SlackBotApi, "updateMessage">>;
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  logger: SlackInboxLogger;
  pushSource?: PushSource;
  batchSize: number;
  deadline: number;
  only?: { channelId: string; slackTs: string };
  now?: () => number;
}): Promise<SlackCardSettlePass> {
  const now = deps.now ?? Date.now;
  const timing = SLACK_CARD_SETTLE_TIMING;
  const pass: SlackCardSettlePass = {
    due: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    uncertain: 0,
    deferred: 0,
    abandoned: 0,
    lost: 0,
  };
  const { store } = deps;
  if (deps.only === undefined) {
    await store.expireInflight({
      graceMs: timing.graceMs,
      windowMs: timing.windowMs,
    });
    pass.due = await store.markDue();
    // Only the platform can read the manifest pushApprovability needs.
    let afterSeq: number | null = null;
    while (deps.pushSource !== undefined && now() < deps.deadline) {
      const page = await store.openPushCards({
        limit: deps.batchSize,
        afterSeq,
      });
      for (const push of page) {
        afterSeq = push.seq;
        const verdict = await pushApprovability(
          {
            id: push.sessionId,
            checkpointRevision: push.sessionCheckpointRevision,
          },
          { state: "requested", ...push },
          deps.pushSource,
        );
        const wanted = verdict.approvable ? "open" : "reject_only";
        if (wanted !== push.rendered && (await store.markDueById(push.id))) {
          pass.due += 1;
        }
      }
      if (page.length < deps.batchSize) break;
    }
  }
  const failed = async (claim: SlackCardClaim, error: string) => {
    const attempts = claim.attempts + 1;
    if (attempts >= timing.maxAttempts) {
      await store.abandon(claim, error);
      pass.abandoned += 1;
      return;
    }
    await store.defer(claim, {
      retryInMs:
        timing.backoffMs[Math.min(attempts, timing.backoffMs.length) - 1] ??
        timing.retryMs,
      failed: true,
      error,
    });
    pass.deferred += 1;
  };
  while (now() < deps.deadline) {
    const batch = await store.claim({
      limit: deps.only === undefined ? deps.batchSize : 1,
      leaseMs: timing.leaseMs,
      graceMs: timing.graceMs,
      ...(deps.only === undefined ? {} : { only: deps.only }),
    });
    if (batch.length === 0) break;
    for (const claim of batch) {
      pass.claimed += 1;
      const ids = { id: claim.id, channel_id: claim.channelId };
      try {
        if (now() >= deps.deadline) {
          // Out of time: hand the row back for the next pass.
          await store.defer(claim, {
            retryInMs: 0,
            failed: false,
            error: null,
          });
          pass.deferred += 1;
          continue;
        }
        const drawn = await drawCard(store, claim, deps.pushSource);
        if (drawn === null) {
          deps.logger.warn("Slack card's request is gone; left as it is", ids);
          await store.abandon(claim, "request_gone");
          pass.abandoned += 1;
          continue;
        }
        if (
          drawn.rendered === claim.rendered &&
          !claim.uncertain &&
          !claim.inherited
        ) {
          if (await store.skip(claim)) pass.skipped += 1;
          else pass.lost += 1;
          continue;
        }
        const botToken = await deps
          .botToken(claim.workspaceId, claim.slackAppId)
          .catch(() => null);
        if (botToken === null) {
          await failed(claim, "no_bot_token");
          continue;
        }
        const startedAt = await store.beginSend(claim, timing.minLeaseLeftMs);
        if (startedAt === null) {
          pass.lost += 1;
          continue;
        }
        const edit = (blocks: unknown[]) =>
          deps.slack.updateMessage(botToken, {
            channelId: claim.channelId,
            ts: claim.slackTs,
            text: drawn.text,
            blocks,
          });
        let failure: Error | null = null;
        try {
          await edit(drawn.blocks);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        // Blocks Slack refuses go once more as the card's text alone, which
        // slackCardText made safe as mrkdwn.
        if (
          failure instanceof SlackApiError &&
          failure.answered &&
          CARD_BAD_BLOCKS.has(failure.code)
        ) {
          failure = null;
          try {
            await edit([
              { type: "section", text: { type: "mrkdwn", text: drawn.text } },
            ]);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            if (
              failure instanceof SlackApiError &&
              failure.answered &&
              CARD_BAD_BLOCKS.has(failure.code)
            ) {
              deps.logger.warn("Slack refused the card's blocks and text", {
                ...ids,
                code: failure.code,
              });
              await store.abandon(claim, failure.code);
              pass.abandoned += 1;
              continue;
            }
          }
        }
        if (failure === null) {
          const finished = await store
            .finish(claim, {
              rendered: drawn.rendered,
              uncertainRev: claim.uncertainRev,
              windowMs: timing.windowMs,
            })
            .catch(() => false);
          if (finished) {
            pass.sent += 1;
          } else {
            // Slack took it, but another writer may have edited since.
            await store.uncertain(claim, startedAt, timing.windowMs);
            pass.uncertain += 1;
          }
          continue;
        }
        const code = failure instanceof SlackApiError ? failure.code : "error";
        if (failure instanceof SlackRateLimitedError) {
          await store.defer(claim, {
            retryInMs: Math.max(
              timing.retryMs,
              failure.retryAfterSeconds * 1000,
            ),
            failed: false,
            error: code,
          });
          pass.deferred += 1;
        } else if (
          failure instanceof SlackApiError &&
          failure.answered &&
          code !== "timeout"
        ) {
          if (CARD_GONE.has(code)) {
            deps.logger.warn("Slack card can no longer be edited", {
              ...ids,
              code,
            });
            await store.abandon(claim, code);
            pass.abandoned += 1;
          } else {
            deps.logger.warn("Slack card edit failed", { ...ids, code });
            await failed(claim, code);
          }
        } else {
          deps.logger.warn("Slack card edit outcome unknown", { ...ids, code });
          await store.uncertain(claim, startedAt, timing.windowMs);
          pass.uncertain += 1;
        }
      } catch (error) {
        // One card's failure leaves the others, and the outbox, going.
        deps.logger.warn("Slack card step failed for a card", {
          ...ids,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (deps.only !== undefined) break;
  }
  return pass;
}

/**
 * One outbox pass of the `slack` role: rows whose send outlived its lease
 * become `uncertain` (a lost reply gets a notice saying so), unanswered
 * turns are enqueued, then due rows are sent and thread statuses written,
 * in the order `statusesFirst` picks, until none is left or `deadline`
 * passes. Each row starts before its step's deadline, so a step overruns
 * it by at most one row's calls. A row is `sending` only while its request is in
 * flight, so nothing Slack may already hold is sent twice.
 */
export async function drainSlackOutbox(deps: {
  outbox: SlackOutboxStore;
  slack: Pick<SlackBotApi, "setStatus" | "updateMessage"> & SlackBotSender;
  /** Null without a master key: rows wait, unsent. */
  botToken:
    | ((workspaceId: string, slackAppId: string) => Promise<string | null>)
    | null;
  logger: SlackInboxLogger;
  consoleOrigin: string | null;
  batchSize: number;
  leaseMs: number;
  deadline: number;
  /** Statuses in the first third, then posts; otherwise posts in the first two thirds, then statuses. */
  statusesFirst?: boolean;
  now?: () => number;
}): Promise<SlackOutboxDrain> {
  const now = deps.now ?? Date.now;
  const started = now();
  const drain: SlackOutboxDrain = {
    enqueued: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    uncertain: 0,
    lost: 0,
    statuses: 0,
    cards: 0,
  };
  // A reply Slack may or may not hold: the thread hears so, once.
  const noticeUncertain = async (row: SlackOutboxLost) => {
    if (row.kind !== "reply" || row.sessionId === null) return;
    const link_url = sessionUrl(deps.consoleOrigin, row.sessionId);
    const locale = row.body.locale ?? DEFAULT_USER_LOCALE;
    const text = SLACK_OUTBOX_MESSAGES[locale].uncertain;
    await deps.outbox.enqueue({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      installationId: row.installationId,
      kind: "failure_notice",
      channelId: row.channelId,
      threadTs: row.threadTs,
      slackUserId: null,
      sessionId: row.sessionId,
      body:
        link_url === undefined ? { text, locale } : { text, locale, link_url },
      dedupeKey: `uncertain:${row.id}`,
    });
  };
  // An instruction goes under its sender's name and profile image. An app
  // installed before chat:write.customize may be refused the name; Slack
  // posted nothing then, so it goes once more as the app.
  // Read before beginSend, so a slow users.info spends no send lease.
  const senderImage = (botToken: string, claim: SlackOutboxClaim) =>
    claim.kind !== "instruction" ||
    claim.body.sender?.slack_user_id === undefined
      ? Promise.resolve(null)
      : deps.slack
          .userImage(botToken, claim.body.sender.slack_user_id)
          .catch(() => null);
  const postMessage = async (
    botToken: string,
    claim: SlackOutboxClaim,
    text: string,
    iconUrl: string | null,
  ) => {
    const target = {
      channelId: claim.channelId,
      threadTs: claim.threadTs,
      text,
    };
    const sender = claim.body.sender;
    if (claim.kind !== "instruction" || sender === undefined) {
      if (claim.body.blocks !== undefined) {
        return deps.slack.postMessage(botToken, {
          ...target,
          blocks: claim.body.blocks,
        });
      }
      const blocks =
        claim.kind === "reply" ? slackReplyBlocks(claim.body) : null;
      if (blocks === null) return deps.slack.postMessage(botToken, target);
      const response = await deps.slack.postMessage(botToken, {
        ...target,
        blocks,
      });
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
    const named = `${sender.username}\n`;
    return deps.slack.postMessage(botToken, {
      ...target,
      text: claim.body.text.startsWith(named)
        ? text
        : slackOutboxText({ ...claim.body, text: named + claim.body.text }),
    });
  };
  for (const lost of await deps.outbox.expireSending()) {
    drain.uncertain += 1;
    deps.logger.warn("Slack send outlived its lease; marked uncertain", {
      id: lost.id,
      kind: lost.kind,
      channel_id: lost.channelId,
    });
  }
  for (const closed of await deps.outbox.closeUnaddressed()) {
    drain.failed += 1;
    deps.logger.info("Slack send dropped; its thread no longer takes it", {
      id: closed.id,
      kind: closed.kind,
      channel_id: closed.channelId,
    });
  }
  // Also those a pass marked and died before telling, or told with a failed
  // enqueue: the notice is the dedupe key's, so it goes once.
  for (const row of await deps.outbox.untoldUncertain(deps.batchSize)) {
    await noticeUncertain(row);
  }
  await deps.outbox.advanceAnswered();
  // First, so an answer enqueued below is claimed after what it answers.
  drain.enqueued = await enqueueSlackInstructions({
    outbox: deps.outbox,
    limit: deps.batchSize,
  });
  drain.enqueued += await enqueueSlackTurnAnswers({
    outbox: deps.outbox,
    consoleOrigin: deps.consoleOrigin,
    limit: deps.batchSize,
  });
  drain.enqueued += await enqueueSlackPrompts({
    outbox: deps.outbox,
    consoleOrigin: deps.consoleOrigin,
    limit: deps.batchSize,
  });
  if (deps.botToken === null) return drain;

  const botTokenOf = deps.botToken;
  // Its failures only delay the statuses.
  const writeStatuses = async (until: number) => {
    const threadStatus = deps.outbox.threadStatus;
    // A status backlog keeps only half the window, so the cards always get
    // a turn.
    const statusesUntil = now() + Math.max(0, until - now()) / 2;
    if (threadStatus !== undefined) {
      try {
        await reconcileSlackThreadStatuses({ store: threadStatus });
        const statuses = await writeSlackThreadStatuses({
          store: threadStatus,
          slack: deps.slack,
          botToken: botTokenOf,
          logger: deps.logger,
          batchSize: deps.batchSize,
          deadline: statusesUntil,
          now,
        });
        drain.statuses = statuses.sent;
      } catch (error) {
        deps.logger.warn("Slack status step failed; going on", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const cards = deps.outbox.cards;
    const updateMessage = deps.slack.updateMessage;
    if (cards === undefined || updateMessage === undefined) return;
    try {
      const settled = await settleSlackCards({
        store: cards,
        slack: { updateMessage },
        botToken: botTokenOf,
        logger: deps.logger,
        batchSize: SLACK_CARD_SETTLE_TIMING.batchSize,
        deadline: until,
        now,
      });
      drain.cards = settled.sent;
    } catch (error) {
      deps.logger.warn("Slack card step failed; going on", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Whichever step goes first may spend a short window on one slow call,
  // so the caller alternates them pass by pass. Each step starts a call
  // only before its deadline.
  const firstSplit = started + Math.max(0, deps.deadline - started) / 3;
  const postsUntil = deps.statusesFirst
    ? deps.deadline
    : started + Math.max(0, deps.deadline - started) * (2 / 3);
  if (deps.statusesFirst) await writeStatuses(firstSplit);

  while (now() < postsUntil) {
    const batch = await deps.outbox.claim({
      limit: deps.batchSize,
      leaseMs: deps.leaseMs,
    });
    if (batch.length === 0) break;
    for (const claim of batch) {
      // Out of time: the row is still pending and comes back once its
      // lease runs out.
      if (now() >= postsUntil) break;
      drain.claimed += 1;
      const ids = {
        id: claim.id,
        kind: claim.kind,
        channel_id: claim.channelId,
        attempts: claim.attempts,
      };
      const settle = async (outcome: SlackOutboxSettle) => {
        if (!(await deps.outbox.settle(claim, outcome))) {
          drain.lost += 1;
          deps.logger.warn("Slack outbox lease lost", ids);
          return false;
        }
        drain[
          outcome.status === "pending"
            ? "retried"
            : outcome.status === "sent"
              ? "sent"
              : outcome.status
        ] += 1;
        if (outcome.status !== "sent") {
          deps.logger.warn("Slack send not delivered", {
            ...ids,
            status: outcome.status,
            error: outcome.errorCode,
          });
        }
        return true;
      };

      let botToken: string | null;
      try {
        botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
      } catch {
        botToken = null;
      }
      if (botToken === null) {
        await settle(
          claim.attempts >= SLACK_SEND_MAX_ATTEMPTS
            ? { status: "failed", errorCode: "no_bot_token" }
            : {
                status: "pending",
                errorCode: "no_bot_token",
                retryInMs: slackInboundBackoffMs(claim.attempts),
              },
        );
        continue;
      }
      const iconUrl = await senderImage(botToken, claim);
      if (!(await deps.outbox.beginSend(claim))) {
        drain.lost += 1;
        deps.logger.warn("Slack outbox lease lost before send", ids);
        continue;
      }

      // A card's text is slackCardText's, escaped and linked already.
      const text =
        claim.kind === "input_notice" && claim.body.blocks !== undefined
          ? claim.body.text
          : slackOutboxText(claim.body);
      let outcome: SlackOutboxSettle;
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
        outcome = settleFor(claim, response);
      } catch (error) {
        // No answer came: the request may have reached Slack.
        outcome = {
          status: "uncertain",
          errorCode: error instanceof SlackApiError ? error.code : "send_threw",
        };
      }
      const settled = await settle(outcome);
      if (settled && outcome.status === "uncertain") {
        await noticeUncertain(claim);
      }
    }
  }
  if (!deps.statusesFirst) await writeStatuses(deps.deadline);
  return drain;
}
