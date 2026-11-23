import { describeExecutionBackendContract } from "@werft-ai/platform/testing/execution-backend";
import { LocalDockerBackend } from "./backend.ts";
import { DockerClient } from "./docker-client.ts";
import {
  removeInstallation,
  startStandInProxy,
  testDockerHost,
} from "./testing.ts";

/** Opt in with `DOCKER_BACKEND_TEST=1`, like backend.integration.test.ts. */
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";

describeExecutionBackendContract("LocalDockerBackend", {
  create: async () => {
    const dockerHost = await testDockerHost();
    const client = new DockerClient(dockerHost);
    const installationId = `ct-${crypto.randomUUID().slice(0, 8)}`;
    await client.version();
    // Pull once so create does not 404 on a fresh daemon.
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    // The backend refuses to launch without this installation's proxy.
    await startStandInProxy({ dockerHost, image: IMAGE, installationId });
    const backend = new LocalDockerBackend(
      {
        apiVersion: "v1.44",
        command: ["sleep", "600"],
        dockerHost,
        egressCredentialPort: 3129,
        egressProxyUrl: "http://egress-proxy:3128",
        gatewayUrl: "http://host.docker.internal:3000",
        homeDir: "/home/worker",
        installationId,
        objectStore: { bucket: "claude-sessions", region: "ap-northeast-1" },
        requestTimeoutMs: 30_000,
        stopTimeoutSeconds: 1,
        tmpfsSizeBytes: 16 * 1024 * 1024,
        user: "1000:1000",
        workspaceDir: "/workspace",
        volumeLabelNamespace: "werft",
        volumeNamePrefix: "werft-ws-",
        workspaceGcMinAgeMs: 0,
        // See backend.integration.test.ts: the quota is covered by
        // workspace.integration.test.ts on a daemon that can carry one.
        workspaceQuota: { mode: "off" },
      },
      client,
    );
    return {
      backend,
      removeOutOfBand: (providerRef) =>
        client.stopAndRemoveContainer(providerRef, 1),
      tearDown: () =>
        removeInstallation(client, installationId, "backend.contract"),
    };
  },
  enabled: process.env.DOCKER_BACKEND_TEST === "1",
  image: IMAGE,
});
