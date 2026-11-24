import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
} from "@werft-ai/contracts";
import { integerSetting, settingProblems } from "@werft-ai/contracts/settings";
import { type LogLevel, logLevelFromEnv } from "@werft-ai/observability";
import {
  DEFAULT_LEASE_TTL_MS,
  installationLimitProblems,
} from "@werft-ai/platform";
import {
  type AuthAttemptRules,
  DEFAULT_AUTH_ATTEMPT_RULES,
} from "./auth-attempts.ts";

/**
 * The API's own settings, apart from the installation limits it shares with
 * the scheduler. One parser for startup and readiness, and every value that
 * is set but wrong stops the process: a typo that quietly became a default
 * is an installation running under settings nobody chose.
 */
export type ApiSettings = {
  leaseTtlMs: number;
  logLevel: LogLevel;
  sse: {
    batchMaxBytes?: number;
    maxStreams?: number;
    maxStreamsPerOwner?: number;
  };
  webDistDir?: string;
  /** The chart's `codexSandbox.provider`, which the scheduler reads too. */
  codexSandboxProvider?: (typeof CODEX_SANDBOX_PROVIDERS)[number];
  signIn: {
    /** Lower-cased; unset trusts no header. */
    clientIpHeader?: string;
    rules: AuthAttemptRules;
  };
};

const CODEX_SANDBOX_PROVIDERS = ["disabled", "installer", "external"] as const;

// The reconciler keeps a window's row for a day (auth-attempts.ts in db).
const MAX_AUTH_WINDOW_SEC = 86_400;
const MAX_AUTH_LIMIT = 1_000_000;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

export class ApiSettingsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid API settings: ${problems.join("; ")}`);
  }
}

export function apiSettingsFromEnv(
  environment: Record<string, string | undefined>,
): ApiSettings {
  const { problems, read } = settingProblems();
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
  const sse = {
    batchMaxBytes: read(() =>
      optionalInteger("SSE_REPLAY_MAX_BYTES", { min: 1 }),
    ),
    maxStreams: read(() => optionalInteger("SSE_MAX_STREAMS", { min: 1 })),
    maxStreamsPerOwner: read(() =>
      optionalInteger("SSE_MAX_STREAMS_PER_OWNER", { min: 1 }),
    ),
  };
  const rule = (
    prefix: string,
    fallback: { limit: number; windowMs: number },
  ) => ({
    limit:
      read(() =>
        integerSetting(environment, `${prefix}_LIMIT`, {
          min: 1,
          max: MAX_AUTH_LIMIT,
          default: fallback.limit,
        }),
      ) ?? fallback.limit,
    windowMs:
      (read(() =>
        integerSetting(environment, `${prefix}_WINDOW_SEC`, {
          min: 1,
          max: MAX_AUTH_WINDOW_SEC,
          default: fallback.windowMs / 1000,
        }),
      ) ?? fallback.windowMs / 1000) * 1000,
  });
  const signInRules: AuthAttemptRules = {
    accountFailures: rule(
      "LOGIN_ACCOUNT_FAILURE",
      DEFAULT_AUTH_ATTEMPT_RULES.accountFailures,
    ),
    networkFailures: rule(
      "LOGIN_IP_FAILURE",
      DEFAULT_AUTH_ATTEMPT_RULES.networkFailures,
    ),
    networkRequests: rule(
      "AUTH_IP_REQUEST",
      DEFAULT_AUTH_ATTEMPT_RULES.networkRequests,
    ),
  };
  const clientIpHeader = environment.CLIENT_IP_HEADER;
  if (clientIpHeader !== undefined && !HEADER_NAME.test(clientIpHeader)) {
    problems.push(
      "CLIENT_IP_HEADER must be one header name (letters, digits and hyphens), such as CF-Connecting-IP",
    );
  }
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
  const provider = environment.CODEX_SANDBOX_PROVIDER;
  const codexSandboxProvider = CODEX_SANDBOX_PROVIDERS.find(
    (known) => known === provider,
  );
  if (provider && codexSandboxProvider === undefined) {
    problems.push(
      `CODEX_SANDBOX_PROVIDER must be installer, external or disabled (got ${provider})`,
    );
  }
  if (problems.length > 0) throw new ApiSettingsError(problems);
  return {
    leaseTtlMs: leaseTtlMs as number,
    logLevel: logLevel as LogLevel,
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
    ...(codexSandboxProvider === undefined ? {} : { codexSandboxProvider }),
    signIn: {
      ...(clientIpHeader === undefined
        ? {}
        : { clientIpHeader: clientIpHeader.toLowerCase() }),
      rules: signInRules,
    },
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
// the ones every worker runs with.
const MIN_HEARTBEAT_TTL_SEC =
  (WORKER_LEASE_SAFETY_MARGIN_MS + WORKER_HEARTBEAT_INTERVAL_MS) / 1000;

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
