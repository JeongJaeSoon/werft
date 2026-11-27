import { DEFAULT_USER_LOCALE } from "@werft-ai/contracts";
import type {
  DeliveryOutcome,
  SurfaceOutboxLost,
  SurfaceOutboxSettle,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import { messageOf, type SurfaceBindingStore } from "@werft-ai/platform";
import type { RowDelivery, RowDeliveryInput } from "./outbox-delivery.ts";
import {
  SLACK_CARD_SETTLE_TIMING,
  type SlackRequesterLeft,
  settleSlackCards,
} from "./slack-card-settle.ts";
import { enqueueSlackChannelNotices } from "./slack-channel-notice.ts";
import type { SlackBotApi, SlackBotSender } from "./slack-config-api.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import {
  enqueueSlackCapacityWaits,
  enqueueSlackInputMirrors,
  enqueueSlackInstructions,
  enqueueSlackProgress,
  enqueueSlackPrompts,
  enqueueSlackTurnAnswers,
} from "./slack-outbox-enqueue.ts";
import { SLACK_OUTBOX_MESSAGES, sessionUrl } from "./slack-outbox-render.ts";
import {
  reconcileSlackThreadStatuses,
  writeSlackThreadStatuses,
} from "./slack-session-status.ts";

/** The row settle a delivery ends in; `lease_lost` settles nothing. */
function settleOf(
  outcome: Exclude<DeliveryOutcome, { kind: "lease_lost" }>,
): SurfaceOutboxSettle {
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", slackTs: outcome.ref };
    case "retry":
      return {
        status: "pending",
        errorCode: outcome.code,
        retryInMs: outcome.retryAfterMs,
      };
    case "failed":
      return outcome.retryAfterMs === undefined
        ? { status: "failed", errorCode: outcome.code }
        : {
            status: "failed",
            errorCode: outcome.code,
            retryInMs: outcome.retryAfterMs,
          };
    case "uncertain":
      return { status: "uncertain", errorCode: outcome.code };
  }
}

export type SlackOutboxDrain = {
  enqueued: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  uncertain: number;
  lost: number;
  /** Rows never sent: a source was deleted in Slack before the send. */
  voided: number;
  /** Rows held back unsent by a rate limit another row's send ran into. */
  deferred: number;
  /** Thread statuses sent. */
  statuses: number;
  /** Posted cards redrawn. */
  cards: number;
  /**
   * Web input mirrors that opened a thread a reply had already made a topic
   * of; the input took the post as its alias, its topic stayed unplaced.
   */
  topicAliasTaken: number;
  /**
   * Rows held for a web input's thread past `inputHoldMs`, closed unsent;
   * the input reads `unconfirmed`.
   */
  heldClosed: number;
  /** Links of closed sessions closed, their last report in. */
  linksClosed: number;
};

