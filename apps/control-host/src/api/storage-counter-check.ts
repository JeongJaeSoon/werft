// Once a day, the installation's storage counter against the bytes its
// turns hold. Read-only: a difference is logged for an operator, never
// corrected here.
import type { StorageCounterCheck } from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";

export const STORAGE_COUNTER_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** 03:30 UTC: the turns scan runs off the busy hours. */
export const STORAGE_COUNTER_CHECK_OFFSET_MS = 3.5 * 60 * 60_000;
/**
 * The scan is cut off after this; the next day tries again. Below the api
 * pool's read timeout (API_POOL_TIMEOUTS.queryMs), so the server's cancel ends
 * the scan, not the client dropping its connection.
 */
export const STORAGE_COUNTER_CHECK_TIMEOUT_MS = 15_000;

/**
 * Time to the next run: the same moment of every day for every replica, so
 * they start together and the check's lock keeps them from scanning side by
 * side. Never at once, so a boot does not scan.
 */
export function untilNextStorageCounterCheck(now: number): number {
  const into =
    (now - STORAGE_COUNTER_CHECK_OFFSET_MS) % STORAGE_COUNTER_CHECK_INTERVAL_MS;
  return STORAGE_COUNTER_CHECK_INTERVAL_MS - into;
}

/** Runs one check and logs its result; never throws. */
export async function runStorageCounterCheck(
  check: () => Promise<StorageCounterCheck>,
  logger: StructuredLogger,
): Promise<void> {
  let result: StorageCounterCheck;
  try {
    result = await check();
  } catch (error) {
    logger.warn("The daily storage counter check failed", {
      error_name: error instanceof Error ? error.name : typeof error,
      sqlstate: sqlstateOf(error) ?? null,
    });
    return;
  }
  if (result.outcome === "busy") {
    logger.info("The daily storage counter check ran on another replica");
    return;
  }
  const fields = {
    counter_bytes: result.counterBytes,
    actual_bytes: result.actualBytes,
    difference_bytes: result.counterBytes - result.actualBytes,
  };
  if (fields.difference_bytes === 0) {
    logger.info("The storage counter matches the turns", fields);
  } else {
    logger.warn("The storage counter differs from the turns", fields);
  }
}

/**
 * Runs `run` at each daily moment, for the life of the process. The next
 * moment is set before `run` starts, so a run that never ends does not stop
 * the days after it.
 */
export function scheduleStorageCounterCheck(
  run: () => Promise<void>,
  now: () => number = Date.now,
): void {
  const next = () => {
    setTimeout(() => {
      next();
      run().catch(() => {});
    }, untilNextStorageCounterCheck(now())).unref();
  };
  next();
}

function sqlstateOf(error: unknown): string | undefined {
  for (let at = error; at instanceof Error; at = at.cause) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
