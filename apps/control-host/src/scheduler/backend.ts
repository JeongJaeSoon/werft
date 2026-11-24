import {
  KubernetesBackend,
  KubernetesClient,
  kubernetesConnectionFromEnv,
} from "@werft-ai/execution-kubernetes";
import {
  LocalDockerBackend,
  type LocalDockerBackendConfig,
} from "@werft-ai/execution-local-docker";
import {
  type ExecutionBackend,
  messageOf,
  type ReclaimOptions,
  reclaimNetworks,
  reclaimWorkspaces,
} from "@werft-ai/platform";
import type { SchedulerExecution } from "./config.ts";
import { nodeCapacityCheckFromEnv } from "./node-capacity.ts";
import { verifyWorkspaceQuotaOnce } from "./quota-preflight.ts";

export type PreflightContext = Omit<ReclaimOptions, "backend"> & {
  /** See QUOTA_PREFLIGHT_MARKER_ENV. */
  quotaMarker: string | undefined;
  /**
   * False when every worker image is retracted: the pass creates no
   * workspace, and the probe's helper, which holds CAP_SYS_ADMIN, would run
   * a retracted image.
   */
  probeQuota: boolean;
};

export type SchedulerBackend = {
  backend: ExecutionBackend;
  /**
   * What must hold before a pass admits work, beyond the port: throws when
   * it does not. Each backend brings its own; the pass knows none of them.
   */
  preflight(context: PreflightContext): Promise<void>;
};

export async function schedulerBackendFor(
  execution: SchedulerExecution,
  environment: NodeJS.ProcessEnv,
): Promise<SchedulerBackend> {
  if (execution.backend === "local_docker") {
    const backend = new LocalDockerBackend(execution.docker);
    return {
      backend,
      preflight: (context) =>
        dockerPreflight(backend, execution.docker, context),
    };
  }
  const config = execution.kubernetes;
  const client = new KubernetesClient(
    await kubernetesConnectionFromEnv(environment),
    { timeoutMs: config.requestTimeoutMs },
  );
  // Network isolation is the chart's NetworkPolicy and the workspace ceiling
  // the PVC's size: nothing here for the scheduler to probe.
  return {
    backend: new KubernetesBackend(
      { ...config, readsNodes: nodeCapacityCheckFromEnv(environment) },
      client,
    ),
    preflight: async () => {},
  };
}

async function dockerPreflight(
  backend: LocalDockerBackend,
  docker: LocalDockerBackendConfig,
  context: PreflightContext,
): Promise<void> {
  const { logger } = context;
  if (docker.workspaceQuota.mode === "off") {
    // The one warning the opt-out costs. Losing the quota by accident —
    // a daemon that cannot carry one — stops the process instead.
    logger.warn(
      "Worker workspaces have no disk or inode quota (EXECUTION_WORKSPACE_QUOTA=off); " +
        "each worker measures its own at most once a minute and stops a turn that outgrows " +
        `${docker.workspaceQuota.sizeBytes} bytes or ${docker.workspaceQuota.inodes} inodes, ` +
        "so a workspace can pass them between two measurements",
    );
  }
  // Before anything is launched: without exactly one running proxy there
  // is nothing to give a worker network, and a daemon older than Docker 28
  // cannot keep the host off one. The network reconcile still runs,
  // under the pass lock like the pass itself, since two running proxies are
  // exactly when it has to take them off the live networks; the error is
  // rethrown either way.
  try {
    await backend.verifyNetworkIsolation();
  } catch (error) {
    logger.error(
      "Network isolation preflight failed; reconciling worker networks before giving up",
      { error: messageOf(error) },
    );
    await reclaimNetworks({ ...context, backend }).catch(
      (reconcileError: unknown) => {
        logger.error("Worker network reconcile failed", {
          error: messageOf(reconcileError),
        });
      },
    );
    throw error;
  }
  if (!context.probeQuota) return;
  await verifyWorkspaceQuotaOnce({
    logger,
    marker: context.quotaMarker,
    // Any setting, not just the quota's: a new daemon or installation id
    // is as much a reason to probe again.
    settings: docker,
    verify: async () => {
      try {
        await backend.verifyWorkspaceQuota();
      } catch (error) {
        // The probe needs a little disk of its own, so a daemon that is
        // already full fails it — and that is exactly when the workspaces
        // of finished sessions are worth reclaiming. `reclaimWorkspaces`
        // frees them without starting or replacing anything, which a pass
        // with no free slots would still do; the error is rethrown
        // afterwards, so this process refuses to admit work either way.
        logger.error(
          "Workspace quota preflight failed; reclaiming workspaces before giving up",
          { error: messageOf(error) },
        );
        await reclaimWorkspaces({ ...context, backend }).catch(
          (reclaimError: unknown) => {
            logger.error("Workspace reclaim failed", {
              error: messageOf(reclaimError),
            });
          },
        );
        throw error;
      }
    },
  });
}
