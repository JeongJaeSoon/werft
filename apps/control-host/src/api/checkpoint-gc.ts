import { createPostgresCheckpointStore } from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type CheckpointCollectorDependencies,
  createCheckpointCollector,
} from "@werft-ai/platform";
import {
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
} from "@werft-ai/storage";
import { booleanFlag } from "../boolean-flag.ts";
import {
  API_CHECKPOINT_CODECS,
  assertCheckpointBucketProtection,
  type CheckpointStorageEnvironment,
  checkpointStorageConfigFromEnv,
} from "./checkpoints.ts";
import { exitWithJob, openJobConnections } from "./one-shot-job.ts";

const BATCH_SIZE = 100;

/**
 * One checkpoint garbage collection pass over every session, then exit
 * the same one-shot shape as `main.ts reconciler --once`, run on the API
 * image with the API's object store settings, since releasing a hold needs
 * the control plane's credentials.
 *
 * Read: the API's checkpoint storage variables (checkpoints.ts),
 * `DATABASE_URL` and `CHECKPOINT_GC_DRY_RUN` (`true`/`1` reports what would
 * go and deletes nothing). A deployment that is `unversioned` or has its
 * object store `disabled` holds nothing and names no versions, so the pass
 * says so and exits 0.
 *
 * Returns the exit code: 1 when any session failed. Must not run while a
 * backup is being taken.
 */
export async function runCheckpointGc(input: {
  environment: CheckpointStorageEnvironment & {
    CHECKPOINT_GC_DRY_RUN?: string;
    DATABASE_URL?: string;
  };
  logger: StructuredLogger;
  /** Tests substitute the stores; the product path builds them from env. */
  connect?: (config: { bucket: string; databaseUrl: string }) => Promise<
    Pick<CheckpointCollectorDependencies, "collector" | "objects" | "store"> & {
      close(): Promise<void>;
    }
  >;
}): Promise<number> {
  const { environment, logger } = input;
  const dryRun = booleanFlag(
    environment.CHECKPOINT_GC_DRY_RUN ?? "false",
    "CHECKPOINT_GC_DRY_RUN",
  );
  const config = checkpointStorageConfigFromEnv(environment);
  if (config === "disabled" || config.protection !== "locked") {
    logger.info("Checkpoint GC skipped", {
      reason:
        config === "disabled"
          ? "CHECKPOINT_OBJECT_STORE=disabled"
          : "CHECKPOINT_OBJECT_PROTECTION=unversioned holds nothing and pins no versions",
    });
    return 0;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await assertCheckpointBucketProtection(config);
  const stores = await (input.connect ?? connect(config, logger))({
    bucket: config.bucket,
    databaseUrl,
  });
  try {
    const collector = createCheckpointCollector({
      ...stores,
      codecs: API_CHECKPOINT_CODECS,
      objectProtection: config.protection,
    });
    const totals = await collector.collect({
      batchSize: BATCH_SIZE,
      dryRun,
      onSession(sessionId, result) {
        if (result.status === "failed") {
          logger.error("Checkpoint GC failed for a session", {
            error: String(result.error),
            session_id: sessionId,
          });
        } else if (result.status === "skipped") {
          logger.info("Checkpoint GC skipped a session", {
            reason: result.reason,
            session_id: sessionId,
          });
        } else if (result.purged > 0) {
          logger.info("Checkpoint GC collected a session", {
            dry_run: dryRun,
            kept: result.kept,
            purged: result.purged,
            session_id: sessionId,
          });
        }
      },
    });
    logger.info("Checkpoint GC completed", { dry_run: dryRun, ...totals });
    return totals.failed > 0 ? 1 : 0;
  } finally {
    await stores.close();
  }
}

function connect(
  config: Exclude<
    ReturnType<typeof checkpointStorageConfigFromEnv>,
    "disabled"
  >,
  logger: StructuredLogger,
) {
  return async ({
    bucket,
    databaseUrl,
  }: {
    bucket: string;
    databaseUrl: string;
  }) => {
    const { client, db, close } = openJobConnections({
      s3: config,
      databaseUrl,
      logger,
      poolName: "checkpoint-gc",
    });
    return {
      collector: createCheckpointObjectCollector({ bucket, client }),
      objects: createCheckpointObjectStore({ bucket, client }),
      store: createPostgresCheckpointStore(db),
      close,
    };
  };
}

if (import.meta.main) {
  await exitWithJob((logger) =>
    runCheckpointGc({ environment: process.env, logger }),
  );
}
