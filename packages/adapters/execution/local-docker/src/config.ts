import { isIP } from "node:net";
import {
  DEFAULT_INSTALLATION_ID,
  DEFAULT_WORKER_USER,
  DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
  DEFAULT_WORKSPACE_QUOTA_MB,
  MIN_WORKSPACE_QUOTA_MB,
} from "@werft-ai/contracts/execution";
import { integerSetting } from "@werft-ai/contracts/settings";
import {
  DEFAULT_DOCKER_API_VERSION,
  DEFAULT_DOCKER_HOST,
  DEFAULT_DOCKER_REQUEST_TIMEOUT_MS,
} from "./docker-client.ts";

/**
 * `enforced` puts a byte ceiling on the per-session workspace volume through
 * the `local` driver's `size` option, which only holds on a daemon whose
 * storage sits on a quota-capable filesystem (xfs with `prjquota`), and an
 * inode ceiling on the same xfs project, which Docker has no option for and
 * a helper container sets instead (`workspace-inodes.ts`). `off` is the
 * deliberate opt-out for daemons that cannot: it is never the fallback a
 * missing capability drops into, because an unbounded workspace lets one
 * worker fill the host out from under every other session on the daemon —
 * with bytes, or with millions of empty files.
 */
export type WorkspaceQuota =
  | {
      mode: "enforced";
      sizeBytes: number;
      inodes: number;
      /**
       * What the inode helper runs from: the scheduler's own worker image
       * (`WORKER_IMAGE`), which carries xfsprogs. Never a launch's image —
       * the helper holds CAP_SYS_ADMIN, and which image gets that is the
       * operator's choice, not something a catalog entry can steer.
       */
      helperImage: string;
    }
  | { mode: "off" };

export type LocalDockerBackendConfig = {
  apiVersion: string;
  /** Overrides the image entrypoint; tests use it to run a sleeping busybox. */
  command?: string[];
  dockerHost: string;
  /**
   * The forward proxy that is each worker network's only route off itself.
   * Handed to the worker as `HTTP_PROXY`/`HTTPS_PROXY`; the destination
   * allowlist lives in the proxy, not here. Its host must be a name: the
   * proxy container joins every worker's network under that alias, and its
   * address differs on each one.
   */
  egressProxyUrl: string;
  /**
   * The port of the same proxy's credential routes, where the
   * worker's provider and repository calls pick up the credentials it never
   * holds. Same host as `egressProxyUrl`, since only that alias resolves on
   * a worker network; handed to the worker as `WORKER_EGRESS_CREDENTIAL_URL`.
   */
  egressCredentialPort: number;
  /** Handed to the worker as `WORKER_GATEWAY_URL`. */
  gatewayUrl: string;
  /** Mounted as tmpfs so the read-only rootfs still has a writable HOME. */
  homeDir: string;
  /**
   * Identifies this control host on a daemon shared with other installations
   * (another database, another environment). Only containers carrying the
   * same id are ever listed, adopted or reaped.
   */
  installationId: string;
  /**
   * Where the worker mirrors transcripts and publishes checkpoints: the
   * bucket and region, plus the session prefix the backend computes per
   * launch. No endpoint and no credential — the worker reaches the store
   * only through the egress proxy's object store route, which the API signs
   * for.
   */
  objectStore: WorkerObjectStoreAccess;
  /** Deadline for each Docker Engine API call. */
  requestTimeoutMs: number;
  /**
   * Seconds between SIGTERM and SIGKILL on terminate, handed to the worker as
   * `WORKER_STOP_GRACE_SEC` so it sizes its drain to fit. 120 by default.
   */
  stopTimeoutSeconds: number;
  tmpfsSizeBytes: number;
  /** `uid:gid`; must not be root. */
  user: string;
  /** Mount point of the per-session volume. */
  workspaceDir: string;
  /**
   * How long a workspace volume must have existed before GC will consider
   * it. A volume is created before the container that mounts it and before
   * anything records the session, so a young orphan is more likely a launch
   * in flight than one to reclaim.
   */
  workspaceGcMinAgeMs: number;
  workspaceQuota: WorkspaceQuota;
  /**
   * The key prefix of the labels on workspace volumes (`<ns>.managed`, ...).
   * A volume's labels cannot be edited after it is created, so an install
   * whose volumes carry another prefix sets it here instead of copying them.
   */
  volumeLabelNamespace: string;
  /**
   * The name prefix of workspace volumes, trailing `-` included. Names are
   * likewise fixed at creation, and the name-derived lookups use this too.
   */
  volumeNamePrefix: string;
  /**
   * Installation limits the worker enforces itself, handed to it as
   * `WORKER_MAX_TURN_SEC` and `WORKER_PROVIDER_MAX_RETRIES`. The scheduler
   * always sets them; a worker launched without the retries refuses to
   * start, since that limit has no code default. Only backends
   * running a stand-in image leave this out.
   */
  workerLimits?: { maxTurnSeconds: number; providerMaxRetries: number };
  /**
   * The scheduler's own `LOG_LEVEL`, handed to the worker as is.
   * Not part of the isolation stamp: an adopted container keeps the level it
   * was launched with rather than being replaced for it.
   */
  logLevel?: string;
};

