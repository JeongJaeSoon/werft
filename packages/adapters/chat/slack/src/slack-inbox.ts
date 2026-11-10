import {
  SLACK_INBOUND_MAX_ATTEMPTS,
  type SlackInboundDropReason,
} from "@werft-ai/contracts";
import type {
  SlackInboundClaim,
  SlackInboundEventStore,
} from "@werft-ai/platform";

/**
 * The thread an event belongs to, `<slack_app_id>:<channel>:<thread_ts ??
 * ts>`: a message outside a thread starts its own, and a DM is a channel
 * too. Null for an event that is no channel message.
 */
export function slackConversationKey(
  slackAppId: string,
  event: Record<string, unknown>,
): string | null {
  const text = (value: unknown) =>
    typeof value === "string" && value !== "" ? value : null;
  const channel = text(event.channel);
  const thread = text(event.thread_ts) ?? text(event.ts);
  return channel === null || thread === null
    ? null
    : `${slackAppId}:${channel}:${thread}`;
}

/**
 * Acts on one claimed event. Throwing gives it back for a later attempt;
 * returning marks it processed. 94S-791 puts sessions behind it.
 */
export type SlackInboundHandler = (event: SlackInboundClaim) => Promise<void>;

export const noopSlackInboundHandler: SlackInboundHandler = async () => {};

/** Thrown by a handler to end the event `dropped` instead of retrying it. */
export class SlackInboundDropped extends Error {
  constructor(readonly reason: SlackInboundDropReason) {
    super(`Slack event dropped: ${reason}`);
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;

/** The wait after a failed attempt, `attempts` counting it. */
export function slackInboundBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

export type SlackInboxLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

export type SlackInboxDrain = {
  claimed: number;
  processed: number;
  dropped: number;
  retried: number;
  failed: number;
  lost: number;
};

/**
 * One pass of the `slack` role: claims a batch, acts on each event, and
 * claims again until the inbox has nothing due or `deadline` (ms since the
 * epoch) has passed. The deadline only stops the pass; leases are the
 * database's.
 */
export async function drainSlackInbox(deps: {
  inbox: SlackInboundEventStore;
  handler: SlackInboundHandler;
  logger: SlackInboxLogger;
  batchSize: number;
  leaseMs: number;
  deadline: number;
  now?: () => number;
}): Promise<SlackInboxDrain> {
  const now = deps.now ?? Date.now;
  const maxAttempts = SLACK_INBOUND_MAX_ATTEMPTS;
  const drain: SlackInboxDrain = {
    claimed: 0,
    processed: 0,
    dropped: 0,
    retried: 0,
    failed: 0,
    lost: 0,
  };
  while (now() < deps.deadline) {
    const batch = await deps.inbox.claim({
      limit: deps.batchSize,
      leaseMs: deps.leaseMs,
      maxAttempts,
    });
    if (batch.length === 0) break;
    for (const event of batch) {
      drain.claimed += 1;
      const ids = {
        id: event.id,
        event_id: event.eventId,
        event_type: event.eventType,
        attempts: event.attempts,
      };
      deps.logger.info("Slack event claimed", ids);
      const lost = () => {
        drain.lost += 1;
        deps.logger.warn("Slack event lease lost; left to its next claim", ids);
      };
      if (event.installationStatus === "revoked") {
        if (await deps.inbox.drop(event, "installation_revoked")) {
          drain.dropped += 1;
        } else lost();
        continue;
      }
      let failure: { error: unknown } | undefined;
      try {
        await deps.handler(event);
      } catch (error) {
        failure = { error };
      }
      if (failure?.error instanceof SlackInboundDropped) {
        if (await deps.inbox.drop(event, failure.error.reason)) {
          drain.dropped += 1;
        } else lost();
        continue;
      }
      if (failure === undefined) {
        if (await deps.inbox.complete(event)) drain.processed += 1;
        else lost();
        continue;
      }
      const outcome = await deps.inbox.fail(event, {
        retryInMs: slackInboundBackoffMs(event.attempts),
        maxAttempts,
      });
      if (outcome === "lost") {
        lost();
        continue;
      }
      drain[outcome === "failed" ? "failed" : "retried"] += 1;
      deps.logger.warn(
        outcome === "failed"
          ? "Slack event failed; attempts spent"
          : "Slack event failed; retried later",
        {
          ...ids,
          error:
            failure.error instanceof Error
              ? failure.error.message
              : String(failure.error),
        },
      );
    }
  }
  return drain;
}
