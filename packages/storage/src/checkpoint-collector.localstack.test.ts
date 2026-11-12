import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  type CheckpointCollectionStore,
  type CheckpointFence,
  type CheckpointPointer,
  type CheckpointStore,
  createCheckpointCollector,
  createCheckpointService,
  manifestRefFor,
  sessionObjectPrefix,
} from "@werft-ai/platform";
import {
  type CommitCheckpoint,
  finalizeCheckpoint,
  structuralBundleVerifier,
} from "@werft-ai/platform/testing/checkpoints";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  ObjectRef,
  RuntimeFingerprint,
} from "@werft-ai/runtime-core";
import { createGitBundle } from "@werft-ai/testkit/git-bundle";
import {
  type LocalstackBucket,
  localstackEnabled,
  withLocalstackBucket,
} from "@werft-ai/testkit/localstack";

import {
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
} from "./checkpoint-objects.ts";

/**
 * Garbage collection against a real Object Lock bucket: what it
 * releases and deletes is gone by version, and what the pointer's restore
 * plan names still reads back held.
 */
const localstack = localstackEnabled() ? describe : describe.skip;

const sessionId = "66666666-6666-4666-8666-666666666666";
const attemptId = "attempt-gc";
const fence: CheckpointFence = {
  attemptId,
  authRevision: 1,
  executionGeneration: 1,
  leaseEpoch: 1,
  sessionId,
};
const runtime: RuntimeFingerprint = {
  cliVersion: "2.1.270",
  engine: "claude",
  profileSha256: "a".repeat(64),
  sdkVersion: "0.3.270",
};
const codec: CheckpointCodec = {
  engine: runtime.engine,
  encode(manifest) {
    const bytes = encode(`${JSON.stringify(manifest)}\n`);
    return { bytes, sha256: sha256(bytes) };
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
  },
  validateCompatibility() {
    return { status: "compatible" };
  },
};
const workspaceBundle = await createGitBundle();

/**
 * Pointer and rows as the database keeps them; no attempt is fenced, and the
 * session runs as `generation.current`.
 */
function memoryStore(
  generation = { current: 1 },
): CheckpointStore & CheckpointCollectionStore & { commit: CommitCheckpoint } {
  let pointer: CheckpointPointer | null = null;
  const rows: CheckpointPointer[] = [];
  return {
    async readPointer() {
      return pointer;
    },
    async listPinnedCommits() {
      return [];
    },
    async listCheckpoints(_session, { belowRevision, limit }) {
      return rows
        .filter((row) => row.revision < belowRevision)
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit);
    },
    async commit(input) {
      const next = (pointer?.revision ?? -1) + 1;
      if (input.checkpoint.revision !== next) {
        return {
          outcome: "conflict",
          currentRevision: pointer?.revision ?? null,
        };
      }
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        manifestVersion: input.checkpoint.manifest_version ?? null,
        parentRevision: pointer?.revision ?? null,
        revision: next,
        turnId: null,
        versionsHeld: input.versionsHeld === true,
      };
      rows.push(pointer);
      return { outcome: "committed", revision: next };
    },
    async readCollectionFences() {
      return {
        executionGeneration: generation.current,
        fallbackRevision: null,
        fencedAttemptIds: new Set(),
      };
    },
    async readPushPinnedRevisions() {
      return [];
    },
    async markCollected() {
      return 0;
    },
    async markPurged() {},
    async listSessionIds({ after }) {
      return after === null ? [sessionId] : [];
    },
    async settleCollection() {
      return false;
    },
  };
}

function setup({ bucket, s3 }: LocalstackBucket) {
  const objects = createCheckpointObjectStore({ bucket, client: s3 });
  const generation = { current: 1 };
  const store = memoryStore(generation);
  const service = createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objects,
    store,
    workspaceBundles: structuralBundleVerifier,
  });
  const collector = createCheckpointCollector({
    codecs: { [runtime.engine]: codec },
    collector: createCheckpointObjectCollector({ bucket, client: s3 }),
    // The pointer and one revision below it: revision 0 of three falls out.
    maxRestoreFallbacks: 1,
    objectProtection: "locked",
    objects,
    store,
  });
  return { collector, generation, objects, service, store };
}

async function upload(
  objects: CheckpointObjectStore,
  key: string,
  bytes: Uint8Array,
): Promise<ObjectRef> {
  const result = await objects.putImmutable(key, bytes);
  if (result.outcome === "conflict" || result.version === undefined) {
    throw new Error(`upload of ${key} did not land with a version`);
  }
  return {
    bytes: bytes.byteLength,
    key,
    sha256: sha256(bytes),
    version: result.version,
  };
}

