import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CheckpointRef } from "@werft-ai/contracts";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  CheckpointOutput,
  ObjectRef,
  RuntimeFingerprint,
  WorkspaceArtifact,
} from "@werft-ai/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import { createGitBundle } from "@werft-ai/testkit/git-bundle";
import {
  type CommitCheckpointInput,
  finalizeCheckpoint,
} from "../testing/checkpoints.ts";
import {
  createCheckpointService,
  manifestRefFor,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";
import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "./ports/checkpoint-store.ts";
import { serviceCheckpointVerifier } from "./ports/checkpoint-verifier.ts";
import { structuralBundleVerifier } from "./ports/workspace-bundle-verifier.ts";

/**
 * what a checkpoint verified is what it restores. Every object is
 * named by version, finalize reads those versions and holds them, and the
 * pointer and the restore plan carry them — so a key overwritten, deleted or
 * reused after the commit changes nothing the session resumes from.
 */

const sessionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "attempt-1";
const PUBLISH_ID = "0123456789abcdef0123456789abcdef";
const prefix = sessionObjectPrefix(sessionId);
const runtime: RuntimeFingerprint = {
  cliVersion: "2.1.270",
  engine: "claude",
  profileSha256: "a".repeat(64),
  sdkVersion: "0.3.270",
};
const fence: CheckpointFence = {
  attemptId,
  authRevision: 1,
  executionGeneration: 1,
  leaseEpoch: 1,
  sessionId,
};

// The service is under test, not a manifest schema: JSON in, JSON out.
const codec: CheckpointCodec = {
  engine: runtime.engine,
  encode(manifest) {
    const text = `${JSON.stringify(manifest)}\n`;
    return { bytes: encode(text), sha256: sha256(encode(text)) };
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
  },
  validateCompatibility() {
    return { status: "compatible" };
  },
};

const workspaceBundle = await createGitBundle();

function attemptDirectory(revision: number): string {
  const ref = manifestRefFor(sessionId, revision, attemptId, PUBLISH_ID);
  return ref.slice(0, ref.lastIndexOf("/") + 1);
}

/** The pointer store, recording the version the way the database does. */
function memoryCheckpointStore() {
  let pointer: CheckpointPointer | null = null;
  const history: CheckpointPointer[] = [];
  let commits = 0;
  const store: CheckpointStore = {
    async readPointer() {
      return pointer;
    },
    async listCheckpoints(_sessionId, { belowRevision, limit }) {
      return history
        .filter((row) => row.revision < belowRevision)
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit);
    },
    async listPinnedCommits() {
      return [];
    },
  };
  async function commit(input: CommitCheckpointInput) {
    if (pointer !== null && input.checkpoint.revision <= pointer.revision) {
      return {
        outcome: "conflict" as const,
        currentRevision: pointer.revision,
      };
    }
    commits += 1;
    pointer = {
      committedAt: input.now,
      manifestRef: input.checkpoint.manifest_ref,
      manifestSha256: input.checkpoint.manifest_sha256,
      manifestVersion: input.checkpoint.manifest_version ?? null,
      revision: input.checkpoint.revision,
      turnId: input.turnId,
      versionsHeld: input.versionsHeld === true,
    };
    history.push(pointer);
    return {
      outcome: "committed" as const,
      revision: input.checkpoint.revision,
    };
  }
  return { commit, commits: () => commits, pointer: () => pointer, store };
}

let objects: MemoryCheckpointObjectStore;
let checkpoints: ReturnType<typeof memoryCheckpointStore>;
let service: ReturnType<typeof createCheckpointService>;

beforeEach(() => {
  objects = createMemoryCheckpointObjectStore({ versioned: true });
  checkpoints = memoryCheckpointStore();
  service = createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objects,
    store: checkpoints.store,
    workspaceBundles: structuralBundleVerifier,
  });
});

