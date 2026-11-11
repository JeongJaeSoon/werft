import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
} from "@werft-ai/contracts";
import { DEFAULT_WORKSPACE_QUOTA_MB } from "@werft-ai/contracts/execution";
import {
  integerSetting,
  positiveNumberSetting,
} from "@werft-ai/contracts/settings";
import {
  objectStoreConfigFromEnv,
  type WorkerObjectStoreConfig,
  type WorkerObjectStoreEnvironment,
} from "./object-store.ts";
import { type AttachLimits, DEFAULT_ATTACH_LIMITS } from "./workspace.ts";
import type { WorkspaceLimitEvidence } from "./workspace-limit-mode.ts";
import type { WorkspaceQuotaLimits } from "./workspace-quota.ts";

/**
 * Everything the worker reads from its environment. The first block is what
 * the execution backends inject (`ENV` in
 * `packages/contracts/src/shared/execution.ts`), object store included; the
 * rest is timers and limits, of which a launcher sets only
 * `WORKER_MAX_TURN_SEC` and `WORKER_PROVIDER_MAX_RETRIES`. What the engine
 * runs — model, tools, permission mode, provider — is not here: the claim
 * carries it, resolved by the server from the session's spec.
 */
export type WorkerEnvironment = WorkerObjectStoreEnvironment & {
  HOME?: string | undefined;
  LOG_LEVEL?: string | undefined;
  WORKER_BOOTSTRAP_NONCE?: string | undefined;
  WORKER_EGRESS_CREDENTIAL_URL?: string | undefined;
  WORKER_EXECUTION_GENERATION?: string | undefined;
  WORKER_EXECUTION_ID?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  WORKER_STOP_GRACE_SEC?: string | undefined;
  WORKER_WORKSPACE_DIR?: string | undefined;
  WORKER_WORKSPACE_ENFORCED_BY_STORAGE?: string | undefined;
  WORKER_WORKSPACE_MOUNT_DIR?: string | undefined;
  WORKER_WORKSPACE_PVC_CAPACITY_BYTES?: string | undefined;
  WORKER_WORKSPACE_QUOTA_BYTES?: string | undefined;
  WORKER_WORKSPACE_QUOTA_MODE?: string | undefined;

  WORKER_CLAUDE_CONFIG_DIR?: string | undefined;

  WORKER_ANSWER_POLL_SEC?: string | undefined;
  WORKER_ATTACH_FETCH_MAX_MB?: string | undefined;
  WORKER_ATTACH_FETCH_TIMEOUT_SEC?: string | undefined;
  WORKER_CLAIM_TIMEOUT_SEC?: string | undefined;
  WORKER_DRAIN_TIMEOUT_SEC?: string | undefined;
  WORKER_HEARTBEAT_INTERVAL_SEC?: string | undefined;
  WORKER_IDLE_TIMEOUT_SEC?: string | undefined;
  WORKER_LEASE_SAFETY_MARGIN_SEC?: string | undefined;
  WORKER_MAX_TURN_SEC?: string | undefined;
  WORKER_NEXT_INPUT_RETRY_SEC?: string | undefined;
  WORKER_NEXT_INPUT_WAIT_SEC?: string | undefined;
  WORKER_PROVIDER_MAX_RETRIES?: string | undefined;
  WORKER_REQUEST_TIMEOUT_SEC?: string | undefined;
  WORKER_STARTUP_TIMEOUT_SEC?: string | undefined;
  QUESTION_TIMEOUT_SEC?: string | undefined;
};

export type WorkerTimeouts = {
  /**
   * How often a waiting approval asks the gateway for its answer, and a turn
   * in flight asks whether it has been interrupted.
   */
  answerPollIntervalMs: number;
  /** Give up claiming a session and exit cleanly. */
  claimTimeoutMs: number;
  /**
   * Budget for a turn to finish on its own once SIGTERM arrived. Never more
   * than the launcher's stop grace leaves after the shutdown that follows.
   */
  drainTimeoutMs: number;
  heartbeatIntervalMs: number;
  /**
   * How long an interrupted engine gets to produce the turn's terminal before
   * the turn is closed as unknown. Not configurable from the environment; the
   * default is the shutdown's interrupt grace.
   */
  interruptGraceMs?: number;
  /**
   * How long an interrupted turn's checkpoint capture may run once the engine
   * has stopped, apart from the grace above. Not configurable from
   * the environment; the default stays well inside the reconciler's settle
   * deadline for an interrupt.
   */
  interruptCaptureMs?: number;
  /** Release the session and exit after this long with no input. */
  idleTimeoutMs: number;
  /**
   * How long a permission callback waits for the frame carrying its tool
   * call to be stored. That frame is normally just behind the callback; one
   * that is not stored in time gets the request denied rather than shown
   * ahead of the call it is about. Not configurable from the environment.
   */
  toolUseFrameWaitMs?: number;
  /**
   * How long before an unrenewed lease runs out the worker gives it up and
   * kills the engine: enough for the kill to land before another
   * attempt may be handed the session. `LEASE_SAFETY_MARGIN_MS` when unset.
   */
  leaseSafetyMarginMs?: number;
  /**
   * Wall-clock budget for one turn, approvals included. Nothing else bounds
   * an engine that stops answering while the heartbeat keeps the lease alive
   * It is configured per installation as `MAX_TURN_SECONDS`.
   */
  maxTurnMs: number;
  /**
   * How long a poll, or one batch of events, keeps retrying a gateway that
   * answers with transient errors. The server may already have handed the
   * turn over, and a finalize waits on its events, so without it a worker
   * whose heartbeats still land holds that turn forever.
   * Counted from the first failure; retries are not charged to `maxTurnMs`.
   */
  nextInputRetryTimeoutMs: number;
  nextInputWaitMs: number;
  /**
   * A pending permission or question denied once nobody has answered it,
   * until the gateway has registered it; from then on the server's
   * PENDING_REQUEST_TTL_SEC decides.
   */
  questionTimeoutMs: number;
  requestTimeoutMs: number;
  /**
   * Wall-clock budget from the claim to a running engine: workspace
   * preparation and checkpoint restore together. The turn deadline starts
   * only after it, and the heartbeat keeps the lease alive meanwhile.
   */
  startupTimeoutMs: number;
  /**
   * Time between SIGTERM and SIGKILL, when the launcher says (LocalDocker
   * does). Every shutdown wait fits inside it; unknown means unbounded.
   */
  stopGraceMs?: number;
};

