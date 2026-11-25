import type { StructuredLogger } from "@werft-ai/observability";

/**
 * How long one start waits, all its waits together, for the object store and
 * the database to answer. It stays under the chart's api startup probe
 * (deploy/helm/werft/templates/api.yaml, 5 s x 24), so a start that gives up
 * says why and exits before the probe would end it without a word.
 */
export const STARTUP_WAIT_BUDGET_MS = 90_000;
const FIRST_PAUSE_MS = 1_000;
const LONGEST_PAUSE_MS = 5_000;

export type StartupWait = <T>(
  dependency: "database" | "object store",
  step: () => Promise<T>,
  /** The failure is the dependency being away, not an answer that refuses the start. */
  unreachable: (error: unknown) => boolean,
) => Promise<T>;

/**
 * Runs the start steps that need a dependency to be up. A step that fails
 * because its dependency is out of reach runs again after a pause (1 s,
 * doubling to 5 s) and logs one line per failed try, so a start that waits is
 * never silent. Any other failure is thrown on at once: it refuses the start.
 * Past the budget, which the steps of one start share, the last failure is
 * thrown after a line that says the start gave up, and whatever runs the
 * process starts it again.
 */
export function createStartupWait(options: {
  readonly logger: Pick<StructuredLogger, "warn" | "error">;
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}): StartupWait {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const budgetMs = options.budgetMs ?? STARTUP_WAIT_BUDGET_MS;
  const startedAt = now();
  return async (dependency, step, unreachable) => {
    for (let attempt = 1, pauseMs = FIRST_PAUSE_MS; ; attempt += 1) {
      try {
        return await step();
      } catch (error) {
        if (!unreachable(error)) throw error;
        const waitedMs = now() - startedAt;
        const fields = {
          attempt,
          waited_ms: waitedMs,
          error_name: error instanceof Error ? error.name : typeof error,
          // Not `error_message`: the logger drops any *message* key as a body.
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: unknown } | null)?.code ?? null,
        };
        if (waitedMs + pauseMs > budgetMs) {
          options.logger.error(
            `Refusing to start: the ${dependency} could not be reached`,
            fields,
          );
          throw error;
        }
        options.logger.warn(`Waiting for the ${dependency} before starting`, {
          ...fields,
          retry_in_ms: pauseMs,
        });
        await sleep(pauseMs);
        pauseMs = Math.min(pauseMs * 2, LONGEST_PAUSE_MS);
      }
    }
  };
}
