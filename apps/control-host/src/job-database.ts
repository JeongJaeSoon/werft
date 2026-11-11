import * as schema from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

/**
 * Runs a one-shot job on a pool of its own and ends the pool whether the job
 * returns or throws. `name` tells the job apart in pg_stat_activity and in the
 * pool's idle-error log.
 */
export async function withJobDatabase<T>(
  name: string,
  databaseUrl: string,
  logger: StructuredLogger,
  work: (database: {
    db: NodePgDatabase<typeof schema>;
    pool: Pool;
  }) => Promise<T>,
  poolOptions?: { max: number },
): Promise<T> {
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    name,
    JOB_POOL_TIMEOUTS,
    poolOptions,
  );
  try {
    return await work({ db: drizzle(pool, { schema }), pool });
  } finally {
    await pool.end();
  }
}
