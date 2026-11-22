import { expect, test } from "bun:test";
import { ENV as SHARED_ENV } from "@werft-ai/contracts/execution";
import {
  checkoutDirOf,
  ENV,
  workerEnvironmentFor,
} from "@werft-ai/execution-kubernetes";
import { testConfig } from "@werft-ai/execution-kubernetes/testing";
import {
  ENV as DOCKER_ENV,
  workerEnvironmentFor as dockerEnvironmentFor,
} from "@werft-ai/execution-local-docker";
import type { LaunchIntent } from "@werft-ai/platform";

const config = {
  ...testConfig("agents", "prod"),
  workerLimits: { maxTurnSeconds: 900, providerMaxRetries: 3 },
};
const NONCE = "wln_never-in-the-pod";
const intent: LaunchIntent = {
  bootstrapCredentialState: async () => ({ claimed: true }),
  executionId: "exec-1",
  generation: 3,
  image: `worker@sha256:${"c".repeat(64)}`,
  issueBootstrapNonce: async () => NONCE,
  launchSpec: "f".repeat(64),
  operationId: "op-1",
  resources: { cpus: 1.5, memoryBytes: 1024 * 1024 * 1024, pidsLimit: 512 },
  sessionId: "6c1f8d0e-0000-4000-8000-000000000001",
};

test("the Kubernetes backend tells the worker exactly what the Docker backend tells it, under the same names", () => {
  expect(ENV).toBe(SHARED_ENV);
  expect(DOCKER_ENV).toBe(SHARED_ENV);
  const docker = dockerEnvironmentFor(
    {
      apiVersion: "v1.44",
      dockerHost: "unix:///var/run/docker.sock",
      egressCredentialPort: config.egressCredentialPort,
      egressProxyUrl: config.egressProxyUrl,
      gatewayUrl: config.gatewayUrl,
      homeDir: config.homeDir,
      installationId: "prod",
      objectStore: config.objectStore,
      requestTimeoutMs: 1,
      stopTimeoutSeconds: config.stopTimeoutSeconds,
      tmpfsSizeBytes: 1,
      user: config.user,
      workerLimits: config.workerLimits,
      // The checkout below the mount (CHECKOUT_DIRECTORY).
      workspaceDir: checkoutDirOf(config),
      volumeLabelNamespace: "werft",
      volumeNamePrefix: "werft-ws-",
      workspaceGcMinAgeMs: 0,
      workspaceQuota: { mode: "off" },
    },
    intent,
    NONCE,
  );
  const kubernetes = workerEnvironmentFor(config, intent, "secret-name").map(
    (e) => ("value" in e ? `${e.name}=${e.value}` : `${e.name}=${NONCE}`),
  );
  const observations = [
    ENV.workspaceMountDir,
    ENV.workspaceQuotaBytes,
    ENV.workspaceQuotaMode,
  ];
  const common = (values: string[]) =>
    values.filter(
      (value) => !observations.some((name) => value.startsWith(`${name}=`)),
    );
  expect(common(kubernetes)).toEqual(common(docker));
  expect(kubernetes).toContain(
    `${ENV.workspaceMountDir}=${config.workspaceDir}`,
  );
  expect(kubernetes).toContain(
    `${ENV.workspaceQuotaBytes}=${config.workspaceSizeBytes}`,
  );
  expect(
    kubernetes.some((value) => value.startsWith(`${ENV.workspaceQuotaMode}=`)),
  ).toBe(false);
});