/** A worker's upload: create-only, keeping the version the store answered. */
async function upload(key: string, bytes: Uint8Array): Promise<ObjectRef> {
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
  revision: number,
  parts: readonly ObjectRef[],
  edit: (manifest: CheckpointManifest) => CheckpointManifest = (m) => m,
) {
  const directory = attemptDirectory(revision);
  const bundle = await upload(
    `${directory}workspace.bundle`,
    workspaceBundle.bytes,
  );
  const notes = await upload(`${directory}untracked/notes.md`, encode("n\n"));
  const manifest = edit({
    createdAt: "2026-09-23T00:00:00.000Z",
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
  const manifestRef = manifestRefFor(
    sessionId,
    revision,
    attemptId,
    PUBLISH_ID,
  );
  const encoded = codec.encode(manifest);
  const stored = await upload(manifestRef, encoded.bytes);
  return {
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      manifest_version: stored.version as string,
      revision,
    },
    manifest,
  };
}

function finalize(checkpoint: CheckpointRef) {
  return finalizeCheckpoint(service, checkpoints.commit, {
    checkpoint,
    fence,
    now: new Date("2026-09-23T00:00:00.000Z"),
    sessionId,
    turnId: null,
  });
}

function everyRef(manifest: CheckpointManifest): ObjectRef[] {
  return [
    ...manifest.transcripts.root.parts,
    manifest.workspace.bundle,
    ...manifest.workspace.untracked,
  ];
}

describe("locked (the default)", () => {
  test("will not run over a store that cannot hold versions", () => {
    expect(() =>
      createCheckpointService({
        codecs: { [runtime.engine]: codec },
        objects: createMemoryCheckpointObjectStore(),
        store: checkpoints.store,
        workspaceBundles: structuralBundleVerifier,
      }),
    ).toThrow(/objectProtection "locked" needs an object store that can hold/);
  });

  test("records the verified manifest version on the pointer and holds every version the checkpoint names", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint, manifest } = await publish(0, [part]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 0,
    });
    expect(checkpoints.pointer()?.manifestVersion).toBe(
      checkpoint.manifest_version,
    );
    for (const ref of everyRef(manifest)) {
      expect(await objects.head(ref.key, ref.version)).toMatchObject({
        held: true,
        version: ref.version,
      });
    }
    expect(
      await objects.head(checkpoint.manifest_ref, checkpoint.manifest_version),
    ).toMatchObject({ held: true });
  });

  test("the restore plan names the versions finalize verified", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint, manifest } = await publish(0, [part]);
    await finalize(checkpoint);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toEqual({
      status: "ready",
      plan: {
        artifacts: [
          { kind: "transcript_root", label: "", objects: [part] },
          {
            kind: "workspace_bundle",
            label: "",
            objects: [manifest.workspace.bundle],
          },
          {
            kind: "workspace_untracked",
            label: "",
            objects: manifest.workspace.untracked,
          },
        ],
        cwd: "/workspace",
        engine: "claude",
        gitCommit: workspaceBundle.commit,
        manifestRef: checkpoint.manifest_ref,
        manifestSha256: checkpoint.manifest_sha256,
        manifestVersion: checkpoint.manifest_version,
        objectKeys: everyRef(manifest).map((ref) => ref.key),
        resume: "engine-session-0",
        revision: 0,
      },
    });
    for (const ref of everyRef(manifest)) expect(ref.version).toBeString();
  });

  test("a key overwritten, deleted or reused after the commit leaves the plan on the versions it verified", async () => {
    const original = encode("a\n");
    const part = await upload(`${prefix}mirror/part-0.jsonl`, original);
    const { checkpoint, manifest } = await publish(0, [part]);
    await finalize(checkpoint);

    // A privileged overwrite with bytes of the same length, a delete marker,
    // and a create-only write that lands again once the key reads as absent.
    await objects.overwrite(part.key, encode("b\n"));
    await objects.overwrite(checkpoint.manifest_ref, encode("{}\n"));
    const untracked = manifest.workspace.untracked[0] as ObjectRef;
    objects.remove(untracked.key);
    objects.remove(manifest.workspace.bundle.key);
    await objects.putImmutable(manifest.workspace.bundle.key, encode("x"));

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.manifestVersion).toBe(checkpoint.manifest_version);
    expect(result.plan.artifacts[0]?.objects).toEqual([part]);
    // What the worker downloads by those versions is what was verified.
    expect(await objects.get(part.key, part.version)).toEqual(original);
    expect(await objects.get(part.key)).toEqual(encode("b\n"));
  });

  test("a held version cannot be destroyed", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    await finalize(checkpoint);

    expect(() =>
      objects.purgeVersion(part.key, part.version as string),
    ).toThrow(/under a legal hold/);
    expect(await objects.get(part.key, part.version)).toEqual(encode("a\n"));
  });

  test("refuses a checkpoint whose manifest is not named by version", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    const { manifest_version: _version, ...unpinned } = checkpoint;

    expect(await finalize(unpinned)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/is not named by version/),
    });
    expect(checkpoints.commits()).toBe(0);
  });

  test("refuses a manifest naming an object without its version", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { version: _version, ...loose } = part;
    const { checkpoint } = await publish(0, [loose]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(
        new RegExp(`names ${part.key} without a version`),
      ),
    });
    expect(checkpoints.commits()).toBe(0);
    // Nothing was held for a checkpoint that did not verify.
    expect(await objects.head(part.key, part.version)).not.toHaveProperty(
      "held",
    );
  });

  test("refuses a version the store never issued", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [{ ...part, version: "v999" }]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/missing object: .* \(version v999\)/),
    });
  });

  test("a hold that fails leaves the pointer where it was", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    const failing = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objects: {
        ...objects,
        async hold() {
          throw new Error("AccessDenied");
        },
      },
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    await expect(
      finalizeCheckpoint(failing, checkpoints.commit, {
        checkpoint,
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
      }),
    ).rejects.toThrow(/AccessDenied/);
    expect(checkpoints.pointer()).toBeNull();
  });

  test("does not re-read a version the committed pointer already proved, and holds the new ones", async () => {
    const first = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    await finalize((await publish(0, [first])).checkpoint);

    const grown = await upload(`${prefix}mirror/part-1.jsonl`, encode("b\n"));
    const { checkpoint } = await publish(1, [first, grown]);
    objects.resetReads();
    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 1,
    });
    expect(objects.reads()).not.toContain(first.key);
    expect(objects.reads()).toContain(grown.key);
    expect(await objects.head(grown.key, grown.version)).toMatchObject({
      held: true,
    });
  });
});

