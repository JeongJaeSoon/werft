import { describe, expect, test } from "bun:test";
import { localDockerConfigFromEnv } from "./config.ts";

const base = {
  AWS_REGION: "ap-northeast-1",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  S3_BUCKET: "claude-sessions",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
  WORKER_IMAGE: "werft-worker:dev",
};

describe("localDockerConfigFromEnv", () => {
  test("applies the documented defaults", () => {
    expect(localDockerConfigFromEnv(base)).toEqual({
      apiVersion: "v1.44",
      dockerHost: "unix:///var/run/docker.sock",
      egressCredentialPort: 3129,
      egressProxyUrl: "http://egress-proxy:3128",
      gatewayUrl: "http://host.docker.internal:3000",
      homeDir: "/home/worker",
      installationId: "local",
      objectStore: {
        bucket: "claude-sessions",
        region: "ap-northeast-1",
      },
      requestTimeoutMs: 30_000,
      idleTimeoutSeconds: 1800,
      stopTimeoutSeconds: 120,
      tmpfsSizeBytes: 256 * 1024 * 1024,
      user: "1000:1000",
      volumeLabelNamespace: "werft",
      volumeNamePrefix: "werft-ws-",
      workspaceDir: "/workspace",
      workspaceGcMinAgeMs: 3_600_000,
      workspaceQuota: {
        helperImage: "werft-worker:dev",
        inodes: 1_000_000,
        mode: "enforced",
        sizeBytes: 4096 * 1024 * 1024,
      },
    });
  });

  test("an install whose volumes carry other names points the two settings at them", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_VOLUME_LABEL_NAMESPACE: "legacy-ns",
        EXECUTION_VOLUME_NAME_PREFIX: "legacy-ws-",
      }),
    ).toMatchObject({
      volumeLabelNamespace: "legacy-ns",
      volumeNamePrefix: "legacy-ws-",
    });
  });

  test.each([
    [{ EXECUTION_VOLUME_LABEL_NAMESPACE: "Bad Ns" }, "LABEL_NAMESPACE"],
    [{ EXECUTION_VOLUME_LABEL_NAMESPACE: "ns-" }, "LABEL_NAMESPACE"],
    [{ EXECUTION_VOLUME_NAME_PREFIX: "no-trailing-dash" }, "NAME_PREFIX"],
    [{ EXECUTION_VOLUME_NAME_PREFIX: "Upper-" }, "NAME_PREFIX"],
  ])(
    "rejects a volume naming setting that is not label- or name-safe (%o)",
    (extra, name) => {
      expect(() => localDockerConfigFromEnv({ ...base, ...extra })).toThrow(
        name,
      );
    },
  );

  test("the limits hold under off too, for the worker's measurement", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA: "off",
        EXECUTION_WORKSPACE_QUOTA_MB: "2048",
        EXECUTION_WORKSPACE_QUOTA_INODES: "5000",
      }).workspaceQuota,
    ).toEqual({ mode: "off", sizeBytes: 2048 * 1024 * 1024, inodes: 5000 });
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA: "off",
        EXECUTION_WORKSPACE_QUOTA_MB: "1023",
      }),
    ).toThrow("EXECUTION_WORKSPACE_QUOTA_MB 1023 is under the 1024");
  });

  test("the workspace quota is on unless it is turned off by name", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA: "off",
      }).workspaceQuota,
    ).toEqual({
      mode: "off",
      sizeBytes: 4096 * 1024 * 1024,
      inodes: 1_000_000,
    });
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA_MB: "1024",
      }).workspaceQuota,
    ).toEqual({
      helperImage: "werft-worker:dev",
      inodes: 1_000_000,
      mode: "enforced",
      sizeBytes: 1024 * 1024 * 1024,
    });
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA_INODES: "20000",
      }).workspaceQuota,
    ).toMatchObject({ inodes: 20_000 });
  });

  test("a workspace path mountinfo would escape is refused", () => {
    // The inode helper finds the volume by this path in /proc/self/mountinfo,
    // where a space reads \040 and would never match.
    for (const dir of ["/work space", "/work\tspace", "/work\\space"]) {
      expect(() =>
        localDockerConfigFromEnv({
          ...base,
          EXECUTION_DOCKER_WORKSPACE_DIR: dir,
        }),
      ).toThrow("must not contain whitespace or backslashes");
    }
  });

  test("an inode limit of zero, or none a number, is refused", () => {
    for (const value of ["0", "-1", "1.5", "lots"]) {
      expect(() =>
        localDockerConfigFromEnv({
          ...base,
          EXECUTION_WORKSPACE_QUOTA_INODES: value,
        }),
      ).toThrow("EXECUTION_WORKSPACE_QUOTA_INODES must be a positive integer");
    }
  });

  test("the inode helper's image is the worker image, and needed only while enforced", () => {
    const { WORKER_IMAGE: _, ...withoutImage } = base;
    expect(() => localDockerConfigFromEnv(withoutImage)).toThrow(
      "WORKER_IMAGE is required while EXECUTION_WORKSPACE_QUOTA is on",
    );
    expect(
      localDockerConfigFromEnv({
        ...withoutImage,
        EXECUTION_WORKSPACE_QUOTA: "off",
      }).workspaceQuota,
    ).toEqual({
      mode: "off",
      sizeBytes: 4096 * 1024 * 1024,
      inodes: 1_000_000,
    });
  });

  test("a value that is neither on nor off is a typo, not an opt-out", () => {
    // "false", "0" and "no" all have to fail loudly: read as an opt-out they
    // would silently remove the ceiling the operator thinks they set.
    for (const value of ["false", "0", "no", "OFF"]) {
      expect(() =>
        localDockerConfigFromEnv({
          ...base,
          EXECUTION_WORKSPACE_QUOTA: value,
        }),
      ).toThrow('must be "on" or "off"');
    }
  });

  test("a quota of zero is refused, a GC age of zero is not", () => {
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_WORKSPACE_QUOTA_MB: "0" }),
    ).toThrow("EXECUTION_WORKSPACE_QUOTA_MB must be a positive integer");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA_MB: "1023",
      }),
    ).toThrow("under the 1024 a checkpoint restore needs");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "-1",
      }),
    ).toThrow(
      "EXECUTION_WORKSPACE_GC_MIN_AGE_SEC must be a non-negative integer",
    );
    // Zero says "reclaim as soon as the session is finished with it", which
    // is what the tests that want a deterministic pass ask for.
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "0",
      }).workspaceGcMinAgeMs,
    ).toBe(0);
  });

  test("an entrypoint override is split on whitespace and omitted when empty", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_COMMAND: " sleep  600 ",
      }).command,
    ).toEqual(["sleep", "600"]);
    expect("command" in localDockerConfigFromEnv(base)).toBe(false);
  });

  test("requires the gateway URL and rejects a non-URL", () => {
    expect(() => localDockerConfigFromEnv({})).toThrow("WORKER_GATEWAY_URL");
    expect(() =>
      localDockerConfigFromEnv({ ...base, WORKER_GATEWAY_URL: "not a url" }),
    ).toThrow("WORKER_GATEWAY_URL");
  });

  test("requires an http egress proxy URL", () => {
    expect(() =>
      localDockerConfigFromEnv({
        WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
      }),
    ).toThrow("EXECUTION_EGRESS_PROXY_URL");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_PROXY_URL: "egress-proxy:3128",
      }),
    ).toThrow("EXECUTION_EGRESS_PROXY_URL");
    // A proxy is addressed over http even when it tunnels TLS.
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_PROXY_URL: "https://egress-proxy:3128",
      }),
    ).toThrow("http://");
    // What the worker's object store would refuse at startup is refused
    // here, before a launch; the credential is never quoted.
    const secret = "proxy-secret-value";
    for (const [url, message] of [
      [`http://user:${secret}@egress-proxy:3128`, "credentials"],
      ["http://egress-proxy:3128/path", "host and port"],
      ["http://egress-proxy:3128/?q=1", "host and port"],
    ] as const) {
      let error: unknown;
      try {
        localDockerConfigFromEnv({ ...base, EXECUTION_EGRESS_PROXY_URL: url });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("object store access is the bucket and region, never a credential", () => {
    for (const name of ["AWS_REGION", "S3_BUCKET"] as const) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(name);
      expect(() => localDockerConfigFromEnv({ ...base, [name]: " " })).toThrow(
        name,
      );
    }
    // The scheduler shares the control host's environment, key included;
    // none of it reaches the backend config a worker is launched from.
    const config = localDockerConfigFromEnv({
      ...base,
      AWS_ACCESS_KEY_ID: "control-host-key-id",
      AWS_ENDPOINT_URL: "http://localstack:4566",
      AWS_SECRET_ACCESS_KEY: "control-host-secret",
    } as typeof base);
    expect(config.objectStore).toEqual({
      bucket: "claude-sessions",
      region: "ap-northeast-1",
    });
  });

  test("a refused object store value is named, never quoted", () => {
    // These land in scheduler logs; the check is by name so the message
    // can be logged as is.
    for (const [name, value] of [
      ["AWS_REGION", "ap-northeast-1=oops"],
      ["S3_BUCKET", "my bucket"],
    ] as const) {
      let message = "";
      try {
        localDockerConfigFromEnv({ ...base, [name]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(value);
    }
  });

  test("the shared worker network settings stop startup instead of being ignored", () => {
    for (const name of [
      "EXECUTION_DOCKER_NETWORK",
      "EXECUTION_DOCKER_NETWORK_ALLOWLIST",
    ]) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, [name]: "werft-worker" }),
      ).toThrow(`${name} is no longer read`);
      // An empty line left in an env file asks for nothing.
      expect(() =>
        localDockerConfigFromEnv({ ...base, [name]: " " }),
      ).not.toThrow();
    }
  });

  test("the proxy has to be named, because it has a different address on every worker network", () => {
    for (const url of [
      "http://172.18.0.2:3128",
      "http://[fd00::2]:3128",
      "http://localhost:3128",
    ]) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, EXECUTION_EGRESS_PROXY_URL: url }),
      ).toThrow("host name");
    }
  });

  test("the worker user must not be root", () => {
    for (const user of [
      "0",
      "0:0",
      "00",
      "000:1000",
      "1000:0",
      "root",
      "worker",
      "",
    ]) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, EXECUTION_DOCKER_USER: user }),
      ).toThrow("non-root");
    }
  });

  test("home and workspace must be distinct absolute paths", () => {
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_DOCKER_HOME_DIR: "home" }),
    ).toThrow("absolute");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_HOME_DIR: "/workspace",
      }),
    ).toThrow("differ");
  });

  test("the installation id must be label-safe", () => {
    expect(
      localDockerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: "prod-a" })
        .installationId,
    ).toBe("prod-a");
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: "a b" }),
    ).toThrow("EXECUTION_INSTALLATION_ID");
  });

  test("the Docker request deadline is configured in seconds", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: "5",
      }).requestTimeoutMs,
    ).toBe(5_000);
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: "0",
      }),
    ).toThrow("EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC");
  });

  test("refuses a stop grace too short for a worker to drain in", () => {
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "10",
      }),
    ).toThrow("at least 30");
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "30",
      }).stopTimeoutSeconds,
    ).toBe(30);
  });

  test("numeric settings must be positive integers", () => {
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "0",
      }),
    ).toThrow("EXECUTION_DOCKER_STOP_TIMEOUT_SEC");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_TMPFS_SIZE_MB: "x",
      }),
    ).toThrow("EXECUTION_DOCKER_TMPFS_SIZE_MB");
  });
});

describe("the egress credential port", () => {
  test("defaults to 3129 on the proxy's host and refuses the proxy's own port", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_CREDENTIAL_PORT: "4000",
      }).egressCredentialPort,
    ).toBe(4000);
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_CREDENTIAL_PORT: "3128",
      }),
    ).toThrow("other than the proxy's own");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_CREDENTIAL_PORT: "http",
      }),
    ).toThrow("is not a port");
  });
});