/** Where the engine runs; what it runs comes with the claim. */
export type WorkerRuntimeSettings = {
  claudeConfigDir: string;
  cwd: string;
  home: string;
  /**
   * Retries of a failed Messages request before the turn fails: the
   * installation's PROVIDER_MAX_RETRIES, which the launcher passes on.
   */
  providerMaxRetries: number;
};

export type WorkerConfig = {
  bootstrapNonce: string;
  /**
   * The egress proxy's credential routes: where the engine's
   * Messages calls and the workspace's git fetches go with the tokens the
   * claim hands out, and pick up the credentials this process never holds.
   */
  egressCredentialUrl: string;
  executionGeneration: number;
  executionId: string;
  gatewayUrl: string;
  objectStore: WorkerObjectStoreConfig;
  runtime: WorkerRuntimeSettings;
  timeouts: WorkerTimeouts;
  /** How long and how large one attached repository's fetch may get. */
  attachLimits?: AttachLimits;
};

/** The workspace volume as the launcher described it. */
export type WorkerWorkspaceSettings = {
  /** The checkout directory when the launcher names no mount point. */
  mountDir: string;
  quota: WorkspaceQuotaLimits;
  evidence: WorkspaceLimitEvidence;
};

export function workerConfigFromEnv(
  environment: WorkerEnvironment,
): WorkerConfig & { workspace: WorkerWorkspaceSettings } {
  const home = required(environment.HOME, "HOME");
  const stopGraceMs =
    environment.WORKER_STOP_GRACE_SEC === undefined
      ? undefined
      : seconds(environment, "WORKER_STOP_GRACE_SEC", 0);
  const nextInputWaitMs = seconds(
    environment,
    "WORKER_NEXT_INPUT_WAIT_SEC",
    20,
  );
  const requestTimeoutMs = seconds(
    environment,
    "WORKER_REQUEST_TIMEOUT_SEC",
    30,
  );
  // A long poll the request timeout cuts short is aborted every time, and
  // the worker never receives its next input.
  if (nextInputWaitMs >= requestTimeoutMs) {
    throw new Error(
      "WORKER_NEXT_INPUT_WAIT_SEC must be less than WORKER_REQUEST_TIMEOUT_SEC",
    );
  }
  const egressCredentialUrl = url(
    required(
      environment.WORKER_EGRESS_CREDENTIAL_URL,
      "WORKER_EGRESS_CREDENTIAL_URL",
    ),
    "WORKER_EGRESS_CREDENTIAL_URL",
  );
  const config: WorkerConfig = {
    bootstrapNonce: required(
      environment.WORKER_BOOTSTRAP_NONCE,
      "WORKER_BOOTSTRAP_NONCE",
    ),
    executionGeneration: integerSetting(
      environment,
      "WORKER_EXECUTION_GENERATION",
      { min: 0 },
    ),
    executionId: required(
      environment.WORKER_EXECUTION_ID,
      "WORKER_EXECUTION_ID",
    ),
    egressCredentialUrl,
    gatewayUrl: url(
      required(environment.WORKER_GATEWAY_URL, "WORKER_GATEWAY_URL"),
      "WORKER_GATEWAY_URL",
    ),
    objectStore: objectStoreConfigFromEnv(environment, egressCredentialUrl),
    runtime: {
      claudeConfigDir:
        environment.WORKER_CLAUDE_CONFIG_DIR ?? `${home}/.claude`,
      cwd: required(environment.WORKER_WORKSPACE_DIR, "WORKER_WORKSPACE_DIR"),
      home,
      // An installation limit, so no code default: the scheduler
      // always passes the installation's PROVIDER_MAX_RETRIES.
      providerMaxRetries: integerSetting(
        environment,
        "WORKER_PROVIDER_MAX_RETRIES",
        { min: 0 },
      ),
    },
    timeouts: {
      answerPollIntervalMs: seconds(environment, "WORKER_ANSWER_POLL_SEC", 1),
      claimTimeoutMs: seconds(environment, "WORKER_CLAIM_TIMEOUT_SEC", 60),
      drainTimeoutMs: drainBudget(
        seconds(environment, "WORKER_DRAIN_TIMEOUT_SEC", 100),
        stopGraceMs,
      ),
      heartbeatIntervalMs: seconds(
        environment,
        "WORKER_HEARTBEAT_INTERVAL_SEC",
        WORKER_HEARTBEAT_INTERVAL_MS / 1000,
      ),
      idleTimeoutMs: seconds(environment, "WORKER_IDLE_TIMEOUT_SEC", 1800),
      leaseSafetyMarginMs: seconds(
        environment,
        "WORKER_LEASE_SAFETY_MARGIN_SEC",
        LEASE_SAFETY_MARGIN_MS / 1000,
      ),
      maxTurnMs: seconds(environment, "WORKER_MAX_TURN_SEC", 3600),
      nextInputRetryTimeoutMs: seconds(
        environment,
        "WORKER_NEXT_INPUT_RETRY_SEC",
        60,
      ),
      nextInputWaitMs,
      questionTimeoutMs: seconds(environment, "QUESTION_TIMEOUT_SEC", 1800),
      requestTimeoutMs,
      startupTimeoutMs: seconds(
        environment,
        "WORKER_STARTUP_TIMEOUT_SEC",
        3600,
      ),
      ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
    },
    attachLimits: {
      timeoutMs: seconds(
        environment,
        "WORKER_ATTACH_FETCH_TIMEOUT_SEC",
        DEFAULT_ATTACH_LIMITS.timeoutMs / 1000,
      ),
      maxBytes: Math.round(
        positiveNumberSetting(environment, "WORKER_ATTACH_FETCH_MAX_MB", {
          default: DEFAULT_ATTACH_LIMITS.maxBytes / 1024 ** 2,
        }) *
          1024 ** 2,
      ),
    },
  };
  const evidence = workspaceEvidenceFromEnv(environment);
  return {
    ...config,
    workspace: {
      mountDir: environment.WORKER_WORKSPACE_MOUNT_DIR ?? config.runtime.cwd,
      quota: {
        bytes:
          evidence.requestedBytes ?? DEFAULT_WORKSPACE_QUOTA_MB * 1024 * 1024,
        inodes: 1_000_000,
      },
      evidence,
    },
  };
}

