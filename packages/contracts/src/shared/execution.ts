import { z } from "zod";
import { integerSetting, type SettingsEnvironment } from "./settings.ts";

export const workspaceEnforceSchema = z.enum(["warn", "fail", "off"]);
export type WorkspaceEnforce = z.infer<typeof workspaceEnforceSchema>;
export const DEFAULT_WORKSPACE_ENFORCE: WorkspaceEnforce = "warn";

/**
 * Who puts the Codex sandbox on a Kubernetes installation's nodes: the
 * chart's `codexSandbox.provider`, read as `CODEX_SANDBOX_PROVIDER`. With
 * `disabled` no Codex worker starts.
 */
export const codexSandboxProviderSchema = z.enum([
  "disabled",
  "installer",
  "external",
]);
export type CodexSandboxProvider = z.infer<typeof codexSandboxProviderSchema>;

export const DEFAULT_WORKER_USER = "1000:1000";
export const DEFAULT_INSTALLATION_ID = "local";
export const DEFAULT_WORKSPACE_QUOTA_MB = 4096;
/**
 * A checkpoint restore holds two copies of the 256 MiB bundle limit beside
 * up to 256 MiB of untracked files, pack indexes and thin-pack delta bases.
 * A smaller quota cannot resume a checkpoint the limits admit.
 */
export const MIN_WORKSPACE_QUOTA_MB = 1024;
export const DEFAULT_WORKSPACE_GC_MIN_AGE_SEC = 3600;

/** Names shared by worker containers and Pods; values come from each launch. */
export const ENV = {
  bootstrapNonce: "WORKER_BOOTSTRAP_NONCE",
  executionGeneration: "WORKER_EXECUTION_GENERATION",
  executionId: "WORKER_EXECUTION_ID",
  gatewayUrl: "WORKER_GATEWAY_URL",
  egressCredentialUrl: "WORKER_EGRESS_CREDENTIAL_URL",
  home: "HOME",
  workspaceDir: "WORKER_WORKSPACE_DIR",
  workspaceMountDir: "WORKER_WORKSPACE_MOUNT_DIR",
  workspaceQuotaBytes: "WORKER_WORKSPACE_QUOTA_BYTES",
  workspacePvcCapacityBytes: "WORKER_WORKSPACE_PVC_CAPACITY_BYTES",
  workspaceQuotaMode: "WORKER_WORKSPACE_QUOTA_MODE",
  workspaceEnforcedByStorage: "WORKER_WORKSPACE_ENFORCED_BY_STORAGE",
  // Tools read different spellings; network isolation enforces the boundary.
  httpProxy: "HTTP_PROXY",
  httpProxyLower: "http_proxy",
  httpsProxy: "HTTPS_PROXY",
  httpsProxyLower: "https_proxy",
  noProxy: "NO_PROXY",
  noProxyLower: "no_proxy",
  objectBucket: "S3_BUCKET",
  objectPrefix: "WORKER_OBJECT_PREFIX",
  objectRegion: "AWS_REGION",
  stopGrace: "WORKER_STOP_GRACE_SEC",
  idleTimeout: "WORKER_IDLE_TIMEOUT_SEC",
  maxTurnSeconds: "WORKER_MAX_TURN_SEC",
  providerMaxRetries: "WORKER_PROVIDER_MAX_RETRIES",
  logLevel: "LOG_LEVEL",
  // Set only to `disabled`, where an operator turned Codex auto's sandbox off.
  codexSandbox: "CODEX_SANDBOX",
} as const;

/**
 * How long a worker with no input waits before it ends and gives its room
 * back, in seconds: the operator's setting, read by the scheduler and
 * handed to every worker it launches.
 */
export const WORKER_IDLE_TIMEOUT_SEC = {
  default: 1800,
  min: 60,
  max: 7200,
} as const;

/** `WORKER_IDLE_TIMEOUT_SEC`, refused outside its range. */
export function workerIdleTimeoutSecondsOf(
  environment: SettingsEnvironment,
): number {
  return integerSetting(environment, ENV.idleTimeout, WORKER_IDLE_TIMEOUT_SEC);
}

export const NO_PROXY_VALUE = "localhost,127.0.0.1,::1";

/** Credential routes use the proxy's host directly, on a separate port. */
export function egressCredentialUrlOf(config: {
  egressCredentialPort: number;
  egressProxyUrl: string;
}): string {
  const url = new URL(config.egressProxyUrl);
  url.port = String(config.egressCredentialPort);
  return url.toString().replace(/\/$/, "");
}

/** The proxy's credential routes must bypass the forward proxy itself. */
export function noProxyValueFor(config: { egressProxyUrl: string }): string {
  return `${NO_PROXY_VALUE},${new URL(config.egressProxyUrl).hostname}`;
}
