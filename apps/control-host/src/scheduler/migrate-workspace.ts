import * as schema from "@werft-ai/db";
import { createPostgresSchedulerStore } from "@werft-ai/db";
import {
  DEFAULT_MIGRATION_HELPER_IMAGE,
  LocalDockerBackend,
  WorkspaceMigrator,
} from "@werft-ai/execution-local-docker";
import { createLogger } from "@werft-ai/observability";
import { messageOf } from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import { withJobDatabase } from "../job-database.ts";
import { schedulerConfigFromEnv } from "./config.ts";

const USAGE =
  "usage: migrate-workspace [--helper-image name@sha256:...] [--deadline-sec N] <session-id>...";

export type MigrateWorkspaceArgs = {
  sessionIds: string[];
  helperImage: string;
  deadlineMs: number;
};

export function parseMigrateWorkspaceArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): MigrateWorkspaceArgs {
  const sessionIds: string[] = [];
  let helperImage =
    environment.EXECUTION_WORKSPACE_MIGRATION_IMAGE ||
    DEFAULT_MIGRATION_HELPER_IMAGE;
  let deadlineSec = 3_600;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--helper-image" || arg === "--deadline-sec") {
      const value = argv[++i];
      if (value === undefined)
        throw new Error(`${arg} needs a value\n${USAGE}`);
      if (arg === "--helper-image") {
        helperImage = value;
      } else {
        deadlineSec = Number(value);
        if (!Number.isInteger(deadlineSec) || deadlineSec < 1) {
          throw new Error(`--deadline-sec ${value} is not a positive integer`);
        }
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}\n${USAGE}`);
    } else {
      sessionIds.push(arg);
    }
  }
  if (sessionIds.length === 0) throw new Error(USAGE);
  return { deadlineMs: deadlineSec * 1_000, helperImage, sessionIds };
}

/**
 * Moves legacy workspaces onto the current quota contract: an
 * explicit operator action, never something a pass does on its own. Holds
 * the scheduler's pass lock throughout, so no pass launches onto or reclaims
 * either volume while a copy is in flight; run it between passes. Returns
 * the process exit code: 0 when every session is now current.
 */
export async function migrateWorkspaces(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseMigrateWorkspaceArgs(argv, environment);
  const config = schedulerConfigFromEnv(environment);
  if (config.execution.backend !== "local_docker") {
    throw new Error(
      `migrate-workspace moves Docker volumes; EXECUTION_BACKEND is ${config.execution.backend}`,
    );
  }
  const { docker } = config.execution;
  const logger = createLogger({ level: config.logLevel });
  return withJobDatabase(
    "migrate-workspace",
    config.databaseUrl,
    logger,
    async ({ db, pool }) => {
      // Only the pass lock is used from it.
      const store = createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        logger,
        sessionCostLimitUsd: config.limits.sessionCostLimitUsd,
        sessionTokenLimit: config.limits.sessionTokenLimit,
      });
      // The copy lands under the ceiling this host enforces; a daemon that
      // cannot carry it would only fail the copy later and less clearly.
      await new LocalDockerBackend(docker).verifyWorkspaceQuota();
      const lock = await store.acquirePassLock();
      if (lock === null) {
        logger.error("A scheduler pass holds the lock; run again once it ends");
        return 1;
      }
      let failed = 0;
      try {
        const migrator = new WorkspaceMigrator(docker);
        for (const sessionId of args.sessionIds) {
          try {
            const [row] = await db
              .select({
                admissionState: schema.sessions.admissionState,
                id: schema.sessions.id,
                reclaimId: schema.sessions.workspaceReclaimId,
              })
              .from(schema.sessions)
              .where(eq(schema.sessions.id, sessionId))
              .limit(1);
            // Neither has anything to resume onto the copy.
            if (row === undefined) {
              throw new Error(
                `session ${sessionId} is not in the database; nothing proves its workspace ours, so neither GC nor this command touches it — remove it by hand once you are sure`,
              );
            }
            if (row.admissionState === "closed") {
              throw new Error(
                `session ${sessionId} is closed; GC reclaims its workspace, there is nothing to migrate`,
              );
            }
            // The next pass settles that claim before it lists anything, and
            // would remove the source out from under a copy made now. No new
            // claim can be taken while this holds the pass lock.
            if (row.reclaimId !== null) {
              throw new Error(
                `session ${sessionId} has a workspace reclaim pending; let the next scheduler pass settle it`,
              );
            }
            const result = await migrator.migrate({
              deadlineMs: args.deadlineMs,
              helperImage: args.helperImage,
              // PostgreSQL matches a uuid in any case; Docker names and labels
              // carry it in the one spelling the row holds.
              sessionId: row.id,
              signal: lock.signal,
            });
            logger.info(
              result.outcome === "migrated"
                ? "Workspace migrated"
                : "Workspace already current",
              { session_id: sessionId, ...result },
            );
          } catch (error) {
            failed++;
            logger.error("Workspace migration failed", {
              error: messageOf(error),
              session_id: sessionId,
            });
            if (lock.signal.aborted) break;
          }
        }
        if (lock.signal.aborted) {
          // A pass may have run beside the last step; that session's outcome
          // was logged, but the run as a whole is not one to call clean.
          logger.error("The scheduler pass lock was lost during the run");
          failed++;
        }
      } finally {
        await lock.release();
      }
      return failed === 0 ? 0 : 1;
    },
  );
}

if (import.meta.main) {
  try {
    process.exitCode = await migrateWorkspaces(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 2;
  }
}
