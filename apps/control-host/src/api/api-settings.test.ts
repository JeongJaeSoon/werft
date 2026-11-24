import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiSettingsError,
  apiSettingsFromEnv,
  apiSettingsProblems,
  heartbeatTtlMsFromEnv,
} from "./api-settings.ts";

describe("apiSettingsFromEnv", () => {
  test("WORKSPACE_ENFORCE is the console's now: not read, so not refused", () => {
    expect(apiSettingsFromEnv({ WORKSPACE_ENFORCE: "force" })).toEqual(
      apiSettingsFromEnv({}),
    );
  });
  test("unset keeps every default", () => {
    expect(apiSettingsFromEnv({})).toEqual({
      leaseTtlMs: 30_000,
      logLevel: "info",
      sse: {},
      signIn: {
        rules: {
          accountFailures: { limit: 5, windowMs: 900_000 },
          networkFailures: { limit: 20, windowMs: 900_000 },
          networkRequests: { limit: 30, windowMs: 60_000 },
        },
      },
    });
  });

  test("CODEX_SANDBOX_PROVIDER is read as the scheduler reads it", () => {
    for (const provider of ["disabled", "installer", "external"] as const) {
      expect(
        apiSettingsFromEnv({ CODEX_SANDBOX_PROVIDER: provider })
          .codexSandboxProvider,
      ).toBe(provider);
    }
    expect(
      apiSettingsFromEnv({ CODEX_SANDBOX_PROVIDER: "" }).codexSandboxProvider,
    ).toBeUndefined();
    expect(apiSettingsProblems({ CODEX_SANDBOX_PROVIDER: "helm" })).toEqual([
      "CODEX_SANDBOX_PROVIDER must be installer, external or disabled (got helm)",
    ]);
  });

  test("the removed AGENT_ACTION_FLOWS setting is ignored, not parsed", () => {
    expect(apiSettingsFromEnv({ AGENT_ACTION_FLOWS: "yes" })).toEqual(
      apiSettingsFromEnv({}),
    );
  });

  test("reads what is set", () => {
    expect(
      apiSettingsFromEnv({
        HEARTBEAT_TTL_SEC: "45",
        LOG_LEVEL: "debug",
        SSE_MAX_STREAMS: "512",
        SSE_MAX_STREAMS_PER_OWNER: "16",
        SSE_REPLAY_MAX_BYTES: "65536",
      }),
    ).toEqual({
      leaseTtlMs: 45_000,
      logLevel: "debug",
      sse: { batchMaxBytes: 65_536, maxStreams: 512, maxStreamsPerOwner: 16 },
      signIn: {
        rules: {
          accountFailures: { limit: 5, windowMs: 900_000 },
          networkFailures: { limit: 20, windowMs: 900_000 },
          networkRequests: { limit: 30, windowMs: 60_000 },
        },
      },
    });
  });

  // The ticket's reproduction: each of these used to start the API on a
  // default nobody chose.
  test.each([
    ["SSE_MAX_STREAMS", "25O"],
    ["SSE_MAX_STREAMS", "0"],
    ["SSE_MAX_STREAMS_PER_OWNER", "-8"],
    ["SSE_REPLAY_MAX_BYTES", "1.5"],
    ["LOG_LEVEL", "inf0"],
    ["HEARTBEAT_TTL_SEC", "10"],
  ])("%s=%p stops the API", (name, value) => {
    expect(() => apiSettingsFromEnv({ [name]: value })).toThrow(name);
  });

  test("reads the sign-in limits and the client address header", () => {
    expect(
      apiSettingsFromEnv({
        LOGIN_ACCOUNT_FAILURE_LIMIT: "3",
        LOGIN_ACCOUNT_FAILURE_WINDOW_SEC: "600",
        LOGIN_IP_FAILURE_LIMIT: "50",
        LOGIN_IP_FAILURE_WINDOW_SEC: "3600",
        AUTH_IP_REQUEST_LIMIT: "100",
        AUTH_IP_REQUEST_WINDOW_SEC: "120",
        CLIENT_IP_HEADER: "CF-Connecting-IP",
      }).signIn,
    ).toEqual({
      clientIpHeader: "cf-connecting-ip",
      rules: {
        accountFailures: { limit: 3, windowMs: 600_000 },
        networkFailures: { limit: 50, windowMs: 3_600_000 },
        networkRequests: { limit: 100, windowMs: 120_000 },
      },
    });
  });

  test.each([
    ["LOGIN_ACCOUNT_FAILURE_LIMIT", "0"],
    ["LOGIN_IP_FAILURE_LIMIT", "1000001"],
    ["AUTH_IP_REQUEST_LIMIT", "ten"],
    ["LOGIN_ACCOUNT_FAILURE_WINDOW_SEC", "86401"],
    ["AUTH_IP_REQUEST_WINDOW_SEC", ""],
    ["CLIENT_IP_HEADER", ""],
    ["CLIENT_IP_HEADER", "X-Forwarded-For, CF-Connecting-IP"],
  ])("%s=%p stops the API", (name, value) => {
    expect(() => apiSettingsFromEnv({ [name]: value })).toThrow(name);
  });

  test("AUTH_MODE=none is refused where workers can reach the API", () => {
    expect(() =>
      apiSettingsFromEnv({ AUTH_MODE: "none", EGRESS_AUTHORIZER_PORT: "3100" }),
    ).toThrow("AUTH_MODE=none cannot run with the egress authorizer on");
    // Without the authorizer no worker reaches a provider, so none do run.
    expect(apiSettingsFromEnv({ AUTH_MODE: "none" }).leaseTtlMs).toBe(30_000);
    expect(
      apiSettingsFromEnv({
        AUTH_MODE: "api-key",
        EGRESS_AUTHORIZER_PORT: "3100",
      }).leaseTtlMs,
    ).toBe(30_000);
  });

  test("names every problem at once", () => {
    const environment = {
      SSE_MAX_STREAMS: "25O",
      LOG_LEVEL: "loud",
    };
    let thrown: unknown;
    try {
      apiSettingsFromEnv(environment);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiSettingsError);
    expect(apiSettingsProblems(environment)).toEqual([
      'LOG_LEVEL must be one of debug|info|warn|error, got "loud"',
      "SSE_MAX_STREAMS must be a positive integer",
    ]);
    expect(apiSettingsProblems({})).toEqual([]);
  });
});