export type WorkerObjectStoreAccess = {
  bucket: string;
  region: string;
};

/** Shaped like the process environment so it can be passed straight through. */
export type LocalDockerBackendEnvironment = {
  AWS_REGION?: string | undefined;
  DOCKER_API_VERSION?: string | undefined;
  DOCKER_HOST?: string | undefined;
  /** Whitespace-separated entrypoint override, e.g. `sleep 600` for tests. */
  EXECUTION_DOCKER_COMMAND?: string | undefined;
  EXECUTION_DOCKER_HOME_DIR?: string | undefined;
  EXECUTION_EGRESS_CREDENTIAL_PORT?: string | undefined;
  EXECUTION_EGRESS_PROXY_URL?: string | undefined;
  EXECUTION_INSTALLATION_ID?: string | undefined;
  EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_STOP_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_TMPFS_SIZE_MB?: string | undefined;
  EXECUTION_DOCKER_USER?: string | undefined;
  EXECUTION_DOCKER_WORKSPACE_DIR?: string | undefined;
  EXECUTION_WORKSPACE_GC_MIN_AGE_SEC?: string | undefined;
  /** `on` (default) or `off`; anything else is a typo, not an opt-out. */
  EXECUTION_WORKSPACE_QUOTA?: string | undefined;
  EXECUTION_WORKSPACE_QUOTA_MB?: string | undefined;
  EXECUTION_WORKSPACE_QUOTA_INODES?: string | undefined;
  EXECUTION_VOLUME_LABEL_NAMESPACE?: string | undefined;
  EXECUTION_VOLUME_NAME_PREFIX?: string | undefined;
  S3_BUCKET?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  /** The worker image, and what the workspace inode helper runs from. */
  WORKER_IMAGE?: string | undefined;
  [key: string]: string | undefined;
};

const INSTALLATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const DEFAULT_VOLUME_LABEL_NAMESPACE = "werft";
export const DEFAULT_VOLUME_NAME_PREFIX = "werft-ws-";
// Label keys are `<ns>.<name>`; a Docker volume name is [a-zA-Z0-9][a-zA-Z0-9_.-]*.
const VOLUME_LABEL_NAMESPACE = /^[a-z0-9]([a-z0-9.-]{0,60}[a-z0-9])?$/;
const VOLUME_NAME_PREFIX = /^[a-z0-9][a-z0-9.-]{0,30}-$/;
/**
 * The settings of the shared worker network that per-execution networks
 * replaced. Set, they mean an operator expects a network this host
 * no longer uses, so startup stops and says what changed.
 */
const RETIRED_NETWORK_SETTINGS = [
  "EXECUTION_DOCKER_NETWORK",
  "EXECUTION_DOCKER_NETWORK_ALLOWLIST",
] as const;

