import { expect, test } from "bun:test";
import { workerEnvironmentFor } from "../../../packages/adapters/execution/kubernetes/src/specs.ts";
import { schedulerConfigFromEnv } from "../../control-host/src/scheduler/config.ts";
import { workspaceEvidenceFromEnv } from "./main.ts";
import { WorkspaceObserver } from "./workspace-observer.ts";

test.each([undefined, "false", "true"])(
  "scheduler storage declaration %j reaches the worker observer and evidence log",
  async (declaration) => {
    const { execution } = schedulerConfigFromEnv({
      AWS_REGION: "ap-northeast-1",
      DATABASE_URL: "postgresql://localhost/sessions",
      EXECUTION_BACKEND: "kubernetes",
      EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
      EXECUTION_INSTALLATION_ID: "test",
      EXECUTION_K8S_NAMESPACE: "workers",
      EXECUTION_SLOT_LIMIT: "10",
      EXECUTION_WORKSPACE_ENFORCED_BY_STORAGE: declaration,
      MAX_TURN_SECONDS: "3600",
      PROVIDER_MAX_RETRIES: "2",
      QUEUED_INPUT_LIMIT_PER_SESSION: "20",
      S3_BUCKET: "sessions",
      SESSION_COST_LIMIT_USD: "25",
      STORAGE_LIMIT_BYTES: "1073741824",
      WORKER_GATEWAY_URL: "http://api:3000",
      WORKER_IMAGE: `registry.local/worker@sha256:${"a".repeat(64)}`,
    });
    if (execution.backend !== "kubernetes") throw new Error("wrong backend");
    const config = execution.kubernetes;
    const environment = Object.fromEntries(
      workerEnvironmentFor(
        config,
        { executionId: "exec-1", generation: 1, sessionId: "session-1" },
        "nonce-secret",
        config.workspaceSizeBytes,
      ).flatMap((entry) =>
        "value" in entry ? [[entry.name, entry.value]] : [],
      ),
    );
    const evidence = workspaceEvidenceFromEnv(environment);
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const observer = new WorkspaceObserver(
      { root: environment.WORKER_WORKSPACE_MOUNT_DIR as string, evidence },
      {
        info: (event, fields) =>
          logs.push({ event, ...(fields ? { fields } : {}) }),
        warn: () => {},
        error: () => {},
      },
      async () => ({
        bytes: 100,
        inodes: 1,
        errors: 0,
        complete: true,
        durationMs: 1,
        mount: {
          mountPoint: "/workspace",
          filesystem: "ext4",
          options: ["rw"],
        },
        filesystem: {
          totalBytes: config.workspaceSizeBytes,
          freeBytes: config.workspaceSizeBytes - 100,
          totalInodes: 1000,
          freeInodes: 999,
        },
      }),
    );
    try {
      await observer.measureNow();
      const classified = logs.find(
        (entry) => entry.event === "workspace_limit_mode",
      )?.fields;
      expect(classified).toMatchObject({
        bytes: declaration === "true" ? "hard" : "unknown",
        inodes: "unknown",
        reason:
          declaration === "true"
            ? "storage_declaration_and_capacity"
            : "storage_enforcement_unverified",
        evidence: {
          requestedBytes: config.workspaceSizeBytes,
          pvcCapacityBytes: config.workspaceSizeBytes,
        },
      });
      expect(
        (classified?.evidence as Record<string, unknown>).enforcedByStorage,
      ).toBe(declaration === "true" ? true : undefined);
    } finally {
      observer.stop();
    }
  },
);
