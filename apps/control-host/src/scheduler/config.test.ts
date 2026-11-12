import { describe, expect, test } from "bun:test";
import {
  assertPassOutlastsStop,
  type SchedulerConfig,
  schedulerConfigFromEnv,
} from "./config.ts";

const base = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "test",
  DATABASE_URL: "postgresql://postgres:dev@127.0.0.1:5432/sessions",
  EXECUTION_SLOT_LIMIT: "10",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  EXECUTION_INSTALLATION_ID: "dev-a",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  S3_BUCKET: "claude-sessions",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
  WORKER_IMAGE: "werft-worker:dev",
};

// What a cluster scheduler is given: no Docker setting at all.
const kubernetes = {
  ...base,
  EXECUTION_BACKEND: "kubernetes",
  EXECUTION_INSTALLATION_ID: "dev-a",
  EXECUTION_K8S_NAMESPACE: "werft",
  WORKER_GATEWAY_URL: "http://api:3000",
  WORKER_IMAGE: `registry.local/worker@sha256:${"a".repeat(64)}`,
};

function dockerOf(config: SchedulerConfig) {
  if (config.execution.backend !== "local_docker") {
    throw new Error(`expected local_docker, got ${config.execution.backend}`);
  }
  return config.execution.docker;
}

describe("assertPassOutlastsStop", () => {
  const message =
    "SCHEDULER_PASS_TIMEOUT_SEC must be greater than EXECUTION_DOCKER_STOP_TIMEOUT_SEC + EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC";

  test("the defaults leave a pass room for one whole worker stop", () => {
    const config = schedulerConfigFromEnv(base);
    const docker = dockerOf(config);
    expect(docker.stopTimeoutSeconds * 1_000 + docker.requestTimeoutMs).toBe(
      150_000,
    );
    expect(() =>
      assertPassOutlastsStop(180_000, config.execution),
    ).not.toThrow();
  });

  test("refuses a pass timeout a worker stop can outlast", () => {
    const { execution } = schedulerConfigFromEnv(base);
    expect(() => assertPassOutlastsStop(120_000, execution)).toThrow(message);
    expect(() => assertPassOutlastsStop(150_000, execution)).toThrow(message);
    const longer = schedulerConfigFromEnv({
      ...base,
      EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: "60",
      EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "300",
    }).execution;
    expect(() => assertPassOutlastsStop(180_000, longer)).toThrow(message);
    expect(() => assertPassOutlastsStop(361_000, longer)).not.toThrow();
  });

  test("holds the kubernetes backend to its own fixed timeouts", () => {
    const { execution } = schedulerConfigFromEnv(kubernetes);
    expect(() => assertPassOutlastsStop(180_000, execution)).not.toThrow();
    expect(() => assertPassOutlastsStop(150_000, execution)).toThrow(
      "the kubernetes backend's stop and request timeouts (150s)",
    );
  });
});

