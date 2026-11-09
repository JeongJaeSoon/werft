import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointRequestResponse,
  RegisterPendingRequest,
  RegisterPendingResponse,
  RuntimeConfig,
  WorkspaceDescriptor,
} from "@werft-ai/contracts";
import {
  type CheckpointPointer,
  type CheckpointStore,
  createCheckpointService,
  restorePlanOnWire,
} from "@werft-ai/platform";
import {
  type CommitCheckpoint,
  finalizeCheckpoint,
} from "@werft-ai/platform/testing/checkpoints";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";
import {
  createGitWorkspaceBundleVerifier,
  scopedCheckpointObjectStore,
} from "@werft-ai/storage";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";

import {
  claimFingerprint,
  imageRuntime,
  workerRuntimeRegistry,
} from "../apps/worker/src/composition.ts";
import type {
  WorkerConfig,
  WorkerTimeouts,
} from "../apps/worker/src/config.ts";
import { EngineProcesses } from "../apps/worker/src/engine-processes.ts";
import { SessionCheckpoints } from "../apps/worker/src/session-checkpoints.ts";
import {
  type FakeCheckpointProtocol,
  FakeWorkerGateway,
} from "../apps/worker/src/testing/fake-gateway.ts";
import {
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { GitWorkspace } from "../apps/worker/src/workspace.ts";
import {
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type WorkspaceCaptureLimits,
} from "../apps/worker/src/workspace-capture.ts";

/**
 * Workers as the composition root wires them: the real Agent SDK against a
 * fake Anthropic endpoint, a real clone, checkpoints on a session-scoped
 * store, and a gateway whose checkpoint half is the control plane's own
 * CheckpointService — so the manifest one worker writes is the one finalize
 * verifies and the next worker restores from.
 */

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const MODEL = "claude-sonnet-4-5";
// Untracked files are read through /proc/self/fd, so off Linux a capture
// that holds one is refused; the tracked edit is captured everywhere.
const procfs = existsSync("/proc/self/fd");

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 50,
  claimTimeoutMs: 5_000,
  drainTimeoutMs: 10_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 10_000,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
};

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function memoryPointerStore(): CheckpointStore & {
  commit: CommitCheckpoint;
  pointer(): CheckpointPointer | null;
} {
  let pointer: CheckpointPointer | null = null;
  return {
    async readPointer() {
      return pointer;
    },
    async commit(input) {
      const revision = input.checkpoint.revision;
      if (pointer !== null && revision <= pointer.revision) {
        return {
          outcome: "conflict" as const,
          currentRevision: pointer.revision,
        };
      }
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        manifestVersion: input.checkpoint.manifest_version ?? null,
        revision,
        turnId: input.turnId,
        versionsHeld: input.versionsHeld === true,
      };
      return { outcome: "committed" as const, revision };
    },
    pointer: () => pointer,
  };
}

/** Approves every tool the engine asks for, the way a user answering would. */
class ApprovingGateway extends FakeWorkerGateway {
  override async registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    const registered = await super.registerPending(request);
    this.answer({
      request_id: request.request_id,
      kind: "permission",
      decision: "allow",
    });
    return registered;
  }
}

/** The control plane's checkpoint half, as the Worker Gateway serves it. */
function servedBy(
  service: ReturnType<typeof createCheckpointService>,
  commit: CommitCheckpoint,
): FakeCheckpointProtocol {
  return {
    async requestCheckpoint(request): Promise<CheckpointRequestResponse> {
      const decision = await service.requestCheckpoint({
        attemptId: request.attempt_id,
        preparation: request.preparation,
        sessionId: request.session_id,
      });
      return decision.status === "ready"
        ? {
            status: "ready",
            revision: decision.request.revision,
            manifest_ref: decision.request.manifestRef,
          }
        : decision;
    },
    async commit(request) {
      const result = await finalizeCheckpoint(service, commit, {
        checkpoint: request.checkpoint,
        fence: {
          attemptId: request.attempt_id,
          authRevision: request.auth_revision,
          executionGeneration: request.execution_generation,
          leaseEpoch: request.lease_epoch,
          sessionId: request.session_id,
        },
        now: new Date(),
        sessionId: request.session_id,
        turnId: request.turn_id,
      });
      if (result.outcome === "rejected") {
        throw new WorkerGatewayRequestError(
          409,
          "CHECKPOINT_UNAVAILABLE",
          `Checkpoint manifest rejected: ${result.reason}`,
          false,
        );
      }
      if (result.outcome !== "committed") {
        throw new Error(`unexpected commit outcome ${result.outcome}`);
      }
    },
    async restorePlan(request) {
      return restorePlanOnWire(
        await service.getRestorePlan({
          runtime: {
            cliVersion: request.runtime.cli_version,
            engine: request.runtime.engine,
            profileSha256: request.runtime.profile_sha256,
            sdkVersion: request.runtime.sdk_version,
          },
          sessionId: request.session_id,
        }),
      );
    },
  };
}

