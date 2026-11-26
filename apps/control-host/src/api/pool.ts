import {
  createEnforcedPool,
  enforcedConfig,
  type PoolTimeouts,
  watchIdleErrors,
} from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import { Pool } from "pg";

// Generous enough for a write that waits on another request's row lock,
// short enough that a frozen database turns into 503s within the window a
// reverse proxy allows (api.md: storage outages are retryable 503s, never
// requests that hang until the client gives up).
export const API_POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5_000,
  statementMs: 10_000,
  queryMs: 20_000,
};

export function createApiPool(
  connectionString: string,
  logger: StructuredLogger,
  timeouts: PoolTimeouts = API_POOL_TIMEOUTS,
): Pool {
  return createEnforcedPool(connectionString, logger, "api", timeouts);
}

// A pool of its own so probe traffic never competes with API requests for
// clients; max 1 caps the work a burst of probes can leave on the server.
export function createProbePool(
  connectionString: string,
  logger: StructuredLogger,
  timeoutMs = 2_000,
): Pool {
  return watchIdleErrors(
    new Pool({
      ...enforcedConfig(
        connectionString,
        {
          connectMs: timeoutMs,
          statementMs: timeoutMs,
          queryMs: timeoutMs * 2,
        },
        "probe",
      ),
      max: 1,
    }),
    logger,
    "probe",
  );
}
