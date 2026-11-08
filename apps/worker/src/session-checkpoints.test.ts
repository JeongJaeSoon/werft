import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BootstrapClaimResponse,
  CheckpointRef,
  CheckpointRequest,
  CheckpointRequestResponse,
  RestorePlanRequest,
  RestorePlanResponse,
} from "@werft-ai/contracts";
import {
  type CheckpointCodec,
  type CheckpointManifest,
  type CheckpointPreparation,
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_MANIFEST_OBJECTS,
  type ImageRuntime,
  MAX_TRANSCRIPT_PART_BYTES,
  ObjectIntegrityError,
  type ObjectRef,
  type RuntimeFingerprint,
  readGitBundleHeader,
  type TranscriptMirror,
  type TranscriptRevision,
  transcriptWarnBytes,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import { isolatedGit } from "@werft-ai/testkit/git";

import { stageCheckpointBundle } from "./checkpoint-restore.ts";
import { RestoreRefused, SessionCheckpoints } from "./session-checkpoints.ts";
import {
  FakeWorkerGateway,
  type FakeWorkerGatewayOptions,
} from "./testing/fake-gateway.ts";
import type { WorkerLogger } from "./worker-host.ts";
import { GitWorkspace } from "./workspace.ts";
import type {
  WorkspaceCapture,
  WorkspaceCaptureResult,
} from "./workspace-capture.ts";
import { captureWorkspace } from "./workspace-capture.ts";

const claude = realRuntimeFor("claude_agent_sdk");
const claudeCheckpointCodec = claude.checkpointCodec;
/** The build this image runs, short of a profile. */
const { profileDigestScheme: _scheme, ...engineBuild }: ImageRuntime =
  JSON.parse(claude.imageFingerprint());
/** What the transcript mirror a fresh plan opens does beyond `TranscriptMirror`. */
type CapturingMirror = TranscriptMirror & {
  captureRevision(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<TranscriptRevision | null>;
  transcriptSizes(
    sessionId: string,
  ): Promise<Array<{ bytes: number; key: string }> | null>;
};
const runtime: RuntimeFingerprint = {
  ...engineBuild,
  profileSha256: "a".repeat(64),
};
/** FakeWorkerGateway's default session. */
const SESSION = "11111111-1111-4111-8111-111111111111";
const resume = "engine-session-1";
const ready: CheckpointPreparation = {
  status: "ready",
  checkpoint: {
    engine: engineBuild.engine,
    resume,
    sdkVersion: engineBuild.sdkVersion,
  },
};
const root = { projectKey: "-workspace", sessionId: resume };

let scratch: string;
let workspace: string;
const git = isolatedGit(() => scratch);

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-246-publish-"));
  workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await git(workspace, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(workspace, "README.md"), "hello\n");
  await git(workspace, "add", "--all");
  await git(workspace, "commit", "--quiet", "-m", "first");
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

type Logged = { event: string; fields: Record<string, unknown> | undefined };

function harness(
  options: {
    gateway?: FakeWorkerGateway;
    objects?: MemoryCheckpointObjectStore;
    captureWorkspace?: ConstructorParameters<
      typeof SessionCheckpoints
    >[0]["captureWorkspace"];
    fingerprint?:
      | RuntimeFingerprint
      | ((claim: BootstrapClaimResponse) => RuntimeFingerprint);
    instructionsCommit?: () => string | null;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    claudeConfigDir?: string;
    transcriptLimits?: { partBytes: number; totalBytes: number };
    outputLimits?: {
      maxFileBytes: number;
      maxFiles: number;
      maxTotalBytes: number;
    };
    codec?: CheckpointCodec;
  } = {},
) {
  const gateway = options.gateway ?? new FakeWorkerGateway();
  const { fingerprint } = options;
  const objects = options.objects ?? createMemoryCheckpointObjectStore();
  const infos: Logged[] = [];
  const warnings: Logged[] = [];
  const errors: Logged[] = [];
  const logger: WorkerLogger = {
    info: (event, fields) => infos.push({ event, fields }),
    warn: (event, fields) => warnings.push({ event, fields }),
    error: (event, fields) => errors.push({ event, fields }),
  };
  const port = new SessionCheckpoints({
    fingerprint: (claim) =>
      typeof fingerprint === "function"
        ? fingerprint(claim)
        : (fingerprint ?? runtime),
    gateway,
    logger,
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    objectPrefix: `sessions/${SESSION}/`,
    objects,
    workspaceRoot: workspace,
    instructionFiles: ["AGENTS.md", "CLAUDE.md"],
    runtime: {
      checkpointCodec: options.codec ?? claudeCheckpointCodec,
      openTranscriptStore: claude.openTranscriptStore,
    },
    ...(options.captureWorkspace === undefined
      ? {}
      : { captureWorkspace: options.captureWorkspace }),
    ...(options.instructionsCommit === undefined
      ? {}
      : { instructionsCommit: options.instructionsCommit }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.claudeConfigDir === undefined
      ? {}
      : { claudeConfigDir: options.claudeConfigDir }),
    ...(options.transcriptLimits === undefined
      ? {}
      : { transcriptLimits: options.transcriptLimits }),
    ...(options.outputLimits === undefined
      ? {}
      : { outputLimits: options.outputLimits }),
  });
  return { errors, gateway, infos, logger, objects, port, warnings };
}

async function claimOf(
  gateway: FakeWorkerGateway,
  generation = gateway instanceof PlanningGateway ? 2 : 1,
): Promise<BootstrapClaimResponse> {
  return gateway.bootstrapClaim({
    execution_id: `execution-${generation}`,
    execution_generation: generation,
    credential: { kind: "launch_nonce", nonce: "nonce" },
  });
}

function scopeOf(claim: BootstrapClaimResponse) {
  return {
    session_id: claim.session_id,
    turn_id: "turn-1",
    attempt_id: claim.attempt_id,
    lease_epoch: claim.lease_epoch,
    execution_generation: claim.execution_generation,
    auth_revision: claim.auth_revision,
  };
}

async function opened(h: ReturnType<typeof harness>) {
  const claim = await claimOf(h.gateway);
  const plan = await h.port.restorePlan(claim, new AbortController().signal);
  if (plan.mode !== "new" || plan.sessionStore === undefined) {
    throw new Error("expected a fresh plan with a mirror");
  }
  return { claim, mirror: plan.sessionStore as TranscriptMirror };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("SessionCheckpoints", () => {
  test("waits out an object store outage before opening a fresh transcript generation", async () => {
    let elapsed = 0;
    const h = harness({
      sleep: async (ms) => {
        elapsed += ms;
      },
    });
    const list = h.objects.list.bind(h.objects);
    h.objects.list = async (prefix) => {
      if (elapsed < 7_000) throw answered(503);
      return list(prefix);
    };

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    expect(plan.mode).toBe("new");
    expect(elapsed).toBe(7_000);
    expect(h.errors).toEqual([]);
    expect(h.warnings).toEqual(
      [1, 2, 4].map((seconds, retries) => ({
        event: "worker.checkpoint.store_unavailable",
        fields: {
          reason: "status 503",
          retries,
          retry_in_ms: seconds * 1_000,
          execution_generation: 1,
        },
      })),
    );
  });

  test("keeps a fresh engine's transcripts on the workspace volume, not in HOME", async () => {
    const config = join(scratch, "home", ".claude");
    const h = harness({ claudeConfigDir: config });

    await opened(h);

    const projects = join(config, "projects");
    expect((await lstat(projects)).isSymbolicLink()).toBe(true);
    expect(await realpath(projects)).toStartWith(
      join(await realpath(workspace), ".git", "werft-transcripts-"),
    );
    // A directory of its own is left where it is.
    const own = join(scratch, "own-home", ".claude");
    await mkdir(join(own, "projects"), { recursive: true });
    await opened(harness({ claudeConfigDir: own }));
    expect((await lstat(join(own, "projects"))).isDirectory()).toBe(true);
  });

  test("publishes the workspace, the pinned transcript and a manifest under the key it was handed", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    await writeFile(join(workspace, "README.md"), "edited\n");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).not.toBeNull();
    if (ref === null) return;
    expect(h.warnings).toEqual([]);
    const [request] = h.gateway.checkpointRequests;
    expect(request?.preparation).toEqual({ status: "ready" });
    expect(request?.turn_id).toBe("turn-1");
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    expect(sha256(bytes)).toBe(ref.manifest_sha256);
    const manifest = claudeCheckpointCodec.decode(bytes);
    expect(manifest.revision).toBe(ref.revision);
    expect(manifest.sessionId).toBe(claim.session_id);
    expect(manifest.resume).toBe(resume);
    expect(manifest.runtime).toEqual(runtime);
    expect(manifest.cwd).toBe(workspace);
    const directory = ref.manifest_ref.slice(
      0,
      ref.manifest_ref.lastIndexOf("/") + 1,
    );
    const bundle = manifest.workspace.bundle;
    expect(bundle.key.startsWith(directory)).toBe(true);
    const stored = await h.objects.get(bundle.key);
    if (stored === undefined) throw new Error("bundle missing");
    expect(sha256(stored)).toBe(bundle.sha256);
    expect(stored.byteLength).toBe(bundle.bytes);
    // The capture commits the edit on top of HEAD; HEAD itself is untouched.
    expect(manifest.workspace.gitCommit).not.toBe(
      (await git(workspace, "rev-parse", "HEAD")).trim(),
    );
    expect(manifest.transcripts.root.parts).toHaveLength(1);
    const part = manifest.transcripts.root.parts[0];
    if (part === undefined) throw new Error("part missing");
    const partBytes = await h.objects.get(part.key);
    expect(partBytes === undefined ? null : sha256(partBytes)).toBe(
      part.sha256,
    );
  });

  test("carries the worker state a parked turn hands it into the manifest, and none otherwise", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const workerState = {
      pendingApprovals: [
        {
          input: { command: "rm -rf build" },
          inputHash: "f".repeat(64),
          kind: "permission" as const,
          requestId: "req_1",
          tool: "Bash",
          toolCallId: "toolu_1",
        },
      ],
    };

    const parked = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
      workerState,
    });
    await writeFile(join(workspace, "README.md"), "edited again\n");
    const plain = await h.port.capture(ready, {
      scope: { ...scopeOf(claim), turn_id: "turn-2" },
      recheck: async () => ready,
    });

    const decoded = await Promise.all(
      [parked, plain].map(async (ref) => {
        const bytes =
          ref === null ? undefined : await h.objects.get(ref.manifest_ref);
        if (bytes === undefined) throw new Error("manifest missing");
        return claudeCheckpointCodec.decode(bytes);
      }),
    );
    expect(decoded[0]?.workerState).toEqual(workerState);
    expect(decoded[1] !== undefined && "workerState" in decoded[1]).toBe(false);
  });

  test("uploads the bundle from a file in chunks, and leaves no spool behind", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    // Incompressible, so the bundle spans many reads of the file.
    await writeFile(join(workspace, "noise.bin"), randomBytes(512 * 1024));
    await git(workspace, "add", "noise.bin");
    await git(workspace, "commit", "--quiet", "-m", "noise");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (ref === null) throw new Error(`nothing published: ${h.warnings}`);
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const { bundle } = claudeCheckpointCodec.decode(bytes).workspace;
    expect(bundle.bytes).toBeGreaterThan(512 * 1024);
    const [write, ...others] = h.objects
      .streamedWrites()
      .filter(({ key }) => key === bundle.key);
    expect(others).toEqual([]);
    expect(write?.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...(write?.chunks ?? []))).toBeLessThanOrEqual(64 * 1024);
    expect(write?.chunks.reduce((total, size) => total + size, 0)).toBe(
      bundle.bytes,
    );
    expect(
      (await readdir(join(workspace, ".git"))).filter((name) =>
        name.startsWith("werft-"),
      ),
    ).toEqual([]);
  });

  test("a second publish of the same revision number never overwrites the first", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const context = { scope: scopeOf(claim), recheck: async () => ready };

    const first = await h.port.capture(ready, context);
    const second = await h.port.capture(ready, context);

    expect(first?.revision).toBe(second?.revision as number);
    expect(first?.manifest_ref).not.toBe(second?.manifest_ref as string);
  });

  test("reports a refusal to the gateway and commits nothing", async () => {
    const h = harness();
    const { claim } = await opened(h);

    const ref = await h.port.capture(
      { status: "rejected", reason: "tool_in_flight", detail: "Bash running" },
      { scope: scopeOf(claim), recheck: async () => ready },
    );

    expect(ref).toBeNull();
    expect(h.gateway.checkpointRequests.map((r) => r.preparation)).toEqual([
      { status: "rejected", reason: "tool_in_flight", detail: "Bash running" },
    ]);
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("uploads nothing when the gateway answers blocked", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async () => ({
          status: "blocked",
          reason: "mirror_error",
          detail: "an earlier batch was dropped",
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
    // The gateway made that call itself; nothing is reported back to it.
    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toEqual([{ status: "ready" }]);
  });

  test("a workspace the capture refuses fails the publish before the manifest", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "the checkout is shallow",
      }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings).toEqual([
      {
        event: "worker.checkpoint.failed",
        fields: expect.objectContaining({
          stage: "workspace",
          reason: "the checkout is shallow",
          revision: 0,
        }),
      },
    ]);
    expect(h.objects.keys().some((key) => key.endsWith("manifest.json"))).toBe(
      false,
    );
  });

  test("a transcript batch that failed to mirror keeps the manifest back", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    h.objects.failWrites(1);
    await expect(
      mirror.append(root, [{ type: "user", uuid: "u2", message: "lost" }]),
    ).rejects.toThrow("Injected");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({ stage: "transcript" });
    expect(h.objects.keys().some((key) => key.endsWith("manifest.json"))).toBe(
      false,
    );
    // Recorded as the blocking reason before the turn can finish without it.
    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail:
        "a transcript batch failed to mirror and has not been written since",
    });
  });

  test("an unsettled mirror is recorded even when the publish stopped for another reason", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "the checkout is shallow",
      }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    h.objects.failWrites(1);
    await expect(
      mirror.append(root, [{ type: "user", uuid: "u2", message: "lost" }]),
    ).rejects.toThrow("Injected");

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();

    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toMatchObject({
      status: "rejected",
      reason: "mirror_error",
    });
  });

  test("a mirror error the run reports is recorded however early the publish stopped", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "bundle too large",
      }),
    });
    const { claim } = await opened(h);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ({
          status: "rejected",
          reason: "mirror_error",
          detail: "late loss",
        }),
      }),
    ).toBeNull();

    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toEqual([
      { status: "ready" },
      { status: "rejected", reason: "mirror_error", detail: "late loss" },
    ]);
  });

  test("a lost mirror the gateway could not be told about fails the capture", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            throw new WorkerGatewayRequestError(503, null, "restarting", true);
          }
          return {
            status: "ready",
            revision: 0,
            manifest_ref: `sessions/${SESSION}/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json`,
          };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const context = {
      scope: scopeOf(claim),
      recheck: async (): Promise<CheckpointPreparation> => ({
        status: "rejected",
        reason: "mirror_error",
        detail: "Transcript mirror dropped a root batch",
      }),
    };

    await expect(h.port.capture(ready, context)).rejects.toThrow(
      "did not record it",
    );
    // The engine's own verdict takes the same path.
    await expect(
      h.port.capture(await context.recheck(), context),
    ).rejects.toThrow("did not record it");
    // An advisory refusal is no way around it: the mirror error the run
    // reports since is still recorded before the turn can close.
    await expect(
      h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        context,
      ),
    ).rejects.toThrow("did not record it");
    // One that does not land, with the mirror whole, is only logged.
    expect(
      await h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        { ...context, recheck: async () => ready },
      ),
    ).toBeNull();
  });

  test("an upload that fails leaves no manifest naming what is missing", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    // The bundle is the first write of the publish.
    h.objects.failWrites(1);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();

    expect(h.warnings[0]?.fields).toMatchObject({ category: "error" });
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("a mirror error raised while it uploaded keeps the manifest back", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ({
        status: "rejected",
        reason: "mirror_error",
        detail: "Transcript mirror dropped a root batch",
      }),
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({
      stage: "transcript",
      reason: "Transcript mirror dropped a root batch",
    });
    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail: "Transcript mirror dropped a root batch",
    });
  });

  test("a key that already holds another manifest is a failure, not an overwrite", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const manifestRef =
      "sessions/11111111-1111-4111-8111-111111111111/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json";
    await objects.putImmutable(manifestRef, new TextEncoder().encode("{}"));
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (): Promise<CheckpointRequestResponse> => ({
          status: "ready",
          revision: 0,
          manifest_ref: manifestRef,
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway, objects });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({
      stage: "manifest",
      manifest_ref: manifestRef,
    });
    expect(new TextDecoder().decode(await objects.get(manifestRef))).toBe("{}");
  });

  test("refuses a manifest key outside the session it mirrors", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (): Promise<CheckpointRequestResponse> => ({
          status: "ready",
          revision: 0,
          manifest_ref: "sessions/other/checkpoints/x/manifest.json",
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({ stage: "request" });
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("a gateway that says the attempt lost the session is thrown, not logged", async () => {
    const lost = new WorkerGatewayRequestError(
      409,
      "STALE_EPOCH",
      "stale",
      false,
    );
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (_request: CheckpointRequest) => {
          throw lost;
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim } = await opened(h);

    await expect(
      h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).rejects.toBe(lost);
    await expect(
      h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        { scope: scopeOf(claim), recheck: async () => ready },
      ),
    ).rejects.toBe(lost);
  });

  test("binds the mirror to the claim's generation and reports when it last wrote", async () => {
    const h = harness();
    expect(h.port.mirror()).toBeUndefined();
    const { mirror } = await opened(h);
    expect(h.port.mirror()).toEqual({ persistedAt: null });

    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(h.port.mirror()?.persistedAt).toBeInstanceOf(Date);
    expect(
      h.objects
        .keys()
        .every((key) =>
          key.startsWith(
            "sessions/11111111-1111-4111-8111-111111111111/transcripts/",
          ),
        ),
    ).toBe(true);
  });

  test("logs how long each stage of a publish took", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (ref === null) throw new Error("nothing published");
    const published = h.infos.find(
      ({ event }) => event === "worker.checkpoint.published",
    );
    const stages = published?.fields?.durations_ms as Record<string, number>;
    expect(Object.keys(stages).sort()).toEqual([
      "bundle_upload",
      "chain",
      "git",
      "manifest",
      "recheck",
      "request",
      "transcript",
      "untracked_upload",
    ]);
    for (const ms of Object.values(stages)) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(published?.fields?.total_ms).toBeGreaterThanOrEqual(
      Math.max(...Object.values(stages)),
    );
    const result = h.infos.find(
      ({ event }) => event === "worker.checkpoint.result",
    );
    expect(result?.fields).toMatchObject({
      message: "Checkpoint capture finished",
      operation: "checkpoint_capture",
      outcome: "succeeded",
      reason_code: "none",
      duration_ms: expect.any(Number),
      durations_ms: expect.any(Object),
      put_count: 2,
      uploaded_bytes: expect.any(Number),
      manifest_bytes: expect.any(Number),
      reused_count: 0,
      conflict_count: 0,
    });
    expect(result?.fields).not.toHaveProperty("manifest_ref");
    expect(JSON.stringify(result)).not.toContain("sessions/");
  });

  test("a failed publish logs the stages it reached, up to the one that failed", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(
      await h.port.capture(
        { ...ready, checkpoint: { ...ready.checkpoint, resume: "elsewhere" } },
        { scope: scopeOf(claim), recheck: async () => ready },
      ),
    ).toBeNull();

    expect(h.warnings[0]).toMatchObject({
      event: "worker.checkpoint.failed",
      fields: { stage: "transcript" },
    });
    expect(
      Object.keys(h.warnings[0]?.fields?.durations_ms as object).sort(),
    ).toEqual([
      "bundle_upload",
      "chain",
      "git",
      "request",
      "transcript",
      "untracked_upload",
    ]);
    expect(
      h.infos.find(({ event }) => event === "worker.checkpoint.result"),
    ).toMatchObject({
      fields: {
        operation: "checkpoint_capture",
        outcome: "refused",
        reason_code: "transcript",
        put_count: 1,
        manifest_bytes: 0,
      },
    });
  });
});

