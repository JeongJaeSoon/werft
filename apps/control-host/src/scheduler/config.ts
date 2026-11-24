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
  DRAIN_FINALIZE_GRACE_MS,
  type ExecutionResources,
  type InstallationLimits,
  type InstallationLimitsEnvironment,
  installationLimitsFromEnv,
  MAX_TURN_SECONDS_CEILING,
  type SchedulerOptions,
  workerImageListFromEnv,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import { CODEX_CHECKPOINT_ENGINE } from "@werft-ai/runtime-codecs";
import { queueDatabaseUrl } from "../database-url.ts";

type ImageRuntime = NonNullable<SchedulerOptions["imageRuntime"]>;

export type SchedulerEnvironment = LocalDockerBackendEnvironment &
  InstallationLimitsEnvironment & {
    CODEX_SANDBOX?: string | undefined;
    CODEX_SANDBOX_PROVIDER?: string | undefined;
    DATABASE_URL?: string | undefined;
    EXECUTION_BACKEND?: string | undefined;
    LOG_LEVEL?: string | undefined;
    QUEUE_DATABASE_URL?: string | undefined;
    WORKER_CPUS?: string | undefined;
    WORKER_IMAGE?: string | undefined;
    WORKER_IMAGES?: string | undefined;
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
  /** Newest first after `image`; empty without a runtime. */
  olderImages: { image: string; runtime: ImageRuntime }[];
  /** Listed but retracted, newest first; `image` among them only when all are. */
  retractedImages: { image: string; runtime: ImageRuntime }[];
  limits: InstallationLimits;
  logLevel: LogLevel;
  resources: ExecutionResources;
  slotLimit: number;
};

export function schedulerConfigFromEnv(
  environment: SchedulerEnvironment,
): SchedulerConfig {
  const databaseUrl = queueDatabaseUrl(environment);
  const images = configuredImages(environment);
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
    // For a claimed worker whose own turn time is unknown — reserved before
    // it was pinned, on a resource whose env cannot be read. The console's
    // value says nothing about the limits of its day, so it gets as long as
    // any turn may run rather than having a long turn cut.
    drainDeadlineMs: MAX_TURN_SECONDS_CEILING * 1_000 + DRAIN_FINALIZE_GRACE_MS,
    // The workspace quota helper runs from the newest image, listed or not.
    // Every worker starts with the limits its launch carries: its pinned
    // ones, else the console's at the pass that builds it.
    execution: executionFromEnv(
      { ...environment, WORKER_IMAGE: images.image },
      { logLevel },
      codexSandboxFromEnv(environment, images),
    ),
    ...images,
    limits,
    logLevel,
    resources: {
      cpus: cpuShare(environment),
      memoryBytes:
        // A resumed engine holds about twice a transcript with no
        // compaction in it; this keeps one at MAX_TRANSCRIPT_BYTES under
        // half the limit (apps/docs/content/docs/run-server/self-hosting/capacity.mdx).
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
    // The workspace TTLs are the console's, read by each pass.
    slotLimit: limits.executionSlotLimit,
  };
}

function configuredImages(
  environment: SchedulerEnvironment,
): Pick<
  SchedulerConfig,
  "image" | "imageRuntime" | "olderImages" | "retractedImages"
> {
  const listed = workerImageListFromEnv(environment);
  if (listed !== null) {
    const pair = ({
      image,
      runtime,
    }: {
      image: string;
      runtime: ImageRuntime;
    }) => ({
      image,
      runtime,
    });
    const launchable = listed.filter(({ retracted }) => !retracted);
    const retractedImages = listed
      .filter(({ retracted }) => retracted)
      .map(pair);
    // Every image retracted: `image` is one of them, and the scheduler
    // launches nothing and runs no quota probe on it.
    const [newest = listed[0], ...older] = launchable;
    return {
      image: newest.image,
      imageRuntime: newest.runtime,
      olderImages: older.map(pair),
      retractedImages,
    };
  }
  const image = environment.WORKER_IMAGE;
  if (!image) throw new Error("WORKER_IMAGES or WORKER_IMAGE is required");
  const runtimes = workerImageRuntimesFromEnv(environment);
  const previousImage = environment.WORKER_IMAGE_PREVIOUS;
  if (!previousImage !== (runtimes?.previous == null)) {
    throw new Error(
      "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME are set together",
    );
  }
  return {
    image,
    ...(runtimes === null ? {} : { imageRuntime: runtimes.current }),
    olderImages:
      runtimes?.previous == null || !previousImage
        ? []
        : [{ image: previousImage, runtime: runtimes.previous }],
    retractedImages: [],
  };
}

type CodexSandbox =
  | {
      mode: "enabled";
      images: string[];
      provider?: "installer" | "external" | "disabled";
    }
  | { mode: "disabled" };

export const CODEX_SANDBOX_DISABLED_WARNING =
  "Codex auto mode's sandbox is turned off (CODEX_SANDBOX=disabled): Codex workers refuse auto sessions; other modes run";

/**
 * Codex `auto` mode's sandbox: on unless `CODEX_SANDBOX=disabled`, which
 * turns auto mode off with it. Only the images whose declared runtime is
 * Codex run under its seccomp profile; one with no declared runtime keeps
 * the default, and its auto sessions are refused with the reason.
 */
function codexSandboxFromEnv(
  environment: SchedulerEnvironment,
  images: Pick<
    SchedulerConfig,
    "image" | "imageRuntime" | "olderImages" | "retractedImages"
  >,
): CodexSandbox {
  const value = environment.CODEX_SANDBOX;
  if (value === "disabled") return { mode: "disabled" };
  if (value && value !== "enabled") {
    throw new Error(`CODEX_SANDBOX must be enabled or disabled (got ${value})`);
  }
  const provider = environment.CODEX_SANDBOX_PROVIDER;
  if (
    provider !== undefined &&
    provider !== "" &&
    provider !== "installer" &&
    provider !== "external" &&
    provider !== "disabled"
  ) {
    throw new Error(
      `CODEX_SANDBOX_PROVIDER must be installer, external or disabled (got ${provider})`,
    );
  }
  const declared = [
    ...(images.imageRuntime === undefined
      ? []
      : [{ image: images.image, runtime: images.imageRuntime }]),
    ...images.olderImages,
    ...images.retractedImages,
  ];
  return {
    mode: "enabled",
    images: declared
      .filter(({ runtime }) => runtime.engine === CODEX_CHECKPOINT_ENGINE)
      .map(({ image }) => image),
    ...(provider ? { provider } : {}),
  };
}

function executionFromEnv(
  environment: SchedulerEnvironment,
  worker: { logLevel: LogLevel },
  codexSandbox: CodexSandbox,
): SchedulerExecution {
  const backend = environment.EXECUTION_BACKEND || "local_docker";
  switch (backend) {
    case "local_docker":
      return {
        backend,
        docker: {
          ...localDockerConfigFromEnv(environment),
          ...worker,
          codexSandbox,
        },
      };
    case "kubernetes":
      return {
        backend,
        kubernetes: {
          ...kubernetesConfigFromEnv(environment),
          ...worker,
          codexSandbox,
        },
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
