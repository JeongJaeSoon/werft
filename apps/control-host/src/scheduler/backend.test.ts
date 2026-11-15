import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesBackend } from "@werft-ai/execution-kubernetes";
import { LocalDockerBackend } from "@werft-ai/execution-local-docker";
import type { PreflightContext } from "./backend.ts";
import { schedulerBackendFor } from "./backend.ts";
import { schedulerConfigFromEnv } from "./config.ts";

const dir = await mkdtemp(join(tmpdir(), "scheduler-backend-"));
afterAll(() => rm(dir, { force: true, recursive: true }));

const base = {
  AWS_REGION: "ap-northeast-1",
  DATABASE_URL: "postgresql://postgres:dev@127.0.0.1:5432/sessions",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  EXECUTION_INSTALLATION_ID: "dev-a",
  EXECUTION_SLOT_LIMIT: "10",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  S3_BUCKET: "claude-sessions",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
  WORKER_GATEWAY_URL: "http://api:3000",
  WORKER_IMAGE: `registry.local/worker@sha256:${"a".repeat(64)}`,
};

/** A context whose every use throws: a preflight that touches it fails. */
const untouchable = new Proxy({} as PreflightContext, {
  get(_, key) {
    throw new Error(`preflight read ${String(key)}`);
  },
});

describe("schedulerBackendFor", () => {
  test("builds the Docker backend by default", async () => {
    const { execution } = schedulerConfigFromEnv(base);
    const { backend } = await schedulerBackendFor(execution, base);
    expect(backend).toBeInstanceOf(LocalDockerBackend);
    expect(backend.kind).toBe("local_docker");
  });

  test("builds the Kubernetes backend from KUBECONFIG and gives it no Docker preflight", async () => {
    const kubeconfig = join(dir, "kubeconfig.yaml");
    await writeFile(
      kubeconfig,
      `apiVersion: v1
kind: Config
current-context: kind
contexts:
- name: kind
  context: { cluster: kind, user: kind }
clusters:
- name: kind
  cluster:
    server: https://127.0.0.1:6443/
    certificate-authority-data: ${Buffer.from("CA").toString("base64")}
users:
- name: kind
  user:
    client-certificate-data: ${Buffer.from("CERT").toString("base64")}
    client-key-data: ${Buffer.from("KEY").toString("base64")}
`,
    );
    const environment = {
      ...base,
      EXECUTION_BACKEND: "kubernetes",
      EXECUTION_K8S_NAMESPACE: "werft",
      KUBECONFIG: kubeconfig,
    };
    const { execution } = schedulerConfigFromEnv(environment);
    const { backend, preflight } = await schedulerBackendFor(
      execution,
      environment,
    );
    expect(backend).toBeInstanceOf(KubernetesBackend);
    expect(backend.kind).toBe("kubernetes");
    // Nothing reaches the API server, the store or the logger.
    await preflight(untouchable);
  });
});