describe("heartbeatTtlMsFromEnv", () => {
  test("unset is the platform default; a positive number is seconds", () => {
    expect(heartbeatTtlMsFromEnv(undefined)).toBe(30_000);
    expect(heartbeatTtlMsFromEnv("45")).toBe(45_000);
    expect(heartbeatTtlMsFromEnv("20.5")).toBe(20_500);
    // 15 s (margin + interval) is the floor; 20 s, the floor while workers
    // that beat every 10 s were supported, is now accepted.
    expect(heartbeatTtlMsFromEnv("15.5")).toBe(15_500);
    expect(heartbeatTtlMsFromEnv("20")).toBe(20_000);
  });

  test("anything else stops the API instead of becoming the default", () => {
    expect(heartbeatTtlMsFromEnv("86400")).toBe(86_400_000);
    for (const value of [
      "",
      " ",
      "0",
      "-5",
      // At or under the worker's margin + interval (10 s + 5 s): every
      // attempt would give its lease up at or near its first beat.
      "0.5",
      "10",
      "15",
      "abc",
      "Infinity",
      "NaN",
      "86401",
      "1e308",
    ]) {
      expect(() => heartbeatTtlMsFromEnv(value)).toThrow(
        /^HEARTBEAT_TTL_SEC must be a number of seconds above 15 /,
      );
    }
  });
});

describe("WEB_DIST_DIR", () => {
  test("unset serves no web console; a built directory is read as is", async () => {
    expect(apiSettingsFromEnv({}).webDistDir).toBeUndefined();
    const dist = await mkdtemp(join(tmpdir(), "web-dist-"));
    try {
      await writeFile(join(dist, "index.html"), "<!doctype html>");
      expect(apiSettingsFromEnv({ WEB_DIST_DIR: dist }).webDistDir).toBe(dist);
      expect(apiSettingsProblems({ WEB_DIST_DIR: join(dist, "nope") })).toEqual(
        [
          "WEB_DIST_DIR must be an absolute path to a directory holding index.html (apps/web's build output)",
        ],
      );
      expect(
        apiSettingsProblems({ WEB_DIST_DIR: "apps/web/dist" }),
      ).toHaveLength(1);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});
