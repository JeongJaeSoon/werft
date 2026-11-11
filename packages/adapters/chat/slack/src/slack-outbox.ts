import { DEFAULT_USER_LOCALE } from "@werft-ai/contracts";
import type {
  DeliveryInput,
  DeliveryOutcome,
  SlackOutboxLost,
  SlackOutboxSettle,
  SlackOutboxStore,
} from "@werft-ai/platform";
import type { RowDelivery } from "./outbox-delivery.ts";
import {
  SLACK_CARD_SETTLE_TIMING,
  settleSlackCards,
} from "./slack-card-settle.ts";
import type { SlackBotApi, SlackBotSender } from "./slack-config-api.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import {
  enqueueSlackInstructions,
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
): SlackOutboxSettle {
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
      return { status: "failed", errorCode: outcome.code };
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
  /** Thread statuses sent. */
  statuses: number;
  /** Posted cards redrawn. */
  cards: number;
};

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
  /** How a claimed row reaches the channel; see `createRowDelivery`. */
  delivery: RowDelivery;
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
  // The notice kinds go through Notifiable, a decision request through
  // Approvable; the rest the sender posts itself.
  const deliver = (input: DeliveryInput) => {
    switch (input.row.kind) {
      case "notice":
      case "failure_notice":
      case "action_notice":
      case "model_notice":
        return deps.delivery.notifiable.notify(input);
      case "input_notice":
        return deps.delivery.approvable.requestDecision(input);
      case "instruction":
      case "reply":
      case "welcome":
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

      const outcome = await deliver({
        row: claim,
        attempts: claim.attempts,
        begin: async () => deps.outbox.beginSend(claim),
      });
      if (outcome.kind === "lease_lost") {
        drain.lost += 1;
        deps.logger.warn("Slack outbox lease lost before send", ids);
        continue;
      }
      const settled = await settle(settleOf(outcome));
      if (settled && outcome.kind === "uncertain") {
        await noticeUncertain(claim);
      }
    }
  }
  if (!deps.statusesFirst) await writeStatuses(deps.deadline);
  return drain;
}