type Recorded = {
  errors: string[];
  failures: unknown[];
  logger: WorkerLogger;
};

function recorder(): Recorded {
  const errors: string[] = [];
  const failures: unknown[] = [];
  return {
    errors,
    failures,
    logger: {
      info: () => {},
      warn: (event, fields) => {
        if (event === "worker.checkpoint.failed") failures.push(fields);
      },
      error: (event, fields) => {
        errors.push(event);
        failures.push({ event, fields });
      },
    },
  };
}

/** One execution of the worker, wired the way the composition root wires it. */
function workerOn(input: {
  bucket: MemoryCheckpointObjectStore;
  gateway: FakeWorkerGateway;
  generation: number;
  home: string;
  limits?: WorkspaceCaptureLimits;
  logger: WorkerLogger;
  workspace: string;
}): WorkerHost {
  const { gateway, home, logger, workspace } = input;
  const config = {
    // The fake server stands in for the egress proxy's provider route too.
    egressCredentialUrl: (server?.url ?? "").replace(/\/$/, ""),
    runtime: { claudeConfigDir: home, cwd: workspace, home },
  } as WorkerConfig;
  const engines = new EngineProcesses();
  const prepared = new GitWorkspace(workspace, "CLAUDE.md");
  const prefix = `sessions/${SESSION_ID}/`;
  return new WorkerHost({
    checkpoints: new SessionCheckpoints({
      fingerprint: claimFingerprint(config),
      gateway,
      instructionsCommit: () => prepared.instructionsCommit(),
      logger,
      objectPrefix: prefix,
      objects: scopedCheckpointObjectStore(input.bucket, prefix),
      workspaceRoot: workspace,
      instructionsFile: "CLAUDE.md",
      runtime: imageRuntime(),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    }),
    engines,
    execution: {
      bootstrapNonce: "wln_local",
      generation: input.generation,
      id: `exec-${input.generation}`,
    },
    gateway,
    logger,
    runtimes: workerRuntimeRegistry(config, engines),
    timeouts,
    workspace: prepared,
  });
}

