/**
 * What the integration tests need from a real cluster (kind) beyond the
 * backend: a namespace of their own, out-of-band removal, and cleanup.
 * Opt in with `K8S_BACKEND_TEST=1` and a `KUBECONFIG` for the cluster.
 */
import type { KubernetesBackend } from "../backend.ts";
import { KubernetesClient, kubernetesConnectionFromEnv } from "../client.ts";
import type { KubernetesBackendConfig } from "../config.ts";
import { LABELS } from "../specs.ts";

export const TEST_ENABLED = Bun.env.K8S_BACKEND_TEST === "1";

/**
 * busybox:1.36 by digest; resolveImage refuses anything else. Override with
 * `K8S_BACKEND_TEST_IMAGE` (also a digest) for a registry the cluster reaches.
 */
export const TEST_IMAGE =
  Bun.env.K8S_BACKEND_TEST_IMAGE ??
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

/** What `testResolver` answers for any name: a ClusterIP-shaped address. */
export const TEST_PROXY_ADDRESS = "10.96.200.1";

/**
 * Stands in for the scheduler's resolver: the tests run outside the
 * cluster, where the proxy's Service name resolves to nothing.
 */
export const testResolver = async (): Promise<string[]> => [TEST_PROXY_ADDRESS];

export async function testClient(): Promise<KubernetesClient> {
  return new KubernetesClient(await kubernetesConnectionFromEnv(Bun.env), {
    timeoutMs: 30_000,
  });
}

export function testConfig(
  namespace: string,
  installationId: string,
): KubernetesBackendConfig {
  return {
    command: ["sleep", "600"],
    egressCredentialPort: 3129,
    egressProxyUrl: "http://egress-proxy:3128",
    ephemeralStorageBytes: 64 * 1024 * 1024,
    gatewayUrl: "http://gateway:3000",
    homeDir: "/home/worker",
    imagePullSecrets: [],
    installationId,
    namespace,
    nodeSelector: {},
    objectStore: { bucket: "claude-sessions", region: "ap-northeast-1" },
    requestTimeoutMs: 30_000,
    // busybox `sleep` as PID 1 ignores SIGTERM; a long grace would make
    // every terminate wait it out.
    stopTimeoutSeconds: 1,
    storageClass: null,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    tolerations: [],
    user: "1000:1000",
    workerServiceAccount: null,
    workspaceDir: "/workspace",
    volumeNamePrefix: "werft-ws-",
    workspaceGcMinAgeMs: 0,
    workspaceSizeBytes: 64 * 1024 * 1024,
  };
}

export async function createNamespace(
  client: KubernetesClient,
  name: string,
): Promise<void> {
  await client.request("POST", "/api/v1/namespaces", {
    body: { apiVersion: "v1", kind: "Namespace", metadata: { name } },
  });
}

/** Deletes the namespace unless `K8S_BACKEND_TEST_KEEP=1` asks to look at it. */
export async function deleteNamespace(
  client: KubernetesClient,
  name: string,
): Promise<void> {
  if (Bun.env.K8S_BACKEND_TEST_KEEP === "1") return;
  await client.request("DELETE", `/api/v1/namespaces/${name}`, {
    absent: true,
  });
}

/** Deletes the Pod with this uid behind the backend's back, and waits it out. */
export async function removePodOutOfBand(
  client: KubernetesClient,
  namespace: string,
  installationId: string,
  uid: string,
): Promise<void> {
  const pods = await client.list(namespace, "pods", {
    [LABELS.installation]: installationId,
  });
  const pod = pods.find((p) => p.metadata.uid === uid);
  if (pod === undefined) return;
  const { name } = pod.metadata;
  await client.delete(namespace, "pods", name, { gracePeriodSeconds: 0, uid });
  for (;;) {
    const now = await client.get(namespace, "pods", name);
    if (now === null || now.metadata.uid !== uid) return;
    await Bun.sleep(250);
  }
}

/**
 * Takes down everything through the backend — terminate, then workspace
 * removal — and reports what the installation label still selects. That
 * leftover list is what "a finished session leaves nothing" means.
 */
export async function drainInstallation(
  backend: KubernetesBackend,
  client: KubernetesClient,
  namespace: string,
  installationId: string,
): Promise<string[]> {
  for (const managed of await backend.listManaged()) {
    await backend.terminate(managed);
  }
  for (const workspace of await backend.listWorkspaces()) {
    await backend.removeWorkspace(workspace.id);
  }
  const selector = { [LABELS.installation]: installationId };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const left = [
      ...(await client.list(namespace, "pods", selector)).map(
        (o) => `pod/${o.metadata.name}`,
      ),
      ...(await client.list(namespace, "secrets", selector)).map(
        (o) => `secret/${o.metadata.name}`,
      ),
      ...(await client.list(namespace, "persistentvolumeclaims", selector)).map(
        (o) => `pvc/${o.metadata.name}`,
      ),
    ];
    // A deleted claim lingers while its protection finalizer is lifted.
    if (left.length === 0 || Date.now() > deadline) return left;
    await Bun.sleep(500);
  }
}