export function localDockerConfigFromEnv(
  environment: LocalDockerBackendEnvironment,
): LocalDockerBackendConfig {
  const gatewayUrl = environment.WORKER_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("WORKER_GATEWAY_URL is required");
  const egressProxyUrl = environment.EXECUTION_EGRESS_PROXY_URL;
  if (!egressProxyUrl) {
    throw new Error("EXECUTION_EGRESS_PROXY_URL is required");
  }
  for (const name of RETIRED_NETWORK_SETTINGS) {
    if ((environment[name] ?? "").trim() !== "") {
      throw new Error(
        `${name} is no longer read: every worker now gets an internal network of its own, ` +
          "created and removed by the scheduler, and the egress proxy is found by its " +
          "werft.egress-proxy label. Remove the setting and label the proxy container.",
      );
    }
  }
  const command = (environment.EXECUTION_DOCKER_COMMAND ?? "")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return validateLocalDockerConfig({
    apiVersion: environment.DOCKER_API_VERSION ?? DEFAULT_DOCKER_API_VERSION,
    ...(command.length > 0 ? { command } : {}),
    dockerHost: environment.DOCKER_HOST ?? DEFAULT_DOCKER_HOST,
    egressCredentialPort: port(
      environment.EXECUTION_EGRESS_CREDENTIAL_PORT ?? "3129",
      "EXECUTION_EGRESS_CREDENTIAL_PORT",
    ),
    egressProxyUrl,
    gatewayUrl,
    homeDir: environment.EXECUTION_DOCKER_HOME_DIR ?? "/home/worker",
    installationId:
      environment.EXECUTION_INSTALLATION_ID ?? DEFAULT_INSTALLATION_ID,
    objectStore: objectStoreAccessFromEnv(environment),
    requestTimeoutMs:
      environment.EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC === undefined
        ? DEFAULT_DOCKER_REQUEST_TIMEOUT_MS
        : integerSetting(environment, "EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC", {
            min: 1,
          }) * 1_000,
    stopTimeoutSeconds: stopGrace(
      integerSetting(environment, "EXECUTION_DOCKER_STOP_TIMEOUT_SEC", {
        min: 1,
        default: 120,
      }),
    ),
    tmpfsSizeBytes:
      integerSetting(environment, "EXECUTION_DOCKER_TMPFS_SIZE_MB", {
        min: 1,
        default: 256,
      }) *
      1024 *
      1024,
    user: environment.EXECUTION_DOCKER_USER ?? DEFAULT_WORKER_USER,
    workspaceDir: environment.EXECUTION_DOCKER_WORKSPACE_DIR ?? "/workspace",
    // Zero is a real setting: reclaim as soon as the session is finished.
    workspaceGcMinAgeMs:
      integerSetting(environment, "EXECUTION_WORKSPACE_GC_MIN_AGE_SEC", {
        min: 0,
        default: DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
      }) * 1_000,
    workspaceQuota: workspaceQuotaFromEnv(environment),
    volumeLabelNamespace:
      environment.EXECUTION_VOLUME_LABEL_NAMESPACE?.trim() ||
      DEFAULT_VOLUME_LABEL_NAMESPACE,
    volumeNamePrefix:
      environment.EXECUTION_VOLUME_NAME_PREFIX?.trim() ||
      DEFAULT_VOLUME_NAME_PREFIX,
  });
}

/**
 * Room for a large monorepo checkout with its dependencies installed (a few
 * hundred thousand files) several times over. Empty files cost the byte
 * quota nothing — xfs does not charge inodes to a project's blocks — so
 * without this a loop of them only stops when the daemon's filesystem does.
 */
export const DEFAULT_WORKSPACE_QUOTA_INODES = 1_000_000;

function workspaceQuotaFromEnv(
  environment: LocalDockerBackendEnvironment,
): WorkspaceQuota {
  const mode = environment.EXECUTION_WORKSPACE_QUOTA ?? "on";
  if (mode === "off") return { mode: "off" };
  if (mode !== "on") {
    // A misspelt value must not read as an opt-out, and must not read as
    // "enforced" either — either way the operator did not get what they typed.
    throw new Error(
      `EXECUTION_WORKSPACE_QUOTA ${mode} must be "on" or "off"; "off" is the explicit opt-out`,
    );
  }
  const helperImage = environment.WORKER_IMAGE;
  if (!helperImage) {
    throw new Error(
      "WORKER_IMAGE is required while EXECUTION_WORKSPACE_QUOTA is on: the workspace inode limit is set by a helper run from it",
    );
  }
  const sizeMb = integerSetting(environment, "EXECUTION_WORKSPACE_QUOTA_MB", {
    min: 1,
    default: DEFAULT_WORKSPACE_QUOTA_MB,
  });
  if (sizeMb < MIN_WORKSPACE_QUOTA_MB) {
    throw new Error(
      `EXECUTION_WORKSPACE_QUOTA_MB ${sizeMb} is under the ${MIN_WORKSPACE_QUOTA_MB} a checkpoint restore needs`,
    );
  }
  return {
    helperImage,
    mode: "enforced",
    sizeBytes: sizeMb * 1024 * 1024,
    inodes: integerSetting(environment, "EXECUTION_WORKSPACE_QUOTA_INODES", {
      min: 1,
      default: DEFAULT_WORKSPACE_QUOTA_INODES,
    }),
  };
}

