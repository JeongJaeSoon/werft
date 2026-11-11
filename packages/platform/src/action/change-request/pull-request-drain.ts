import {
  PULL_REQUEST_MAX_ATTEMPTS,
  type PullRequestDrainOutcome,
  type PullRequestDrainStore,
  type PullRequestJob,
  pullRequestBackoffMs,
} from "../ports/pull-request-drain.ts";

/**
 * How long a claim holds its row. The forge calls are cut off at
 * `PULL_REQUEST_DEADLINE_SHARE` of it, so a create is not started when too
 * little lease is left to record its answer.
 */
export const PULL_REQUEST_LEASE_MS = 5 * 60_000;
export const PULL_REQUEST_DEADLINE_SHARE = 0.8;
export const PULL_REQUEST_POLL_INTERVAL_MS = 3_000;

export type PullRequestDrainLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

/**
 * The control-host's action-broker half that opens a pull request once its
 * push request is `pushed` (`pr_state = due`). It starts whether or not the
 * install turns the action flows on: a stage left over from before a restart
 * with the setting off is still finished.
 *
 * Every write of a claim is fenced by its token in the store, so a claim
 * that outlived its lease cannot record over its successor.
 */
export function createPullRequestDrain(deps: {
  store: PullRequestDrainStore;
  opener: {
    openForPushRequest(
      job: PullRequestJob,
      options: { deadline: number },
    ): Promise<PullRequestDrainOutcome>;
  };
  logger: PullRequestDrainLogger;
  leaseMs?: number;
}) {
  const { store, opener, logger } = deps;
  const leaseMs = deps.leaseMs ?? PULL_REQUEST_LEASE_MS;

  /** Runs one claimed stage to where it rests. False when none was due. */
  async function runOnce(): Promise<boolean> {
    // Read before the claim, so the deadline cannot trail the lease the
    // database starts at the claim.
    const claimedAt = Date.now();
    const job = await store.claimNextDue(leaseMs);
    if (job === null) return false;
    let outcome: PullRequestDrainOutcome;
    try {
      outcome = await opener.openForPushRequest(job, {
        deadline: claimedAt + leaseMs * PULL_REQUEST_DEADLINE_SHARE,
      });
    } catch (error) {
      // An unexpected failure carries no secret in its name; whether the
      // forge took the call is unknown, so the next claim looks first.
      logger.warn("Pull request stage failed", {
        push_request_id: job.id,
        error: error instanceof Error ? error.name : "error",
      });
      outcome =
        job.attempt >= PULL_REQUEST_MAX_ATTEMPTS
          ? {
              kind: "stop",
              stage: "uncertain",
              error: "forge_failed",
            }
          : {
              kind: "retry",
              error: "forge_failed",
              delayMs: pullRequestBackoffMs(job.attempt),
            };
    }
    const settled = await store.settle(job, outcome);
    logger.info(
      settled.result === "fenced"
        ? "Pull request stage was taken over"
        : "Pull request stage settled",
      {
        push_request_id: job.id,
        attempt: job.attempt,
        outcome: outcome.kind,
        result: settled.result,
        ...(outcome.kind === "opened" ? {} : { error: outcome.error }),
      },
    );
    return true;
  }

  /**
   * Polls until stopped. Each replica runs one; the claim's SKIP LOCKED keeps
   * them off each other's rows.
   */
  function start(intervalMs = PULL_REQUEST_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          while (!stopped && (await runOnce())) {}
        } catch (error) {
          logger.warn("Pull request drain could not claim", {
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

export type PullRequestDrain = ReturnType<typeof createPullRequestDrain>;