describe("the worker's checkpoints against the control plane's service", () => {
  test("a replacement worker restores the checkpoint a turn committed, and one for another partition is refused", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-246-" });
    const { home, root, workspace } = isolated;
    await rm(workspace, { force: true, recursive: true });
    await mkdir(workspace);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    git(["init", "--quiet", "--bare", "--initial-branch=main", origin], root);
    git(["clone", "--quiet", origin, seed], root);
    await writeFile(join(seed, "README.md"), "original\n");
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "seed"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
    const descriptor: WorkspaceDescriptor = {
      repository: { id: "sample", url: origin, branch: "main" },
    };

    const command = procfs
      ? "printf 'edited\\n' > README.md && printf 'fresh\\n' > notes.txt && chmod +x notes.txt"
      : "printf 'edited\\n' > README.md";
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply("Bash", { command }, "toolu_edit")
        : textReply("done"),
    );
    const runtimeConfig: RuntimeConfig = {
      model: MODEL,
      tools: ["Bash"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "egress_token", token: "wep_placeholder-local" },
      },
    };

    // Versioned, and the service in its default `locked` mode: every object
    // the worker names must carry the version it wrote.
    const bucket = createMemoryCheckpointObjectStore({ versioned: true });
    const pointers = memoryPointerStore();
    const service = createCheckpointService({
      codecs: { claude: imageRuntime().checkpointCodec },
      objects: bucket,
      store: pointers,
      workspaceBundles: createGitWorkspaceBundleVerifier(),
    });
    const session = {
      checkpoints: servedBy(service, pointers.commit),
      runtimeConfig,
      sessionId: SESSION_ID,
      workspace: descriptor,
    };

    // Generation 1: one turn, checkpointed.
    const first = new ApprovingGateway(session);
    first.enqueue("edit the readme");
    const one = recorder();
    const summary = await workerOn({
      bucket,
      gateway: first,
      generation: 1,
      home,
      logger: one.logger,
      workspace,
    }).runLoop();

    expect(one.failures).toEqual([]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    const committed = first.finalized[0]?.checkpoint;
    if (committed == null) throw new Error("turn 1 committed no checkpoint");
    expect(committed.revision).toBe(0);
    expect(committed.manifest_version).toBeDefined();
    expect(pointers.pointer()?.manifestRef).toBe(committed.manifest_ref);
    expect(pointers.pointer()?.manifestSha256).toBe(committed.manifest_sha256);
    // The heartbeat that ended the run reported the mirror as written.
    expect(first.heartbeats.at(-1)?.transcript).toMatchObject({
      mirror_error: null,
    });
    // What the engine left committed on the branch is untouched: the capture
    // commit is the checkpoint's, not the session's history.
    expect(git(["rev-list", "--count", "HEAD"], workspace).trim()).toBe("1");
    const modelRequests = server.requests.length;

    // Another partition on the same endpoint: refused before the
    // engine starts, the workspace as it was.
    await writeFile(join(workspace, "sentinel.txt"), "left behind\n");
    const stranger = new ApprovingGateway({
      ...session,
      ownerScope: "owner-b",
      restore: committed,
    });
    stranger.enqueue("edit the readme");
    const two = recorder();
    const strangerHome = join(root, "home-2");
    await mkdir(strangerHome);
    const refused = await workerOn({
      bucket,
      gateway: stranger,
      generation: 2,
      home: strangerHome,
      logger: two.logger,
      workspace,
    }).runLoop();

    expect(refused.outcome).toBe("failed");
    expect(refused.reason).toContain("INCOMPATIBLE_CHECKPOINT");
    expect(two.errors).toContain("worker.checkpoint.restore_refused");
    expect(await readFile(join(workspace, "sentinel.txt"), "utf8")).toBe(
      "left behind\n",
    );
    expect(server.requests.length).toBe(modelRequests);

    // The owner again, on a volume that kept nothing and a home that never
    // saw the transcript, redelivered the input turn 1 already took.
    await rm(workspace, { force: true, recursive: true });
    await mkdir(workspace);
    const ownerHome = join(root, "home-3");
    await mkdir(ownerHome);
    const owner = new ApprovingGateway({ ...session, restore: committed });
    owner.enqueue("edit the readme");
    const three = recorder();
    const resumed = await workerOn({
      bucket,
      gateway: owner,
      generation: 3,
      home: ownerHome,
      logger: three.logger,
      workspace,
    }).runLoop();

    expect(three.errors).toEqual([]);
    expect(owner.restorePlans).toHaveLength(1);
    expect(resumed.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "input_already_consumed",
      },
    ]);
    // Held, not sent again: the model saw nothing from the restored engine.
    expect(server.requests.length).toBe(modelRequests);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(git(["rev-list", "--count", "HEAD"], workspace).trim()).toBe("1");
    expect(git(["symbolic-ref", "HEAD"], workspace).trim()).toBe(
      "refs/heads/main",
    );
    if (procfs) {
      expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe(
        "fresh\n",
      );
      expect((await stat(join(workspace, "notes.txt"))).mode & 0o100).toBe(
        0o100,
      );
      expect(git(["status", "--porcelain"], workspace)).toBe(
        " M README.md\n?? notes.txt\n",
      );
    } else {
      expect(git(["status", "--porcelain"], workspace)).toBe(" M README.md\n");
    }
  }, 180_000);

  test("a workspace the capture refuses leaves the turn without a checkpoint, and the session is told", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-312-" });
    const { home, root, workspace } = isolated;
    await rm(workspace, { force: true, recursive: true });
    await mkdir(workspace);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    git(["init", "--quiet", "--bare", "--initial-branch=main", origin], root);
    git(["clone", "--quiet", origin, seed], root);
    await writeFile(join(seed, "README.md"), "original\n");
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "seed"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            // `tee` is not a redirect: the platform's own rules pre-approve a
            // redirect into the workspace, and this test needs the approval
            // wait that the capture before it hangs on.
            { command: "printf 'edited\\n' | tee README.md" },
            "toolu_edit",
          )
        : textReply("done"),
    );
    const bucket = createMemoryCheckpointObjectStore({ versioned: true });
    const pointers = memoryPointerStore();
    const gateway = new ApprovingGateway({
      checkpoints: servedBy(
        createCheckpointService({
          codecs: { claude: imageRuntime().checkpointCodec },
          objects: bucket,
          store: pointers,
          workspaceBundles: createGitWorkspaceBundleVerifier(),
        }),
        pointers.commit,
      ),
      runtimeConfig: {
        model: MODEL,
        tools: ["Bash"],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "egress_token", token: "wep_placeholder-local" },
        },
      },
      sessionId: SESSION_ID,
      workspace: {
        repository: { id: "sample", url: origin, branch: "main" },
      },
    });
    gateway.enqueue("edit the readme");
    const recorded = recorder();

    // Any real workspace is over a one-byte bundle, as a large one is over
    // the default.
    const summary = await workerOn({
      bucket,
      gateway,
      generation: 1,
      home,
      limits: { ...DEFAULT_WORKSPACE_CAPTURE_LIMITS, maxBundleBytes: 1 },
      logger: recorded.logger,
      workspace,
    }).runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    expect(pointers.pointer()).toBeNull();
    // The approval-wait capture, then the turn's end.
    expect(recorded.failures).toEqual([
      expect.objectContaining({ stage: "workspace" }),
      expect.objectContaining({ stage: "workspace" }),
    ]);
    expect(gateway.registrations).toHaveLength(1);
    expect(gateway.registrations[0]?.checkpoint).toBeUndefined();
    expect(
      gateway.checkpointRequests
        .map((request) => request.preparation)
        .filter((preparation) => preparation.status === "rejected"),
    ).toEqual(
      Array(2).fill({
        status: "rejected",
        reason: "publish_failed",
        detail: expect.stringMatching(
          /^workspace: the workspace bundle is over/,
        ),
      }),
    );
  }, 180_000);
});