function objectStoreAccessFromEnv(
  environment: LocalDockerBackendEnvironment,
): WorkerObjectStoreAccess {
  return {
    bucket: requiredValue(environment.S3_BUCKET, "S3_BUCKET"),
    region: requiredValue(environment.AWS_REGION, "AWS_REGION"),
  };
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

/** The invariants the ticket lists for a worker container, checked once. */
export function validateLocalDockerConfig(
  config: LocalDockerBackendConfig,
): LocalDockerBackendConfig {
  // Docker accepts any decimal spelling of uid 0 ("00", "000:1000"), so
  // compare the parsed number, not the string.
  const [uid, gid] = config.user.split(":");
  if (
    !uid ||
    !/^\d+$/.test(uid) ||
    Number.parseInt(uid, 10) === 0 ||
    (gid !== undefined &&
      (!/^\d+$/.test(gid) || Number.parseInt(gid, 10) === 0))
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
  // The inode helper finds the volume in /proc/self/mountinfo, which escapes
  // exactly these characters; a path holding one would never match there.
  if (/[\s\\]/.test(config.workspaceDir)) {
    throw new Error(
      `workspaceDir ${JSON.stringify(config.workspaceDir)} must not contain whitespace or backslashes`,
    );
  }
  if (!INSTALLATION_ID.test(config.installationId)) {
    throw new Error(
      `EXECUTION_INSTALLATION_ID ${config.installationId} must be a short label-safe id`,
    );
  }
  try {
    new URL(config.gatewayUrl);
  } catch {
    throw new Error(`WORKER_GATEWAY_URL ${config.gatewayUrl} is not a URL`);
  }
  // Proxies are addressed over http even when they tunnel TLS, and every
  // HTTP client reads the variable that way.
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
  // The worker finds the proxy through the alias it is given on each worker
  // network. An address would be right on at most one of them, and localhost
  // is the worker itself.
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  if (isIP(proxyHost) !== 0 || proxyHost === "localhost") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} must name the proxy by a host name; it joins every worker network under that name`,
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
  if (
    config.workspaceQuota.mode === "enforced" &&
    (!Number.isInteger(config.workspaceQuota.sizeBytes) ||
      config.workspaceQuota.sizeBytes < 1)
  ) {
    throw new Error(
      `Workspace quota ${config.workspaceQuota.sizeBytes} is not a positive byte limit`,
    );
  }
  if (
    config.workspaceQuota.mode === "enforced" &&
    (!Number.isInteger(config.workspaceQuota.inodes) ||
      config.workspaceQuota.inodes < 1)
  ) {
    throw new Error(
      `Workspace quota ${config.workspaceQuota.inodes} is not a positive inode limit`,
    );
  }
  if (
    config.workspaceQuota.mode === "enforced" &&
    config.workspaceQuota.helperImage.trim() === ""
  ) {
    throw new Error("Workspace quota needs an image to run its inode helper");
  }
  if (
    !Number.isInteger(config.workspaceGcMinAgeMs) ||
    config.workspaceGcMinAgeMs < 0
  ) {
    throw new Error("workspaceGcMinAgeMs must be a non-negative integer");
  }
  if (!VOLUME_LABEL_NAMESPACE.test(config.volumeLabelNamespace)) {
    throw new Error(
      `EXECUTION_VOLUME_LABEL_NAMESPACE ${config.volumeLabelNamespace} must be lowercase letters, digits, "." or "-"`,
    );
  }
  if (!VOLUME_NAME_PREFIX.test(config.volumeNamePrefix)) {
    throw new Error(
      `EXECUTION_VOLUME_NAME_PREFIX ${config.volumeNamePrefix} must be lowercase letters, digits, "." or "-" and end with "-"`,
    );
  }
  const { objectStore } = config;
  // Names only in these messages, never the values: they end up in logs.
  for (const [name, value] of [
    ["AWS_REGION", objectStore.region],
    ["S3_BUCKET", objectStore.bucket],
  ] as const) {
    if (value.trim() === "" || /[\s=]/.test(value)) {
      throw new Error(`${name} must be a single non-empty token`);
    }
  }
  return config;
}

/**
 * The worker spends about 12 s of the grace on interrupt, engine exit and
 * release (`SHUTDOWN_RESERVE_MS` in apps/worker) and drains with the rest. A
 * grace that leaves no real drain turns every stop of a busy worker into a
 * turn for the recovery path, so it is refused rather than run quietly.
 */
export const MIN_STOP_GRACE_SECONDS = 30;

function stopGrace(seconds: number): number {
  if (seconds < MIN_STOP_GRACE_SECONDS) {
    throw new Error(
      `EXECUTION_DOCKER_STOP_TIMEOUT_SEC must be at least ${MIN_STOP_GRACE_SECONDS}: below that a worker has no time to drain the turn it is running`,
    );
  }
  return seconds;
}

function port(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} ${value} is not a port`);
  }
  return parsed;
}