describe("a publish that fails for a reason other than the mirror", () => {
  const manifestRef = `sessions/${SESSION}/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json`;
  const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle = new TextEncoder().encode("bundle bytes");
  const captured =
    (untracked: WorkspaceCapture["untracked"] = []) =>
    async (input: { bundlePath: string }): Promise<WorkspaceCaptureResult> => {
      await writeFile(input.bundlePath, bundle);
      return {
        status: "captured",
        capture: {
          bundle: {
            bytes: bundle.byteLength,
            incremental: false,
            path: input.bundlePath,
            sha256: sha256(bundle),
            tips: [],
          },
          gitCommit: "c".repeat(40),
          headCommit: "c".repeat(40),
          sources: [],
          untracked,
        },
      };
    };
  const untrackedFiles = (count: number, pathBytes = 8) =>
    Array.from({ length: count }, (_, index) => ({
      bytes: new TextEncoder().encode("same bytes"),
      executable: false,
      path: `${String(index).padStart(pathBytes, "0")}.txt`,
    }));
  /** Hands out `handed` for a ready request and records every refusal. */
  const handing = (
    handed = manifestRef,
    ready: () => Promise<void> = async () => {},
  ) =>
    new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            return {
              status: "blocked",
              reason: request.preparation.reason,
              detail: request.preparation.detail,
            };
          }
          await ready();
          return { status: "ready", revision: 0, manifest_ref: handed };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });

  type Case = {
    stage: string;
    options: () => Promise<Parameters<typeof harness>[0]>;
    mirrored?: false;
    failWrites?: number;
  };
  const cases: Array<[string, Case]> = [
    [
      "a workspace the capture refuses",
      {
        stage: "workspace",
        options: async () => ({
          captureWorkspace: async () => ({
            status: "refused",
            reason: "5000 untracked files, over the 10 a checkpoint carries",
          }),
        }),
      },
    ],
    [
      "an upload key that already holds other bytes",
      {
        stage: "upload",
        options: async () => {
          const objects = createMemoryCheckpointObjectStore();
          await objects.putImmutable(
            `${directory}workspace-${sha256(bundle)}.bundle`,
            new TextEncoder().encode("other bytes"),
          );
          return {
            captureWorkspace: captured(),
            gateway: handing(),
            objects,
          };
        },
      },
    ],
    [
      "a manifest naming more objects than the control plane reads",
      {
        stage: "manifest",
        options: async () => ({
          captureWorkspace: captured(untrackedFiles(20_000)),
        }),
      },
    ],
    [
      "a manifest larger than the control plane reads",
      {
        stage: "manifest",
        options: async () => ({
          captureWorkspace: captured(untrackedFiles(15_000, 600)),
        }),
      },
    ],
    [
      "a manifest key that already holds another manifest",
      {
        stage: "manifest",
        options: async () => {
          const objects = createMemoryCheckpointObjectStore();
          await objects.putImmutable(
            manifestRef,
            new TextEncoder().encode("{}"),
          );
          return {
            captureWorkspace: captured(),
            gateway: handing(),
            objects,
          };
        },
      },
    ],
    [
      "a manifest key outside the session",
      {
        stage: "request",
        options: async () => ({
          gateway: handing("sessions/other/checkpoints/x/manifest.json"),
        }),
      },
    ],
    [
      "an engine session with nothing mirrored",
      {
        stage: "transcript",
        mirrored: false,
        options: async () => ({ captureWorkspace: captured() }),
      },
    ],
    [
      "a store that fails an upload",
      {
        stage: "publish",
        failWrites: 1,
        options: async () => ({ captureWorkspace: captured() }),
      },
    ],
    [
      "a gateway that cannot hand out a key",
      {
        stage: "request",
        options: async () => ({
          gateway: handing(manifestRef, async () => {
            throw new WorkerGatewayRequestError(
              503,
              "BACKEND_UNAVAILABLE",
              "checkpoint store unreachable",
              true,
            );
          }),
        }),
      },
    ],
  ];

  test.each(cases)(
    "%s is recorded as publish_failed",
    async (_name, { stage, options, mirrored, failWrites }) => {
      const h = harness(await options());
      const { claim, mirror } = await opened(h);
      if (mirrored !== false) {
        await mirror.append(root, [
          { type: "user", uuid: "u1", message: "hi" },
        ]);
      }
      if (failWrites !== undefined) h.objects.failWrites(failWrites);

      const ref = await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      });

      expect(ref).toBeNull();
      expect(
        h.gateway.checkpointRequests
          .map((request) => request.preparation)
          .filter((preparation) => preparation.status === "rejected"),
      ).toEqual([
        {
          status: "rejected",
          reason: "publish_failed",
          detail: expect.stringMatching(new RegExp(`^${stage}: `)),
        },
      ]);
      expect(h.warnings[0]).toMatchObject({
        event: "worker.checkpoint.failed",
        fields: { stage },
      });
    },
    30_000,
  );

  test("a manifest the gateway refuses at finalize is recorded the same way", async () => {
    const h = harness();
    const { claim } = await opened(h);

    await h.port.finalizeRefused(
      "Checkpoint manifest rejected: digest mismatch",
      scopeOf(claim),
    );

    expect(h.gateway.checkpointRequests).toEqual([
      {
        ...scopeOf(claim),
        preparation: {
          status: "rejected",
          reason: "publish_failed",
          detail: "finalize: Checkpoint manifest rejected: digest mismatch",
        },
      },
    ]);
  });

  test("a gateway that does not take the report only costs a log line", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            throw new WorkerGatewayRequestError(503, null, "restarting", true);
          }
          return { status: "ready", revision: 0, manifest_ref: manifestRef };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({
      gateway,
      captureWorkspace: async () => ({ status: "refused", reason: "shallow" }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();
    expect(h.warnings.map(({ event }) => event)).toEqual([
      "worker.checkpoint.failed",
      "worker.checkpoint.report_failed",
    ]);
  });

  test("writes the bundle and untracked files as content-addressed, the manifest as not", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const putImmutable = objects.putImmutable.bind(objects);
    const writes: Array<{ key: string; contentAddressed: boolean }> = [];
    objects.putImmutable = async (key, body, options) => {
      writes.push({
        key,
        contentAddressed: options?.contentAddressed === true,
      });
      return putImmutable(key, body, options);
    };
    const h = harness({
      captureWorkspace: captured(
        ["one", "two"].map((body) => ({
          bytes: new TextEncoder().encode(body),
          executable: false,
          path: `${body}.txt`,
        })),
      ),
      objects,
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (ref === null) throw new Error("nothing published");
    const directory = ref.manifest_ref.slice(
      0,
      ref.manifest_ref.lastIndexOf("/") + 1,
    );
    const published = writes.filter(({ key }) => key.startsWith(directory));
    expect(published.map(({ key }) => key.slice(directory.length))).toEqual([
      expect.stringMatching(/^workspace-[0-9a-f]{64}\.bundle$/),
      expect.stringMatching(/^untracked\/[0-9a-f]{64}$/),
      expect.stringMatching(/^untracked\/[0-9a-f]{64}$/),
      "manifest.json",
    ]);
    expect(published.map(({ contentAddressed }) => contentAddressed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("local branches in a checkpoint", () => {
  const promptOf = (prompt_revision: 1 | 2 | 3 | 4) => ({
    prompt_revision,
    agent_identity: { name: "a", description: null },
    origin_surface: "console" as const,
    language: "ko" as const,
    repository: null,
  });

  test.each([
    ["no platform prompt", undefined, false],
    ["revision 1", 1, false],
    ["revision 3", 3, false],
    ["revision 4", 4, true],
  ] as const)(
    "a session with %s asks the capture for branches: %p",
    async (_label, revision, keeps) => {
      const seen: Array<boolean | undefined> = [];
      const h = harness({
        captureWorkspace: async (input) => {
          seen.push(input.keepBranches);
          return captureWorkspace(input);
        },
      });
      const claimed = await claimOf(h.gateway);
      const claim = {
        ...claimed,
        runtime_config: {
          ...claimed.runtime_config,
          ...(revision === undefined
            ? {}
            : { platform_prompt: promptOf(revision) }),
        },
      };
      const plan = await h.port.restorePlan(
        claim,
        new AbortController().signal,
      );
      if (plan.mode !== "new" || plan.sessionStore === undefined) {
        throw new Error("expected a fresh plan with a mirror");
      }
      await (plan.sessionStore as TranscriptMirror).append(root, [
        { type: "user", uuid: "u1", message: "hi" },
      ]);

      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      });

      expect(seen).toEqual([keeps ? true : undefined]);
    },
  );
});

describe("unchanged untracked files", () => {
  test("reuses the previous committed version and reports capture sizes", async () => {
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const putImmutable = objects.putImmutable.bind(objects);
    const writes: string[] = [];
    objects.putImmutable = async (key, body, options) => {
      writes.push(key);
      return putImmutable(key, body, options);
    };
    const notes = new TextEncoder().encode("notes\n");
    let notesExecutable = false;
    const h = harness({
      objects,
      captureWorkspace: async (input) => {
        const captured = await captureWorkspace(input);
        return captured.status === "refused"
          ? captured
          : {
              ...captured,
              capture: {
                ...captured.capture,
                untracked: [
                  {
                    bytes: notes,
                    executable: notesExecutable,
                    path: "notes.txt",
                  },
                ],
              },
            };
      },
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const turn = { scope: scopeOf(claim), recheck: async () => ready };
    const manifestOf = async (ref: CheckpointRef | null) => {
      if (ref === null) {
        throw new Error(
          `checkpoint was not published: ${JSON.stringify(h.warnings)}`,
        );
      }
      const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
      if (bytes === undefined) throw new Error("manifest missing");
      return { manifest: claudeCheckpointCodec.decode(bytes), ref };
    };

    const first = await manifestOf(await h.port.capture(ready, turn));
    h.gateway.checkpointRevision = first.ref.revision;
    const second = await manifestOf(await h.port.capture(ready, turn));

    expect(second.manifest.workspace.untracked).toEqual(
      first.manifest.workspace.untracked,
    );
    const secondDirectory = second.ref.manifest_ref.slice(
      0,
      second.ref.manifest_ref.lastIndexOf("/") + 1,
    );
    expect(
      writes.filter((key) => key.startsWith(`${secondDirectory}untracked/`)),
    ).toEqual([]);
    expect(
      h.infos.filter(({ event }) => event === "worker.checkpoint.published")[1]
        ?.fields,
    ).toMatchObject({
      manifest_bytes: expect.any(Number),
      untracked: 1,
      untracked_bytes: 6,
      untracked_changed: 0,
      untracked_unchanged: 1,
      untracked_uploads: 0,
    });

    h.gateway.checkpointRevision = second.ref.revision;
    notesExecutable = true;
    const third = await manifestOf(await h.port.capture(ready, turn));
    expect(third.manifest.workspace.untracked).not.toEqual(
      second.manifest.workspace.untracked,
    );
    expect(third.manifest.workspace.untracked[0]?.executable).toBe(true);
    expect(
      h.infos.filter(({ event }) => event === "worker.checkpoint.published")[2]
        ?.fields,
    ).toMatchObject({
      untracked_changed: 1,
      untracked_unchanged: 0,
      untracked_uploads: 1,
    });
  });
});

describe("a checkpoint of uncommitted tracked files", () => {
  const manifestAfter = async (headMoved: boolean) => {
    const objects = createMemoryCheckpointObjectStore();
    const h = harness({
      objects,
      captureWorkspace: async (input) => {
        const captured = await captureWorkspace(input);
        return captured.status === "refused" || !headMoved
          ? captured
          : {
              ...captured,
              // A HEAD other than the workspace commit is what a snapshot
              // of uncommitted edits looks like to the publisher.
              capture: { ...captured.capture, headCommit: "f".repeat(40) },
            };
      },
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    if (ref === null) {
      throw new Error(
        `checkpoint was not published: ${JSON.stringify(h.warnings)}`,
      );
    }
    const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
    if (bytes === undefined) throw new Error("manifest missing");
    return claudeCheckpointCodec.decode(bytes);
  };

  test("names the snapshot commit without judging it, so request_push can say what to do", async () => {
    const manifest = await manifestAfter(true);
    expect(manifest.attribution).toEqual({
      mismatches: [{ commit: manifest.workspace.gitCommit, problems: [] }],
    });
  });

  test("leaves the manifest without an attribution entry when HEAD is the workspace commit", async () => {
    expect((await manifestAfter(false)).attribution).toBeUndefined();
  });
});

describe.skipIf(!existsSync("/proc/self/fd"))("files under out/", () => {
  test("are indexed into outputs: a symlink and an escape left out, an oversized file listed as too large, one upload per digest", async () => {
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const putImmutable = objects.putImmutable.bind(objects);
    const writes: string[] = [];
    objects.putImmutable = async (key, body, options) => {
      writes.push(key);
      return putImmutable(key, body, options);
    };
    // Ignored by git, so what is indexed cannot have come from the capture's
    // untracked files.
    await writeFile(join(workspace, ".git", "info", "exclude"), "out/\n");
    await mkdir(join(workspace, "out", "tables"), { recursive: true });
    await writeFile(join(workspace, "out", "report.md"), "# 보고서\n");
    await writeFile(join(workspace, "out", "copy.md"), "# 보고서\n");
    await writeFile(join(workspace, "out", "tables", "q3.csv"), "a,b\n1,2\n");
    await writeFile(join(workspace, "out", "video.mp4"), "x".repeat(64));
    await writeFile(join(scratch, "secret.txt"), "worker credentials\n");
    await symlink("report.md", join(workspace, "out", "latest.md"));
    await symlink("../../secret.txt", join(workspace, "out", "escape.txt"));
    const h = harness({
      objects,
      outputLimits: { maxFileBytes: 32, maxFiles: 100, maxTotalBytes: 1024 },
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const turn = { scope: scopeOf(claim), recheck: async () => ready };
    const manifestOf = async (ref: CheckpointRef | null) => {
      if (ref === null) {
        throw new Error(
          `checkpoint was not published: ${JSON.stringify(h.warnings)}`,
        );
      }
      const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
      if (bytes === undefined) throw new Error("manifest missing");
      const directory = ref.manifest_ref.slice(
        0,
        ref.manifest_ref.lastIndexOf("/") + 1,
      );
      return {
        directory,
        manifest: claudeCheckpointCodec.decode(bytes),
        ref,
      };
    };
    const report = new TextEncoder().encode("# 보고서\n");

    const first = await manifestOf(await h.port.capture(ready, turn));

    const reportKey = `${first.directory}outputs/${sha256(report)}`;
    expect(first.manifest.outputs).toEqual([
      expect.objectContaining({
        bytes: report.byteLength,
        key: reportKey,
        path: "out/copy.md",
        sha256: sha256(report),
        version: expect.any(String),
      }),
      expect.objectContaining({ key: reportKey, path: "out/report.md" }),
      expect.objectContaining({
        bytes: 8,
        path: "out/tables/q3.csv",
        sha256: sha256(new TextEncoder().encode("a,b\n1,2\n")),
      }),
      { bytes: 64, omitted: "too_large", path: "out/video.mp4" },
    ]);
    expect(
      writes.filter((key) => key.startsWith(`${first.directory}outputs/`)),
    ).toEqual([reportKey, expect.stringContaining("outputs/")]);
    expect(await objects.get(reportKey)).toEqual(report);

    h.gateway.checkpointRevision = first.ref.revision;
    const second = await manifestOf(await h.port.capture(ready, turn));

    expect(second.manifest.outputs).toEqual(first.manifest.outputs);
    expect(writes.filter((key) => key.includes("/outputs/"))).toHaveLength(2);
    expect(
      h.infos.filter(({ event }) => event === "worker.checkpoint.published")[1]
        ?.fields,
    ).toMatchObject({
      outputs: 4,
      outputs_too_large: 1,
      outputs_inherited: 3,
      outputs_uploads: 0,
    });
  });

  test("outputs past the objects the manifest has left are dropped, not the checkpoint", async () => {
    await writeFile(join(workspace, ".git", "info", "exclude"), "out/\n");
    await mkdir(join(workspace, "out"));
    for (const name of ["a.md", "b.md", "c.md"]) {
      await writeFile(join(workspace, "out", name), `${name}\n`);
    }
    // The bundle and one transcript part, plus these, leave room for two.
    const padding = Array.from(
      { length: DEFAULT_MAX_MANIFEST_OBJECTS - 4 },
      (_, index) => ({
        bytes: new TextEncoder().encode("same bytes"),
        executable: false,
        path: `pad/${index}.txt`,
      }),
    );
    const h = harness({
      captureWorkspace: async (input) => {
        const result = await captureWorkspace(input);
        return result.status === "captured"
          ? {
              ...result,
              capture: {
                ...result.capture,
                untracked: [...result.capture.untracked, ...padding],
              },
            }
          : result;
      },
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    const bytes =
      ref === null ? undefined : await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) {
      throw new Error(`manifest missing: ${JSON.stringify(h.warnings)}`);
    }

    expect(
      claudeCheckpointCodec.decode(bytes).outputs?.map((output) => output.path),
    ).toEqual(["out/a.md", "out/b.md"]);
    expect(
      h.infos.find(({ event }) => event === "worker.checkpoint.published")
        ?.fields,
    ).toMatchObject({ outputs: 2, outputs_dropped: 1 });
  });

  test("an index that would take the manifest past its bytes is left out, not the checkpoint", async () => {
    await writeFile(join(workspace, ".git", "info", "exclude"), "out/\n");
    await mkdir(join(workspace, "out"));
    await writeFile(join(workspace, "out", "report.md"), "report\n");
    // Stands in for thousands of long paths: only a manifest listing outputs
    // encodes past the limit.
    const codec: CheckpointCodec = {
      engine: claudeCheckpointCodec.engine,
      decode: (bytes) => claudeCheckpointCodec.decode(bytes),
      encode: (manifest) =>
        manifest.outputs === undefined
          ? claudeCheckpointCodec.encode(manifest)
          : {
              bytes: new Uint8Array(DEFAULT_MAX_MANIFEST_BYTES + 1),
              sha256: "0".repeat(64),
            },
      validateCompatibility: (manifest, fingerprint) =>
        claudeCheckpointCodec.validateCompatibility(manifest, fingerprint),
    };
    const h = harness({ codec });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    const bytes =
      ref === null ? undefined : await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) {
      throw new Error(`manifest missing: ${JSON.stringify(h.warnings)}`);
    }

    expect("outputs" in claudeCheckpointCodec.decode(bytes)).toBe(false);
    expect(
      h.infos.find(({ event }) => event === "worker.checkpoint.published")
        ?.fields,
    ).toMatchObject({
      outputs: 0,
      outputs_refused: expect.stringMatching(
        /^listing 1 outputs takes the manifest to \d+ bytes, over the \d+ the control plane reads$/,
      ),
    });
  });

  test("a workspace without out/ writes a manifest without outputs", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    const bytes =
      ref === null ? undefined : await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");

    expect("outputs" in claudeCheckpointCodec.decode(bytes)).toBe(false);
  });
});

/** A gateway whose restore plan is whatever the test says it is. */
class PlanningGateway extends FakeWorkerGateway {
  constructor(
    options: FakeWorkerGatewayOptions,
    answer: (request: RestorePlanRequest) => RestorePlanResponse,
  ) {
    super(options);
    this.#answer = answer;
  }

  readonly #answer: (request: RestorePlanRequest) => RestorePlanResponse;

  override async restorePlan(
    request: RestorePlanRequest,
  ): Promise<RestorePlanResponse> {
    this.restorePlans.push(request);
    return this.#answer(request);
  }
}

function neverStopped(): AbortSignal {
  return new AbortController().signal;
}

/** The plan the control plane would read out of `manifest`, versions included. */
function planOf(
  ref: CheckpointRef,
  manifest: CheckpointManifest,
): RestorePlanResponse {
  const wire = (object: ObjectRef) => ({
    key: object.key,
    bytes: object.bytes,
    sha256: object.sha256,
    ...(object.version === undefined ? {} : { version: object.version }),
  });
  const { root: rootTranscript, subagents } = manifest.transcripts;
  return {
    status: "ready",
    plan: {
      revision: ref.revision,
      manifest_ref: ref.manifest_ref,
      manifest_sha256: ref.manifest_sha256,
      ...(ref.manifest_version === undefined
        ? {}
        : { manifest_version: ref.manifest_version }),
      engine: manifest.engine,
      resume: manifest.resume,
      cwd: manifest.cwd,
      git_commit: manifest.workspace.gitCommit,
      artifacts: [
        {
          kind: "workspace_bundle",
          label: "workspace",
          objects: [
            ...(manifest.workspace.baseBundles ?? []),
            manifest.workspace.bundle,
          ].map(wire),
        },
        {
          kind: "transcript_root",
          label: "root",
          objects: rootTranscript.parts.map(wire),
        },
        ...(manifest.workspace.untracked.length === 0
          ? []
          : [
              {
                kind: "workspace_untracked" as const,
                label: "workspace",
                objects: manifest.workspace.untracked.map((object) => ({
                  ...wire(object),
                  path: object.path,
                  ...(object.executable === true
                    ? { executable: true as const }
                    : {}),
                })),
              },
            ]),
        ...Object.entries(subagents).map(([label, revision]) => ({
          kind: "transcript_subagent" as const,
          label,
          objects: revision.parts.map(wire),
        })),
      ],
      object_keys: [],
    },
  };
}

type Published = {
  manifest: CheckpointManifest;
  objects: MemoryCheckpointObjectStore;
  ref: CheckpointRef;
};

/**
 * One turn through a generation-1 worker: an edit in the checkout, a
 * transcript entry, and the checkpoint the gateway would commit.
 */
async function published(
  options: {
    versioned?: boolean;
    instructions?: boolean;
    untracked?: boolean;
  } = {},
): Promise<Published> {
  const objects = createMemoryCheckpointObjectStore({
    versioned: options.versioned === true,
  });
  let instructions: string | null = null;
  if (options.instructions === true) {
    await writeFile(join(workspace, "CLAUDE.md"), "rules as fetched\n");
    await git(workspace, "add", "CLAUDE.md");
    await git(workspace, "commit", "--quiet", "-m", "rules");
    instructions = (await git(workspace, "rev-parse", "HEAD")).trim();
  }
  const h = harness({ instructionsCommit: () => instructions, objects });
  const { claim, mirror } = await opened(h);
  await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
  await writeFile(join(workspace, "README.md"), "edited\n");
  if (options.untracked === true) {
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes", "new.txt"), "never added\n");
  }
  if (options.instructions === true) {
    await writeFile(join(workspace, "CLAUDE.md"), "rules the engine wrote\n");
  }
  const ref = await h.port.capture(ready, {
    scope: scopeOf(claim),
    recheck: async () => ready,
  });
  if (ref === null) throw new Error(`nothing published: ${h.warnings}`);
  const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
  if (bytes === undefined) throw new Error("manifest missing");
  return { manifest: claudeCheckpointCodec.decode(bytes), objects, ref };
}

/** The volume a replacement worker finds: whatever was there, or nothing. */
async function replaceWorkspaceWithLeftovers(): Promise<void> {
  await rm(workspace, { force: true, recursive: true });
  await mkdir(workspace);
  await writeFile(join(workspace, "left-behind.txt"), "stale\n");
}

function restoring(
  from: Published,
  options: {
    answer?: (request: RestorePlanRequest) => RestorePlanResponse;
    claimed?: Partial<CheckpointRef>;
    fingerprint?:
      | RuntimeFingerprint
      | ((claim: BootstrapClaimResponse) => RuntimeFingerprint);
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    claudeConfigDir?: string;
  } = {},
) {
  const gateway = new PlanningGateway(
    { restore: { ...from.ref, ...options.claimed } },
    options.answer ?? (() => planOf(from.ref, from.manifest)),
  );
  return harness({
    gateway,
    objects: from.objects,
    ...(options.fingerprint === undefined
      ? {}
      : { fingerprint: options.fingerprint }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.claudeConfigDir === undefined
      ? {}
      : { claudeConfigDir: options.claudeConfigDir }),
  });
}

/** An S3 client error as the SDK throws it, with the status it answered. */
function answered(status: number): Error {
  return Object.assign(new Error(`status ${status}`), {
    $metadata: { httpStatusCode: status },
  });
}

/**
 * `objects` failing its streamed reads, and with `gets` every read, with
 * `failure()` until the clock `sleep` advances reaches `outageMs`. The first
 * streamed read fails mid-body instead.
 */
function outage(
  objects: MemoryCheckpointObjectStore,
  outageMs: number,
  failure: () => Error,
  gets = true,
) {
  let now = 0;
  const get = objects.get.bind(objects);
  const stream = objects.stream.bind(objects);
  let cutMidBody = true;
  objects.get = async (key, version) => {
    if (gets && now < outageMs) throw failure();
    return get(key, version);
  };
  objects.stream = async (key, version) => {
    const body = await stream(key, version);
    if (now >= outageMs || body === undefined) return body;
    if (!cutMidBody) throw failure();
    cutMidBody = false;
    return (async function* () {
      for await (const chunk of body) {
        yield chunk;
        throw Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        });
      }
    })();
  };
  return {
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsed: () => now,
  };
}

describe("SessionCheckpoints restoring a checkpoint", () => {
  test("puts back the checkout and the transcript, reading each object at the version the checkpoint pinned", async () => {
    const from = await published({ versioned: true, instructions: true });
    expect(from.ref.manifest_version).toBeDefined();
    expect(from.manifest.workspace.bundle.version).toBeDefined();
    expect(from.manifest.transcripts.root.parts[0]?.version).toBeDefined();
    // A later write under the same key is not what the checkpoint verified.
    await from.objects.overwrite(
      from.manifest.workspace.bundle.key,
      new TextEncoder().encode("overwritten"),
    );
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);
    const claim = await claimOf(h.gateway);

    const plan = await h.port.restorePlan(claim, neverStopped());

    expect(h.errors).toEqual([]);
    expect(h.gateway.restorePlans[0]?.runtime).toEqual({
      cli_version: runtime.cliVersion,
      engine: runtime.engine,
      profile_sha256: runtime.profileSha256,
      sdk_version: runtime.sdkVersion,
    });
    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    expect(plan.resume).toBe(resume);
    expect(plan.restoredRevision).toBe(from.ref.revision);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(false);
    // Uncommitted before, uncommitted again.
    expect(await git(workspace, "status", "--porcelain")).toBe(
      " M CLAUDE.md\n M README.md\n",
    );
    // CLAUDE.md as fetched, not as the engine left it on disk.
    expect(plan.committedInstructions?.()).toBe("rules as fetched\n");
    expect(plan.sessionStore).toBeDefined();
  });

  test.skipIf(!existsSync("/proc/self/fd"))(
    "puts back a file the turn created but never added, still untracked",
    async () => {
      const from = await published({ untracked: true });
      expect(from.manifest.workspace.untracked).toEqual([
        expect.objectContaining({ bytes: 12, path: "notes/new.txt" }),
      ]);
      await replaceWorkspaceWithLeftovers();
      const h = restoring(from);

      await h.port.restorePlan(await claimOf(h.gateway), neverStopped());

      expect(h.errors).toEqual([]);
      expect(await readFile(join(workspace, "notes", "new.txt"), "utf8")).toBe(
        "never added\n",
      );
      expect(
        await git(workspace, "status", "--porcelain", "--untracked-files=all"),
      ).toBe(" M README.md\n?? notes/new.txt\n");
    },
  );

  test("writes the resumed transcript where the engine reads it, on the workspace volume", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const config = join(scratch, "home", ".claude");
    const h = restoring(from, { claudeConfigDir: config });

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    const projects = join(config, "projects");
    expect((await lstat(projects)).isSymbolicLink()).toBe(true);
    expect(await realpath(projects)).toStartWith(
      join(await realpath(workspace), ".git", "werft-transcripts-"),
    );
    const file = join(projects, root.projectKey, `${resume}.jsonl`);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      type: "user",
      uuid: "u1",
      message: "hi",
    });
    // The engine reads the file; the store hands it nothing and names the
    // uuids instead.
    expect(await plan.sessionStore?.load(root)).toBeNull();
    expect([...(plan.sessionStore?.resumedEntryIds?.() ?? [])]).toEqual(["u1"]);
  });

  test("restores the earlier revision a fallback plan names in place of the claim's damaged pointer", async () => {
    const from = await published({ versioned: true });
    await replaceWorkspaceWithLeftovers();
    const damaged: Partial<CheckpointRef> = {
      revision: from.ref.revision + 1,
      manifest_ref: `sessions/${SESSION}/checkpoints/damaged/manifest.json`,
      manifest_sha256: "f".repeat(64),
    };
    const fallbackFrom = (pointerRevision: number) => () => {
      const answer = planOf(from.ref, from.manifest);
      if (answer.status !== "ready") throw new Error("expected a plan");
      return {
        ...answer,
        plan: {
          ...answer.plan,
          fallback: {
            pointer_revision: pointerRevision,
            skipped: [{ revision: pointerRevision, reason: "manifest gone" }],
          },
        },
      };
    };

    // A fallback from some other pointer is not the claim's to take.
    const stray = restoring(from, {
      claimed: damaged,
      answer: fallbackFrom(from.ref.revision + 2),
    });
    await expect(
      stray.port.restorePlan(await claimOf(stray.gateway), neverStopped()),
    ).rejects.toBeInstanceOf(RestoreRefused);

    const h = restoring(from, {
      claimed: damaged,
      answer: fallbackFrom(from.ref.revision + 1),
    });
    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );
    expect(h.errors).toEqual([]);
    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    expect(plan.restoredRevision).toBe(from.ref.revision);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
  });

  test("a capture after the restore pins the same instructions commit", async () => {
    const from = await published({ instructions: true });
    const pinned = (await git(workspace, "rev-parse", "HEAD")).trim();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);
    const claim = await claimOf(h.gateway);
    await h.port.restorePlan(claim, neverStopped());
    await writeFile(join(workspace, "README.md"), "edited again\n");

    const next = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (next === null) throw new Error(`nothing published: ${h.warnings}`);
    const bytes = await from.objects.get(next.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const manifest = claudeCheckpointCodec.decode(bytes);
    expect(manifest.resume).toBe(resume);
    const bundle = await from.objects.get(manifest.workspace.bundle.key);
    if (bundle === undefined) throw new Error("bundle missing");
    await writeFile(join(scratch, "next.bundle"), bundle);
    const staged = await stageCheckpointBundle({
      bundle: join(scratch, "next.bundle"),
      gitCommit: manifest.workspace.gitCommit,
      repository: join(scratch, "next.git"),
      signal: neverStopped(),
    });
    expect(staged.instructions).toBe(pinned);
  });

  test("refuses a checkpoint the gateway calls incompatible, before touching the workspace", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      answer: () => ({
        status: "incompatible",
        code: "INCOMPATIBLE_CHECKPOINT",
        mismatches: [
          {
            field: "profileSha256",
            expected: "b".repeat(64),
            found: "a".repeat(64),
          },
        ],
      }),
    });

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toMatchObject({
      code: "INCOMPATIBLE_CHECKPOINT",
    });
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.errors.map(({ event }) => event)).toEqual([
      "worker.checkpoint.restore_refused",
    ]);
  });

  test("streams the bundle to the workspace volume, never through get, and keeps only the staged repository", async () => {
    const from = await published({ instructions: true });
    await replaceWorkspaceWithLeftovers();
    const get = from.objects.get.bind(from.objects);
    from.objects.get = async (key, version) => {
      if (key === from.manifest.workspace.bundle.key) {
        throw new Error("the bundle is read whole");
      }
      return get(key, version);
    };
    const h = restoring(from);

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    expect(plan.mode).toBe("resume");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(
      (await readdir(workspace)).filter((name) => name.startsWith(".werft-")),
    ).toEqual([]);
    expect(await readdir(join(workspace, ".git", "werft-checkpoint"))).toEqual([
      "checkpoint.git",
    ]);
    // Out of the tree's way: nothing new to commit or capture.
    expect(await git(workspace, "status", "--porcelain")).toBe(
      " M CLAUDE.md\n M README.md\n",
    );
  });

  test("refuses bytes that fail the store's checksum as damage, like a digest mismatch", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const get = from.objects.get.bind(from.objects);
    from.objects.get = async (key, version) => {
      if (key === from.ref.manifest_ref) {
        throw new ObjectIntegrityError(key, {
          cause: new Error(
            'Checksum mismatch: expected "lngI3g==" but received "mONkBA==" in response header "x-amz-checksum-crc32".',
          ),
        });
      }
      return get(key, version);
    };
    const h = restoring(from);

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
    });
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.errors.map(({ event }) => event)).toEqual([
      "worker.checkpoint.restore_refused",
    ]);
  });

  test("a checkpoint made under the profile the session ran before is checked against that one, and the next is stamped with the new", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const switched = { ...runtime, profileSha256: "c".repeat(64) };
    const h = restoring(from, {
      fingerprint: (claim) =>
        claim.runtime_config.model === "claude-haiku-5" ? switched : runtime,
    });
    const claimed = await claimOf(h.gateway);
    const claim: BootstrapClaimResponse = {
      ...claimed,
      runtime_config: { ...claimed.runtime_config, model: "claude-haiku-5" },
      restore_runtime_configs: [claimed.runtime_config],
    };

    const plan = await h.port.restorePlan(claim, neverStopped());

    expect(h.errors).toEqual([]);
    expect(plan.mode).toBe("resume");
    expect(h.gateway.restorePlans[0]).toMatchObject({
      runtime: { profile_sha256: switched.profileSha256 },
      alternate_profile_sha256s: [runtime.profileSha256],
    });
    const next = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    if (next === null) throw new Error(`nothing published: ${h.warnings}`);
    const bytes = await from.objects.get(next.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    expect(claudeCheckpointCodec.decode(bytes).runtime.profileSha256).toBe(
      switched.profileSha256,
    );
  });

  test("without the earlier profile's config, a checkpoint from it is refused as incompatible", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      fingerprint: (claim) =>
        claim.runtime_config.model === "claude-haiku-5"
          ? { ...runtime, profileSha256: "c".repeat(64) }
          : runtime,
    });
    const claimed = await claimOf(h.gateway);
    await expect(
      h.port.restorePlan(
        {
          ...claimed,
          runtime_config: {
            ...claimed.runtime_config,
            model: "claude-haiku-5",
          },
        },
        neverStopped(),
      ),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CHECKPOINT" });
  });

  test("holds the manifest to this worker's runtime even when the gateway plans it", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      fingerprint: { ...runtime, profileSha256: "c".repeat(64) },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CHECKPOINT" });
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a manifest other than the one the claim pinned", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, { claimed: { manifest_sha256: "f".repeat(64) } });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the one the claim pinned");
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a plan for a revision the claim does not name", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      answer: () => {
        const plan = planOf(from.ref, from.manifest);
        if (plan.status !== "ready") throw new Error("unreachable");
        return {
          ...plan,
          plan: { ...plan.plan, revision: from.ref.revision + 1 },
        };
      },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the claim's");
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a bundle whose bytes are not the ones the manifest pinned", async () => {
    const from = await published();
    await from.objects.overwrite(
      from.manifest.workspace.bundle.key,
      new TextEncoder().encode("overwritten"),
    );
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the bytes the manifest pinned");
    // Cleared before the download, which then needs no room beside it; the
    // spool goes with the failure.
    expect(await readdir(workspace)).toEqual([]);
    // Damage fails the claim, which the session counts.
    expect(h.warnings).toEqual([]);
    expect(h.gateway.restorePlans).toHaveLength(1);
  });

  test("refuses a transcript part that is gone, before touching the workspace", async () => {
    const from = await published();
    const part = from.manifest.transcripts.root.parts[0];
    if (part === undefined) throw new Error("part missing");
    from.objects.remove(part.key);
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow();
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a manifest whose cwd is not this workspace", async () => {
    const from = await published();
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(elsewhere);
    const h = restoring(from);
    const moved = new SessionCheckpoints({
      fingerprint: () => runtime,
      gateway: h.gateway,
      logger: h.logger,
      objectPrefix: `sessions/${SESSION}/`,
      objects: from.objects,
      workspaceRoot: elsewhere,
      instructionFiles: ["AGENTS.md", "CLAUDE.md"],
      runtime: claude,
    });

    await expect(
      moved.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toBeInstanceOf(RestoreRefused);
  });

  test("waits out an object store that stops answering for 100s, then restores without counting a failure", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    // Down under the bundle's download, cutting the first one short.
    const down = outage(from.objects, 100_000, () => answered(503), false);
    const h = restoring(from, { sleep: down.sleep });

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    expect(plan.mode).toBe("resume");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(false);
    expect(down.elapsed()).toBeGreaterThanOrEqual(100_000);
    expect(h.errors).toEqual([]);
    const waits = h.warnings.map(({ event, fields }) => ({
      event,
      retry_in_ms: fields?.retry_in_ms,
    }));
    expect(waits).toEqual(
      [1, 2, 4, 8, 16, 30, 30, 30].map((seconds) => ({
        event: "worker.checkpoint.restore_unavailable",
        retry_in_ms: seconds * 1000,
      })),
    );
    expect(h.warnings[0]?.fields?.reason).toBe("read ECONNRESET");
    // Each round asks for the plan again, as a new attempt would.
    expect(h.gateway.restorePlans).toHaveLength(waits.length + 1);
  });

  test("waits out a gateway that cannot plan while the store is down", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const waited: number[] = [];
    const h = restoring(from, {
      answer: () => {
        if (waited.length < 3) {
          throw new WorkerGatewayRequestError(
            503,
            "BACKEND_UNAVAILABLE",
            "The checkpoint's objects cannot be read right now",
            true,
          );
        }
        return planOf(from.ref, from.manifest);
      },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    expect(plan.mode).toBe("resume");
    expect(waited).toEqual([1_000, 2_000, 4_000]);
    expect(h.errors).toEqual([]);
  });

  test("fails at once when the store refuses the request rather than failing to answer", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const down = outage(from.objects, 100_000, () => answered(403));
    const h = restoring(from, { sleep: down.sleep });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("status 403");
    expect(h.warnings).toEqual([]);
    expect(h.gateway.restorePlans).toHaveLength(1);
  });

  test("gives up waiting on the store once stopped", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const down = outage(from.objects, Number.POSITIVE_INFINITY, () =>
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    const stop = new AbortController();
    const h = restoring(from, {
      sleep: async (ms) => {
        await down.sleep(ms);
        if (down.elapsed() > 60_000) stop.abort(new Error("stopped"));
      },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), stop.signal),
    ).rejects.toThrow("stopped");
    expect(h.warnings.length).toBeGreaterThan(1);
    expect(h.errors).toEqual([]);
  });

  test("never replaces the workspace once stopped", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const stop = new AbortController();
    const h = restoring(from, {
      answer: () => {
        // Stopped while the plan was on its way back.
        stop.abort(new Error("stopped"));
        return planOf(from.ref, from.manifest);
      },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), stop.signal),
    ).rejects.toThrow("stopped");
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.port.mirror()).toBeUndefined();
  });
});