/** How long a row waits for its web input's Slack post before it closes. */
export const SLACK_INPUT_HOLD_MS = 60 * 60_000;

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
  outbox: SurfaceOutboxStore;
  slack: Pick<SlackBotApi, "setStatus" | "updateMessage"> & SlackBotSender;
  /** Null without a master key: rows wait, unsent. */
  botToken:
    | ((workspaceId: string, slackAppId: string) => Promise<string | null>)
    | null;
  /** How a claimed row reaches the channel; see `createRowDelivery`. */
  delivery: RowDelivery;
  /** Told when Slack no longer finds a channel a row was sent to. */
  bindings?: Pick<SurfaceBindingStore, "channelNotFound">;
  logger: SlackInboxLogger;
  consoleOrigin: string | null;
  batchSize: number;
  leaseMs: number;
  deadline: number;
  /** Statuses in the first third, then posts; otherwise posts in the first two thirds, then statuses. */
  statusesFirst?: boolean;
  requesterLeft?: SlackRequesterLeft;
  /** Defaults to `SLACK_INPUT_HOLD_MS`. */
  inputHoldMs?: number;
  /**
   * Closes the links of closed sessions once their last report is in, so the
   * thread's next mention opens a new link. Off when absent; the slack role
   * turns it on unless `SLACK_ROLE_CLOSE_LINKS` is false.
   */
  closeLinks?: boolean;
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
    voided: 0,
    deferred: 0,
    statuses: 0,
    cards: 0,
    topicAliasTaken: 0,
    heldClosed: 0,
    linksClosed: 0,
  };
  // A reply Slack may or may not hold: the thread hears so, once.
  const noticeUncertain = async (row: SurfaceOutboxLost) => {
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
      sessionLinkId: row.sessionLinkId,
      body:
        link_url === undefined ? { text, locale } : { text, locale, link_url },
      dedupeKey: `uncertain:${row.id}`,
      sources: row.sources ?? null,
      sourcesTurn: row.sourcesTurn ?? null,
    });
  };
  // The notice kinds go through Notifiable, a decision request through
  // Approvable; the rest the sender posts itself.
  const deliver = (input: RowDeliveryInput) => {
    switch (input.row.kind) {
      case "notice":
      case "failure_notice":
      case "action_notice":
      case "model_notice":
        return deps.delivery.notifiable.notify(input);
      case "input_notice":
        return deps.delivery.approvable.requestDecision(input);
      case "instruction":
      case "input_mirror":
      case "reply":
      case "welcome":
      case "channel_notice":
      case "progress":
      case "reaction":
      case "conversation_reply":
      case "emergency_stop_notice":
        return deps.delivery.direct(input);
    }
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
  drain.heldClosed = await deps.outbox.closeOverdueHeld(
    deps.inputHoldMs ?? SLACK_INPUT_HOLD_MS,
  );
  if (drain.heldClosed > 0) {
    deps.logger.warn(
      "Slack rows held for a web input's post closed unsent; Slack never confirmed the post",
      { count: drain.heldClosed },
    );
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
  drain.enqueued += await enqueueSlackInputMirrors({
    outbox: deps.outbox,
    limit: deps.batchSize,
  });
  // Before the answers: a wait that ran out is told before its failure.
  drain.enqueued += await enqueueSlackCapacityWaits({
    outbox: deps.outbox,
    consoleOrigin: deps.consoleOrigin,
    limit: deps.batchSize,
  });
  drain.enqueued += await enqueueSlackProgress({
    outbox: deps.outbox,
    consoleOrigin: deps.consoleOrigin,
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
  drain.enqueued += await enqueueSlackChannelNotices({
    outbox: deps.outbox,
    limit: deps.batchSize,
  });
  // After the enqueues, so a link closes only past its last report's row;
  // the mark moves first past the rows just enqueued.
  if (deps.closeLinks === true) {
    await deps.outbox.advanceAnswered();
    drain.linksClosed = await deps.outbox.closeFinishedLinks(deps.batchSize);
  }
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
          error: messageOf(error),
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
        ...(deps.requesterLeft === undefined
          ? {}
          : { requesterLeft: deps.requesterLeft }),
      });
      drain.cards = settled.sent;
    } catch (error) {
      deps.logger.warn("Slack card step failed; going on", {
        error: messageOf(error),
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
      const settle = async (outcome: SurfaceOutboxSettle) => {
        const settled = await deps.outbox.settle(claim, outcome);
        if (!settled) {
          drain.lost += 1;
          deps.logger.warn("Slack outbox lease lost", ids);
          return false;
        }
        if (settled === "topic_alias_taken") {
          drain.topicAliasTaken += 1;
          deps.logger.warn(
            "Slack mirror opened a thread another topic already holds; the topics stay apart",
            ids,
          );
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

      // When Slack is asked, so a join noted after it outdates its answer.
      const askedAt = Date.now() * 1000;
      let voided = false;
      let deferred = false;
      const outcome = await deliver({
        row: claim,
        attempts: claim.attempts,
        begin: async () => {
          const begun = await deps.outbox.beginSend(claim);
          if (begun !== "voided_by_delete" && begun !== "rate_limited") {
            return begun;
          }
          voided = begun === "voided_by_delete";
          deferred = begun === "rate_limited";
          return false;
        },
      });
      if (outcome.kind === "lease_lost" && deferred) {
        drain.deferred += 1;
        continue;
      }
      if (outcome.kind === "lease_lost" && voided) {
        drain.voided += 1;
        deps.logger.warn("Slack send voided: a source was deleted", {
          ...ids,
          error: "source_deleted",
        });
        continue;
      }
      if (outcome.kind === "lease_lost") {
        drain.lost += 1;
        deps.logger.warn("Slack outbox lease lost before send", ids);
        continue;
      }
      const settled = await settle(settleOf(outcome));
      if (settled && outcome.kind === "uncertain") {
        await noticeUncertain(claim);
      }
      // The channel is gone, or a private one lost the bot: its binding says
      // so, and no row goes there after this one. A DM or a user channel has
      // no binding of its own and is left alone.
      if (
        settled &&
        outcome.kind === "failed" &&
        outcome.code === "channel_not_found" &&
        !claim.channelId.startsWith("D")
      ) {
        await deps.bindings?.channelNotFound(
          claim.installationId,
          claim.channelId,
          askedAt,
        );
      }
    }
  }
  if (!deps.statusesFirst) await writeStatuses(deps.deadline);
  return drain;
}
