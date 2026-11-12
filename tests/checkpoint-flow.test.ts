import { afterAll, describe, expect, test } from "bun:test";
import {
  type CheckpointFence,
  type CheckpointPointer,
  type CheckpointStore,
  createCheckpointService,
  manifestRefFor,
} from "@werft-ai/platform";
import {
  type CommitCheckpoint,
  finalizeCheckpoint,
  structuralBundleVerifier,
} from "@werft-ai/platform/testing/checkpoints";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeSessionStore,
  claudeCheckpointCodec,
  claudeProfileFingerprint,
} from "@werft-ai/runtime-claude";
import type {
  CheckpointManifest,
  CheckpointObjectStore,
  TranscriptEntry,
} from "@werft-ai/runtime-core";
import { createCheckpointObjectStore } from "@werft-ai/storage";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import { createGitBundle } from "@werft-ai/testkit/git-bundle";
import {
  createLocalstackBucket,
  type LocalstackBucket,
  localstackEnabled,
} from "@werft-ai/testkit/localstack";

/**
 * The whole checkpoint path, wired the way a worker and the control plane wire
 * it: the SDK mirror writes transcripts, the codec seals them into a manifest,
 * the object store refuses to let anyone rewrite it, and the pointer decides
 * which one the session actually resumes from.
 */

const sessionId = "33333333-3333-4333-8333-333333333333";
// What `requestCheckpoint` would have minted for the publish these tests upload.
const PUBLISH_ID = "0123456789abcdef0123456789abcdef";
// The engine names its own session, and transcripts are filed under that name
// — never the platform's. Keeping the two different is what proves nothing
// here confuses them.
const engineSession = "sdk-session-1";
const projectKey = "-workspace";
// The workspace half of the checkpoint: a real bundle, uploaded into the
// attempt's own directory beside the manifest that names it.
const workspaceBundle = await createGitBundle();
const gitCommit = workspaceBundle.commit;

function bundleKeyFor(revision: number, attempt: string): string {
  const ref = manifestRefFor(sessionId, revision, attempt, PUBLISH_ID);
  return `${ref.slice(0, ref.lastIndexOf("/") + 1)}workspace.bundle`;
}

