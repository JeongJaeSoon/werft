import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_WORKSPACE_ENFORCE,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
  type WorkspaceEnforce,
  workspaceEnforceSchema,
} from "@werft-ai/contracts";
import { integerSetting, settingProblems } from "@werft-ai/contracts/settings";
import { type LogLevel, logLevelFromEnv } from "@werft-ai/observability";
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PENDING_TTL_MS,
  installationLimitProblems,
} from "@werft-ai/platform";

/**
 * The API's own settings, apart from the installation limits it shares with
 * the scheduler. One parser for startup and readiness, and every value that
 * is set but wrong stops the process: a typo that quietly became a default
 * is an installation running under settings nobody chose.
 */
export type ApiSettings = {
  workspaceEnforce: WorkspaceEnforce;
  leaseTtlMs: number;
  logLevel: LogLevel;
  pendingTtlMs: number;
  sse: {
    batchMaxBytes?: number;
    maxStreams?: number;
    maxStreamsPerOwner?: number;
  };
  webDistDir?: string;
};

export class ApiSettingsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid API settings: ${problems.join("; ")}`);
  }
}

/** A week, as MAX_TURN_SECONDS allows at most; no turn waits longer. */
const MAX_PENDING_REQUEST_TTL_SEC = 7 * 24 * 60 * 60;

export function apiSettingsFromEnv(
  environment: Record<string, string | undefined>,
): ApiSettings {
  const { problems, read } = settingProblems();
  const workspaceEnforce = read(() => {
    const result = workspaceEnforceSchema.safeParse(
      environment.WORKSPACE_ENFORCE ?? DEFAULT_WORKSPACE_ENFORCE,
    );
    if (!result.success)
      throw new Error("WORKSPACE_ENFORCE must be warn, fail, or off");
    return result.data;
  });
  // Unset keeps the platform default.
  const optionalInteger = (
    name: string,
    rule: { min: number; max?: number },
  ) =>
    environment[name] === undefined
      ? undefined
      : integerSetting(environment, name, rule);
  const leaseTtlMs = read(() =>
    heartbeatTtlMsFromEnv(environment.HEARTBEAT_TTL_SEC),
  );
  const logLevel = read(() => logLevelFromEnv(environment.LOG_LEVEL));
  const pendingTtlSec = read(() =>
    optionalInteger("PENDING_REQUEST_TTL_SEC", {
      min: 1,
      max: MAX_PENDING_REQUEST_TTL_SEC,
    }),
  );
  const sse = {
    batchMaxBytes: read(() =>
      optionalInteger("SSE_REPLAY_MAX_BYTES", { min: 1 }),
    ),
    maxStreams: read(() => optionalInteger("SSE_MAX_STREAMS", { min: 1 })),
    maxStreamsPerOwner: read(() =>
      optionalInteger("SSE_MAX_STREAMS_PER_OWNER", { min: 1 }),
    ),
  };
  // In `none` mode /v1 takes any X-Owner-Id as the caller. With the
  // authorizer on, workers run beside this API and reach it through the
  // proxy, so code inside any of them could act as any owner.
  if (
    environment.AUTH_MODE === "none" &&
    environment.EGRESS_AUTHORIZER_PORT !== undefined
  ) {
    problems.push(
      "AUTH_MODE=none cannot run with the egress authorizer on (EGRESS_AUTHORIZER_PORT): workers reach this API and would act as any owner",
    );
  }
  const webDistDir = environment.WEB_DIST_DIR;
  if (
    webDistDir !== undefined &&
    !(isAbsolute(webDistDir) && existsSync(join(webDistDir, "index.html")))
  ) {
    problems.push(
      "WEB_DIST_DIR must be an absolute path to a directory holding index.html (apps/web's build output)",
    );
  }
  if (problems.length > 0) throw new ApiSettingsError(problems);
  return {
    workspaceEnforce: workspaceEnforce as WorkspaceEnforce,
    leaseTtlMs: leaseTtlMs as number,
    logLevel: logLevel as LogLevel,
    pendingTtlMs:
      pendingTtlSec === undefined
        ? DEFAULT_PENDING_TTL_MS
        : pendingTtlSec * 1000,
    sse: {
      ...(sse.batchMaxBytes === undefined
        ? {}
        : { batchMaxBytes: sse.batchMaxBytes }),
      ...(sse.maxStreams === undefined ? {} : { maxStreams: sse.maxStreams }),
      ...(sse.maxStreamsPerOwner === undefined
        ? {}
        : { maxStreamsPerOwner: sse.maxStreamsPerOwner }),
    },
    ...(webDistDir === undefined ? {} : { webDistDir }),
  };
}

/** Every problem at once, for readiness; empty when the settings parse. */
export function apiSettingsProblems(
  environment: Record<string, string | undefined>,
): string[] {
  try {
    apiSettingsFromEnv(environment);
    return [];
  } catch (error) {
    if (error instanceof ApiSettingsError) return [...error.problems];
    throw error;
  }
}

/**
 * What /readyz requires beyond the database. AUTH_MODE unset still fails
 * closed (every /v1 call is 401), which is a misconfiguration, not a serving
 * instance. app.ts treats anything but "none" as api-key mode, so a typo
 * would silently run authenticated; only the two spellings we document count.
 */
export const API_READINESS_REQUIRED_ENV = [
  "DATABASE_URL",
  { name: "AUTH_MODE", allowed: ["none", "api-key"] },
] as const;

/**
 * The same parsers the process started with: an env that changed under a
 * running instance shows up in /readyz rather than at the next restart.
 */
export function apiReadinessConfigProblems(
  environment: Record<string, string | undefined>,
): string[] {
  return [
    ...installationLimitProblems(environment),
    ...apiSettingsProblems(environment),
  ];
}

// HEARTBEAT_TTL_SEC is read here and nowhere else. Every lease the
// gateway grants carries its own deadline into the database — the attempt's
// and the `workers` row's — and the reconciler judges those deadlines, so a
// second process never needs its own copy of the value. That is why a
// malformed value stops the API instead of quietly becoming the default: a
// silently different TTL is exactly the divergence this function closes.
// A day: far past any sane lease, and small enough that every deadline
// computed from it stays a finite timestamp.
const MAX_HEARTBEAT_TTL_SEC = 86_400;

// A worker gives its lease up this long before it runs out, and beats this
// often; a lease no longer than both is lost at or near the first beat.
// No launcher sets the worker's own values, so its defaults are
// the ones every worker runs with. Workers built before the interval dropped
// to 5s still beat every 10s, and a fleet mid-rollout runs both.
const LEGACY_WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const MIN_HEARTBEAT_TTL_SEC =
  (WORKER_LEASE_SAFETY_MARGIN_MS +
    Math.max(
      WORKER_HEARTBEAT_INTERVAL_MS,
      LEGACY_WORKER_HEARTBEAT_INTERVAL_MS,
    )) /
  1000;

export function heartbeatTtlMsFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  const seconds = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds <= MIN_HEARTBEAT_TTL_SEC ||
    seconds > MAX_HEARTBEAT_TTL_SEC
  ) {
    throw new Error(
      `HEARTBEAT_TTL_SEC must be a number of seconds above ${MIN_HEARTBEAT_TTL_SEC} (the worker's lease safety margin plus its heartbeat interval) and up to ${MAX_HEARTBEAT_TTL_SEC}, got ${JSON.stringify(value)}`,
    );
  }
  return seconds * 1000;
}
