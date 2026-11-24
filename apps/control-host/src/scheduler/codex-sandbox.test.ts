import { describe, expect, test } from "bun:test";
import { schedulerConfigFromEnv } from "./config.ts";

const base = {
  AWS_REGION: "ap-northeast-1",
  DATABASE_URL: "postgresql://postgres:dev@127.0.0.1:5432/sessions",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  EXECUTION_INSTALLATION_ID: "dev-a",
  EXECUTION_SLOT_LIMIT: "10",
  S3_BUCKET: "claude-sessions",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
  WORKER_IMAGE: "werft-worker-codex:dev",
};

const runtime = (engine: string, cliVersion: string) =>
  JSON.stringify({
    engine,
    sdkVersion: cliVersion,
    cliVersion,
    profileDigestScheme: 1,
  });

const kubernetes = {
  ...base,
  EXECUTION_BACKEND: "kubernetes",
  EXECUTION_K8S_NAMESPACE: "werft",
  WORKER_IMAGE: `registry.local/worker-codex@sha256:${"a".repeat(64)}`,
};

function sandboxOf(environment: Record<string, string>): unknown {
  const { execution } = schedulerConfigFromEnv(environment);
  return execution.backend === "local_docker"
    ? execution.docker.codexSandbox
    : execution.kubernetes.codexSandbox;
}

describe("Codex sandbox setting", () => {
  test("is on by default, for the images declared as Codex only", () => {
    expect(
      sandboxOf({
        ...base,
        WORKER_IMAGE_RUNTIME: runtime("codex", "0.167.0"),
        WORKER_IMAGE_PREVIOUS: "werft-worker-claude:dev",
        WORKER_IMAGE_PREVIOUS_RUNTIME: runtime("claude", "2.1.280"),
      }),
    ).toEqual({ mode: "enabled", images: ["werft-worker-codex:dev"] });
    // No declared runtime: not taken for Codex, so its auto sessions are
    // refused rather than run under a profile nobody chose.
    expect(sandboxOf(base)).toEqual({ mode: "enabled", images: [] });
  });

  test("is the same on Kubernetes, whose profile path is fixed", () => {
    expect(
      sandboxOf({
        ...kubernetes,
        WORKER_IMAGE_RUNTIME: runtime("codex", "0.167.0"),
      }),
    ).toEqual({ mode: "enabled", images: [kubernetes.WORKER_IMAGE] });
  });

  test("carries the provider the chart names; an unknown one is refused", () => {
    const codex = {
      ...kubernetes,
      WORKER_IMAGE_RUNTIME: runtime("codex", "0.167.0"),
    };
    for (const provider of ["disabled", "installer", "external"]) {
      expect(sandboxOf({ ...codex, CODEX_SANDBOX_PROVIDER: provider })).toEqual(
        { mode: "enabled", images: [codex.WORKER_IMAGE], provider },
      );
    }
    expect(() =>
      sandboxOf({ ...codex, CODEX_SANDBOX_PROVIDER: "helm" }),
    ).toThrow(
      "CODEX_SANDBOX_PROVIDER must be installer, external or disabled (got helm)",
    );
  });

  test("turned off on either backend; anything else is refused", () => {
    expect(sandboxOf({ ...base, CODEX_SANDBOX: "disabled" })).toEqual({
      mode: "disabled",
    });
    expect(sandboxOf({ ...kubernetes, CODEX_SANDBOX: "disabled" })).toEqual({
      mode: "disabled",
    });
    expect(sandboxOf({ ...base, CODEX_SANDBOX: "enabled" })).toMatchObject({
      mode: "enabled",
    });
    expect(() => sandboxOf({ ...base, CODEX_SANDBOX: "off" })).toThrow(
      "CODEX_SANDBOX must be enabled or disabled (got off)",
    );
  });
});
