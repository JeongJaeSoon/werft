import type { StructuredLogger } from "@werft-ai/observability";

/**
 * How long one start waits, all its waits together, for the object store and
 * the database to answer. It stays under the chart's api startup probe
 * (deploy/helm/werft/templates/api.yaml, 5 s x 24), so a start that gives up
 * says why and exits before the probe would end it without a word.
 */
export const STARTUP_WAIT_BUDGET_MS = 90_000;
// Well above what a try takes when its dependency answers at all. A try still
// open by then counts as failed, so no wait goes longer without a line.
const ATTEMPT_MS = 20_000;
const FIRST_PAUSE_MS = 1_000;
const LONGEST_PAUSE_MS = 5_000;

class NoAnswerError extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = "NoAnswerError";
  }
}

export type StartupWait = <T>(
  dependency: "database" | "object store",
  step: () => Promise<T>,
  /** The failure is the dependency being away, not an answer that refuses the start. */
  unreachable: (error: unknown) => boolean,
) => Promise<T>;

/**
 * Runs the start steps that need a dependency to be up. A step that fails
 * because its dependency is out of reach, or has not settled within 20 s,
 * runs again after a pause (1 s, doubling to 5 s) and logs one line per failed
 * try, so a start that waits is never silent. Any other failure is thrown on
 * at once: it refuses the start. The steps of one start share the budget and
 * no try runs past it; at its end the last failure is thrown after a line
 * that says the start gave up, and whatever runs the process starts it again.
 */
export function createStartupWait(options: {
  readonly logger: Pick<StructuredLogger, "warn" | "error">;
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
  /** Runs `run` after `ms` unless the returned function is called first. */
  readonly after?: (ms: number, run: () => void) => () => void;
}): StartupWait {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const after =
    options.after ??
    ((ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const budgetMs = options.budgetMs ?? STARTUP_WAIT_BUDGET_MS;
  const startedAt = now();
  // An abandoned try is left to settle on its own; nothing reads its result.
  const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const cancel = after(ms, () => reject(new NoAnswerError(ms)));
      work.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });
  return async (dependency, step, unreachable) => {
    for (let attempt = 1, pauseMs = FIRST_PAUSE_MS; ; attempt += 1) {
      let failure: unknown;
      try {
        return await within(
          step(),
          Math.min(ATTEMPT_MS, budgetMs - (now() - startedAt)),
        );
      } catch (error) {
        if (!(error instanceof NoAnswerError) && !unreachable(error)) {
          throw error;
        }
        failure = error;
      }
      const waitedMs = now() - startedAt;
      const fields = {
        attempt,
        waited_ms: waitedMs,
        error_name: failure instanceof Error ? failure.name : typeof failure,
        // Not `error_message`: the logger drops any *message* key as a body.
        error: failure instanceof Error ? failure.message : String(failure),
        code: (failure as { code?: unknown } | null)?.code ?? null,
      };
      if (waitedMs + pauseMs >= budgetMs) {
        options.logger.error(
          `Refusing to start: the ${dependency} could not be reached`,
          fields,
        );
        throw failure;
      }
      options.logger.warn(`Waiting for the ${dependency} before starting`, {
        ...fields,
        retry_in_ms: pauseMs,
      });
      await sleep(pauseMs);
      pauseMs = Math.min(pauseMs * 2, LONGEST_PAUSE_MS);
    }
  };
}
