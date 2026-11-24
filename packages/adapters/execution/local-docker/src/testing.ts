/**
 * Fixtures for integration tests against a real daemon. Not part of the
 * backend: nothing in `src/index.ts` re-exports this module.
 */
import { LABELS } from "./backend.ts";
import type { WorkspaceQuota } from "./config.ts";
import { DockerClient, parseDockerHost } from "./docker-client.ts";

/** The opt-out with the default limits the worker then measures against. */
export const OFF_QUOTA: WorkspaceQuota = {
  mode: "off",
  sizeBytes: 4096 * 1024 * 1024,
  inodes: 1_000_000,
};

/**
 * The quota a suite holds a daemon to: enforced where the daemon can carry
 * one, `off` where it cannot. Enforced needs an image with xfsprogs for the
 * inode helper, named by `DOCKER_BACKEND_TEST_HELPER_IMAGE` (the
 * `workspace-quota` CI job builds one). A capable daemon without it is an
 * error, not a skip: the run would claim a ceiling it never set.
 */
export function quotaForTestDaemon(
  capable: boolean,
  limits: { sizeBytes: number; inodes: number },
): WorkspaceQuota {
  if (!capable) return { mode: "off", ...limits };
  const helperImage = process.env.DOCKER_BACKEND_TEST_HELPER_IMAGE;
  if (!helperImage) {
    throw new Error(
      "This daemon can carry a workspace quota, so DOCKER_BACKEND_TEST_HELPER_IMAGE must name an image with xfsprogs for the inode helper",
    );
  }
  return { helperImage, mode: "enforced", ...limits };
}

/**
 * A container the backend will accept as an installation's egress proxy:
 * running and labelled for it. It forwards nothing, so a worker launched
 * next to it has no route out at all; suites that need real egress run
 * `apps/egress-proxy` instead (see `egress.integration.test.ts`). It also
 * carries the installation label, so a suite's label-scoped cleanup of its
 * own containers takes it too.
 */
export async function startStandInProxy(options: {
  dockerHost: string;
  image: string;
  installationId: string;
  /** For a second proxy of the same installation. */
  name?: string;
}): Promise<string> {
  const name = options.name ?? `ap-it-proxy-${options.installationId}`;
  const response = await rawRequest(
    options.dockerHost,
    "POST",
    `/containers/create?name=${encodeURIComponent(name)}`,
    {
      Cmd: ["sleep", "3600"],
      Image: options.image,
      Labels: {
        [LABELS.egressProxy]: options.installationId,
        [LABELS.installation]: options.installationId,
      },
    },
  );
  if (response.status !== 201) {
    throw new Error(
      `stand-in proxy ${name} was not created: ${response.status} ${await response.text()}`,
    );
  }
  await new DockerClient(options.dockerHost).startContainer(name);
  return name;
}

/**
 * Removes the worker networks the backend made for `installationId`. Run
 * after the suite's containers are gone: a network with a member left on
 * it cannot be removed, and the failure is left to the caller to report.
 */
export async function removeWorkerNetworks(
  client: DockerClient,
  installationId: string,
): Promise<void> {
  const networks = await client.listNetworks([
    `${LABELS.workerNetwork}=true`,
    `${LABELS.installation}=${installationId}`,
  ]);
  const removals = await Promise.allSettled(
    networks.map((network) => client.removeNetwork(network.Id)),
  );
  const failed = removals.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} worker network(s) of ${installationId} were not removed: ${failed.map((r) => String(r.reason)).join("; ")}`,
    );
  }
}

/**
 * The daemon a suite talks to: `DOCKER_HOST`, or the first default socket
 * that exists.
 */
export async function testDockerHost(): Promise<string> {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const candidates = [
    "/var/run/docker.sock",
    `${process.env.HOME}/.docker/run/docker.sock`,
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return `unix://${path}`;
  }
  return "unix:///var/run/docker.sock";
}

/**
 * Removes every container, volume and worker network labelled for
 * `installationId`. Leftovers are a daemon hygiene problem, not a contract
 * violation: they are reported under `suite` and the suite's verdict stands.
 */
export async function removeInstallation(
  client: DockerClient,
  installationId: string,
  suite: string,
): Promise<void> {
  // Everything the backend makes carries the installation label, so one
  // listing finds exactly what exists — no probing generations that were
  // never created. Stops run in parallel: each one waits out the 1s stop
  // timeout because busybox's `sleep` ignores SIGTERM, and in series that
  // alone used to eat bun's 5s hook budget.
  const owned = [`${LABELS.installation}=${installationId}`];
  const t0 = performance.now();
  // A failed listing is itself a cleanup failure, not an empty daemon:
  // it goes into `failed` instead of quietly skipping everything it owned.
  const [containers, volumes] = await Promise.allSettled([
    client.listContainers(owned),
    client.listVolumes(owned),
  ]);
  const stops = await Promise.allSettled(
    (containers.status === "fulfilled" ? containers.value : []).map((c) =>
      client.stopAndRemoveContainer(c.Id, 1),
    ),
  );
  const removes = await Promise.allSettled(
    (volumes.status === "fulfilled" ? volumes.value : []).map((v) =>
      client.removeVolume(v.Name),
    ),
  );
  // After the containers: a network with a member left cannot go.
  const network = await Promise.allSettled([
    removeWorkerNetworks(client, installationId),
  ]);
  const failed = [containers, volumes, ...stops, ...removes, ...network].filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed.length > 0) {
    console.warn(
      `[${suite}] ${failed.length} cleanup step(s) failed after ${Math.round(performance.now() - t0)}ms; leftovers carry ${owned[0]}`,
      failed.map((r) => String(r.reason)),
    );
  }
}

async function rawRequest(
  dockerHost: string,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const endpoint = parseDockerHost(dockerHost);
  const base = endpoint.kind === "unix" ? "http://docker" : endpoint.baseUrl;
  return fetch(`${base}/v1.44${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(60_000),
    ...(endpoint.kind === "unix" ? { unix: endpoint.socketPath } : {}),
  } as RequestInit);
}
