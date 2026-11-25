import { DEFAULT_USER_LOCALE } from "@werft-ai/contracts";
import type {
  SurfaceCardClaim,
  SurfaceCardRendered,
  SurfaceCardSettleStore,
} from "@werft-ai/platform";
import {
  messageOf,
  type PushSource,
  pushApprovability,
} from "@werft-ai/platform";
import {
  SlackApiError,
  type SlackBotApi,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import { slackOutboxGuard } from "./slack-outbox-render.ts";
import {
  guardSlackCardBlocks,
  slackDoneCard,
  slackRejectOnlyCard,
  slackRequesterLeftCard,
  slackSettledCard,
  slackSettledResult,
} from "./slack-prompts.ts";

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
  rendered: SurfaceCardRendered;
  text: string;
  blocks: unknown[];
};

/**
 * Whether a private channel card's requester left every channel of its
 * session (the policy's requesterLeft): a member may then decide it.
 */
export type SlackRequesterLeft = (
  card: {
    workspaceId: string;
    sessionId: string;
  } & ({ pushRequestId: string } | { pendingRequestId: string }),
) => Promise<boolean>;

/**
 * What the card should show now: its request as stored, and a push, tool
 * permission or question still waiting says so when its requester left the
 * private channel.
 */
async function drawCard(
  store: SurfaceCardSettleStore,
  claim: SurfaceCardClaim,
  deps: { pushSource?: PushSource; requesterLeft?: SlackRequesterLeft },
): Promise<DrawnCard | null> {
  const drawn = await drawChoice(store, claim, deps.pushSource);
  const [prefix, , ...rest] = claim.dedupeKey.split(":");
  if (
    drawn === null ||
    (drawn.rendered !== "open" && drawn.rendered !== "reject_only") ||
    (prefix !== "push" && prefix !== "prompt") ||
    claim.sessionId === null ||
    deps.requesterLeft === undefined ||
    !(await deps.requesterLeft({
      workspaceId: claim.workspaceId,
      sessionId: claim.sessionId,
      ...(prefix === "push"
        ? { pushRequestId: rest.join(":") }
        : { pendingRequestId: rest.join(":") }),
    }))
  ) {
    return drawn;
  }
  return {
    rendered:
      drawn.rendered === "open"
        ? "open_requester_left"
        : "reject_only_requester_left",
    ...slackRequesterLeftCard(drawn, claim.body.locale ?? DEFAULT_USER_LOCALE),
  };
}

/**
 * What the card should show from its request as stored. Null when the
 * request is gone from the owner's sessions.
 */
async function drawChoice(
  store: SurfaceCardSettleStore,
  claim: SurfaceCardClaim,
  pushSource: PushSource | undefined,
): Promise<DrawnCard | null> {
  // Redrawn in the scope the card was first drawn in (94S-2213).
  const { guard } = slackOutboxGuard({
    kind: "input_notice",
    channelId: claim.channelId,
    conversationScope: claim.conversationScope ?? null,
  });
  // The stored text is escaped mrkdwn: what the guard can still find there
  // is a bare word, URL or id, and the platform's own controls stay in scope.
  const open = {
    rendered: "open" as const,
    text: guard(claim.body.text),
    blocks: guardSlackCardBlocks(claim.body.blocks ?? [], guard),
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
    const settled = slackSettledCard(card, guard);
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
      guard,
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
  store: SurfaceCardSettleStore;
  slack: Required<Pick<SlackBotApi, "updateMessage">>;
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  logger: SlackInboxLogger;
  pushSource?: PushSource;
  requesterLeft?: SlackRequesterLeft;
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
        if (
          wanted !== push.rendered.replace("_requester_left", "") &&
          (await store.markDueById(push.id))
        ) {
          pass.due += 1;
        }
      }
      if (page.length < deps.batchSize) break;
    }
  }
  const failed = async (claim: SurfaceCardClaim, error: string) => {
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
        const drawn = await drawCard(store, claim, deps);
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
          error: messageOf(error),
        });
      }
    }
    if (deps.only !== undefined) break;
  }
  return pass;
}
