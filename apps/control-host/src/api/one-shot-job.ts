import * as schema from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import { createStorageS3Client } from "@werft-ai/storage";
import { drizzle } from "drizzle-orm/node-postgres";

/** The database and object store client a one-shot job over the bucket opens. */
export function openJobConnections(input: {
  s3: Parameters<typeof createStorageS3Client>[0]["s3"];
  databaseUrl: string;
  logger: StructuredLogger;
  poolName: string;
}) {
  const pool = createEnforcedPool(
    input.databaseUrl,
    input.logger,
    input.poolName,
    JOB_POOL_TIMEOUTS,
  );
  const client = createStorageS3Client({ s3: input.s3 });
  return {
    client,
    db: drizzle(pool, { schema }),
    async close() {
      client.destroy();
      await pool.end();
    },
  };
}

/** Runs a job's entry point with a logger at `LOG_LEVEL` and exits with its code. */
export async function exitWithJob(
  run: (logger: StructuredLogger) => Promise<number>,
): Promise<never> {
  const logger = createLogger(
    process.env.LOG_LEVEL === undefined ? {} : { level: process.env.LOG_LEVEL },
  );
  process.exit(await run(logger));
}
