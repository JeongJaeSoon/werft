import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  DEFAULT_INSTALLATION_ID,
  DEFAULT_WORKER_USER,
  DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
  DEFAULT_WORKSPACE_QUOTA_MB,
  MIN_WORKSPACE_QUOTA_MB,
} from "@werft-ai/contracts/execution";
import { integerSetting } from "@werft-ai/contracts/settings";

export type WorkerObjectStoreAccess = { bucket: string; region: string };

/** A toleration as the Pod spec takes it; checked for shape, not meaning. */
export type Toleration = Record<string, unknown>;

export type KubernetesBackendConfig = {
  /** Where worker Pods, their nonce Secrets and workspace PVCs live. */
  namespace: string;
  /**
   * Identifies this control host in a namespace other installations may
   * share. Only resources labelled with it are listed, adopted or removed.
   * A DNS label, since it goes into every resource name.
   */
  installationId: string;
  /** Handed to the worker as `WORKER_GATEWAY_URL`. */
  gatewayUrl: string;
  /**
   * The egress proxy's Service, by name: the worker reaches it as
   * `HTTP(S)_PROXY`, and the NetworkPolicy the chart installs is what makes
   * it the only route off the Pod. The backend resolves the name to the
   * Service's one ClusterIP and writes it into the Pod's hosts file, since
   * the Pod has no DNS.
   */
  egressProxyUrl: string;
  egressCredentialPort: number;
  objectStore: WorkerObjectStoreAccess;
  /** Null runs the Pod as the namespace's `default` ServiceAccount. */
  workerServiceAccount: string | null;
  /** Null leaves the PVC to the cluster's default StorageClass. */
  storageClass: string | null;
  imagePullSecrets: string[];
  nodeSelector: Record<string, string>;
  tolerations: Toleration[];
  /** The workspace PVC's requested size; enforcement depends on storage. */
  workspaceSizeBytes: number;
  /** Operator declaration covering all workspace PVCs, including existing ones. */
  workspaceEnforcedByStorage?: boolean;
  /** See `LocalDockerBackendConfig.workspaceGcMinAgeMs`. */
  workspaceGcMinAgeMs: number;
  /**
   * The name prefix of workspace PVCs, trailing `-` included. A claim is
   * found by this derived name, which Kubernetes cannot change, so an install
   * whose claims were made under another prefix sets it here.
   */
  volumeNamePrefix: string;
  /**
   * The Pod's `terminationGracePeriodSeconds`, handed to the worker as
   * `WORKER_STOP_GRACE_SEC` so it sizes its drain to fit.
   */
  stopTimeoutSeconds: number;
  /** Deadline for each API server call. */
  requestTimeoutMs: number;
  /** `uid:gid`, numeric and not root. */
  user: string;
  homeDir: string;
  workspaceDir: string;
  /** Size of each memory-backed emptyDir (`/tmp` and HOME). */
  tmpfsSizeBytes: number;
  /**
   * The worker container's `ephemeral-storage` request and limit: node disk
   * outside the PVC and the memory-backed mounts, which with a read-only
   * root is mostly its log. Past it the kubelet evicts the Pod.
   */
  ephemeralStorageBytes: number;
  /** Replaces the image's `CMD` (Pod `args`); tests run a sleeping busybox. */
  command?: string[];
  workerLimits?: { maxTurnSeconds: number; providerMaxRetries: number };
  logLevel?: string;
};

/** Shaped like the process environment so it can be passed straight through. */
export type KubernetesBackendEnvironment = {
  [key: string]: string | undefined;
};

/** Where every Pod finds its own ServiceAccount's namespace. */
export const IN_CLUSTER_NAMESPACE_FILE =
  "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export const DEFAULT_STOP_TIMEOUT_SECONDS = 120;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKER_EPHEMERAL_STORAGE_MB = 1024;

