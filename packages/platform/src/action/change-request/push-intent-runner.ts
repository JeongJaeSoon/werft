import type { PushIntentJob, PushIntentStore } from "../ports/push-intents.ts";

export const PUSH_INTENT_LEASE_MS = 60_000;
export const PUSH_INTENT_POLL_INTERVAL_MS = 3_000;

export type PushIntentRunnerLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

/**
 * The control-host action-broker's runner for push intents. It turns a
 * `pinned` intent into a push request once the turn that asked has ended,
 * whatever AGENT_ACTION_FLOWS says now: an intent made while the setting was
 * on is finished after it is turned off.
 *
 * It holds the stored actor's authority only and never approves anything.
 * Every claim is a lease with a token; a drain that lost its claim writes
 * nothing, because the store checks the token in the same transaction.
 */
export function createPushIntentRunner(deps: {
  store: PushIntentStore;
  /** The service's `createFromIntent`: gates, pinned source, transition. */
  createFromIntent(job: PushIntentJob): Promise<string>;
  logger: PushIntentRunnerLogger;
  leaseMs?: number;
}) {
  const { store, logger } = deps;
  const leaseMs = deps.leaseMs ?? PUSH_INTENT_LEASE_MS;

  /** One intent, or false when nothing is claimable. */
  async function runOnce(): Promise<boolean> {
    // Deferred intents no turn can pin any more (a replica that did not
    // know intents finalized the turn, or the session closed) end here.
    const stale = await store.settleStale();
    if (stale > 0) logger.info("Push intents closed", { count: stale });
    const job = await store.claimNext(leaseMs);
    if (job === null) return false;
    try {
      const outcome = await deps.createFromIntent(job);
      logger.info("Push intent drained", { intent: job.id, outcome });
    } catch (error) {
      // The lease runs out and the intent is claimed again.
      logger.warn("Push intent could not be drained", {
        intent: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  function start(intervalMs = PUSH_INTENT_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          while (!stopped && (await runOnce())) {}
        } catch (error) {
          logger.warn("Push intent runner could not claim", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      })();
    };
    timer = setTimeout(tick, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}

export type PushIntentRunner = ReturnType<typeof createPushIntentRunner>;