/**
 * a pointer committed with its versions held vouches that they are
 * still stored and held, so finalize spends requests only on what the turn
 * added — not on every part the session ever wrote.
 */
describe("finalize trusts what a held pointer already proved", () => {
  /** A service over `objects` that records the key of every request. */
  function counting(store: CheckpointStore = checkpoints.store) {
    const calls = {
      head: [] as string[],
      hold: [] as string[],
      stream: [] as string[],
    };
    const hold = objects.hold?.bind(objects) as NonNullable<
      typeof objects.hold
    >;
    const counted: CheckpointObjectStore = {
      ...objects,
      head(key, version) {
        calls.head.push(key);
        return objects.head(key, version);
      },
      hold(key, version) {
        calls.hold.push(key);
        return hold(key, version);
      },
      stream(key, version) {
        calls.stream.push(key);
        return objects.stream(key, version);
      },
    };
    return {
      calls,
      service: createCheckpointService({
        codecs: { [runtime.engine]: codec },
        objects: counted,
        store,
        workspaceBundles: structuralBundleVerifier,
      }),
    };
  }

  function finalizeWith(
    target: ReturnType<typeof createCheckpointService>,
    checkpoint: CheckpointRef,
  ) {
    return finalizeCheckpoint(target, checkpoints.commit, {
      checkpoint,
      fence,
      now: new Date("2026-09-23T00:00:00.000Z"),
      sessionId,
      turnId: null,
    });
  }

  async function parts(from: number, count: number): Promise<ObjectRef[]> {
    const refs: ObjectRef[] = [];
    for (let index = from; index < from + count; index += 1) {
      refs.push(
        await upload(
          `${prefix}mirror/part-${index}.jsonl`,
          encode(`${index}\n`),
        ),
      );
    }
    return refs;
  }

  // Not deduplicated: a second request for the same object is a regression.
  const sorted = (keys: readonly string[]) => [...keys].sort();

  test("requests only the turn's new parts, manifest and bundle, not the 1,000 it inherited", async () => {
    const inherited = await parts(0, 1_000);
    await finalize((await publish(0, inherited)).checkpoint);
    const added = await parts(1_000, 3);
    const { checkpoint, manifest } = await publish(1, [...inherited, ...added]);
    const { calls, service: watched } = counting();

    // The path a turn's finalize (and so an interrupt) takes.
    expect(
      await serviceCheckpointVerifier(watched).verify({
        at: new Date("2026-09-23T00:00:00.000Z"),
        checkpoint,
        fence,
        turnId: "turn-1",
      }),
    ).toMatchObject({ status: "verified", versionsHeld: true });
    const fresh = [
      ...added.map((ref) => ref.key),
      manifest.workspace.bundle.key,
      ...manifest.workspace.untracked.map((ref) => ref.key),
    ];
    expect(sorted(calls.head)).toEqual(
      sorted([...fresh, checkpoint.manifest_ref]),
    );
    expect(sorted(calls.stream)).toEqual(sorted(fresh));
    expect(sorted(calls.hold)).toEqual(
      sorted([...fresh, checkpoint.manifest_ref]),
    );
  });

  test("accepts an exact untracked artifact from the held pointer without reading or holding it again", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const first = await publish(0, [part]);
    await finalize(first.checkpoint);
    const inherited = first.manifest.workspace
      .untracked[0] as WorkspaceArtifact;
    const next = await publish(1, [part], (candidate) => ({
      ...candidate,
      workspace: { ...candidate.workspace, untracked: [inherited] },
    }));
    const { calls, service: watched } = counting();

    expect(await finalizeWith(watched, next.checkpoint)).toEqual({
      outcome: "committed",
      revision: 1,
    });
    expect(calls.head).not.toContain(inherited.key);
    expect(calls.stream).not.toContain(inherited.key);
    expect(calls.hold).not.toContain(inherited.key);
    const plan = await watched.getRestorePlan({ runtime, sessionId });
    if (plan.status !== "ready") throw new Error(plan.status);
    expect(
      plan.plan.artifacts.find(({ kind }) => kind === "workspace_untracked")
        ?.objects,
    ).toEqual([inherited]);
  });

  test("refuses a previous untracked version under a different restore path", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const first = await publish(0, [part]);
    await finalize(first.checkpoint);
    const inherited = first.manifest.workspace
      .untracked[0] as WorkspaceArtifact;
    const next = await publish(1, [part], (candidate) => ({
      ...candidate,
      workspace: {
        ...candidate.workspace,
        untracked: [{ ...inherited, path: "renamed.md" }],
      },
    }));

    expect(
      await service.verifyAttemptManifest({
        checkpoint: next.checkpoint,
        fence,
      }),
    ).toEqual({
      status: "rejected",
      reason: expect.stringMatching(/not under this publish's/),
    });
  });

  test("a pointer that is not the candidate's parent vouches for nothing", async () => {
    const inherited = await parts(0, 5);
    await finalize((await publish(0, inherited)).checkpoint);
    // Revision 2 while the pointer is at 0: revision 1 may commit in between,
    // so revision 0 is not the pointer this candidate would commit after.
    const { checkpoint } = await publish(2, [
      ...inherited,
      ...(await parts(5, 1)),
    ]);
    const { calls, service: watched } = counting();

    expect(
      await watched.verifyAttemptManifest({ checkpoint, fence }),
    ).toMatchObject({ status: "verified" });
    for (const ref of inherited) {
      expect(calls.head).toContain(ref.key);
      expect(calls.stream).toContain(ref.key);
    }
  });

  test("a pointer committed without its versions held vouches for nothing", async () => {
    const inherited = await parts(0, 5);
    const locked = service;
    service = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    await finalize((await publish(0, inherited)).checkpoint);
    service = locked;
    const { checkpoint } = await publish(1, [
      ...inherited,
      ...(await parts(5, 1)),
    ]);
    const { calls, service: watched } = counting();

    expect(await finalizeWith(watched, checkpoint)).toMatchObject({
      outcome: "committed",
    });
    for (const ref of inherited) {
      expect(calls.head).toContain(ref.key);
      expect(calls.stream).toContain(ref.key);
      expect(calls.hold).toContain(ref.key);
    }
  });

  test("a pointer that cannot be read vouches for nothing", async () => {
    const inherited = await parts(0, 5);
    await finalize((await publish(0, inherited)).checkpoint);
    const { checkpoint } = await publish(1, [
      ...inherited,
      ...(await parts(5, 1)),
    ]);
    const { calls, service: watched } = counting({
      ...checkpoints.store,
      async readPointer() {
        throw new Error("connection reset");
      },
    });

    expect(await finalizeWith(watched, checkpoint)).toMatchObject({
      outcome: "committed",
    });
    for (const ref of inherited) {
      expect(calls.head).toContain(ref.key);
      expect(calls.stream).toContain(ref.key);
    }
  });

  test("a pointer whose manifest does not match its digest vouches for nothing", async () => {
    const inherited = await parts(0, 5);
    await finalize((await publish(0, inherited)).checkpoint);
    const { checkpoint } = await publish(1, [
      ...inherited,
      ...(await parts(5, 1)),
    ]);
    const { calls, service: watched } = counting({
      ...checkpoints.store,
      async readPointer(id) {
        const pointer = await checkpoints.store.readPointer(id);
        return pointer && { ...pointer, manifestSha256: "0".repeat(64) };
      },
    });

    expect(await finalizeWith(watched, checkpoint)).toMatchObject({
      outcome: "committed",
    });
    for (const ref of inherited) {
      expect(calls.head).toContain(ref.key);
      expect(calls.stream).toContain(ref.key);
    }
  });

  test("an inherited part named with a different size is checked, not trusted", async () => {
    const [first] = await parts(0, 1);
    const part = first as ObjectRef;
    await finalize((await publish(0, [part])).checkpoint);
    const { checkpoint } = await publish(1, [
      { ...part, bytes: part.bytes + 1 },
    ]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: `manifest object ${part.key} is ${part.bytes} bytes, not ${part.bytes + 1}`,
    });
  });

  test("a trusted part destroyed after the commit fails the restore instead of passing it", async () => {
    const [first] = await parts(0, 1);
    const part = first as ObjectRef;
    await finalize((await publish(0, [part])).checkpoint);
    const added = await parts(1, 1);
    await finalize((await publish(1, [part, ...added])).checkpoint);
    // Only an operator gets here: nothing in the platform releases a version
    // the live pointer names.
    objects.releaseHold(part.key, part.version as string);
    objects.purgeVersion(part.key, part.version as string);

    expect(await service.getRestorePlan({ runtime, sessionId })).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: expect.stringContaining(
        `manifest references a missing object: ${part.key} (version ${part.version})`,
      ),
    });
  });

  test("a trusted part whose hold was lifted is held again before a restore hands it out", async () => {
    const [first] = await parts(0, 1);
    const part = first as ObjectRef;
    await finalize((await publish(0, [part])).checkpoint);
    const added = await parts(1, 1);
    await finalize((await publish(1, [part, ...added])).checkpoint);
    objects.releaseHold(part.key, part.version as string);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({ status: "ready", plan: { revision: 1 } });
    expect(await objects.head(part.key, part.version)).toMatchObject({
      held: true,
    });
  });
});