describe("a long session's transcript", () => {
  const context = (claim: BootstrapClaimResponse) => ({
    scope: scopeOf(claim),
    recheck: async () => ready,
  });

  test("publishes a mirror of 25,000 parts under the manifest's object limit", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    const expected = [];
    for (let index = 0; index < 25_000; index += 1) {
      const entry = { type: "user", uuid: `u${index}`, message: `m${index}` };
      expected.push(entry);
      await mirror.append(root, [entry]);
    }

    const ref = await h.port.capture(ready, context(claim));

    expect(h.warnings).toEqual([]);
    if (ref === null) throw new Error("nothing published");
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const manifest = claudeCheckpointCodec.decode(bytes);
    const referenced =
      1 +
      manifest.workspace.untracked.length +
      manifest.transcripts.root.parts.length;
    expect(referenced).toBeLessThan(20_000);
    expect(manifest.transcripts.root.parts.length).toBeLessThan(10);
    expect(manifest.transcripts.root.entryCount).toBe(25_000);
    expect(await mirror.load(root)).toEqual(expected);
  }, 60_000);

  test("a merged part that fails to upload is publish_failed, and the next capture merges it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const putImmutable = objects.putImmutable.bind(objects);
    let refuse = true;
    objects.putImmutable = async (key, bytes) => {
      if (refuse && key.includes("/merged-")) {
        throw new Error("store unavailable");
      }
      return putImmutable(key, bytes);
    };
    const h = harness({ objects });
    const { claim, mirror } = await opened(h);
    for (let index = 0; index < 600; index += 1) {
      await mirror.append(root, [{ type: "user", uuid: `u${index}` }]);
    }

    expect(await h.port.capture(ready, context(claim))).toBeNull();

    expect(
      h.gateway.checkpointRequests
        .map((request) => request.preparation)
        .filter((preparation) => preparation.status === "rejected"),
    ).toEqual([
      {
        status: "rejected",
        reason: "publish_failed",
        detail: "publish: store unavailable",
      },
    ]);
    // Nothing a finalize could commit: the last checkpoint stays the one
    // the session resumes from.
    expect(objects.keys().some((key) => key.endsWith("/manifest.json"))).toBe(
      false,
    );

    refuse = false;
    const ref = await h.port.capture(ready, context(claim));
    if (ref === null) throw new Error("nothing published");
    const bytes = await objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const parts = claudeCheckpointCodec.decode(bytes).transcripts.root.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.key).toContain("/merged-");
  });

  test("a transcript part over the size limit stops the publish before anything is requested or uploaded", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    // Enough parts that a capture within the limit would merge them.
    for (let index = 0; index < 600; index += 1) {
      await mirror.append(root, [{ type: "user", uuid: `u${index}` }]);
    }
    await mirror.append(root, [
      {
        type: "user",
        uuid: "big",
        message: "x".repeat(MAX_TRANSCRIPT_PART_BYTES),
      },
    ]);

    expect(await h.port.capture(ready, context(claim))).toBeNull();

    expect(h.warnings[0]).toMatchObject({
      event: "worker.checkpoint.transcript_limit",
      fields: { reason: "transcript_part_too_large" },
    });
    // Its own reason, not publish_failed, and no revision was asked for.
    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toEqual([
      {
        status: "rejected",
        reason: "transcript_part_too_large",
        detail: expect.stringMatching(/over the \d+-byte part limit$/),
      },
    ]);
    expect(
      h.objects
        .keys()
        .some(
          (key) =>
            key.endsWith("/manifest.json") ||
            key.includes("/merged-") ||
            key.includes("/workspace-"),
        ),
    ).toBe(false);
  });
});