async function publish(
  objects: CheckpointObjectStore,
  revision: number,
  parts: readonly ObjectRef[],
) {
  const manifestRef = manifestRefFor(
    sessionId,
    revision,
    attemptId,
    String(revision + 1).padStart(32, "0"),
  );
  const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle = await upload(
    objects,
    `${directory}workspace.bundle`,
    workspaceBundle.bytes,
  );
  const notes = await upload(
    objects,
    `${directory}untracked/notes`,
    encode(`notes ${revision}\n`),
  );
  const encoded = codec.encode({
    createdAt: "2026-09-24T00:00:00.000Z",
    cwd: "/workspace",
    engine: runtime.engine,
    resume: `engine-session-${revision}`,
    revision,
    runtime,
    sessionId,
    transcripts: {
      root: { entryCount: parts.length, parts, sha256: "c".repeat(64) },
      subagents: {},
    },
    version: 2,
    workspace: {
      bundle,
      gitCommit: workspaceBundle.commit,
      untracked: [{ ...notes, path: "notes.md" }],
    },
  });
  const manifest = await upload(objects, manifestRef, encoded.bytes);
  return {
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      manifest_version: manifest.version as string,
      revision,
    },
    versions: [manifest, bundle, notes].map(({ key, version }) => ({
      key,
      version: version as string,
    })),
  };
}

function finalize(
  service: ReturnType<typeof createCheckpointService>,
  store: ReturnType<typeof memoryStore>,
  checkpoint: Awaited<ReturnType<typeof publish>>["checkpoint"],
) {
  return finalizeCheckpoint(service, store.commit, {
    checkpoint,
    fence,
    now: new Date(),
    sessionId,
    turnId: null,
  });
}

/** The S3 error a version-specific GET answers, or "ok". */
async function getVersion(
  bucket: LocalstackBucket,
  entry: { key: string; version: string },
): Promise<string> {
  try {
    await bucket.s3.send(
      new GetObjectCommand({
        Bucket: bucket.bucket,
        Key: entry.key,
        VersionId: entry.version,
      }),
    );
    return "ok";
  } catch (error) {
    return (error as { name?: string }).name ?? String(error);
  }
}

async function plannedVersions(
  service: ReturnType<typeof createCheckpointService>,
) {
  const plan = await service.getRestorePlan({ runtime, sessionId });
  if (plan.status !== "ready") throw new Error(JSON.stringify(plan));
  return [
    { key: plan.plan.manifestRef, version: plan.plan.manifestVersion },
    ...plan.plan.artifacts.flatMap((artifact) => artifact.objects),
  ].map(({ key, version }) => ({ key, version: version as string }));
}

