import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INSTALLATION_ID,
  DEFAULT_WORKER_USER,
  DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
  DEFAULT_WORKSPACE_QUOTA_MB,
  ENV,
  egressCredentialUrlOf,
  MIN_WORKSPACE_QUOTA_MB,
  NO_PROXY_VALUE,
  noProxyValueFor,
  workerIdleTimeoutSecondsOf,
  workerMaxTurnToolCallsOf,
} from "@werft-ai/contracts/execution";

test("worker defaults retain their documented values", () => {
  expect({
    DEFAULT_INSTALLATION_ID,
    DEFAULT_WORKER_USER,
    DEFAULT_WORKSPACE_GC_MIN_AGE_SEC,
    DEFAULT_WORKSPACE_QUOTA_MB,
    MIN_WORKSPACE_QUOTA_MB,
  }).toEqual({
    DEFAULT_INSTALLATION_ID: "local",
    DEFAULT_WORKER_USER: "1000:1000",
    DEFAULT_WORKSPACE_GC_MIN_AGE_SEC: 3600,
    DEFAULT_WORKSPACE_QUOTA_MB: 4096,
    MIN_WORKSPACE_QUOTA_MB: 1024,
  });
});

test("worker environment names retain both proxy spellings", () => {
  expect(ENV).toEqual({
    bootstrapNonce: "WORKER_BOOTSTRAP_NONCE",
    executionGeneration: "WORKER_EXECUTION_GENERATION",
    executionId: "WORKER_EXECUTION_ID",
    gatewayUrl: "WORKER_GATEWAY_URL",
    egressCredentialUrl: "WORKER_EGRESS_CREDENTIAL_URL",
    home: "HOME",
    workspaceDir: "WORKER_WORKSPACE_DIR",
    workspaceMountDir: "WORKER_WORKSPACE_MOUNT_DIR",
    workspaceQuotaBytes: "WORKER_WORKSPACE_QUOTA_BYTES",
    workspaceQuotaInodes: "WORKER_WORKSPACE_QUOTA_INODES",
    workspacePvcCapacityBytes: "WORKER_WORKSPACE_PVC_CAPACITY_BYTES",
    workspaceQuotaMode: "WORKER_WORKSPACE_QUOTA_MODE",
    workspaceEnforcedByStorage: "WORKER_WORKSPACE_ENFORCED_BY_STORAGE",
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
    maxTurnToolCalls: "WORKER_MAX_TURN_TOOL_CALLS",
    providerMaxRetries: "WORKER_PROVIDER_MAX_RETRIES",
    logLevel: "LOG_LEVEL",
    codexSandbox: "CODEX_SANDBOX",
  });
});

describe("egressCredentialUrlOf", () => {
  test.each([
    ["http://egress-proxy:3128", 3129, "http://egress-proxy:3129"],
    ["http://egress-proxy:3128/", 3129, "http://egress-proxy:3129"],
    ["http://EGRESS-PROXY", 80, "http://egress-proxy"],
    ["http://127.0.0.1:3128", 3129, "http://127.0.0.1:3129"],
    ["http://[::1]:3128", 3129, "http://[::1]:3129"],
    ["http://egress-proxy:3128", 65535, "http://egress-proxy:65535"],
    ["http://egress-proxy:3128/path/", 3129, "http://egress-proxy:3129/path"],
  ])(
    "%s on port %i becomes %s",
    (egressProxyUrl, egressCredentialPort, expected) => {
      expect(
        egressCredentialUrlOf({ egressProxyUrl, egressCredentialPort }),
      ).toBe(expected);
    },
  );
});

describe("noProxyValueFor", () => {
  test.each([
    ["http://egress-proxy:3128", "egress-proxy"],
    ["http://EGRESS-PROXY:3128/", "egress-proxy"],
    ["http://127.0.0.1:3128", "127.0.0.1"],
    ["http://[::1]:3128", "[::1]"],
  ])("%s bypasses loopback and %s", (egressProxyUrl, host) => {
    expect(noProxyValueFor({ egressProxyUrl })).toBe(
      `localhost,127.0.0.1,::1,${host}`,
    );
  });

  test("an empty inherited no_proxy cannot remove the worker's bypasses", () => {
    const config = { egressProxyUrl: "http://egress-proxy:3128", no_proxy: "" };
    expect(NO_PROXY_VALUE).toBe("localhost,127.0.0.1,::1");
    expect(noProxyValueFor(config)).toBe(
      "localhost,127.0.0.1,::1,egress-proxy",
    );
  });
});

test.each(["", " ", "http://egress-proxy:bad-port"])(
  "invalid proxy URL %j keeps the URL parser's error",
  (egressProxyUrl) => {
    expect(() =>
      egressCredentialUrlOf({ egressProxyUrl, egressCredentialPort: 3129 }),
    ).toThrow();
    expect(() => noProxyValueFor({ egressProxyUrl })).toThrow();
  },
);

describe("workerIdleTimeoutSecondsOf", () => {
  test("is 1800 unset and takes 60 to 7200", () => {
    expect(workerIdleTimeoutSecondsOf({})).toBe(1800);
    expect(workerIdleTimeoutSecondsOf({ WORKER_IDLE_TIMEOUT_SEC: "60" })).toBe(
      60,
    );
    expect(
      workerIdleTimeoutSecondsOf({ WORKER_IDLE_TIMEOUT_SEC: "7200" }),
    ).toBe(7200);
  });

  test.each(["59", "7201", "", "90.5", "soon"])(
    "refuses %j, naming the setting and its range",
    (value) => {
      expect(() =>
        workerIdleTimeoutSecondsOf({ WORKER_IDLE_TIMEOUT_SEC: value }),
      ).toThrow("WORKER_IDLE_TIMEOUT_SEC must be an integer from 60 to 7200");
    },
  );
});

describe("workerMaxTurnToolCallsOf", () => {
  test("is 500 unset and takes 1 to 100000", () => {
    expect(workerMaxTurnToolCallsOf({})).toBe(500);
    expect(workerMaxTurnToolCallsOf({ WORKER_MAX_TURN_TOOL_CALLS: "1" })).toBe(
      1,
    );
    expect(
      workerMaxTurnToolCallsOf({ WORKER_MAX_TURN_TOOL_CALLS: "100000" }),
    ).toBe(100_000);
  });

  test.each(["0", "100001", "", "5.5", "many"])(
    "refuses %j, naming the setting and its range",
    (value) => {
      expect(() =>
        workerMaxTurnToolCallsOf({ WORKER_MAX_TURN_TOOL_CALLS: value }),
      ).toThrow(
        "WORKER_MAX_TURN_TOOL_CALLS must be an integer from 1 to 100000",
      );
    },
  );
});