describe("schedulerConfigFromEnv", () => {
  test("reads the installation limits and defaults the worker resources to the documented values", () => {
    const config = schedulerConfigFromEnv(base);
    expect(config).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      image: "werft-worker:dev",
      resources: {
        cpus: 1,
        memoryBytes: 4608 * 1024 * 1024,
        pidsLimit: 512,
      },
      slotLimit: 10,
    });
    expect(config.limits).toEqual({
      executionSlotLimit: 10,
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
      queuedInputLimitPerSession: 20,
      sessionCostLimitUsd: 25,
      sessionTokenLimit: null,
      storageLimitBytes: 1073741824,
    });
    const docker = dockerOf(config);
    expect(docker.workerLimits).toEqual({
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
    });
    expect(docker.gatewayUrl).toBe(base.WORKER_GATEWAY_URL);
    expect(docker.egressProxyUrl).toBe(base.EXECUTION_EGRESS_PROXY_URL);
  });

  test("takes the current image's runtime and, when both are given, the previous image and its runtime", () => {
    const current = {
      engine: "claude",
      sdkVersion: "0.3.280",
      cliVersion: "2.1.280",
      profileDigestScheme: 1,
    };
    const previous = {
      ...current,
      sdkVersion: "0.3.270",
      cliVersion: "2.1.270",
    };
    const withImages = {
      ...base,
      WORKER_IMAGE_RUNTIME: JSON.stringify(current),
      WORKER_IMAGE_PREVIOUS: "werft-worker:previous",
      WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
    };
    const config = schedulerConfigFromEnv(withImages);
    expect(config.imageRuntime).toEqual(current);
    expect(config.previousImage).toEqual({
      image: "werft-worker:previous",
      runtime: previous,
    });
    // One image, as before: no previous, and without a runtime no selection.
    const single = schedulerConfigFromEnv({
      ...base,
      WORKER_IMAGE_RUNTIME: JSON.stringify(current),
    });
    expect(single.imageRuntime).toEqual(current);
    expect(single.previousImage).toBeUndefined();
    expect(schedulerConfigFromEnv(base).imageRuntime).toBeUndefined();
    for (const half of [
      { ...withImages, WORKER_IMAGE_PREVIOUS: "" },
      { ...withImages, WORKER_IMAGE_PREVIOUS_RUNTIME: "" },
    ]) {
      expect(() => schedulerConfigFromEnv(half)).toThrow(
        "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME are set together",
      );
    }
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_IMAGE_RUNTIME: "0.3.280" }),
    ).toThrow("WORKER_IMAGE_RUNTIME");
  });

  test("falls back to QUEUE_DATABASE_URL and honours explicit limits", () => {
    const config = schedulerConfigFromEnv({
      ...base,
      DATABASE_URL: undefined,
      EXECUTION_SLOT_LIMIT: "3",
      QUEUE_DATABASE_URL: "postgresql://q",
      WORKER_CPUS: "0.5",
      WORKER_MEMORY_MB: "512",
      WORKER_PIDS_LIMIT: "128",
    });
    expect(config).toMatchObject({
      databaseUrl: "postgresql://q",
      resources: {
        cpus: 0.5,
        memoryBytes: 512 * 1024 * 1024,
        pidsLimit: 128,
      },
      slotLimit: 3,
    });
  });

  test("a blank DATABASE_URL does not hide QUEUE_DATABASE_URL", () => {
    expect(
      schedulerConfigFromEnv({
        ...base,
        DATABASE_URL: "",
        QUEUE_DATABASE_URL: "postgresql://q",
      }).databaseUrl,
    ).toBe("postgresql://q");
  });

  test("a LOG_LEVEL that names no level stops the scheduler", () => {
    expect(schedulerConfigFromEnv(base).logLevel).toBe("info");
    const quiet = schedulerConfigFromEnv({ ...base, LOG_LEVEL: "warn" });
    expect(quiet.logLevel).toBe("warn");
    expect(dockerOf(quiet).logLevel).toBe("warn");
    expect(() =>
      schedulerConfigFromEnv({ ...base, LOG_LEVEL: "verbose" }),
    ).toThrow("LOG_LEVEL must be one of debug|info|warn|error");
  });

  test("rejects missing or malformed settings by name", () => {
    expect(() =>
      schedulerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: undefined }),
    ).toThrow("EXECUTION_INSTALLATION_ID");
    expect(() =>
      schedulerConfigFromEnv({ ...base, DATABASE_URL: undefined }),
    ).toThrow("DATABASE_URL");
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_IMAGE: undefined }),
    ).toThrow("WORKER_IMAGE");
    expect(() =>
      schedulerConfigFromEnv({ ...base, EXECUTION_SLOT_LIMIT: "-1" }),
    ).toThrow("EXECUTION_SLOT_LIMIT");
    for (const name of [
      "EXECUTION_SLOT_LIMIT",
      "MAX_TURN_SECONDS",
      "PROVIDER_MAX_RETRIES",
      "QUEUED_INPUT_LIMIT_PER_SESSION",
      "SESSION_COST_LIMIT_USD",
      "STORAGE_LIMIT_BYTES",
    ]) {
      expect(() =>
        schedulerConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(`${name} is required`);
    }
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_CPUS: "0.001" }),
    ).toThrow("at least 0.01");
    expect(() => schedulerConfigFromEnv({ ...base, WORKER_CPUS: "0" })).toThrow(
      "WORKER_CPUS",
    );
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_MEMORY_MB: "1.5" }),
    ).toThrow("WORKER_MEMORY_MB");
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_GATEWAY_URL: undefined }),
    ).toThrow("WORKER_GATEWAY_URL");
  });

  test("runs the Docker backend unless EXECUTION_BACKEND says otherwise", () => {
    expect(schedulerConfigFromEnv(base).execution.backend).toBe("local_docker");
    expect(
      schedulerConfigFromEnv({ ...base, EXECUTION_BACKEND: "" }).execution
        .backend,
    ).toBe("local_docker");
    expect(
      schedulerConfigFromEnv({ ...base, EXECUTION_BACKEND: "local_docker" })
        .execution.backend,
    ).toBe("local_docker");
  });

  test("EXECUTION_BACKEND=kubernetes reads the cluster settings and no Docker ones", () => {
    const config = schedulerConfigFromEnv({
      ...kubernetes,
      // Would fail the Docker parser; the kubernetes backend never reads it.
      EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "not a number",
      LOG_LEVEL: "warn",
    });
    if (config.execution.backend !== "kubernetes") {
      throw new Error(`expected kubernetes, got ${config.execution.backend}`);
    }
    expect(config.execution.kubernetes).toMatchObject({
      egressProxyUrl: base.EXECUTION_EGRESS_PROXY_URL,
      gatewayUrl: "http://api:3000",
      installationId: "dev-a",
      logLevel: "warn",
      namespace: "werft",
      workerLimits: { maxTurnSeconds: 3600, providerMaxRetries: 2 },
    });
  });

  test("an EXECUTION_BACKEND it does not know stops the scheduler, naming the value", () => {
    for (const value of ["eks_job", "docker", "Kubernetes"]) {
      expect(() =>
        schedulerConfigFromEnv({ ...base, EXECUTION_BACKEND: value }),
      ).toThrow(
        `EXECUTION_BACKEND must be one of local_docker|kubernetes (got ${value})`,
      );
    }
  });

  test("a zero slot limit is allowed and stops all launches", () => {
    expect(
      schedulerConfigFromEnv({ ...base, EXECUTION_SLOT_LIMIT: "0" }).slotLimit,
    ).toBe(0);
  });

  test("a paused session keeps its workspace for a day unless told otherwise", () => {
    expect(schedulerConfigFromEnv(base).pausedWorkspaceTtlMs).toBe(
      24 * 60 * 60 * 1_000,
    );
    expect(
      schedulerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_PAUSED_TTL_SEC: "0",
      }).pausedWorkspaceTtlMs,
    ).toBe(0);
    expect(
      schedulerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_PAUSED_TTL_SEC: "604800",
      }).pausedWorkspaceTtlMs,
    ).toBe(7 * 24 * 60 * 60 * 1_000);
    for (const value of ["-1", "1.5"]) {
      expect(() =>
        schedulerConfigFromEnv({
          ...base,
          EXECUTION_WORKSPACE_PAUSED_TTL_SEC: value,
        }),
      ).toThrow("EXECUTION_WORKSPACE_PAUSED_TTL_SEC");
    }
  });

  test("a stopped session keeps its workspace for a day unless told otherwise", () => {
    expect(schedulerConfigFromEnv(base).stoppedWorkspaceTtlMs).toBe(
      24 * 60 * 60 * 1_000,
    );
    expect(
      schedulerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_STOPPED_TTL_SEC: "0",
      }).stoppedWorkspaceTtlMs,
    ).toBe(0);
    expect(() =>
      schedulerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_STOPPED_TTL_SEC: "1.5",
      }),
    ).toThrow("EXECUTION_WORKSPACE_STOPPED_TTL_SEC");
  });
});