export function workspaceEvidenceFromEnv(
  environment: WorkerEnvironment,
): WorkspaceLimitEvidence {
  const requestedBytes = Number(environment.WORKER_WORKSPACE_QUOTA_BYTES);
  const pvcCapacityBytes = Number(
    environment.WORKER_WORKSPACE_PVC_CAPACITY_BYTES,
  );
  const quotaMode = environment.WORKER_WORKSPACE_QUOTA_MODE;
  return {
    ...(Number.isSafeInteger(pvcCapacityBytes) && pvcCapacityBytes > 0
      ? { pvcCapacityBytes }
      : {}),
    ...(Number.isSafeInteger(requestedBytes) && requestedBytes > 0
      ? { requestedBytes }
      : {}),
    ...(quotaMode === "enforced" || quotaMode === "off"
      ? { localQuota: quotaMode }
      : {}),
    ...(environment.WORKER_WORKSPACE_ENFORCED_BY_STORAGE === "true"
      ? { enforcedByStorage: true }
      : {}),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(value: string, name: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} ${value} is not a URL`);
  }
}

/**
 * What a drain may spend once the rest of the shutdown is paid for: the
 * interrupt grace, the engine exit grace and the release after them. A grace
 * too short for any of that leaves no drain at all — the turn in flight is
 * interrupted at once and left for the recovery path to retry.
 */
export const SHUTDOWN_RESERVE_MS = 12_000;

/**
 * Room for the shutdown to reach the engine kill and for that kill's own
 * 5s exit grace. Against the compose default lease of 30s it leaves 20s
 * of gateway outage ridden out; a longer lease leaves more.
 */
export const LEASE_SAFETY_MARGIN_MS = WORKER_LEASE_SAFETY_MARGIN_MS;

function drainBudget(configured: number, stopGraceMs: number | undefined) {
  if (stopGraceMs === undefined) return configured;
  return Math.min(configured, Math.max(0, stopGraceMs - SHUTDOWN_RESERVE_MS));
}

function seconds(
  environment: WorkerEnvironment,
  name: string,
  fallback: number,
): number {
  return Math.round(
    positiveNumberSetting(environment, name, { default: fallback }) * 1000,
  );
}
