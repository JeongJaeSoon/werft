import type {
  SlackInboxLogger,
  SlackThreadStatusFacts,
  SlackThreadStatusStore,
} from "@werft-ai/platform";
import {
  type PushSource,
  pushApprovability,
  SlackApiError,
  type SlackBotApi,
  SlackRateLimitedError,
} from "@werft-ai/platform";

/** What `agents.sessions.setStatus` shows under a Slack thread. */
export type SlackThreadStatus =
  | "processing"
  | "suspended"
  | "active"
  | "closed";

/**
 * - `recovery`: answers to its pending requests cannot carry the session on
 *   (recovery_required, a turn of unknown outcome, revoked execution).
 * - `paused`: nothing runs until a person resumes it.
 */
export type SlackSessionLifecycle = "open" | "paused" | "recovery" | "closed";

/**
 * A push intent (L4) or a pull request stage (L5) of the session. No source
 * fills it yet; those tickets decide what each state contributes.
 */
export type SlackStatusActionStage = {
  kind: "push_intent" | "pull_request";
  id: string;
  state: string;
};

/** One session's state, as `slackSessionStatus` reads it. */
export type SlackSessionStatusMaterial = {
  lifecycle: SlackSessionLifecycle;
  /** A push request `pushApprovability` would let a person approve. */
  approvablePush: boolean;
  /** A pending request the answer path would accept. */
  answerableRequest: boolean;
  /** A turn running or waiting on input. */
  runningTurn: boolean;
  /** A queued turn, platform continuation and follow-up turns included. */
  queuedTurn: boolean;
  actionStages: readonly SlackStatusActionStage[];
};

/**
 * The thread status for a session: the first rule that holds (design
 * slack-approval-ui §5). A pending push goes before recovery because the
 * server still takes push decisions there; a pending request does not,
 * because its answer is refused there.
 */
export function slackSessionStatus(
  material: SlackSessionStatusMaterial,
): SlackThreadStatus {
  if (material.lifecycle === "closed") return "closed";
  if (material.approvablePush) return "suspended";
  if (material.lifecycle === "recovery") return "active";
  if (material.answerableRequest) return "suspended";
  if (material.lifecycle === "paused") return "active";
  if (material.runningTurn || material.queuedTurn) return "processing";
  return "active";
}

/** Design slack-approval-ui §4–§5: lease 60s, takeover grace 30s, W 5 min. */
export const SLACK_THREAD_STATUS_TIMING = {
  leaseMs: 60_000,
  graceMs: 30_000,
  /** The longest Slack is taken to sit on a request before applying it. */
  windowMs: 5 * 60_000,
  /** Above the 10s HTTP deadline (SLACK_HTTP_TIMEOUT_MS) with room to spare. */
  minLeaseLeftMs: 15_000,
  /** Slack drops `processing` after an hour on its own. */
  processingRefreshMs: 50 * 60_000,
  disabledForMs: 24 * 60 * 60_000,
  retryMs: 30_000,
  reconcileBatch: 50,
} as const;

/** Answers that mean the workspace shows no thread status there. */
const SET_STATUS_DISABLED = new Set([
  "not_authorized",
  "feature_disabled",
  "thread_ts_required",
]);

export async function slackStatusMaterial(
  sessionId: string,
  facts: SlackThreadStatusFacts,
  pushSource?: PushSource,
): Promise<SlackSessionStatusMaterial> {
  const session = {
    id: sessionId,
    checkpointRevision: facts.checkpointRevision,
  };
  let approvablePush = false;
  for (const push of facts.requestedPushes) {
    const verdict = await pushApprovability(
      session,
      { state: "requested", ...push },
      pushSource,
    );
    if (verdict.approvable) {
      approvablePush = true;
      break;
    }
  }
  return {
    lifecycle:
      facts.admissionState === "closed"
        ? "closed"
        : facts.admissionState === "recovery_required" ||
            facts.unknownTurn ||
            facts.executionRevoked
          ? "recovery"
          : facts.admissionState === "paused" ||
              facts.admissionState === "stopped"
            ? "paused"
            : "open",
    approvablePush,
    answerableRequest: facts.answerableRequest,
    runningTurn: facts.runningTurn,
    queuedTurn: facts.queuedTurn,
    actionStages: facts.actionStages,
  };
}

const processingStale = (
  sentStatus: string | null,
  sentAt: Date | null,
  now: number,
) =>
  sentStatus === "processing" &&
  sentAt !== null &&
  now - sentAt.getTime() >= SLACK_THREAD_STATUS_TIMING.processingRefreshMs;

export type SlackThreadStatusPass = {
  expired: number;
  claimed: number;
  sent: number;
  skipped: number;
  uncertain: number;
  deferred: number;
  disabled: number;
  lost: number;
};

/**
 * The drain's thread status step: one writer per thread at a time, under
 * a lease, sends the status computed after the last change. A send whose
 * outcome is unknown is sent again a window later, so Slack converges on
 * the computed status even when an old call lands late. A failure only
 * delays the row; nothing else waits on it.
 */