function bundleRefFor(revision: number, attempt: string) {
  return {
    bytes: workspaceBundle.bytes.byteLength,
    key: bundleKeyFor(revision, attempt),
    sha256: workspaceBundle.sha256,
  };
}
const config = {
  model: "claude-sonnet-4-5",
  profile: {
    kind: "anthropic" as const,
    endpoint: "https://api.anthropic.test",
    auth: { kind: "api_key" as const, value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Bash"],
};
const runtime = {
  ...CLAUDE_RUNTIME_FINGERPRINT,
  profileSha256: claudeProfileFingerprint(config),
};

const attemptId = "attempt-1";
const fence: CheckpointFence = {
  attemptId,
  authRevision: 1,
  executionGeneration: 1,
  leaseEpoch: 1,
  sessionId,
};

/** `live` names the attempt currently holding the lease. */
function memoryCheckpointStore(live = { attemptId }): CheckpointStore & {
  commit: CommitCheckpoint;
  pointer(): CheckpointPointer | null;
} {
  let pointer: CheckpointPointer | null = null;
  return {
    async readPointer() {
      return pointer;
    },
    async commit(input) {
      if (input.fence.attemptId !== live.attemptId) {
        return { outcome: "stale_epoch" as const };
      }
      const revision = input.checkpoint.revision;
      if (pointer !== null && revision <= pointer.revision) {
        return pointer.manifestSha256 === input.checkpoint.manifest_sha256 &&
          revision === pointer.revision
          ? { outcome: "replayed" as const, revision }
          : { outcome: "conflict" as const, currentRevision: pointer.revision };
      }
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        revision,
        turnId: input.turnId,
      };
      return { outcome: "committed" as const, revision };
    },
    pointer: () => pointer,
  };
}

function entry(uuid: string, text: string): TranscriptEntry {
  return { type: "user", uuid, message: { content: text } };
}

const buckets: LocalstackBucket[] = [];

afterAll(async () => {
  for (const bucket of buckets) await bucket.destroy();
});

// The LocalStack variant is skipped rather than left out when LocalStack is
// off: CI fails an integration job on a skip it did not declare
// and a suite that is never declared would slip past that check.
const backends: Array<[string, boolean, () => Promise<CheckpointObjectStore>]> =
  [
    [
      "in-memory objects",
      true,
      async () => createMemoryCheckpointObjectStore(),
    ],
    [
      "LocalStack objects",
      localstackEnabled(),
      async () => {
        const bucket = await createLocalstackBucket({
          prefix: "checkpoint-flow-it",
        });
        buckets.push(bucket);
        return createCheckpointObjectStore({
          bucket: bucket.bucket,
          client: bucket.s3,
        });
      },
    ],
  ];

for (const [name, enabled, createObjects] of backends) {
  (enabled ? describe : describe.skip)(`checkpoint flow (${name})`, () => {
    test("publishes a checkpoint, refuses a stale rewrite, and restores exactly what it pinned", async () => {
      const objects = await createObjects();
      const store = memoryCheckpointStore();
      const service = createCheckpointService({
        codecs: { claude: claudeCheckpointCodec },
        // The mirror does not record part versions yet.
        objectProtection: "unversioned",
        newPublishId: () => PUBLISH_ID,
        objects,
        store,
        workspaceBundles: structuralBundleVerifier,
      });
      const mirror = new ClaudeSessionStore({
        generation: 1,
        objects,
        prefix: `sessions/${sessionId}/mirror`,
      });
      const root = { projectKey, sessionId: engineSession };
      const subagent = { ...root, subpath: "agents/reviewer" };

      for (const attempt of [attemptId, "attempt-stale"]) {
        await objects.putImmutable(
          bundleKeyFor(0, attempt),
          workspaceBundle.bytes,
        );
      }
      await mirror.append(root, [entry("r1", "first turn")]);
      await mirror.append(subagent, [entry("s1", "review")]);

      const request = await service.requestCheckpoint({
        attemptId,
        preparation: {
          status: "ready",
          checkpoint: {
            engine: "claude",
            resume: engineSession,
            sdkVersion: runtime.sdkVersion,
          },
        },
        sessionId,
      });
      if (request.status !== "ready") throw new Error("expected a request");
      expect(request.request.revision).toBe(0);
      expect(request.request.manifestRef).toBe(
        manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID),
      );

      const first = await publish(
        mirror,
        request.request.revision,
        engineSession,
      );
      expect(
        await objects.putImmutable(request.request.manifestRef, first.bytes),
      ).toEqual({ outcome: "created" });
      expect(
        await finalizeCheckpoint(service, store.commit, {
          checkpoint: {
            manifest_ref: request.request.manifestRef,
            manifest_sha256: first.sha256,
            revision: 0,
          },
          fence,
          now: new Date("2026-09-22T00:00:00.000Z"),
          sessionId,
          turnId: "1",
        }),
      ).toEqual({ outcome: "committed", revision: 0 });

      // The session keeps working: the mirror moves on past the checkpoint.
      await mirror.append(root, [entry("r2", "second turn")]);

      // A worker whose lease already ended finishes uploading its own manifest.
      // Its key is its own, so the upload succeeds — what stops it is the fence.
      const stale = await publish(
        mirror,
        0,
        engineSession,
        runtime,
        "attempt-stale",
      );
      const staleRef = manifestRefFor(
        sessionId,
        0,
        "attempt-stale",
        PUBLISH_ID,
      );
      expect(await objects.putImmutable(staleRef, stale.bytes)).toEqual({
        outcome: "created",
      });
      expect(
        await finalizeCheckpoint(service, store.commit, {
          checkpoint: {
            manifest_ref: staleRef,
            manifest_sha256: stale.sha256,
            revision: 0,
          },
          fence: { ...fence, attemptId: "attempt-stale" },
          now: new Date("2026-09-22T00:00:01.000Z"),
          sessionId,
          turnId: "1",
        }),
      ).toEqual({ outcome: "stale_epoch" });

      // Rewriting the live attempt's own key with different bytes is refused
      // outright, so the published manifest stays exactly as it was.
      expect(
        await objects.putImmutable(request.request.manifestRef, stale.bytes),
      ).toMatchObject({ outcome: "conflict" });
      expect(store.pointer()).toMatchObject({ manifestSha256: first.sha256 });

      const plan = await service.getRestorePlan({ runtime, sessionId });
      if (plan.status !== "ready")
        throw new Error(`expected a plan: ${plan.status}`);
      expect(plan.plan.resume).toBe(engineSession);
      expect(plan.plan.gitCommit).toBe(gitCommit);
      expect(plan.plan.revision).toBe(0);
      // The restore plan names the parts captured at revision 0 and nothing the
      // mirror wrote afterwards, even though those objects exist.
      expect(plan.plan.objectKeys).toEqual(
        first.manifest.transcripts.root.parts
          .map((part) => part.key)
          .concat(
            Object.values(first.manifest.transcripts.subagents).flatMap(
              (revision) => revision.parts.map((part) => part.key),
            ),
          )
          .concat(bundleKeyFor(0, attemptId)),
      );
      // The plan says where the commit comes from, so a worker restoring it
      // never has to reach for a remote that may have moved on.
      expect(
        plan.plan.artifacts.find(
          (artifact) => artifact.kind === "workspace_bundle",
        ),
      ).toEqual({
        kind: "workspace_bundle",
        label: "",
        objects: [bundleRefFor(0, attemptId)],
      });
      const rootArtifact = plan.plan.artifacts[0];
      if (rootArtifact === undefined)
        throw new Error("expected a root artifact");
      expect(
        await mirror.loadRevision({
          entryCount: first.manifest.transcripts.root.entryCount,
          parts: rootArtifact.objects,
          sha256: first.manifest.transcripts.root.sha256,
        }),
      ).toEqual([entry("r1", "first turn")]);
    }, 30_000);

    test("a resumed generation's checkpoint carries the parts it adopted, and none a zombie wrote later", async () => {
      const objects = await createObjects();
      const live = { attemptId };
      const store = memoryCheckpointStore(live);
      const service = createCheckpointService({
        codecs: { claude: claudeCheckpointCodec },
        // The mirror does not record part versions yet.
        objectProtection: "unversioned",
        newPublishId: () => PUBLISH_ID,
        objects,
        store,
        workspaceBundles: structuralBundleVerifier,
      });
      const prefix = `sessions/${sessionId}/mirror`;
      const root = { projectKey, sessionId: engineSession };
      const subagent = { ...root, subpath: "agents/reviewer" };
      await objects.putImmutable(
        bundleKeyFor(0, attemptId),
        workspaceBundle.bytes,
      );
      await objects.putImmutable(
        bundleKeyFor(1, "attempt-2"),
        workspaceBundle.bytes,
      );

      const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
      await first.append(root, [entry("r1", "first turn")]);
      await first.append(subagent, [entry("s1", "review")]);
      const committed = await publish(first, 0, engineSession);
      await objects.putImmutable(
        manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID),
        committed.bytes,
      );
      expect(
        await finalizeCheckpoint(service, store.commit, {
          checkpoint: {
            manifest_ref: manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID),
            manifest_sha256: committed.sha256,
            revision: 0,
          },
          fence,
          now: new Date("2026-09-22T00:00:00.000Z"),
          sessionId,
          turnId: "1",
        }),
      ).toEqual({ outcome: "committed", revision: 0 });
      // Mirrored after the checkpoint, then the worker lost its lease.
      await first.append(root, [entry("x1", "never committed")]);

      // A new launch restores from the pointer alone: the manifest it names is
      // the only thing it adopts.
      const restore = await service.getRestorePlan({ runtime, sessionId });
      if (restore.status !== "ready") throw new Error(restore.status);
      const manifestBytes = await objects.get(restore.plan.manifestRef);
      if (manifestBytes === undefined) throw new Error("manifest is gone");
      const restored = claudeCheckpointCodec.decode(manifestBytes);
      live.attemptId = "attempt-2";
      const second = new ClaudeSessionStore({
        generation: 2,
        inherit: {
          sessionId: restored.resume,
          transcripts: restored.transcripts,
        },
        objects,
        prefix,
      });
      await first.append(root, [entry("x2", "the old worker, still running")]);
      await second.append(root, [entry("r2", "second turn")]);
      await second.append(subagent, [entry("s2", "second review")]);

      const next = await publish(
        second,
        1,
        engineSession,
        runtime,
        "attempt-2",
      );
      await objects.putImmutable(
        manifestRefFor(sessionId, 1, "attempt-2", PUBLISH_ID),
        next.bytes,
      );
      expect(
        await finalizeCheckpoint(service, store.commit, {
          checkpoint: {
            manifest_ref: manifestRefFor(sessionId, 1, "attempt-2", PUBLISH_ID),
            manifest_sha256: next.sha256,
            revision: 1,
          },
          fence: { ...fence, attemptId: "attempt-2", executionGeneration: 2 },
          now: new Date("2026-09-22T00:00:01.000Z"),
          sessionId,
          turnId: "2",
        }),
      ).toEqual({ outcome: "committed", revision: 1 });

      const plan = await service.getRestorePlan({ runtime, sessionId });
      if (plan.status !== "ready") throw new Error(plan.status);
      expect(plan.plan.revision).toBe(1);
      const [rootArtifact, subagentArtifact] = plan.plan.artifacts;
      if (rootArtifact === undefined || subagentArtifact === undefined) {
        throw new Error("expected root and subagent artifacts");
      }
      // The chain is the part list itself: generation 1's pinned part, then
      // generation 2's.
      expect(
        rootArtifact.objects.map(
          (part) => part.key.match(/\/generation-(\d+)\//)?.[1],
        ),
      ).toEqual(["0000000001", "0000000002"]);
      const reader = new ClaudeSessionStore({ generation: 3, objects, prefix });
      expect(
        await reader.loadRevision({
          ...next.manifest.transcripts.root,
          parts: rootArtifact.objects,
        }),
      ).toEqual([entry("r1", "first turn"), entry("r2", "second turn")]);
      const reviewer = next.manifest.transcripts.subagents["agents/reviewer"];
      if (reviewer === undefined) throw new Error("expected the subagent");
      expect(
        await reader.loadRevision({
          ...reviewer,
          parts: subagentArtifact.objects,
        }),
      ).toEqual([entry("s1", "review"), entry("s2", "second review")]);
    }, 30_000);

    test("refuses to restore a checkpoint a different SDK build wrote", async () => {
      const objects = await createObjects();
      const store = memoryCheckpointStore();
      const service = createCheckpointService({
        codecs: { claude: claudeCheckpointCodec },
        // The mirror does not record part versions yet.
        objectProtection: "unversioned",
        newPublishId: () => PUBLISH_ID,
        objects,
        store,
        workspaceBundles: structuralBundleVerifier,
      });
      const mirror = new ClaudeSessionStore({
        generation: 1,
        objects,
        prefix: `sessions/${sessionId}/mirror`,
      });
      await objects.putImmutable(
        bundleKeyFor(0, attemptId),
        workspaceBundle.bytes,
      );
      await mirror.append({ projectKey, sessionId: engineSession }, [
        entry("r1", "first turn"),
      ]);

      const published = await publish(mirror, 0, engineSession, {
        ...runtime,
        sdkVersion: "0.3.100",
      });
      const ref = manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID);
      await objects.putImmutable(ref, published.bytes);
      await finalizeCheckpoint(service, store.commit, {
        checkpoint: {
          manifest_ref: ref,
          manifest_sha256: published.sha256,
          revision: 0,
        },
        fence,
        now: new Date("2026-09-22T00:00:00.000Z"),
        sessionId,
        turnId: "1",
      });

      expect(await service.getRestorePlan({ runtime, sessionId })).toEqual({
        status: "incompatible",
        code: "INCOMPATIBLE_CHECKPOINT",
        mismatches: [
          {
            expected: runtime.sdkVersion,
            field: "sdkVersion",
            found: "0.3.100",
          },
        ],
      });
    }, 30_000);
  });
}

/** What a worker does at a safe boundary: capture, seal, hand back the bytes. */
async function publish(
  mirror: ClaudeSessionStore,
  revision: number,
  resume: string,
  fingerprint = runtime,
  attempt = attemptId,
) {
  const transcripts = await mirror.captureTranscripts(resume);
  if (transcripts === null) throw new Error("expected transcripts");
  const manifest: CheckpointManifest = {
    createdAt: "2026-09-22T00:00:00.000Z",
    cwd: "/workspace",
    engine: "claude",
    resume,
    revision,
    runtime: fingerprint,
    sessionId,
    transcripts,
    version: 2,
    workspace: {
      bundle: bundleRefFor(revision, attempt),
      gitCommit,
      untracked: [],
    },
  };
  return { ...claudeCheckpointCodec.encode(manifest), manifest };
}
