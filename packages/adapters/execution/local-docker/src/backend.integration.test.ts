import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  hashWorkerToken,
  type LaunchIntent,
  launchNonceFingerprint,
  launchSpecFingerprint,
} from "@werft-ai/platform";
import {
  ENV,
  LABELS,
  LocalDockerBackend,
  NO_PROXY_VALUE,
  networkNameFor,
  workspaceVolumePrefixFor,
} from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import { DockerClient } from "./docker-client.ts";
import {
  OFF_QUOTA,
  removeInstallation,
  startStandInProxy,
  testDockerHost,
} from "./testing.ts";

/**
 * Talks to a real Docker daemon. Opt in with `DOCKER_BACKEND_TEST=1`; the
 * daemon is whatever `DOCKER_HOST` (or the default socket) points at. Uses a
 * sleeping busybox in place of the worker image, which is a sibling ticket.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost = await testDockerHost();

const RESOURCES = { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 };

function fingerprintOf(nonce: string): string {
  return launchNonceFingerprint(hashWorkerToken(nonce));
}

function envOf(
  container: { Config: { Env: string[] | null } } | null,
  key: string,
): string {
  const found = (container?.Config.Env ?? []).find((entry) =>
    entry.startsWith(`${key}=`),
  );
  if (!found) throw new Error(`${key} is not set on the container`);
  return found.slice(key.length + 1);
}

function intentFor(overrides: Partial<LaunchIntent> = {}): LaunchIntent {
  const suffix = crypto.randomUUID();
  return {
    bootstrapCredentialState: async () => ({
      claimed: false,
      fingerprint: fingerprintOf(`wln-${suffix}`),
    }),
    executionId: `exec-${suffix}`,
    generation: 1,
    image: IMAGE,
    issueBootstrapNonce: async () => `wln-${suffix}`,
    launchSpec: launchSpecFingerprint(IMAGE, RESOURCES),
    operationId: `op-${suffix}`,
    resources: RESOURCES,
    sessionId: crypto.randomUUID(),
    ...overrides,
  };
}

integration("LocalDockerBackend against a real daemon", () => {
  const client = new DockerClient(dockerHost);
  const installationId = `it-${crypto.randomUUID().slice(0, 8)}`;
  const backendConfig = (): LocalDockerBackendConfig => ({
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressCredentialPort: 3129,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId,
    objectStore: {
      bucket: "claude-sessions",
      region: "ap-northeast-1",
    },
    requestTimeoutMs: 30_000,
    stopTimeoutSeconds: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
    workspaceGcMinAgeMs: 0,
    // Neither Docker Desktop nor a stock Linux runner puts its storage on a
    // quota-capable filesystem; the quota itself is covered by
    // workspace.integration.test.ts, which probes for one first.
    workspaceQuota: OFF_QUOTA,
  });
  const backend = new LocalDockerBackend(backendConfig(), client);

  beforeAll(async () => {
    await client.version();
    // Pull once so create does not 404 on a fresh daemon.
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    // Every worker network gets this installation's proxy; the backend
    // refuses to launch without one.
    await startStandInProxy({ dockerHost, image: IMAGE, installationId });
  }, 120_000);

  afterAll(async () => {
    await removeInstallation(client, installationId, "backend.integration");
  }, 120_000);

  async function fetchDocker(path: string, method = "POST"): Promise<Response> {
    const socket = dockerHost.startsWith("unix://")
      ? dockerHost.slice("unix://".length)
      : undefined;
    const base = socket
      ? "http://docker"
      : dockerHost.replace(/^tcp:\/\//, "http://");
    return fetch(`${base}/v1.44${path}`, {
      method,
      ...(socket ? { unix: socket } : {}),
    } as RequestInit);
  }

  test("ensure twice → one container; docker inspect shows the isolation contract", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    const second = await backend.ensureExecution(intent);
    expect(first.created).toBe(true);
    expect(second).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });

    const matching = await client.listContainers([
      `${LABELS.executionId}=${intent.executionId}`,
    ]);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.Labels?.[LABELS.generation]).toBe("1");

    const inspected = await client.inspectContainer(first.providerRef);
    if (!inspected) throw new Error("container vanished");
    expect(inspected.Config.User).toBe("1000:1000");
    // Docker merges the image's own Env (PATH etc.) into the container; only
    // the variables the backend adds may be left after removing those.
    const imageEnv = new Set(
      (
        (await (
          await fetchDocker(`/images/${encodeURIComponent(IMAGE)}/json`, "GET")
        ).json()) as { Config: { Env: string[] | null } }
      ).Config.Env ?? [],
    );
    expect(
      (inspected.Config.Env ?? []).filter((e) => !imageEnv.has(e)).sort(),
    ).toEqual(
      [
        `${ENV.home}=/home/worker`,
        `${ENV.workspaceDir}=/workspace`,
        `${ENV.workspaceMountDir}=/workspace`,
        `${ENV.workspaceQuotaMode}=off`,
        `${ENV.bootstrapNonce}=${await intent.issueBootstrapNonce()}`,
        `${ENV.executionGeneration}=${intent.generation}`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
        `${ENV.egressCredentialUrl}=http://egress-proxy:3129`,
        `${ENV.httpProxy}=http://egress-proxy:3128`,
        `${ENV.httpProxyLower}=http://egress-proxy:3128`,
        `${ENV.httpsProxy}=http://egress-proxy:3128`,
        `${ENV.httpsProxyLower}=http://egress-proxy:3128`,
        `${ENV.noProxy}=${NO_PROXY_VALUE},egress-proxy`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE},egress-proxy`,
        `${ENV.objectBucket}=claude-sessions`,
        `${ENV.objectPrefix}=sessions/${intent.sessionId}/`,
        `${ENV.objectRegion}=ap-northeast-1`,
        `${ENV.stopGrace}=1`,
      ].sort(),
    );
    const host = inspected.HostConfig as Record<string, unknown>;
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Memory).toBe(RESOURCES.memoryBytes);
    expect(host.PidsLimit).toBe(RESOURCES.pidsLimit);
    expect(host.NanoCpus).toBe(500_000_000);
    // Its own network, created for it and internal.
    const network = await client.inspectNetwork(String(host.NetworkMode));
    expect(network).toMatchObject({
      EnableIPv6: false,
      Internal: true,
      Name: networkNameFor(intent, installationId),
    });
    // No route around the proxy to the daemon host.
    expect(host.ExtraHosts ?? null).toBeNull();
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(host.Binds ?? null).toBeNull();
    expect(host.Mounts).toEqual([
      expect.objectContaining({
        Source: expect.stringMatching(
          new RegExp(
            `^${workspaceVolumePrefixFor(intent.sessionId, backendConfig())}`,
          ),
        ),
        Target: "/workspace",
        Type: "volume",
      }),
    ]);
    expect(Object.keys(host.Tmpfs as Record<string, string>).sort()).toEqual([
      "/home/worker",
      "/tmp",
    ]);
    expect(JSON.stringify(inspected)).not.toContain("docker.sock");
  }, 60_000);

  test("a container holding a credential the registry rotated past is replaced, not adopted", async () => {
    // The registry as the scheduler sees it: whatever was issued last is
    // what bootstrapClaim would accept.
    const suffix = crypto.randomUUID();
    let issued = 0;
    let accepted: string | null = null;
    const intent = intentFor({
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: accepted === null ? null : fingerprintOf(accepted),
      }),
      executionId: `exec-${suffix}`,
      issueBootstrapNonce: async () => {
        issued += 1;
        accepted = `wln-${suffix}-${issued}`;
        return accepted;
      },
    });
    const name = `ap-worker-${installationId}-${intent.executionId}-g1`;

    // The container that sits under the name before the pass under test: a
    // create from an earlier pass that landed late, built with nonce 1.
    const first = await backend.ensureExecution(intent);
    expect(first.created).toBe(true);
    const stale = await client.inspectContainer(name);
    expect(envOf(stale, ENV.bootstrapNonce)).toBe(`wln-${suffix}-1`);

    // The pass under test rotates to nonce 2 before its create loses the
    // name. From here the registry only accepts nonce 2.
    accepted = `wln-${suffix}-2`;
    issued = 2;

    const second = await backend.ensureExecution(intent);

    expect(second.created).toBe(true);
    expect(second.providerRef).not.toBe(first.providerRef);
    expect(await client.inspectContainer(first.providerRef)).toBeNull();
    const replaced = await client.inspectContainer(name);
    if (!replaced) throw new Error("no replacement container");
    // The replacement was created, so it minted: nonce 3 is what it holds,
    // what the registry now accepts, and what the label fingerprints.
    const held = envOf(replaced, ENV.bootstrapNonce);
    expect(held).toBe(`wln-${suffix}-3`);
    expect(accepted).toBe(held);
    const labels = replaced.Config.Labels ?? {};
    expect(labels[LABELS.bootstrapFingerprint]).toBe(fingerprintOf(held));
    expect(JSON.stringify(labels)).not.toContain(held);
    expect(JSON.stringify(labels)).not.toContain(`wln-${suffix}-1`);

    // Adopt, now that label and registry agree: nothing minted, nothing replaced.
    const third = await backend.ensureExecution(intent);
    expect(third).toEqual({
      created: false,
      providerRef: second.providerRef,
      state: "running",
    });
    expect(issued).toBe(3);
  }, 120_000);

  test("a stop not waited for still ends in SIGKILL at the stop timeout", async () => {
    // busybox's `sleep` ignores SIGTERM, like a worker draining its turn.
    const draining = new LocalDockerBackend(
      { ...backendConfig(), requestTimeoutMs: 1_000, stopTimeoutSeconds: 6 },
      client,
    );
    const intent = intentFor();
    const { providerRef } = await draining.ensureExecution(intent);

    expect(await draining.terminate(intent, { waitForExit: false })).toEqual({
      outcome: "stopping",
      providerRef,
    });
    expect(await draining.inspect(intent)).toMatchObject({ state: "running" });
    const deadline = Date.now() + 20_000;
    while ((await draining.inspect(intent)).state === "running") {
      if (Date.now() > deadline) throw new Error("the stop was dropped");
      await Bun.sleep(500);
    }
    expect(await draining.terminate(intent, { waitForExit: false })).toEqual({
      outcome: "terminated",
      providerRef,
    });
    expect((await draining.inspect(intent)).found).toBe(false);
  }, 60_000);

  test("the non-root worker can write to HOME and /tmp", async () => {
    // busybox has no uid 1000 in /etc/passwd, so a writable HOME must come
    // from the mount options and the HOME env, not from the image.
    const probe = new LocalDockerBackend(
      {
        ...backendConfig(),
        command: [
          "sh",
          "-c",
          'echo ok > "$HOME/probe" && echo ok > /tmp/probe && sleep 600',
        ],
      },
      client,
    );
    const intent = intentFor();
    await probe.ensureExecution(intent);
    await Bun.sleep(1_500);
    const observed = await probe.inspect(intent);
    expect(observed.state).toBe("running");
  }, 60_000);

  test("the preflight finds this installation's proxy", async () => {
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  }, 30_000);

  test("terminate takes the worker's network with it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const name = networkNameFor(intent, installationId);
    expect(await client.inspectNetwork(name)).not.toBeNull();

    expect(await backend.terminate(intent)).toMatchObject({
      outcome: "terminated",
    });
    expect(await client.inspectNetwork(name)).toBeNull();
  }, 60_000);
});
