import * as schema from "@werft-ai/db";
import { createPostgresSchedulerStore } from "@werft-ai/db";
import {
  createEnforcedPool,
  JOB_POOL_TIMEOUTS,
  SEQUENTIAL_ROLE_POOL_MAX,
} from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  messageOf,
  runScheduler,
  type SchedulerRunSummary,
} from "@werft-ai/platform";
import { installedDescriptors } from "@werft-ai/runtime-codecs";
import { drizzle } from "drizzle-orm/node-postgres";
import { PASS_DEGRADED_EXIT, PASS_SKIPPED_EXIT } from "../pass-loop/loop.ts";
import { installationConfigOf } from "../wiring/installation-config.ts";
import { schedulerBackendFor } from "./backend.ts";
import {
  CODEX_SANDBOX_DISABLED_WARNING,
  schedulerConfigFromEnv,
  stopDeadlineMsOf,
} from "./config.ts";
import { latchOnConnectionLoss } from "./connection-latch.ts";
import { QUOTA_PREFLIGHT_MARKER_ENV } from "./quota-preflight.ts";

/**
 * One scheduling pass (`main.ts scheduler --once`); the scheduler role runs
 * it under the pass loop. This is the only process that holds the execution
 * backend's credentials (the Docker socket, or the Kubernetes ServiceAccount);
 * workers never see them. `stop` ends the pass at its next safe point.
 */
export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  options: { stop?: AbortSignal } = {},
): Promise<SchedulerRunSummary> {
  const config = schedulerConfigFromEnv(environment);
  const logger = createLogger({ level: config.logLevel });
  const execution =
    config.execution.backend === "local_docker"
      ? config.execution.docker
      : config.execution.kubernetes;
  if (execution.codexSandbox?.mode === "disabled") {
    logger.warn(CODEX_SANDBOX_DISABLED_WARNING);
  }
  // The pass-lock client comes out of this pool too, so a frozen database
  // fails the lock query as well instead of holding the pass open.
  const pool = createEnforcedPool(
    config.databaseUrl,
    logger,
    "scheduler",
    JOB_POOL_TIMEOUTS,
    { max: SEQUENTIAL_ROLE_POOL_MAX },
  );
  try {
    const db = drizzle(pool, { schema });
    const { backend, preflight } = await schedulerBackendFor(
      config.execution,
      environment,
    );
    const installationConfig = installationConfigOf(db, logger);
    const latch = latchOnConnectionLoss(
      createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        logger,
        sessionBudget: installationConfig.sessionBudget,
      }),
      (error) => {
        logger.error("Database connection lost; failing the rest of the pass", {
          error: messageOf(error),
        });
      },
    );
    const store = latch.store;
    await preflight({
      logger,
      quotaMarker: environment[QUOTA_PREFLIGHT_MARKER_ENV],
      // Listed digests are unique: `image` is retracted only when all are.
      probeQuota: !config.retractedImages.some(
        ({ image }) => image === config.image,
      ),
      store,
      workspaceTtls: installationConfig.workspaceTtls,
    });
    const summary = await runScheduler({
      backend,
      drainDeadlineMs: config.drainDeadlineMs,
      image: config.image,
      ...(config.imageRuntime === undefined
        ? {}
        : { imageRuntime: config.imageRuntime }),
      olderImages: config.olderImages,
      retractedImages: config.retractedImages,
      engineOfKind: (kind) =>
        installedDescriptors.find((descriptor) => descriptor.kind === kind)
          ?.checkpointEngine,
      logger,
      resources: config.resources,
      workerLimits: installationConfig.workerLimits,
      slotLimit: config.slotLimit,
      stopDeadlineMs: stopDeadlineMsOf(config.execution),
      store,
      workspaceTtls: installationConfig.workspaceTtls,
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    });
    // The pass records a lost connection against each execution it was
    // reconciling and can still come back with a summary; the database being
    // gone is the process's failure, not theirs.
    const lost = latch.lost();
    if (lost !== undefined) throw lost;
    return summary;
  } finally {
    await pool.end();
  }
}

/**
 * Non-zero when the pass left work undone, so the pass loop notices. A pass
 * that found the lock held did nothing and says so (PASS_SKIPPED_EXIT). One
 * that did everything it could but left a session it cannot help this pass
 * says that instead (PASS_DEGRADED_EXIT), unless something else
 * failed too.
 */
export function exitCodeFor(summary: SchedulerRunSummary): number {
  if (summary.skipped) return PASS_SKIPPED_EXIT;
  if (
    summary.failedLaunches.length > 0 ||
    summary.imageUnresolved ||
    summary.imagesRefused.length > 0 ||
    summary.killFailed.length > 0 ||
    // A network that could be neither removed nor repaired is a leaked
    // address pool or a worker without egress; both need someone to look.
    summary.networkScanFailed ||
    summary.networksFailed.length > 0 ||
    summary.orphansUnresolved.length > 0 ||
    summary.reclaimFailed.length > 0 ||
    summary.reconcileFailed.length > 0 ||
    // A GC fault, not a GC judgement: `workspacesUnresolved` is deliberate
    // and stays out of this, but a scan or a removal that threw means disk
    // is being left behind for a reason nobody has looked at.
    summary.workspaceScanFailed ||
    summary.workspacesFailed.length > 0
  ) {
    return 1;
  }
  // A launch waiting out its backoff is one that is failing; one given up
  // on failed its session's input; so did a session out of replacements.
  // Each is one session's trouble, kept in the database, that a restart of
  // this loop would not fix.
  return summary.launchesBackingOff.length > 0 ||
    summary.launchesQuarantined.length > 0 ||
    summary.replacementsExhausted.length > 0
    ? PASS_DEGRADED_EXIT
    : 0;
}