// RFC 1123 label, kept short: it is part of every Pod, Secret and PVC name.
const INSTALLATION_ID = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const DEFAULT_VOLUME_NAME_PREFIX = "werft-ws-";
// Part of a PVC name, so a DNS label fragment that ends where the id begins.
const VOLUME_NAME_PREFIX = /^[a-z0-9][a-z0-9-]{0,30}-$/;
const DNS_SUBDOMAIN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function kubernetesConfigFromEnv(
  environment: KubernetesBackendEnvironment,
  readNamespaceFile: () => string | null = inClusterNamespace,
): KubernetesBackendConfig {
  const gatewayUrl = required(environment, "WORKER_GATEWAY_URL");
  const egressProxyUrl = required(environment, "EXECUTION_EGRESS_PROXY_URL");
  const namespace =
    nonEmpty(environment.EXECUTION_K8S_NAMESPACE) ?? readNamespaceFile();
  if (namespace === null) {
    throw new Error(
      `EXECUTION_K8S_NAMESPACE is required outside a cluster (no ${IN_CLUSTER_NAMESPACE_FILE})`,
    );
  }
  const quotaMb = integerSetting(environment, "EXECUTION_WORKSPACE_QUOTA_MB", {
    min: 1,
    default: DEFAULT_WORKSPACE_QUOTA_MB,
  });
  if (quotaMb < MIN_WORKSPACE_QUOTA_MB) {
    throw new Error(
      `EXECUTION_WORKSPACE_QUOTA_MB ${quotaMb} is under the ${MIN_WORKSPACE_QUOTA_MB} a checkpoint restore needs`,
    );
  }
  return validateKubernetesConfig({
    egressCredentialPort: integerSetting(
      environment,
      "EXECUTION_EGRESS_CREDENTIAL_PORT",
      { default: 3129, max: 65_535, min: 1 },
    ),
    egressProxyUrl,
    ephemeralStorageBytes:
      integerSetting(environment, "EXECUTION_K8S_WORKER_EPHEMERAL_STORAGE_MB", {
        default: DEFAULT_WORKER_EPHEMERAL_STORAGE_MB,
        min: 1,
      }) *
      1024 *
      1024,
    gatewayUrl,
    homeDir: "/home/worker",
    imagePullSecrets: (environment.EXECUTION_K8S_IMAGE_PULL_SECRETS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    installationId:
      nonEmpty(environment.EXECUTION_INSTALLATION_ID) ??
      DEFAULT_INSTALLATION_ID,
    namespace,
    nodeSelector: jsonSetting(
      environment,
      "EXECUTION_K8S_WORKER_NODE_SELECTOR",
      {},
    ) as Record<string, string>,
    objectStore: {
      bucket: required(environment, "S3_BUCKET"),
      region: required(environment, "AWS_REGION"),
    },
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    stopTimeoutSeconds: DEFAULT_STOP_TIMEOUT_SECONDS,
    storageClass: nonEmpty(environment.EXECUTION_K8S_STORAGE_CLASS),
    tmpfsSizeBytes: 256 * 1024 * 1024,
    tolerations: jsonSetting(
      environment,
      "EXECUTION_K8S_WORKER_TOLERATIONS",
      [],
    ) as Toleration[],
    user: DEFAULT_WORKER_USER,
    workerServiceAccount: nonEmpty(
      environment.EXECUTION_K8S_WORKER_SERVICE_ACCOUNT,
    ),
    workspaceDir: "/workspace",
    workspaceEnforcedByStorage: workspaceEnforcedByStorageFromEnv(environment),
    // Zero is a real setting: reclaim as soon as the session is finished.
    workspaceGcMinAgeMs:
      integerSetting(environment, "EXECUTION_WORKSPACE_GC_MIN_AGE_SEC", {
        default: DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
        min: 0,
      }) * 1_000,
    workspaceSizeBytes: quotaMb * 1024 * 1024,
    volumeNamePrefix:
      nonEmpty(environment.EXECUTION_VOLUME_NAME_PREFIX) ??
      DEFAULT_VOLUME_NAME_PREFIX,
  });
}

/** The invariants every worker Pod relies on, checked once. */
export function validateKubernetesConfig(
  config: KubernetesBackendConfig,
): KubernetesBackendConfig {
  if (!DNS_LABEL.test(config.namespace)) {
    throw new Error(
      `EXECUTION_K8S_NAMESPACE ${config.namespace} is not a namespace name`,
    );
  }
  if (!INSTALLATION_ID.test(config.installationId)) {
    throw new Error(
      `EXECUTION_INSTALLATION_ID ${config.installationId} must be a lowercase DNS label of at most 32 characters in kubernetes mode`,
    );
  }
  for (const [name, value] of [
    ["EXECUTION_K8S_WORKER_SERVICE_ACCOUNT", config.workerServiceAccount],
    ["EXECUTION_K8S_STORAGE_CLASS", config.storageClass],
    ...config.imagePullSecrets.map(
      (secret) => ["EXECUTION_K8S_IMAGE_PULL_SECRETS", secret] as const,
    ),
  ] as const) {
    if (value !== null && !DNS_SUBDOMAIN.test(value)) {
      throw new Error(`${name} ${value} is not a Kubernetes object name`);
    }
  }
  if (
    typeof config.nodeSelector !== "object" ||
    config.nodeSelector === null ||
    Array.isArray(config.nodeSelector) ||
    Object.values(config.nodeSelector).some((v) => typeof v !== "string")
  ) {
    throw new Error(
      "EXECUTION_K8S_WORKER_NODE_SELECTOR must be a JSON object of strings",
    );
  }
  if (
    !Array.isArray(config.tolerations) ||
    config.tolerations.some(
      (t) => typeof t !== "object" || t === null || Array.isArray(t),
    )
  ) {
    throw new Error(
      "EXECUTION_K8S_WORKER_TOLERATIONS must be a JSON array of objects",
    );
  }
  // Pod securityContext takes numbers; uid 0 in any spelling is root.
  const [uid, gid] = config.user.split(":");
  if (
    !uid ||
    !/^\d+$/.test(uid) ||
    Number(uid) === 0 ||
    (gid !== undefined && (!/^\d+$/.test(gid) || Number(gid) === 0))
  ) {
    throw new Error(
      `Worker user ${config.user} must be a numeric non-root uid[:gid]`,
    );
  }
  if (!config.homeDir.startsWith("/") || !config.workspaceDir.startsWith("/")) {
    throw new Error("homeDir and workspaceDir must be absolute paths");
  }
  if (config.homeDir === config.workspaceDir) {
    throw new Error("homeDir and workspaceDir must differ");
  }
  try {
    new URL(config.gatewayUrl);
  } catch {
    throw new Error(`WORKER_GATEWAY_URL ${config.gatewayUrl} is not a URL`);
  }
  let proxy: URL;
  try {
    proxy = new URL(config.egressProxyUrl);
  } catch {
    // Not quoted: a value that failed to parse may still hold a credential.
    throw new Error("EXECUTION_EGRESS_PROXY_URL is not a URL");
  }
  if (proxy.username !== "" || proxy.password !== "") {
    throw new Error("EXECUTION_EGRESS_PROXY_URL must not carry credentials");
  }
  if (proxy.protocol !== "http:") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} must be an http:// URL`,
    );
  }
  if (proxy.pathname !== "/" || proxy.search !== "" || proxy.hash !== "") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} must name only a host and port`,
    );
  }
  // A Service name is stable across proxy restarts; a Pod address is not,
  // and the NetworkPolicy selects the proxy by label, not by address.
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  if (isIP(proxyHost) !== 0 || proxyHost === "localhost") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} must name the proxy Service by a host name`,
    );
  }
  if (
    !Number.isInteger(config.egressCredentialPort) ||
    config.egressCredentialPort < 1 ||
    config.egressCredentialPort > 65_535 ||
    String(config.egressCredentialPort) === proxy.port
  ) {
    throw new Error(
      `EXECUTION_EGRESS_CREDENTIAL_PORT ${config.egressCredentialPort} must be a port other than the proxy's own`,
    );
  }
  if (!VOLUME_NAME_PREFIX.test(config.volumeNamePrefix)) {
    throw new Error(
      `EXECUTION_VOLUME_NAME_PREFIX ${config.volumeNamePrefix} must be lowercase letters, digits or "-" and end with "-"`,
    );
  }
  for (const [name, value] of [
    ["workspaceSizeBytes", config.workspaceSizeBytes],
    ["stopTimeoutSeconds", config.stopTimeoutSeconds],
    ["requestTimeoutMs", config.requestTimeoutMs],
    ["tmpfsSizeBytes", config.tmpfsSizeBytes],
    ["ephemeralStorageBytes", config.ephemeralStorageBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} ${value} is not a positive integer`);
    }
  }
  if (
    !Number.isSafeInteger(config.workspaceGcMinAgeMs) ||
    config.workspaceGcMinAgeMs < 0
  ) {
    throw new Error("workspaceGcMinAgeMs must be a non-negative integer");
  }
  // Names only in these messages, never the values: they end up in logs.
  for (const [name, value] of [
    ["AWS_REGION", config.objectStore.region],
    ["S3_BUCKET", config.objectStore.bucket],
  ] as const) {
    if (value.trim() === "" || /[\s=]/.test(value)) {
      throw new Error(`${name} must be a single non-empty token`);
    }
  }
  return config;
}

function inClusterNamespace(): string | null {
  try {
    return readFileSync(IN_CLUSTER_NAMESPACE_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function jsonSetting(
  environment: KubernetesBackendEnvironment,
  name: string,
  fallback: unknown,
): unknown {
  const raw = nonEmpty(environment[name]);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function required(
  environment: KubernetesBackendEnvironment,
  name: string,
): string {
  const value = nonEmpty(environment[name]);
  if (value === null) throw new Error(`${name} is required`);
  return value;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function workspaceEnforcedByStorageFromEnv(
  environment: KubernetesBackendEnvironment,
): boolean {
  const value = environment.EXECUTION_WORKSPACE_ENFORCED_BY_STORAGE;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    "EXECUTION_WORKSPACE_ENFORCED_BY_STORAGE must be true or false",
  );
}