describe("transcript limits, judged against limits a test sets", () => {
  const context = (claim: BootstrapClaimResponse) => ({
    scope: scopeOf(claim),
    recheck: async () => ready,
  });
  // Mutated once the transcript is written, so each test can put the limit
  // exactly at, or one byte from, the size it produced.
  async function sized(limits: { partBytes: number; totalBytes: number }) {
    const h = harness({ transcriptLimits: limits });
    const { claim, mirror } = await opened(h);
    for (let index = 0; index < 20; index += 1) {
      await mirror.append(root, [
        { type: "user", uuid: `u${index}`, message: "y".repeat(100) },
      ]);
    }
    const sizes = await (mirror as CapturingMirror).transcriptSizes(resume);
    if (sizes === null) throw new Error("expected a root transcript");
    const total = sizes.reduce((sum, part) => sum + part.bytes, 0);
    return { claim, h, mirror: mirror as CapturingMirror, sizes, total };
  }
  const nearLimit = (h: ReturnType<typeof harness>) =>
    h.warnings.filter(
      (logged) => logged.event === "worker.checkpoint.transcript_near_limit",
    );
  const reasons = (h: ReturnType<typeof harness>) =>
    h.gateway.checkpointRequests.map((request) =>
      request.preparation.status === "ready"
        ? "ready"
        : request.preparation.reason,
    );

  test("a transcript just under 80% of the limit publishes with no warning", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, total } = await sized(limits);
    // The smallest limit whose warning threshold is still above the total.
    limits.totalBytes = Math.ceil((total + 1) / 0.8);
    while (transcriptWarnBytes(limits) <= total) limits.totalBytes += 1;
    expect(transcriptWarnBytes(limits)).toBe(total + 1);

    expect(await h.port.capture(ready, context(claim))).not.toBeNull();
    expect(nearLimit(h)).toEqual([]);
    expect(reasons(h)).toEqual(["ready"]);
  });

  test("a transcript at 80% of the limit publishes and warns", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, total } = await sized(limits);
    limits.totalBytes = Math.ceil(total / 0.8);
    while (transcriptWarnBytes(limits) > total) limits.totalBytes -= 1;
    while (transcriptWarnBytes(limits) < total) limits.totalBytes += 1;
    expect(transcriptWarnBytes(limits)).toBe(total);

    expect(await h.port.capture(ready, context(claim))).not.toBeNull();
    expect(nearLimit(h)).toEqual([
      {
        event: "worker.checkpoint.transcript_near_limit",
        fields: { transcript_bytes: total, limit_bytes: limits.totalBytes },
      },
    ]);
    expect(reasons(h)).toEqual(["ready"]);
  });

  test("a transcript exactly at the limit still publishes", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, total } = await sized(limits);
    limits.totalBytes = total;

    expect(await h.port.capture(ready, context(claim))).not.toBeNull();
    expect(reasons(h)).toEqual(["ready"]);
  });

  test("a transcript one byte over the limit is transcript_too_large before any upload", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, total } = await sized(limits);
    limits.totalBytes = total - 1;
    const before = h.objects.keys().length;

    expect(await h.port.capture(ready, context(claim))).toBeNull();
    expect(reasons(h)).toEqual(["transcript_too_large"]);
    expect(h.gateway.checkpointRequests[0]?.preparation).toEqual({
      status: "rejected",
      reason: "transcript_too_large",
      detail: `the transcript is ${total} bytes, over the ${total - 1}-byte limit`,
    });
    // Nothing went up: no bundle, no merged part, no manifest.
    expect(h.objects.keys().length).toBe(before);
  });

  test("a part one byte over the part limit is transcript_part_too_large", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, sizes, total } = await sized(limits);
    // The parts fit the total; the largest of them is one byte too many.
    limits.totalBytes = total;
    limits.partBytes = Math.max(...sizes.map((part) => part.bytes)) - 1;

    expect(await h.port.capture(ready, context(claim))).toBeNull();
    expect(reasons(h)).toEqual(["transcript_part_too_large"]);
  });

  test("a transcript that outgrew the limit after the size check is still transcript_too_large", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, mirror, total } = await sized(limits);
    limits.totalBytes = total - 1;
    // As if it grew past the limit between the size check and the capture.
    mirror.transcriptSizes = async () => null;

    expect(await h.port.capture(ready, context(claim))).toBeNull();
    expect(reasons(h)).toEqual(["ready", "transcript_too_large"]);
  });

  test("a limit the gateway did not record keeps the capture from answering", async () => {
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const { claim, h, total } = await sized(limits);
    limits.totalBytes = total - 1;
    h.gateway.requestCheckpoint = async () => {
      throw new Error("restarting");
    };

    await expect(h.port.capture(ready, context(claim))).rejects.toThrow(
      "The transcript is past its limits and the gateway did not record it: restarting",
    );
  });
});