describe("locked fallback to an earlier revision", () => {
  /**
   * What only garbage collection or a privileged operator can do to a held
   * version: lift the hold, then destroy the version.
   */
  function destroy(ref: ObjectRef) {
    objects.releaseHold(ref.key, ref.version as string);
    objects.purgeVersion(ref.key, ref.version as string);
  }

  async function twoRevisions() {
    const first = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const older = await publish(0, [first]);
    expect(await finalize(older.checkpoint)).toMatchObject({
      outcome: "committed",
    });
    const second = await upload(`${prefix}mirror/part-1.jsonl`, encode("b\n"));
    const newer = await publish(1, [first, second]);
    expect(await finalize(newer.checkpoint)).toMatchObject({
      outcome: "committed",
    });
    return { first, older, second };
  }

  test("restores the earlier revision by the version its row recorded, whatever its key holds now", async () => {
    const { first, older, second } = await twoRevisions();
    destroy(second);
    // The earlier manifest's key is rewritten and its part's key deleted;
    // the versions revision 0 committed are untouched.
    await objects.overwrite(older.checkpoint.manifest_ref, encode("{}\n"));
    objects.remove(first.key);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "ready",
      plan: {
        manifestRef: older.checkpoint.manifest_ref,
        manifestSha256: older.checkpoint.manifest_sha256,
        manifestVersion: older.checkpoint.manifest_version,
        revision: 0,
        fallback: {
          pointerRevision: 1,
          skipped: [
            {
              revision: 1,
              reason: `manifest references a missing object: ${second.key} (version ${second.version})`,
            },
          ],
        },
      },
    });
    if (result.status !== "ready") return;
    expect(result.plan.artifacts[0]?.objects).toEqual([first]);
  });

  test("an earlier revision whose hold was released is not a restore point", async () => {
    const { first, older, second } = await twoRevisions();
    destroy(second);
    // Garbage collection has released revision 0 but not yet deleted it.
    objects.releaseHold(
      older.checkpoint.manifest_ref,
      older.checkpoint.manifest_version,
    );

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
    // Nor does looking at it put the hold back: that would race the delete.
    expect(
      await objects.head(
        older.checkpoint.manifest_ref,
        older.checkpoint.manifest_version,
      ),
    ).not.toHaveProperty("held");
    expect(await objects.head(first.key, first.version)).toMatchObject({
      held: true,
    });
  });

  test("a released hold stops the search instead of reaching further back", async () => {
    const { first, older, second } = await twoRevisions();
    const third = await upload(`${prefix}mirror/part-2.jsonl`, encode("c\n"));
    const newest = await publish(2, [first, second, third]);
    expect(await finalize(newest.checkpoint)).toMatchObject({
      outcome: "committed",
    });
    destroy(third);
    // Revision 1 has been released; revision 0 below it is intact and held,
    // and restoring it would drop a turn for a reason that is not damage.
    objects.releaseHold(second.key, second.version as string);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: expect.stringContaining("earlier revision 1 is refused"),
    });
    expect(
      await objects.head(
        older.checkpoint.manifest_ref,
        older.checkpoint.manifest_version,
      ),
    ).toMatchObject({ held: true });
  });

  test("a version gone from an earlier locked revision stops the search instead of walking past it", async () => {
    const base = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const older = await publish(0, [base]);
    await finalize(older.checkpoint);
    const lost = await upload(`${prefix}mirror/part-1.jsonl`, encode("b\n"));
    const middle = await publish(1, [base, lost]);
    await finalize(middle.checkpoint);
    const last = await upload(`${prefix}mirror/part-2.jsonl`, encode("c\n"));
    const newest = await publish(2, [base, lost, last]);
    expect(await finalize(newest.checkpoint)).toMatchObject({
      outcome: "committed",
    });
    destroy(last);
    // A held version cannot go: this one was released first, and whatever
    // else of revision 1 was released with it is not necessarily the object
    // validation reaches.
    destroy(lost);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: expect.stringContaining(
        `earlier revision 1 is refused, and a refusal is not damage to walk past: manifest references a missing object: ${lost.key} (version ${lost.version})`,
      ),
    });
  });

  test("an earlier revision committed without a manifest version is not a restore point", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const older = await publish(0, [part]);
    const { manifest_version: _version, ...unpinned } = older.checkpoint;
    // As an `unversioned` deployment commits it, straight through the store.
    await checkpoints.commit({
      checkpoint: unpinned,
      fence,
      now: new Date("2026-09-23T00:00:00.000Z"),
      sessionId,
      turnId: null,
    });
    const second = await upload(`${prefix}mirror/part-1.jsonl`, encode("b\n"));
    const newer = await publish(1, [part, second]);
    await finalize(newer.checkpoint);
    destroy(second);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });
});

