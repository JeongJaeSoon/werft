import {
  type ArchiveObjectStore,
  archiveSessionEvents,
  type Database,
  restoreSessionEvents,
} from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import { InstallationConfigUnavailableError } from "@werft-ai/platform";
import { createCheckpointObjectStore } from "@werft-ai/storage";
import { installationConfigOf } from "../wiring/installation-config.ts";
import {
  assertCheckpointBucketProtection,
  type CheckpointStorageEnvironment,
  checkpointStorageConfigFromEnv,
} from "./checkpoints.ts";
import { exitWithJob, openJobConnections } from "./one-shot-job.ts";

const BATCH_SIZE = 100;

type Stores = {
  db: Database;
  objects: ArchiveObjectStore;
  close(): Promise<void>;
};

/**
 * One archiving pass, then exit, on the API image with the API's object
 * store settings: moves `events` of sessions idle longer than the console's
 * archive days into held objects under `session-archive/`. Both settings
 * come from one read at the start; the dry run, which only counts, is the
 * default.
 *
 * `restore <session id>` puts that session's archived events back instead,
 * whatever the settings say.
 *
 * Only a `locked` deployment archives: the held version is what makes the
 * object a safe place for rows the database then deletes. Returns the exit
 * code: 1 when any session failed, or the settings could not be read.
 */
export async function runSessionArchive(input: {
  argv?: readonly string[];
  environment: CheckpointStorageEnvironment & { DATABASE_URL?: string };
  logger: StructuredLogger;
  /** Tests substitute the stores; the product path builds them from env. */
  connect?: (config: {
    bucket: string;
    databaseUrl: string;
  }) => Promise<Stores>;
}): Promise<number> {
  const { environment, logger } = input;
  const [command, sessionId, ...rest] = input.argv ?? [];
  if (
    (command !== undefined && command !== "restore") ||
    (command === "restore" && (sessionId === undefined || rest.length > 0))
  ) {
    throw new Error("Usage: session-archive.ts [restore <session id>]");
  }
  const config = checkpointStorageConfigFromEnv(environment);
  if (config === "disabled" || config.protection !== "locked") {
    const reason =
      config === "disabled"
        ? "CHECKPOINT_OBJECT_STORE=disabled"
        : "CHECKPOINT_OBJECT_PROTECTION=unversioned cannot hold archived events";
    if (command === "restore") {
      throw new Error(`Cannot restore archived events: ${reason}`);
    }
    logger.info("Session archive skipped", { reason });
    return 0;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const stores = await (input.connect ?? connect(config, logger))({
    bucket: config.bucket,
    databaseUrl,
  });
  try {
    if (command === "restore" && sessionId !== undefined) {
      const restored = await restoreSessionEvents(
        stores.db,
        stores.objects,
        sessionId,
      );
      logger.info("Session archive restored", {
        session_id: sessionId,
        ...restored,
      });
      return 0;
    }
    let afterDays: number;
    let dryRun: boolean;
    try {
      const read = await installationConfigOf(stores.db, logger).read();
      afterDays = read.get("session_archive_after_days");
      dryRun = read.get("session_archive_dry_run");
    } catch (error) {
      if (!(error instanceof InstallationConfigUnavailableError)) throw error;
      logger.error("Session archive refused: its settings cannot be read", {
        error: error.message,
        setting: error.key,
      });
      return 1;
    }
    if (afterDays === 0) {
      logger.info("Session archive skipped", {
        reason: "session_archive_after_days is 0",
      });
      return 0;
    }
    const totals = await archiveSessionEvents(stores.db, stores.objects, {
      afterDays,
      batchSize: BATCH_SIZE,
      dryRun,
      onSession(id, result) {
        if (result.status === "failed") {
          logger.error("Session archive failed for a session", {
            error: String(result.error),
            session_id: id,
          });
        } else if (result.events > 0) {
          logger.info(
            dryRun
              ? "Session archive would move a session"
              : "Session archive moved a session",
            { session_id: id, ...withoutStatus(result) },
          );
        }
      },
    });
    logger.info("Session archive completed", {
      after_days: afterDays,
      dry_run: dryRun,
      ...totals,
    });
    return totals.failed > 0 ? 1 : 0;
  } finally {
    await stores.close();
  }
}

function withoutStatus<T extends { status: string }>({
  status: _,
  ...rest
}: T) {
  return rest;
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
  }): Promise<Stores> => {
    await assertCheckpointBucketProtection(config);
    const { client, db, close } = openJobConnections({
      s3: config,
      databaseUrl,
      logger,
      poolName: "session-archive",
    });
    const objects = createCheckpointObjectStore({ bucket, client });
    const hold = objects.hold?.bind(objects);
    if (hold === undefined) {
      throw new Error("The checkpoint object store cannot hold versions");
    }
    return {
      db,
      objects: {
        get: (key, version) => objects.get(key, version),
        hold,
        putImmutable: (key, body) => objects.putImmutable(key, body),
      },
      close,
    };
  };
}

if (import.meta.main) {
  await exitWithJob((logger) =>
    runSessionArchive({
      argv: process.argv.slice(2),
      environment: process.env,
      logger,
    }),
  );
}
