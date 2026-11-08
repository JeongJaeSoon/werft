import { lstat, mkdir } from "node:fs/promises";
import { WORKER_EXIT_LEASE_LOST } from "@werft-ai/contracts";
import { DEFAULT_WORKSPACE_QUOTA_MB } from "@werft-ai/contracts/execution";

import { createWorkerHost } from "./composition.ts";
import { type WorkerEnvironment, workerConfigFromEnv } from "./config.ts";
import { consoleLogger } from "./console-logger.ts";
import type { WorkerHost, WorkerRunSummary } from "./worker-host.ts";
import type { WorkspaceLimitEvidence } from "./workspace-limit-mode.ts";
import { WorkspaceObserver } from "./workspace-observer.ts";

const DRAIN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * The worker process. It owns one session for as long as its lease holds, and
 * a signal here means "wind down", not "die": the drain the host runs is what
 * turns a container stop into a released session rather than an expired lease.
 */
export async function main(
  environment: NodeJS.ProcessEnv & WorkerEnvironment = process.env,
): Promise<WorkerRunSummary> {
  const config = workerConfigFromEnv(environment);
  await verifyWorkspace(config.runtime.cwd);
  const requestedBytes = Number(environment.WORKER_WORKSPACE_QUOTA_BYTES);
  const observer = new WorkspaceObserver(
    {
      root: environment.WORKER_WORKSPACE_MOUNT_DIR ?? config.runtime.cwd,
      evidence: workspaceEvidenceFromEnv(environment),
    },
    consoleLogger,
  );
  observer.start();
  const host = createWorkerHost(config, {
    workspaceQuota: {
      observer,
      limits: {
        bytes:
          Number.isSafeInteger(requestedBytes) && requestedBytes > 0
            ? requestedBytes
            : DEFAULT_WORKSPACE_QUOTA_MB * 1024 * 1024,
        inodes: 1_000_000,
      },
    },
  });
  const release = drainOnSignals(host);
  try {
    return await host.runLoop();
  } finally {
    release();
    observer.stop();
  }
}

export function workspaceEvidenceFromEnv(
  environment: NodeJS.ProcessEnv,
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

/** Hands each drain signal to the host until the returned function is called. */
export function drainOnSignals(host: Pick<WorkerHost, "drain">): () => void {
  const handlers = DRAIN_SIGNALS.map((signal) => {
    const handler = () => host.drain(`received ${signal}`);
    process.on(signal, handler);
    return { signal, handler } as const;
  });
  return () => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}

/**
 * Checked before the session is claimed, because everything after the claim
 * costs somebody a turn. The root is the backend's mount point, so a missing
 * one means the two disagree about where the workspace is. What goes in it
 * is decided after the claim, from its workspace descriptor (`workspace.ts`).
 */
export async function verifyWorkspace(directory: string): Promise<void> {
  // The Kubernetes backend mounts the volume one level up: a fresh volume's
  // own root belongs to root, and git refuses a repository whose top
  // directory another user owns. Only the leaf is made, so a missing mount
  // still fails here.
  await mkdir(directory).catch(() => undefined);
  // lstat: a link the last engine left there would move the checkout off
  // the volume.
  const found = await lstat(directory).catch(() => null);
  if (found?.isDirectory() !== true) {
    throw new Error(
      `Workspace directory ${directory} does not exist; set WORKER_WORKSPACE_DIR to the path the execution backend mounts`,
    );
  }
}

/** Non-zero only when the session was left in a state somebody has to resolve. */
export function exitCodeFor(summary: WorkerRunSummary): number {
  if (summary.outcome === "lease_lost") return WORKER_EXIT_LEASE_LOST;
  return summary.outcome === "failed" ? 1 : 0;
}

if (import.meta.main) {
  // Exits rather than waiting for the event loop to drain: a request the
  // shutdown stopped waiting for inside the stop grace would otherwise keep
  // the process alive for its full timeout, into the launcher's SIGKILL.
  process.exit(exitCodeFor(await main()));
}