export async function writeSlackThreadStatuses(deps: {
  store: SlackThreadStatusStore;
  slack: Pick<SlackBotApi, "setStatus">;
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  logger: SlackInboxLogger;
  pushSource?: PushSource;
  batchSize: number;
  deadline: number;
  now?: () => number;
}): Promise<SlackThreadStatusPass> {
  const now = deps.now ?? Date.now;
  const timing = SLACK_THREAD_STATUS_TIMING;
  const pass: SlackThreadStatusPass = {
    expired: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    uncertain: 0,
    deferred: 0,
    disabled: 0,
    lost: 0,
  };
  pass.expired = await deps.store.expireInflight({
    graceMs: timing.graceMs,
    windowMs: timing.windowMs,
  });
  while (now() < deps.deadline) {
    const batch = await deps.store.claim({
      limit: deps.batchSize,
      leaseMs: timing.leaseMs,
      graceMs: timing.graceMs,
    });
    if (batch.length === 0) break;
    for (const claim of batch) {
      pass.claimed += 1;
      const ids = {
        session_link_id: claim.sessionLinkId,
        channel_id: claim.channelId,
      };
      try {
        if (now() >= deps.deadline) {
          // Out of time: hand the row back for the next pass.
          await deps.store.defer(claim, 0);
          pass.deferred += 1;
          continue;
        }
        const facts = await deps.store.facts(claim.sessionId);
        if (facts === null) {
          if (await deps.store.skip(claim, claim.dirtyRev)) pass.skipped += 1;
          continue;
        }
        const status = slackSessionStatus(
          await slackStatusMaterial(claim.sessionId, facts, deps.pushSource),
        );
        if (
          status === claim.sentStatus &&
          !claim.uncertain &&
          !claim.inherited &&
          !processingStale(claim.sentStatus, claim.sentAt, now())
        ) {
          if (await deps.store.skip(claim, claim.dirtyRev)) pass.skipped += 1;
          else pass.lost += 1;
          continue;
        }
        const botToken = await deps
          .botToken(claim.workspaceId, claim.slackAppId)
          .catch(() => null);
        if (botToken === null) {
          await deps.store.defer(claim, timing.retryMs);
          pass.deferred += 1;
          continue;
        }
        const startedAt = await deps.store.beginSend(
          claim,
          timing.minLeaseLeftMs,
        );
        if (startedAt === null) {
          pass.lost += 1;
          continue;
        }
        let failure: SlackApiError | Error | null = null;
        try {
          await deps.slack.setStatus(botToken, {
            channelId: claim.channelId,
            threadTs: claim.threadTs,
            status,
          });
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (failure === null) {
          const finished = await deps.store
            .finish(claim, {
              dirtyRev: claim.dirtyRev,
              status,
              startedAt,
              uncertainRev: claim.uncertainRev,
              windowMs: timing.windowMs,
            })
            .catch(() => false);
          if (finished) {
            pass.sent += 1;
          } else {
            // Slack took it, but another writer may have sent since.
            await deps.store.uncertain(claim, startedAt, timing.windowMs);
            pass.uncertain += 1;
          }
          continue;
        }
        const code = failure instanceof SlackApiError ? failure.code : "error";
        if (failure instanceof SlackApiError && SET_STATUS_DISABLED.has(code)) {
          deps.logger.info("Slack status not shown", { ...ids, code });
          await deps.store.disable(claim, code);
          pass.disabled += 1;
        } else if (
          failure instanceof SlackApiError &&
          failure.answered &&
          code !== "timeout"
        ) {
          // Slack answered with an error: nothing was applied.
          deps.logger.warn("Slack status failed; going on", { ...ids, code });
          await deps.store.defer(
            claim,
            failure instanceof SlackRateLimitedError
              ? Math.max(timing.retryMs, failure.retryAfterSeconds * 1000)
              : timing.retryMs,
          );
          pass.deferred += 1;
        } else {
          deps.logger.warn("Slack status outcome unknown", { ...ids, code });
          await deps.store.uncertain(claim, startedAt, timing.windowMs);
          pass.uncertain += 1;
        }
      } catch (error) {
        // One thread's failure leaves the others, and the outbox, going.
        deps.logger.warn("Slack status step failed for a thread", {
          ...ids,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return pass;
}

/**
 * Catches what no write announced: a request that expired, a lease that
 * ran out, Slack's own hour on `processing`. Walks the live links longest
 * unreconciled first, so every one comes round in turn.
 */
export async function reconcileSlackThreadStatuses(deps: {
  store: SlackThreadStatusStore;
  pushSource?: PushSource;
  limit?: number;
  now?: () => number;
}): Promise<{ checked: number; dirty: number }> {
  const now = deps.now ?? Date.now;
  const rows = await deps.store.reconcileBatch({
    limit: deps.limit ?? SLACK_THREAD_STATUS_TIMING.reconcileBatch,
    disabledForMs: SLACK_THREAD_STATUS_TIMING.disabledForMs,
  });
  const marks: { sessionLinkId: string; dirty: boolean }[] = [];
  for (const row of rows) {
    const status = slackSessionStatus(
      await slackStatusMaterial(row.sessionId, row.facts, deps.pushSource),
    );
    marks.push({
      sessionLinkId: row.sessionLinkId,
      dirty:
        status !== row.sentStatus ||
        processingStale(row.sentStatus, row.sentAt, now()),
    });
  }
  await deps.store.reconciled(marks);
  return {
    checked: rows.length,
    dirty: marks.filter((mark) => mark.dirty).length,
  };
}