describe("unversioned", () => {
  test("reads by key, ignores versions a manifest carries, and holds nothing", async () => {
    const plain = createMemoryCheckpointObjectStore();
    objects = plain as MemoryCheckpointObjectStore;
    const degraded = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects: plain,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    const body = encode("a\n");
    await plain.putImmutable(`${prefix}mirror/part-0.jsonl`, body);
    // Versions from a store this one is not — a bucket restored from a
    // backup keeps the manifests but issues every object a new version.
    const part = {
      bytes: body.byteLength,
      key: `${prefix}mirror/part-0.jsonl`,
      sha256: sha256(body),
      version: "from-another-bucket",
    };
    const directory = attemptDirectory(0);
    await plain.putImmutable(
      `${directory}workspace.bundle`,
      workspaceBundle.bytes,
    );
    const manifest: CheckpointManifest = {
      createdAt: "2026-09-23T00:00:00.000Z",
      cwd: "/workspace",
      engine: runtime.engine,
      resume: "engine-session-0",
      revision: 0,
      runtime,
      sessionId,
      transcripts: {
        root: { entryCount: 1, parts: [part], sha256: "c".repeat(64) },
        subagents: {},
      },
      version: 2,
      workspace: {
        bundle: {
          bytes: workspaceBundle.bytes.byteLength,
          key: `${directory}workspace.bundle`,
          sha256: workspaceBundle.sha256,
          version: "from-another-bucket",
        },
        gitCommit: workspaceBundle.commit,
        untracked: [],
      },
    };
    const manifestRef = manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID);
    const encoded = codec.encode(manifest);
    await plain.putImmutable(manifestRef, encoded.bytes);

    expect(
      await finalizeCheckpoint(degraded, checkpoints.commit, {
        checkpoint: {
          manifest_ref: manifestRef,
          manifest_sha256: encoded.sha256,
          manifest_version: "from-another-bucket",
          revision: 0,
        },
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    const result = await degraded.getRestorePlan({ runtime, sessionId });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan).not.toHaveProperty("manifestVersion");
    for (const artifact of result.plan.artifacts) {
      for (const object of artifact.objects) {
        expect(object).not.toHaveProperty("version");
      }
    }
  });
});

describe("unversioned, then locked", () => {
  function unversionedService() {
    return createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
  }

  test("a version an unversioned commit recorded but never read is not trusted once locked", async () => {
    // The key's current bytes are what unversioned verifies; the version the
    // ref names holds different bytes of the same length.
    const key = `${prefix}mirror/part-0.jsonl`;
    const older = await upload(key, encode("a\n"));
    await objects.overwrite(key, encode("b\n"));
    const stranger: ObjectRef = {
      ...older,
      sha256: sha256(encode("b\n")),
    };
    const locked = service;
    service = unversionedService();
    const { checkpoint } = await publish(0, [stranger]);
    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 0,
    });
    expect(checkpoints.pointer()?.manifestVersion).toBe(
      checkpoint.manifest_version,
    );

    const result = await locked.getRestorePlan({ runtime, sessionId });
    expect(result).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: expect.stringContaining(key),
    });
    expect(await objects.head(key, older.version)).not.toHaveProperty("held");
  });

  test("a hold some later candidate placed on the old manifest does not make its versions trusted", async () => {
    const key = `${prefix}mirror/part-0.jsonl`;
    const older = await upload(key, encode("a\n"));
    await objects.overwrite(key, encode("b\n"));
    const stranger: ObjectRef = { ...older, sha256: sha256(encode("b\n")) };
    const locked = service;
    service = unversionedService();
    const { checkpoint: first } = await publish(0, [stranger]);
    await finalize(first);

    // The next candidate names the committed manifest as one of its own
    // untracked files, to have locked verification hold it. Finalize no
    // longer accepts a name in another publish's directory, but
    // the hold can come from elsewhere, and it must not count either.
    const manifestBytes = (await objects.get(
      first.manifest_ref,
      first.manifest_version,
    )) as Uint8Array;
    service = locked;
    const { checkpoint: second } = await publish(1, [], (manifest) => ({
      ...manifest,
      workspace: {
        ...manifest.workspace,
        untracked: [
          ...manifest.workspace.untracked,
          {
            bytes: manifestBytes.byteLength,
            key: first.manifest_ref,
            path: "old-manifest.json",
            sha256: sha256(manifestBytes),
            version: first.manifest_version,
          },
        ],
      },
    }));
    expect(
      await locked.verifyAttemptManifest({ checkpoint: second, fence }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("not under this publish's"),
    });
    await objects.hold?.(first.manifest_ref, first.manifest_version as string);
    expect(checkpoints.pointer()?.revision).toBe(0);

    expect(await locked.getRestorePlan({ runtime, sessionId })).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason: expect.stringContaining(key),
    });
  });

  test("an honest unversioned commit is hashed by version and held before a locked restore hands it out", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const locked = service;
    service = unversionedService();
    const { checkpoint, manifest } = await publish(0, [part]);
    await finalize(checkpoint);
    for (const ref of everyRef(manifest)) {
      expect(await objects.head(ref.key, ref.version)).not.toHaveProperty(
        "held",
      );
    }

    const result = await locked.getRestorePlan({ runtime, sessionId });
    expect(result.status).toBe("ready");
    for (const ref of everyRef(manifest)) {
      expect(await objects.head(ref.key, ref.version)).toMatchObject({
        held: true,
      });
    }
    expect(
      await objects.head(checkpoint.manifest_ref, checkpoint.manifest_version),
    ).toMatchObject({ held: true });
  });
});