describe("restoring a transcript over the size limit", () => {
  test("is refused before any transcript part is fetched", async () => {
    const from = await published();
    // A real revision of one part just over the limit, pinned where nothing
    // is ever read from.
    const elsewhere = (await opened(harness())).mirror as CapturingMirror;
    await elsewhere.append(root, [
      {
        type: "user",
        uuid: "big",
        message: "x".repeat(MAX_TRANSCRIPT_PART_BYTES),
      },
    ]);
    const revision = await elsewhere.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const oversized: CheckpointManifest = {
      ...from.manifest,
      transcripts: { ...from.manifest.transcripts, root: revision },
    };
    const encoded = claudeCheckpointCodec.encode(oversized);
    await from.objects.overwrite(from.ref.manifest_ref, encoded.bytes);
    const ref = { ...from.ref, manifest_sha256: encoded.sha256 };
    await replaceWorkspaceWithLeftovers();
    const h = restoring({ manifest: oversized, objects: from.objects, ref });
    from.objects.resetReads();

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toThrow(/over the \d+-byte part limit/);
    expect(from.objects.reads()).toEqual([from.ref.manifest_ref]);
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });
});

describe("a bundle built on the checkpoint before", () => {
  /** Two turns of one run, the gateway committing the first in between. */
  async function twoTurns(
    between: (
      h: ReturnType<typeof harness>,
      first: CheckpointManifest,
      scope: ReturnType<typeof scopeOf>,
    ) => Promise<void> = async () => {},
  ) {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    await writeFile(
      join(workspace, "random.txt"),
      crypto.getRandomValues(new Uint8Array(64 * 1024)).join(),
    );
    await git(workspace, "add", "random.txt");
    await git(workspace, "commit", "--quiet", "-m", "big");
    const turn = { scope: scopeOf(claim), recheck: async () => ready };
    const manifestOf = async (ref: CheckpointRef | null) => {
      if (ref === null)
        throw new Error(`nothing published: ${JSON.stringify(h.warnings)}`);
      const bytes = await h.objects.get(ref.manifest_ref);
      if (bytes === undefined) throw new Error("manifest missing");
      return {
        manifest: claudeCheckpointCodec.decode(bytes),
        objects: h.objects,
        ref,
      };
    };
    const first = await manifestOf(await h.port.capture(ready, turn));
    h.gateway.checkpointRevision = first.ref.revision;
    await between(h, first.manifest, turn.scope);
    await writeFile(join(workspace, "README.md"), "second turn\n");
    const second = await manifestOf(await h.port.capture(ready, turn));
    return { first, h, second };
  }

  test("uploads only what is new, and a restore fetches the chain in order", async () => {
    const { first, second } = await twoTurns();

    expect(second.ref.revision).toBe(first.ref.revision + 1);
    expect(second.manifest.workspace.baseBundles).toEqual([
      first.manifest.workspace.bundle,
    ]);
    expect(second.manifest.workspace.bundle.bytes).toBeLessThan(
      first.manifest.workspace.bundle.bytes / 10,
    );

    await replaceWorkspaceWithLeftovers();
    const h = restoring(second);
    const claim = await claimOf(h.gateway);
    const plan = await h.port.restorePlan(claim, neverStopped());
    expect(h.errors).toEqual([]);
    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "second turn\n",
    );
    expect(await git(workspace, "status", "--porcelain")).toBe(
      " M README.md\n",
    );

    // The restored chain is what the next capture builds on.
    h.gateway.checkpointRevision = second.ref.revision;
    await writeFile(join(workspace, "README.md"), "third turn\n");
    const third = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    if (third === null)
      throw new Error(`nothing published: ${JSON.stringify(h.warnings)}`);
    const bytes = await second.objects.get(third.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    expect(claudeCheckpointCodec.decode(bytes).workspace.baseBundles).toEqual([
      first.manifest.workspace.bundle,
      second.manifest.workspace.bundle,
    ]);
  });

  test("a restore the store failed is redone only once the round's other downloads are over", async () => {
    const { first, second } = await twoTurns();
    await replaceWorkspaceWithLeftovers();
    const stream = second.objects.stream.bind(second.objects);
    const tip = second.manifest.workspace.bundle.key;
    const base = first.manifest.workspace.bundle.key;
    let round = 0;
    let pulledAfterRedo = 0;
    second.objects.stream = async (key, version) => {
      if (round > 0 || (key !== tip && key !== base)) {
        return stream(key, version);
      }
      if (key === tip) throw answered(503);
      // A slow body that would keep writing into the spool if nothing
      // stopped reading it.
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((resolve) =>
              setTimeout(() => {
                if (round > 0) pulledAfterRedo += 1;
                resolve({ done: false, value: new Uint8Array(1) });
              }, 20),
            ),
          return: async () => ({ done: true, value: undefined }),
        }),
      };
    };
    const h = restoring(second, {
      sleep: async () => {
        round += 1;
      },
    });

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );
    await Bun.sleep(200);

    expect(plan.mode).toBe("resume");
    expect(round).toBe(1);
    // At most the read already in flight when the round stopped.
    expect(pulledAfterRedo).toBeLessThanOrEqual(1);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "second turn\n",
    );
  });

  test("stands alone once a bundle it would build on is gone from the store", async () => {
    const { second } = await twoTurns(async (h, first) => {
      h.objects.remove(first.workspace.bundle.key);
    });

    expect(second.manifest.workspace.baseBundles).toBeUndefined();
    const bundle = await second.objects.get(
      second.manifest.workspace.bundle.key,
    );
    if (bundle === undefined) throw new Error("bundle missing");
    expect(readGitBundleHeader(bundle)?.prerequisites).toEqual([]);
  });

  test("stands alone after finalize refused the one before", async () => {
    const { second } = await twoTurns(async (h, first, scope) => {
      h.gateway.checkpointRevision =
        first.revision > 0 ? first.revision - 1 : null;
      await h.port.finalizeRefused("refused", scope);
    });

    expect(second.manifest.workspace.baseBundles).toBeUndefined();
  });
});