localstack("checkpoint garbage collection on an Object Lock bucket", () => {
  test("revision 0 goes after 0 → 1 → 2; revision 2's plan reads back held, shared transcript parts included", async () => {
    await withLocalstackBucket(
      async (bucket) => {
        const { collector, objects, service, store } = setup(bucket);
        const part = await upload(
          objects,
          `${sessionObjectPrefix(sessionId)}transcripts/generation-0000000001/part-0.jsonl`,
          encode('{"type":"user","uuid":"u0"}\n'),
        );
        const revisions = [];
        for (const revision of [0, 1, 2]) {
          const published = await publish(objects, revision, [part]);
          expect(await finalize(service, store, published.checkpoint)).toEqual({
            outcome: "committed",
            revision,
          });
          revisions.push(published);
        }

        expect(
          await collector.collectSession(sessionId, { dryRun: false }),
        ).toEqual({ status: "collected", kept: 7, purged: 3 });

        for (const entry of revisions[0]?.versions ?? []) {
          expect(await getVersion(bucket, entry)).toBe("NoSuchVersion");
        }
        const planned = await plannedVersions(service);
        expect(planned).toContainEqual({
          key: part.key,
          version: part.version as string,
        });
        for (const entry of planned) {
          expect(await getVersion(bucket, entry)).toBe("ok");
          expect(await objects.head(entry.key, entry.version)).toMatchObject({
            held: true,
          });
        }
      },
      { objectLock: true, prefix: "checkpoint-gc-it" },
    );
  }, 60_000);

  test("a collection between a finalize's holds and its CAS leaves the committed checkpoint whole", async () => {
    await withLocalstackBucket(
      async (bucket) => {
        const { collector, objects, service, store } = setup(bucket);
        const part = await upload(
          objects,
          `${sessionObjectPrefix(sessionId)}transcripts/generation-0000000001/part-0.jsonl`,
          encode('{"type":"user","uuid":"u0"}\n'),
        );
        await finalize(
          service,
          store,
          (await publish(objects, 0, [part])).checkpoint,
        );
        const next = await publish(objects, 1, [part]);

        expect(
          await service.verifyAttemptManifest({
            checkpoint: next.checkpoint,
            fence,
          }),
        ).toMatchObject({ status: "verified", versionsHeld: true });
        await collector.collectSession(sessionId, { dryRun: false });
        expect(
          await store.commit({
            checkpoint: next.checkpoint,
            fence,
            now: new Date(),
            sessionId,
            turnId: null,
            versionsHeld: true,
          }),
        ).toEqual({ outcome: "committed", revision: 1 });

        for (const entry of await plannedVersions(service)) {
          expect(await objects.head(entry.key, entry.version)).toMatchObject({
            held: true,
          });
        }
      },
      { objectLock: true, prefix: "checkpoint-gc-it" },
    );
  }, 60_000);

  test("transcript parts of a generation that can no longer commit go by version unless a kept revision names them", async () => {
    await withLocalstackBucket(
      async (bucket) => {
        const { collector, generation, objects, service, store } =
          setup(bucket);
        const mirror = `${sessionObjectPrefix(sessionId)}transcripts`;
        const part = (name: string, generationDirectory: string) =>
          upload(
            objects,
            `${mirror}/${generationDirectory}/${name}.jsonl`,
            encode(`{"type":"user","uuid":"${generationDirectory}-${name}"}\n`),
          );
        const inherited = await part("part-0", "generation-0000000001");
        const abandoned = await part("part-1", "generation-0000000001");
        expect(
          await finalize(
            service,
            store,
            (await publish(objects, 0, [inherited, abandoned])).checkpoint,
          ),
        ).toMatchObject({ outcome: "committed" });
        const tail = await part("part-2", "generation-0000000001");
        generation.current = 2;
        const own = await part("part-0", "generation-0000000002");
        for (const revision of [1, 2]) {
          const published = await publish(objects, revision, [inherited, own]);
          expect(
            await finalizeCheckpoint(service, store.commit, {
              checkpoint: published.checkpoint,
              fence: { ...fence, executionGeneration: 2 },
              now: new Date(),
              sessionId,
              turnId: null,
            }),
          ).toEqual({ outcome: "committed", revision });
        }

        await collector.collectSession(sessionId, { dryRun: false });

        for (const gone of [abandoned, tail]) {
          expect(
            await getVersion(bucket, {
              key: gone.key,
              version: gone.version as string,
            }),
          ).toBe("NoSuchVersion");
        }
        for (const kept of [inherited, own]) {
          expect(
            await objects.head(kept.key, kept.version as string),
          ).toMatchObject({ held: true });
        }
      },
      { objectLock: true, prefix: "checkpoint-gc-it" },
    );
  }, 60_000);

  test("purge releases a held version before deleting it, and deletes delete markers", async () => {
    await withLocalstackBucket(
      async (bucket) => {
        const objects = createCheckpointObjectStore({
          bucket: bucket.bucket,
          client: bucket.s3,
        });
        const collector = createCheckpointObjectCollector({
          bucket: bucket.bucket,
          client: bucket.s3,
        });
        const held = await upload(objects, "gc/held", encode("held\n"));
        await objects.hold?.(held.key, held.version as string);
        await bucket.s3.send(
          new PutObjectCommand({
            Body: "x",
            Bucket: bucket.bucket,
            Key: "gc/marked",
          }),
        );
        // A key-level delete on a versioned bucket stacks a delete marker.
        await bucket.s3.send(
          new DeleteObjectCommand({ Bucket: bucket.bucket, Key: "gc/marked" }),
        );
        expect(
          (await collector.listVersions("gc/")).map(
            (entry) => entry.deleteMarker,
          ),
        ).toContain(true);

        for (const entry of await collector.listVersions("gc/")) {
          await collector.purge(entry);
        }

        expect(await collector.listVersions("gc/")).toEqual([]);
      },
      { objectLock: true, prefix: "checkpoint-gc-it" },
    );
  }, 60_000);
});

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
