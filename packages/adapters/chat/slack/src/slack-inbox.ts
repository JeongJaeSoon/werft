import {
  SLACK_INBOUND_MAX_ATTEMPTS,
  type SlackInboundDropReason,
} from "@werft-ai/contracts";
import type {
  BufferedInputReceipt,
  InboundInputReceipt,
  SurfaceInboundClaim,
  SurfaceInboundEventStore,
} from "@werft-ai/platform";

/**
 * A person's posts that take no turn but still start the bots' count in
 * their thread over: a file, a `/me` line.
 */
export const SLACK_PERSON_RESET_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "me_message",
]);

/**
 * The thread an event belongs to, `<slack_app_id>:<channel>:<thread_ts ??
 * ts>`: a message outside a thread starts its own, and a DM is a channel
 * too. Null for an event that is no channel message. Stored with the row;
 * the claim lines rows up by their channel, not by this key.
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
 * returning marks it processed, taking the input it returns with it.
 */
export type SlackInboundHandler = (
  event: SurfaceInboundClaim,
  // biome-ignore lint/suspicious/noConfusingVoidType: most handlers take no input and return nothing.
) => Promise<InboundInputReceipt | BufferedInputReceipt | void>;

/**
 * Thrown by a handler to take the event up again `retryInMs` later, the
 * claim not counted as an attempt: it waits for something else, as a reply
 * of work going on waits for its judgment (v1-b/U1). Its thread steps aside
 * meanwhile, and the channel's events of no thread (a member, a rename, an
 * archive) wait behind it; the channel's other threads go on, unless such
 * an event heads the channel's line.
 */
export class SlackInboundDeferred extends Error {
  constructor(readonly retryInMs: number) {
    super(`Slack event deferred for ${retryInMs} ms`);
  }
}

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
  deferred: number;
};

/**
 * One pass of the `slack` role: acts on up to `concurrency` events at a
 * time and claims another as each slot frees, until the inbox has nothing
 * due and nothing in flight, or `deadline` (ms since the epoch) has passed.
 * The claim hands out one event per channel at a time, so events of one
 * channel run in order and different channels side by side. A claim takes
 * only what a free slot starts at once, so no lease runs while its event
 * waits. Past the deadline nothing new is claimed; what is in flight ends.
 */
export async function drainSlackInbox(deps: {
  inbox: SurfaceInboundEventStore;
  handler: SlackInboundHandler;
  logger: SlackInboxLogger;
  concurrency: number;
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
    deferred: 0,
  };

  async function settle(event: SurfaceInboundClaim): Promise<void> {
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
      return;
    }
    let failure: { error: unknown } | undefined;
    let input: InboundInputReceipt | BufferedInputReceipt | undefined;
    try {
      input = (await deps.handler(event)) ?? undefined;
    } catch (error) {
      failure = { error };
    }
    if (failure?.error instanceof SlackInboundDeferred) {
      if (
        await deps.inbox.defer(event, { retryInMs: failure.error.retryInMs })
      ) {
        drain.deferred += 1;
      } else lost();
      return;
    }
    if (failure?.error instanceof SlackInboundDropped) {
      if (await deps.inbox.drop(event, failure.error.reason)) {
        drain.dropped += 1;
      } else lost();
      return;
    }
    if (failure === undefined) {
      if (await deps.inbox.complete(event, input)) drain.processed += 1;
      else lost();
      return;
    }
    const outcome = await deps.inbox.fail(event, {
      retryInMs: slackInboundBackoffMs(event.attempts),
      maxAttempts,
    });
    if (outcome === "lost") {
      lost();
      return;
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

  const inFlight = new Set<Promise<void>>();
  // settle() catches the handler's throw; a store write that throws ends
  // the pass, as it did one event at a time: no new claim, and it is thrown
  // once the rest in flight end.
  let broken: { error: unknown } | undefined;
  while (broken === undefined && now() < deps.deadline) {
    const free = deps.concurrency - inFlight.size;
    const running = inFlight.size;
    let batch: SurfaceInboundClaim[] = [];
    if (free > 0) {
      try {
        batch = await deps.inbox.claim({
          limit: free,
          leaseMs: deps.leaseMs,
          maxAttempts,
        });
      } catch (error) {
        broken = { error };
        break;
      }
    }
    for (const event of batch) {
      drain.claimed += 1;
      const running: Promise<void> = settle(event)
        .catch((error: unknown) => {
          broken ??= { error };
        })
        .finally(() => inFlight.delete(running));
      inFlight.add(running);
    }
    // A claim that went out while work ran may have read that work's
    // channel as still taken; with some of it ended since, ask once more.
    if (batch.length === 0 && inFlight.size < running) continue;
    if (inFlight.size === 0) break;
    // Nothing more to claim until one ends: it may be what its channel's
    // next event waits for.
    if (batch.length === 0 || inFlight.size >= deps.concurrency) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);
  if (broken !== undefined) throw broken.error;
  return drain;
}
