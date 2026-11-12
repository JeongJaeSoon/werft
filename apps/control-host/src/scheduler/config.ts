import {
  integerSetting,
  positiveNumberSetting,
} from "@werft-ai/contracts/settings";
import {
  type KubernetesBackendConfig,
  kubernetesConfigFromEnv,
} from "@werft-ai/execution-kubernetes";
import {
  type LocalDockerBackendConfig,
  type LocalDockerBackendEnvironment,
  localDockerConfigFromEnv,
} from "@werft-ai/execution-local-docker";
import { type LogLevel, logLevelFromEnv } from "@werft-ai/observability";
import {
  DEFAULT_STOPPED_WORKSPACE_TTL_MS,
  type ExecutionResources,
  type InstallationLimits,
  type InstallationLimitsEnvironment,
  installationLimitsFromEnv,
  type SchedulerOptions,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import { queueDatabaseUrl } from "../database-url.ts";

type ImageRuntime = NonNullable<SchedulerOptions["imageRuntime"]>;

export type SchedulerEnvironment = LocalDockerBackendEnvironment &
  InstallationLimitsEnvironment & {
    DATABASE_URL?: string | undefined;
    EXECUTION_BACKEND?: string | undefined;
    EXECUTION_WORKSPACE_STOPPED_TTL_SEC?: string | undefined;
    LOG_LEVEL?: string | undefined;
    QUEUE_DATABASE_URL?: string | undefined;
    WORKER_CPUS?: string | undefined;
    WORKER_IMAGE?: string | undefined;
    WORKER_IMAGE_PREVIOUS?: string | undefined;
    WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
    WORKER_IMAGE_RUNTIME?: string | undefined;
    WORKER_MEMORY_MB?: string | undefined;
    WORKER_PIDS_LIMIT?: string | undefined;
  };

const SCHEDULER_BACKENDS = ["local_docker", "kubernetes"] as const;

/** Only the chosen backend's settings are read, so neither needs the other's. */
export type SchedulerExecution =
  | { backend: "local_docker"; docker: LocalDockerBackendConfig }
  | { backend: "kubernetes"; kubernetes: KubernetesBackendConfig };

export type SchedulerConfig = {
  databaseUrl: string;
  drainDeadlineMs: number;
  execution: SchedulerExecution;
  image: string;
  /** Without them every launch takes `image` and nothing is held to a combination. */
  imageRuntime?: ImageRuntime;
  previousImage?: { image: string; runtime: ImageRuntime };
  limits: InstallationLimits;
  logLevel: LogLevel;
  resources: ExecutionResources;
  slotLimit: number;
  stoppedWorkspaceTtlMs: number;
};

export function schedulerConfigFromEnv(
  environment: SchedulerEnvironment,
): SchedulerConfig {
  const databaseUrl = queueDatabaseUrl(environment);
  const image = environment.WORKER_IMAGE;
  if (!image) throw new Error("WORKER_IMAGE is required");
  const runtimes = workerImageRuntimesFromEnv(environment);
  const previousImage = environment.WORKER_IMAGE_PREVIOUS;
  if (!previousImage !== (runtimes?.previous == null)) {
    throw new Error(
      "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME are set together",
    );
  }
  // The adapter defaults this for tests; a real scheduler must say which
  // installation it is, or two installations on one daemon reap each other.
  if (!environment.EXECUTION_INSTALLATION_ID) {
    throw new Error("EXECUTION_INSTALLATION_ID is required");
  }
  // The same parser the API starts with, so the two processes cannot run
  // under different limits from one env file.
  const limits = installationLimitsFromEnv(environment);
  const logLevel = logLevelFromEnv(environment.LOG_LEVEL);
  return {
    databaseUrl,
    // A claimed worker on an older isolation contract finishes its turn
    // before it is replaced. No turn outlasts MAX_TURN_SECONDS
    // the grace covers the finalize and checkpoint that end it.
    drainDeadlineMs: limits.maxTurnSeconds * 1_000 + DRAIN_FINALIZE_GRACE_MS,
    execution: executionFromEnv(environment, {
      workerLimits: {
        maxTurnSeconds: limits.maxTurnSeconds,
        providerMaxRetries: limits.providerMaxRetries,
      },
      logLevel,
    }),
    image,
    ...(runtimes === null ? {} : { imageRuntime: runtimes.current }),
    ...(runtimes?.previous == null || !previousImage
      ? {}
      : {
          previousImage: { image: previousImage, runtime: runtimes.previous },
        }),
    limits,
    logLevel,
    resources: {
      cpus: cpuShare(environment),
      memoryBytes:
        // A resumed engine holds about twice a transcript with no
        // compaction in it; this keeps one at MAX_TRANSCRIPT_BYTES under
        // half the limit (apps/docs/content/docs/run-server/self-hosting/operate/capacity.mdx).
        integerSetting(environment, "WORKER_MEMORY_MB", {
          min: 1,
          default: 4608,
        }) *
        1024 *
        1024,
      pidsLimit: integerSetting(environment, "WORKER_PIDS_LIMIT", {
        min: 1,
        default: 512,
      }),
    },
    slotLimit: limits.executionSlotLimit,
    // Zero is a real setting: a stopped session's workspace goes on the
    // next pass, and a resume restores from the checkpoint.
    stoppedWorkspaceTtlMs:
      integerSetting(environment, "EXECUTION_WORKSPACE_STOPPED_TTL_SEC", {
        min: 0,
        default: DEFAULT_STOPPED_WORKSPACE_TTL_MS / 1_000,
      }) * 1_000,
  };
}

function executionFromEnv(
  environment: SchedulerEnvironment,
  worker: {
    workerLimits: { maxTurnSeconds: number; providerMaxRetries: number };
    logLevel: LogLevel;
  },
): SchedulerExecution {
  const backend = environment.EXECUTION_BACKEND || "local_docker";
  switch (backend) {
    case "local_docker":
      return {
        backend,
        docker: { ...localDockerConfigFromEnv(environment), ...worker },
      };
    case "kubernetes":
      return {
        backend,
        kubernetes: { ...kubernetesConfigFromEnv(environment), ...worker },
      };
    default:
      throw new Error(
        `EXECUTION_BACKEND must be one of ${SCHEDULER_BACKENDS.join("|")} (got ${backend})`,
      );
  }
}

/** One whole stop: the backend's stop grace plus the request that asks for it. */
export function stopDeadlineMsOf(execution: SchedulerExecution): number {
  const { requestTimeoutMs, stopTimeoutSeconds } =
    execution.backend === "local_docker"
      ? execution.docker
      : execution.kubernetes;
  return stopTimeoutSeconds * 1_000 + requestTimeoutMs;
}

/**
 * Kills and teardowns do not wait for a worker to stop, but a pass can
 * still wait out one whole stop: ensure removes a container it cannot adopt
 * before building again. A pass killed there counts as failed, and three in
 * a row restart the scheduler.
 */
export function assertPassOutlastsStop(
  passTimeoutMs: number,
  execution: SchedulerExecution,
): void {
  const { requestTimeoutMs, stopTimeoutSeconds } =
    execution.backend === "local_docker"
      ? execution.docker
      : execution.kubernetes;
  if (passTimeoutMs <= stopDeadlineMsOf(execution)) {
    // Only the Docker backend lets either timeout be set.
    const stop =
      execution.backend === "local_docker"
        ? "EXECUTION_DOCKER_STOP_TIMEOUT_SEC + EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC"
        : `the kubernetes backend's stop and request timeouts (${stopTimeoutSeconds + requestTimeoutMs / 1_000}s)`;
    throw new Error(
      `SCHEDULER_PASS_TIMEOUT_SEC must be greater than ${stop}: a pass that waits out a worker's stop would be killed and counted as failed`,
    );
  }
}

const DRAIN_FINALIZE_GRACE_MS = 5 * 60_000;

/** Docker's smallest CPU quota is 0.01 CPU; below that NanoCpus rounds to "no limit". */
const MIN_CPUS = 0.01;

function cpuShare(environment: SchedulerEnvironment): number {
  const parsed = positiveNumberSetting(environment, "WORKER_CPUS", {
    default: 1,
  });
  if (parsed < MIN_CPUS) {
    throw new Error(`WORKER_CPUS must be at least ${MIN_CPUS}`);
  }
  return parsed;
}