describe("outputs", () => {
  async function output(revision: number, body: string, path: string) {
    const bytes = encode(body);
    const ref = await upload(
      `${attemptDirectory(revision)}outputs/${sha256(bytes)}`,
      bytes,
    );
    return { ...ref, path };
  }

  function withOutputs(outputs: readonly CheckpointOutput[]) {
    return (candidate: CheckpointManifest): CheckpointManifest => ({
      ...candidate,
      outputs,
    });
  }

  test("commits stored and too-large outputs and holds each stored version", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const report = await output(0, "# report\n", "out/report.md");
    const { checkpoint } = await publish(
      0,
      [part],
      withOutputs([
        report,
        { bytes: 70_000_000, omitted: "too_large", path: "out/video.mp4" },
      ]),
    );

    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 0,
    });
    expect(await objects.head(report.key, report.version)).toMatchObject({
      held: true,
    });
  });

  test("refuses an output stored outside the session's prefix", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const bytes = encode("stolen\n");
    const foreign = await upload(
      `sessions/55555555-5555-4555-8555-555555555555/checkpoints/0000000000/a/p/outputs/${sha256(bytes)}`,
      bytes,
    );
    const { checkpoint } = await publish(
      0,
      [part],
      withOutputs([{ ...foreign, path: "out/stolen.md" }]),
    );

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/references an object outside sessions\//),
    });
    expect(checkpoints.commits()).toBe(0);
  });

  test("refuses an output whose bytes do not match its digest", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const claimed = sha256(encode("what the worker said\n"));
    const stored = await upload(
      `${attemptDirectory(0)}outputs/${claimed}`,
      encode("what the store holds\n"),
    );
    const { checkpoint } = await publish(
      0,
      [part],
      withOutputs([
        {
          ...stored,
          bytes: encode("what the worker said\n").byteLength,
          path: "out/a.md",
          sha256: claimed,
        },
      ]),
    );

    expect(await finalize(checkpoint)).toMatchObject({
      reason: expect.stringMatching(
        new RegExp(`outputs/${claimed} hashes to [0-9a-f]{64}, not ${claimed}`),
      ),
    });
    expect(checkpoints.commits()).toBe(0);
  });

  test("refuses an output not stored under its own digest", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const bytes = encode("# report\n");
    const elsewhere = await upload(
      `${attemptDirectory(0)}outputs/report.md`,
      bytes,
    );
    const { checkpoint } = await publish(
      0,
      [part],
      withOutputs([{ ...elsewhere, path: "out/report.md" }]),
    );

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(
        /not at a checkpoint directory's outputs\//,
      ),
    });
  });

  test.each([
    ["outside out/", ["notes/a.md"]],
    ["climbing out of the workspace", ["out/../secret"]],
    ["twice", ["out/a.md", "out/a.md"]],
  ])("refuses an output path %s", async (_, paths) => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(
      0,
      [part],
      withOutputs(
        paths.map((path) => ({ bytes: 1, omitted: "too_large", path })),
      ),
    );

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/output/),
    });
  });

  test("inherits the pointer's output by its exact ref, and nothing else from another directory", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const report = await output(0, "# report\n", "out/report.md");
    await finalize(
      (await publish(0, [part], withOutputs([report]))).checkpoint,
    );
    // Same bytes under a new name: the ref is the pointer's, the path is not.
    const renamed = { ...report, path: "out/final.md" };
    const next = await publish(1, [part], withOutputs([renamed]));

    expect(await finalize(next.checkpoint)).toEqual({
      outcome: "committed",
      revision: 1,
    });

    // An object in revision 0's directory the pointer never named.
    const bytes = encode("never committed\n");
    const orphan = await upload(
      `${attemptDirectory(0)}outputs/${sha256(bytes)}`,
      bytes,
    );
    const stray = await publish(
      2,
      [part],
      withOutputs([{ ...orphan, path: "out/orphan.md" }]),
    );
    expect(await finalize(stray.checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/not under this publish's/),
    });
  });
});