describe("SessionCheckpoints for a session without a repository", () => {
  test("publishes the engine's files in the bundle and restores them on a new volume with no origin", async () => {
    await rm(workspace, { force: true, recursive: true });
    await new GitWorkspace(workspace, ["AGENTS.md", "CLAUDE.md"]).prepare({
      descriptor: { repository: null },
      restore: null,
      signal: neverStopped(),
    });
    const objects = createMemoryCheckpointObjectStore();
    const h = harness({
      gateway: new FakeWorkerGateway({ workspace: { repository: null } }),
      objects,
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    await mkdir(join(workspace, "out"));
    await writeFile(join(workspace, "out", "report.md"), "report\n");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });
    if (ref === null) throw new Error("nothing published");
    const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
    if (bytes === undefined) throw new Error("manifest missing");
    const manifest = claudeCheckpointCodec.decode(bytes);
    expect(manifest.workspace.untracked).toEqual([]);

    await replaceWorkspaceWithLeftovers();
    const r = harness({
      gateway: new PlanningGateway(
        { restore: ref, workspace: { repository: null } },
        () => planOf(ref, manifest),
      ),
      objects,
    });
    const plan = await r.port.restorePlan(
      await claimOf(r.gateway),
      neverStopped(),
    );

    expect(r.errors).toEqual([]);
    expect(plan.mode).toBe("resume");
    expect(await readFile(join(workspace, "out", "report.md"), "utf8")).toBe(
      "report\n",
    );
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(false);
    expect(await git(workspace, "remote")).toBe("");
    expect(
      await readFile(join(workspace, ".git", "info", "exclude"), "utf8"),
    ).toBe("node_modules/\n.venv/\n__pycache__/\n.cache/\n");
  });

  test.skipIf(!existsSync("/proc/self/fd"))(
    "indexes out/ beside the bundle, which carries the symlink the index leaves out",
    async () => {
      await rm(workspace, { force: true, recursive: true });
      await new GitWorkspace(workspace, ["AGENTS.md", "CLAUDE.md"]).prepare({
        descriptor: { repository: null },
        restore: null,
        signal: neverStopped(),
      });
      const objects = createMemoryCheckpointObjectStore({ versioned: true });
      const h = harness({
        gateway: new FakeWorkerGateway({ workspace: { repository: null } }),
        objects,
        outputLimits: { maxFileBytes: 16, maxFiles: 10, maxTotalBytes: 64 },
      });
      const { claim, mirror } = await opened(h);
      await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
      await mkdir(join(workspace, "out"));
      await writeFile(join(workspace, "out", "report.md"), "report\n");
      await writeFile(join(workspace, "out", "big.bin"), "x".repeat(32));
      await symlink("report.md", join(workspace, "out", "latest.md"));

      const ref = await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      });
      if (ref === null) {
        throw new Error(`nothing published: ${JSON.stringify(h.warnings)}`);
      }
      const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
      if (bytes === undefined) throw new Error("manifest missing");
      const manifest = claudeCheckpointCodec.decode(bytes);
      const report = new TextEncoder().encode("report\n");

      expect(manifest.workspace.untracked).toEqual([]);
      expect(manifest.outputs).toEqual([
        { bytes: 32, omitted: "too_large", path: "out/big.bin" },
        expect.objectContaining({
          bytes: report.byteLength,
          key: `${ref.manifest_ref.slice(0, ref.manifest_ref.lastIndexOf("/") + 1)}outputs/${sha256(report)}`,
          path: "out/report.md",
          sha256: sha256(report),
        }),
      ]);
    },
  );
});