describe("reading outputs", () => {
  const tooLarge: CheckpointOutput = {
    bytes: 70_000_000,
    omitted: "too_large",
    path: "out/video.mp4",
  };

  async function commitReport(body = "# report\n") {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const bytes = encode(body);
    const report = {
      ...(await upload(
        `${attemptDirectory(0)}outputs/${sha256(bytes)}`,
        bytes,
      )),
      path: "out/report.md",
    };
    const { checkpoint } = await publish(0, [part], (manifest) => ({
      ...manifest,
      outputs: [report, tooLarge],
    }));
    expect(await finalize(checkpoint)).toMatchObject({ outcome: "committed" });
    return { checkpoint, report };
  }

  async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of body) text += decoder.decode(chunk);
    return text;
  }

  test("a session without a committed checkpoint has none", async () => {
    expect(await service.readOutputs(sessionId)).toEqual({ status: "none" });
    expect(await service.openOutput(sessionId, "out/report.md")).toEqual({
      status: "missing",
    });
  });

  test("lists the pointer's stored and omitted outputs", async () => {
    const { report } = await commitReport();
    expect(await service.readOutputs(sessionId)).toEqual({
      status: "ready",
      revision: 0,
      outputs: [report, tooLarge],
    });
  });

  test("streams a listed output by the version the checkpoint pinned", async () => {
    const { report } = await commitReport();
    // An overwrite after the commit changes what the key reads, not the version.
    await objects.overwrite(report.key, encode("# swapped\n"));

    const opened = await service.openOutput(sessionId, "out/report.md");
    expect(opened).toMatchObject({ status: "ready", output: report });
    if (opened.status !== "ready") return;
    expect(await drain(opened.body)).toBe("# report\n");
  });

  test.each([
    ["omitted", "out/video.mp4"],
    ["not listed", "out/other.md"],
    ["a climbing spelling of a listed path", "out/../out/report.md"],
    ["the storage key", "outputs/report.md"],
  ])("a path %s is missing", async (_, path) => {
    await commitReport();
    expect(await service.openOutput(sessionId, path)).toEqual({
      status: "missing",
    });
  });

  test("a manifest that no longer matches the pointer is unavailable", async () => {
    const { checkpoint } = await commitReport();
    objects.remove(checkpoint.manifest_ref);
    const unversioned = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    expect(await unversioned.readOutputs(sessionId)).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/revision 0 is missing, damaged/),
    });
    expect(
      await unversioned.openOutput(sessionId, "out/report.md"),
    ).toMatchObject({ status: "unavailable" });
  });

  test("an unversioned key overwritten with other bytes ends the stream with an error before its last chunk", async () => {
    const { report } = await commitReport();
    const unversioned = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    // Same length, so only the digest can tell.
    await objects.overwrite(report.key, encode("# Report\n"));

    const opened = await unversioned.openOutput(sessionId, "out/report.md");
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const received: Uint8Array[] = [];
    const reading = (async () => {
      for await (const chunk of opened.body) received.push(chunk);
    })();
    await expect(reading).rejects.toThrow(/hashing to [0-9a-f]{64}, not/);
    expect(received).toEqual([]);
  });

  test("an unversioned key gone after the commit is unavailable", async () => {
    const { report } = await commitReport();
    objects.remove(report.key);
    const unversioned = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    expect(await unversioned.openOutput(sessionId, "out/report.md")).toEqual({
      status: "unavailable",
      reason: `output ${report.key} is not stored`,
    });
  });
});

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
