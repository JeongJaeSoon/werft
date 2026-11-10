import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MAX_RESTORE_CONFIGS, type RuntimeConfig } from "@werft-ai/contracts";
import { testSpecSource } from "@werft-ai/db/testing/spec-pins";
import {
  type CheckpointPointer,
  createCheckpointService,
  manifestRefFor,
} from "@werft-ai/platform";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeSessionStore,
  claudeCheckpointCodec,
} from "@werft-ai/runtime-claude";
import type {
  CheckpointManifest,
  CheckpointOutput,
  ObjectRef,
  TranscriptRevision,
} from "@werft-ai/runtime-core";
import { storedOutputs } from "@werft-ai/runtime-core";
import { createGitWorkspaceBundleVerifier } from "@werft-ai/storage";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import {
  createGitBundle,
  createGitBundleChain,
  type GitBundleFixture,
} from "@werft-ai/testkit/git-bundle";
import { testCatalog } from "../apps/control-host/src/test-support/catalog.ts";
import {
  imageClaimFingerprint,
  imageRuntimeOf,
} from "../apps/worker/src/image-runtime.ts";
import {
  type ArchiveRow,
  alternateDigests,
  applyArchiveRepin,
  applyRepin,
  CheckpointPinError,
  type CheckpointRow,
  candidatesDigest,
  captureArchiveObjects,
  captureCheckpointObjects,
  claimedSessionOf,
  describeMismatches,
  legacyConfigKey,
  manifestBindingProblem,
  parseImageRuntime,
  pinnedObjectsOf,
  planArchiveRepin,
  planProblems,
  planRepin,
  planRuntime,
  refsOf,
  restoreClaims,
  sealedMatchesCandidates,
  sessionClaim,
  sha256Hex,
} from "../scripts/lib/checkpoint-pins.ts";

/**
 * The checkpoint half of scripts/backup.sh → restore.sh, against
 * in-memory versioned stores standing in for the source and the restored
 * bucket, and a directory standing in for the backup's objects/. The compose
 * round trip itself is the E2E recorded on the PR.
 */

const codecs = { [claudeCheckpointCodec.engine]: claudeCheckpointCodec };

const publishId = () => randomUUID().replaceAll("-", "");

type Seeded = { manifest: CheckpointManifest; row: CheckpointRow };

/** One committed checkpoint as a locked finalize leaves it (seed-checkpoint.ts). */
async function seed(
  objects: MemoryCheckpointObjectStore,
  untracked: readonly { path: string; text: string }[] = [],
  workspaceBundle?: GitBundleFixture,
  profileSha256 = "0".repeat(64),
  outputFiles: readonly { path: string; text: string }[] = [],
): Promise<Seeded> {
  const sessionId = randomUUID();
  const attemptId = `attempt-${randomUUID().slice(0, 8)}`;
  const engineSession = `sdk-${sessionId.slice(0, 8)}`;
  const mirror = new ClaudeSessionStore({
    generation: 1,
    objects,
    prefix: `sessions/${sessionId}/mirror`,
  });
  const root = { projectKey: "-workspace", sessionId: engineSession };
  await mirror.append(root, [
    { type: "user", uuid: randomUUID(), message: { content: "hi" } },
  ]);
  await mirror.append({ ...root, subpath: "agents/a" }, [
    { type: "user", uuid: randomUUID(), message: { content: "sub" } },
  ]);
  const captured = await mirror.captureTranscripts(engineSession);
  if (captured === null) throw new Error("not captured");
  const withVersion = async <T extends ObjectRef>(ref: T): Promise<T> => ({
    ...ref,
    version: (await objects.head(ref.key))?.version,
  });
  const pin = async (revision: TranscriptRevision) => ({
    ...revision,
    parts: await Promise.all(revision.parts.map(withVersion)),
  });
  const manifestRef = manifestRefFor(sessionId, 0, attemptId, publishId());
  const prefix = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle =
    workspaceBundle ?? (await createGitBundle({ message: sessionId }));
  const bundlePut = await objects.putImmutable(
    `${prefix}workspace.bundle`,
    bundle.bytes,
  );
  const files = [];
  for (const file of untracked) {
    const bytes = new TextEncoder().encode(file.text);
    const key = `${prefix}untracked/${file.path}`;
    const put = await objects.putImmutable(key, bytes);
    files.push({
      bytes: bytes.byteLength,
      key,
      path: file.path,
      sha256: sha256Hex(bytes),
      ...(put.outcome === "created" ? { version: put.version } : {}),
    });
  }
  const outputs: CheckpointOutput[] = [];
  for (const file of outputFiles) {
    const bytes = new TextEncoder().encode(file.text);
    const digest = sha256Hex(bytes);
    const key = `${prefix}outputs/${digest}`;
    const put = await objects.putImmutable(key, bytes);
    outputs.push({
      bytes: bytes.byteLength,
      key,
      path: file.path,
      sha256: digest,
      ...(put.outcome === "created" ? { version: put.version } : {}),
    });
  }
  // An omitted output is listed but has no object to back up.
  if (outputs.length > 0) {
    outputs.push({
      bytes: 1 << 30,
      omitted: "too_large",
      path: "out/huge.bin",
    });
  }
  const manifest: CheckpointManifest = {
    createdAt: new Date(0).toISOString(),
    cwd: "/workspace",
    engine: "claude",
    resume: engineSession,
    revision: 0,
    runtime: { ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256 },
    ...(outputs.length === 0 ? {} : { outputs }),
    sessionId,
    transcripts: {
      root: await pin(captured.root),
      subagents: Object.fromEntries(
        await Promise.all(
          Object.entries(captured.subagents).map(
            async ([subpath, revision]) => [subpath, await pin(revision)],
          ),
        ),
      ),
    },
    version: 2,
    workspace: {
      bundle: {
        bytes: bundle.bytes.byteLength,
        key: `${prefix}workspace.bundle`,
        sha256: bundle.sha256,
        ...(bundlePut.outcome === "created"
          ? { version: bundlePut.version }
          : {}),
      },
      gitCommit: bundle.commit,
      untracked: files,
    },
  };
  const sealed = claudeCheckpointCodec.encode(manifest);
  const put = await objects.putImmutable(manifestRef, sealed.bytes);
  if (put.outcome !== "created" || put.version === undefined) {
    throw new Error("manifest not created");
  }
  return {
    manifest,
    row: {
      manifestRef,
      manifestSha256: sealed.sha256,
      manifestVersion: put.version,
      revision: 0,
      sessionId,
    },
  };
}

/** `aws s3 sync s3://bucket dir`: every key's current bytes. */
async function syncDown(objects: MemoryCheckpointObjectStore, dir: string) {
  for (const key of objects.keys()) {
    const bytes = await objects.get(key);
    if (bytes === undefined) continue;
    const path = join(dir, key);
    await Bun.write(path, bytes);
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** `aws s3 sync dir s3://bucket`, minus what restore.sh leaves out. */
async function syncUp(
  dir: string,
  objects: MemoryCheckpointObjectStore,
  exclude: ReadonlySet<string>,
) {
  for (const key of await filesUnder(dir)) {
    if (exclude.has(key)) continue;
    await objects.overwrite(
      key,
      new Uint8Array(await readFile(join(dir, key))),
    );
  }
}

/** A restored bucket whose version ids cannot coincide with the source's. */
async function restoredBucket() {
  const objects = createMemoryCheckpointObjectStore({ versioned: true });
  for (let i = 0; i < 50; i += 1) {
    await objects.overwrite(`filler/${i}`, new Uint8Array([i]));
  }
  return objects;
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-pins-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function pointerOf(row: {
  manifestRef: string;
  manifestSha256: string;
  manifestVersion: string;
  revision?: number;
}): CheckpointPointer {
  return {
    committedAt: new Date(0),
    manifestRef: row.manifestRef,
    manifestSha256: row.manifestSha256,
    manifestVersion: row.manifestVersion,
    revision: row.revision ?? 0,
    turnId: null,
    versionsHeld: true,
  };
}

async function restorePlan(
  objects: MemoryCheckpointObjectStore,
  pointer: CheckpointPointer,
  seeded: Seeded,
  runtime = seeded.manifest.runtime,
  alternateProfileSha256s?: readonly string[],
) {
  const service = createCheckpointService({
    codecs,
    objectProtection: "locked",
    objects,
    store: {
      listCheckpoints: async () => [],
      readPointer: async () => pointer,
    },
    workspaceBundles: createGitWorkspaceBundleVerifier(),
  });
  return service.getRestorePlan({
    runtime,
    ...(alternateProfileSha256s === undefined
      ? {}
      : { alternateProfileSha256s }),
    sessionId: seeded.row.sessionId,
  });
}

describe("backup → restore re-pin", () => {
  test("the restored checkpoint is ready under locked, on new versions, all held", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "notes.txt", text: "n" }]);
      await syncDown(source, dir);
      const capture = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(capture.replaced).toEqual([]);

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      expect(row.previousSha256).toBe(seeded.row.manifestSha256);
      expect(row.manifestSha256).not.toBe(seeded.row.manifestSha256);

      const bytes = await restored.get(
        seeded.row.manifestRef,
        row.manifestVersion,
      );
      if (bytes === undefined) throw new Error("manifest not written");
      expect(sha256Hex(bytes)).toBe(row.manifestSha256);
      const manifest = claudeCheckpointCodec.decode(bytes);
      const before = refsOf(seeded.manifest);
      const after = refsOf(manifest);
      // Same objects, same bytes, same part-list digests; only the ids moved.
      expect(after.map(({ version: _, ...ref }) => ref)).toEqual(
        before.map(({ version: _, ...ref }) => ref),
      );
      expect(manifest.transcripts.root.sha256).toBe(
        seeded.manifest.transcripts.root.sha256,
      );
      for (const [index, ref] of after.entries()) {
        expect(ref.version).toBeDefined();
        expect(ref.version).not.toBe(before[index]?.version);
        expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
      }
      expect(
        (await restored.head(seeded.row.manifestRef, row.manifestVersion))
          ?.held,
      ).toBe(true);

      const result = await restorePlan(
        restored,
        pointerOf({ ...seeded.row, ...row }),
        seeded,
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.plan.manifestVersion).toBe(row.manifestVersion);
      expect(
        result.plan.artifacts.flatMap((artifact) => artifact.objects),
      ).toEqual(expect.arrayContaining(after));
    });
  });

  test("without the re-pin the backup's versions are not in the restored bucket", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      await syncDown(source, dir);
      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set());
      const result = await restorePlan(
        restored,
        pointerOf({
          ...seeded.row,
          manifestVersion: seeded.row.manifestVersion ?? "",
        }),
        seeded,
      );
      expect(result.status).toBe("unavailable");
    });
  });

  test("backup keeps the pinned bytes of a key overwritten or delete-marked after commit", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "a.txt", text: "pinned" }]);
      const overwritten = seeded.manifest.workspace.untracked[0]?.key ?? "";
      const deleted = seeded.manifest.transcripts.root.parts[0]?.key ?? "";
      await source.overwrite(overwritten, new TextEncoder().encode("tampered"));
      source.remove(deleted);
      await syncDown(source, dir);
      expect(await Bun.file(join(dir, deleted)).exists()).toBe(false);

      const { replaced } = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(replaced).toEqual([deleted, overwritten].sort());
      expect(await readFile(join(dir, overwritten), "utf8")).toBe("pinned");

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(planned).toHaveLength(1);
    });
  });

  test("backup refuses a checkpoint whose pinned version is gone or does not hash", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      const part = seeded.manifest.transcripts.root.parts[0];
      if (part?.version === undefined) throw new Error("no part");
      source.purgeVersion(part.key, part.version);
      await syncDown(source, dir);
      const refused = captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [
          seeded.row,
          { ...seeded.row, revision: 1, manifestSha256: "0".repeat(64) },
        ],
      });
      await expect(refused).rejects.toBeInstanceOf(CheckpointPinError);
      const error = (await refused.catch((e) => e)) as CheckpointPinError;
      expect(error.problems.join("\n")).toContain(
        `${part.key} (version ${part.version}) is missing`,
      );
      expect(error.problems.join("\n")).toContain("hashes to");
    });
  });

  test("a manifest key another checkpoint pins as an object is refused on both sides", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const victim = await seed(source);
      const victimBytes = await source.get(
        victim.row.manifestRef,
        victim.row.manifestVersion ?? undefined,
      );
      if (victimBytes === undefined) throw new Error("no manifest");
      // A second checkpoint whose untracked file is the first one's manifest.
      const borrower = await seed(source);
      const manifest: CheckpointManifest = {
        ...borrower.manifest,
        workspace: {
          ...borrower.manifest.workspace,
          untracked: [
            {
              bytes: victimBytes.byteLength,
              key: victim.row.manifestRef,
              path: "m.json",
              sha256: sha256Hex(victimBytes),
              version: victim.row.manifestVersion ?? "",
            },
          ],
        },
      };
      const sealed = claudeCheckpointCodec.encode(manifest);
      const ref = borrower.row.manifestRef.replace("manifest.json", "m2.json");
      const put = await source.putImmutable(ref, sealed.bytes);
      const row: CheckpointRow = {
        ...borrower.row,
        manifestRef: ref,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
      };
      await syncDown(source, dir);
      const rows = [victim.row, row];
      const capture = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows,
      }).catch((e) => e);
      expect(capture).toBeInstanceOf(CheckpointPinError);
      expect(String(capture.message)).toContain("which is the manifest of");

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set(rows.map((r) => r.manifestRef)));
      const plan = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows,
      }).catch((e) => e);
      expect(plan).toBeInstanceOf(CheckpointPinError);
    });
  });

  test("restore refuses before writing when an object is missing, altered, or the manifest key exists", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "u.txt", text: "u" }]);
      await syncDown(source, dir);
      const bundleKey = seeded.manifest.workspace.bundle.key;
      const untrackedKey = seeded.manifest.workspace.untracked[0]?.key ?? "";

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef, bundleKey]));
      await restored.overwrite(untrackedKey, new TextEncoder().encode("x"));
      const before = restored.keys().length;
      const refused = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(refused).toBeInstanceOf(CheckpointPinError);
      const problems = (refused as CheckpointPinError).problems.join("\n");
      expect(problems).toContain(`${bundleKey} is not in the restored bucket`);
      expect(problems).toContain(`${untrackedKey} (version`);
      expect(restored.keys().length).toBe(before);

      const occupied = await restoredBucket();
      await syncUp(dir, occupied, new Set());
      const taken = await planRepin({
        codecs,
        objects: occupied,
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(String(taken.message)).toContain(
        "already exists in the restored bucket",
      );
    });
  });

  test("restore refuses a backup manifest that does not hash to its row", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      await syncDown(source, dir);
      await writeFile(join(dir, seeded.row.manifestRef), "{}");
      const refused = await planRepin({
        codecs,
        objects: await restoredBucket(),
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(String(refused.message)).toContain("hashes to");
    });
  });

  test("every revision of a session is re-pinned, and parts they share get one version", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const first = await seed(source);
      // Revision 1 of the same session: the transcript parts carry over, the
      // bundle is the new attempt's own.
      const attempt = `attempt-${randomUUID().slice(0, 8)}`;
      const manifestRef = manifestRefFor(
        first.row.sessionId,
        1,
        attempt,
        publishId(),
      );
      const bundle = await createGitBundle({ message: "revision 1" });
      const bundleKey = manifestRef.replace(
        "manifest.json",
        "workspace.bundle",
      );
      const bundlePut = await source.putImmutable(bundleKey, bundle.bytes);
      const manifest: CheckpointManifest = {
        ...first.manifest,
        revision: 1,
        workspace: {
          ...first.manifest.workspace,
          bundle: {
            bytes: bundle.bytes.byteLength,
            key: bundleKey,
            sha256: bundle.sha256,
            ...(bundlePut.outcome === "created"
              ? { version: bundlePut.version }
              : {}),
          },
          gitCommit: bundle.commit,
        },
      };
      const sealed = claudeCheckpointCodec.encode(manifest);
      const put = await source.putImmutable(manifestRef, sealed.bytes);
      const second: CheckpointRow = {
        manifestRef,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
        revision: 1,
        sessionId: first.row.sessionId,
      };
      const rows = [first.row, second];
      await syncDown(source, dir);
      await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows,
      });

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set(rows.map((row) => row.manifestRef)));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows,
      });
      const repinned = await applyRepin({ objects: restored, planned });
      expect(repinned.map((row) => row.revision)).toEqual([0, 1]);
      const [older, newer] = planned;
      if (older === undefined || newer === undefined) throw new Error("rows");
      expect(newer.manifest.transcripts.root.parts).toEqual(
        older.manifest.transcripts.root.parts,
      );
      for (const [index, checkpoint] of planned.entries()) {
        const row = repinned[index];
        if (row === undefined) throw new Error("row");
        const bytes = await restored.get(
          checkpoint.row.manifestRef,
          row.manifestVersion,
        );
        expect(bytes && sha256Hex(bytes)).toBe(row.manifestSha256);
        for (const ref of refsOf(checkpoint.manifest)) {
          expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
        }
      }
    });
  });

  test("a checkpoint's stored outputs are captured, re-pinned and held; an omitted one is skipped", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [], undefined, undefined, [
        { path: "out/report.md", text: "# report" },
      ]);
      const stored = (seeded.manifest.outputs ?? []).find(
        (output) => !("omitted" in output),
      );
      if (stored === undefined || "omitted" in stored) {
        throw new Error("no stored output");
      }
      expect(refsOf(seeded.manifest).map((ref) => ref.key)).toContain(
        stored.key,
      );

      await source.overwrite(stored.key, new TextEncoder().encode("tampered"));
      await syncDown(source, dir);
      const { replaced } = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(replaced).toContain(stored.key);
      expect(await readFile(join(dir, stored.key), "utf8")).toBe("# report");
      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      const bytes = await restored.get(
        seeded.row.manifestRef,
        row.manifestVersion,
      );
      if (bytes === undefined) throw new Error("manifest not written");
      const written = claudeCheckpointCodec.decode(bytes);

      const repinned = (written.outputs ?? []).find(
        (output) => !("omitted" in output),
      );
      if (repinned === undefined || "omitted" in repinned) {
        throw new Error("no repinned output");
      }
      expect(repinned.version).toBeDefined();
      expect(repinned.version).not.toBe(stored.version);
      expect(repinned.version).toBe((await restored.head(stored.key))?.version);
      expect((await restored.head(repinned.key, repinned.version))?.held).toBe(
        true,
      );
      expect(written.outputs?.at(-1)).toEqual({
        bytes: 1 << 30,
        omitted: "too_large",
        path: "out/huge.bin",
      });

      const result = await restorePlan(
        restored,
        pointerOf({ ...seeded.row, ...row }),
        seeded,
      );
      expect(result.status).toBe("ready");
    });
  });

  test("verify-restore's plan check reads back and holds a stored output like a transcript part", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [], undefined, undefined, [
        { path: "out/report.md", text: "# report" },
      ]);
      await syncDown(source, dir);
      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      const bytes = await restored.get(
        seeded.row.manifestRef,
        row.manifestVersion,
      );
      if (bytes === undefined) throw new Error("manifest not written");
      const manifest = claudeCheckpointCodec.decode(bytes);
      const result = await restorePlan(
        restored,
        pointerOf({ ...seeded.row, ...row }),
        seeded,
      );
      if (result.status !== "ready") throw new Error(result.status);
      const stored = storedOutputs(manifest.outputs)[0];
      if (stored?.version === undefined) throw new Error("no stored output");

      // The plan's artifacts do not list outputs; the manifest does.
      expect(
        result.plan.artifacts.flatMap((a) => a.objects).map((o) => o.key),
      ).not.toContain(stored.key);
      const pinned = pinnedObjectsOf(result.plan, manifest, bytes);
      expect(pinned.map((o) => o.key)).toContain(stored.key);
      expect(await planProblems(restored, pinned)).toEqual([]);

      restored.releaseHold(stored.key, stored.version);
      expect(await planProblems(restored, pinned)).toEqual([
        `${stored.key} version ${stored.version} is not held`,
      ]);

      restored.purgeVersion(stored.key, stored.version);
      expect(await planProblems(restored, pinned)).toEqual([
        `${stored.key} version ${stored.version} does not read back`,
      ]);
    });
  });

  test("an incremental checkpoint's base bundles are captured, re-pinned and held", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const chain = await createGitBundleChain();
      const first = await seed(source, [], chain.base);
      const base = first.manifest.workspace.bundle;
      // Revision 1 uploads only the tip and names revision 0's bundle, where
      // revision 0 wrote it, as its base.
      const manifestRef = manifestRefFor(
        first.row.sessionId,
        1,
        `attempt-${randomUUID().slice(0, 8)}`,
        publishId(),
      );
      const tipKey = manifestRef.replace("manifest.json", "workspace.bundle");
      const tipPut = await source.putImmutable(tipKey, chain.tip.bytes);
      const incremental: CheckpointManifest = {
        ...first.manifest,
        revision: 1,
        workspace: {
          ...first.manifest.workspace,
          baseBundles: [base],
          bundle: {
            bytes: chain.tip.bytes.byteLength,
            key: tipKey,
            sha256: chain.tip.sha256,
            ...(tipPut.outcome === "created"
              ? { version: tipPut.version }
              : {}),
          },
          gitCommit: chain.tip.commit,
        },
      };
      const sealed = claudeCheckpointCodec.encode(incremental);
      const put = await source.putImmutable(manifestRef, sealed.bytes);
      const second: CheckpointRow = {
        manifestRef,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
        revision: 1,
        sessionId: first.row.sessionId,
      };
      expect(refsOf(incremental).map((ref) => ref.key)).toContain(base.key);

      // Only revision 1 is backed up, as after revision 0 was collected: its
      // base must come from its own manifest. The sync saw the key already
      // overwritten, so only a capture by version keeps the base's bytes.
      await source.overwrite(base.key, new TextEncoder().encode("overwritten"));
      await syncDown(source, dir);
      const { replaced } = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [second],
      });
      expect(replaced).toEqual([base.key]);

      const restored = await restoredBucket();
      await syncUp(
        dir,
        restored,
        new Set([first.row.manifestRef, manifestRef]),
      );
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [second],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      const bytes = await restored.get(manifestRef, row.manifestVersion);
      if (bytes === undefined) throw new Error("manifest not written");
      const written = claudeCheckpointCodec.decode(bytes);
      const [repinnedBase, ...rest] = written.workspace.baseBundles ?? [];
      expect(rest).toEqual([]);
      expect(repinnedBase?.version).toBeDefined();
      expect(repinnedBase?.version).not.toBe(base.version);
      expect(repinnedBase?.version).toBe(
        (await restored.head(base.key))?.version,
      );
      for (const ref of refsOf(written)) {
        expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
      }

      const result = await restorePlan(
        restored,
        pointerOf({ ...second, ...row, revision: 1 }),
        { manifest: incremental, row: second },
      );
      expect(result.status).toBe("ready");
    });
  });
});

describe("archived session events through backup → restore", () => {
  async function archived(objects: MemoryCheckpointObjectStore, text: string) {
    const bytes = new TextEncoder().encode(text);
    const objectKey = `session-archive/${randomUUID()}/events-1-2-${publishId().slice(0, 16)}.jsonl.gz`;
    const put = await objects.putImmutable(objectKey, bytes);
    if (put.version === undefined) throw new Error("no version");
    await objects.hold?.(objectKey, put.version);
    return {
      bytes: bytes.byteLength,
      fromId: 1,
      objectKey,
      sessionId: randomUUID(),
      sha256: sha256Hex(bytes),
      versionId: put.version,
    } satisfies ArchiveRow;
  }

  test("a chunk is captured at its version and re-pinned, held, on the restored bucket", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const row = await archived(source, '{"id":1}\n{"id":2}\n');
      // A later object under the key must not stand in for the pinned one.
      await source.overwrite(row.objectKey, new TextEncoder().encode("other"));
      await syncDown(source, dir);
      const capture = await captureArchiveObjects({
        objects: source,
        objectsDir: dir,
        rows: [row],
      });
      expect(capture.replaced).toEqual([row.objectKey]);

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set());
      const planned = await planArchiveRepin({
        objects: restored,
        rows: [row],
      });
      expect(planned).toHaveLength(1);
      const [plan] = planned;
      if (plan === undefined) throw new Error("no plan");
      expect(plan.version).not.toBe(row.versionId);
      expect((await restored.head(row.objectKey, plan.version))?.held).not.toBe(
        true,
      );
      await applyArchiveRepin({ objects: restored, planned });
      expect((await restored.head(row.objectKey, plan.version))?.held).toBe(
        true,
      );
      const bytes = await restored.get(row.objectKey, plan.version);
      if (bytes === undefined) throw new Error("not restored");
      expect(sha256Hex(bytes)).toBe(row.sha256);
    });
  });

  test("a chunk missing or altered is refused on both sides before anything is held", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const row = await archived(source, '{"id":1}\n');
      await expect(
        captureArchiveObjects({
          objects: source,
          objectsDir: dir,
          rows: [{ ...row, sha256: "0".repeat(64) }],
        }),
      ).rejects.toBeInstanceOf(CheckpointPinError);

      const restored = await restoredBucket();
      await expect(
        planArchiveRepin({ objects: restored, rows: [row] }),
      ).rejects.toBeInstanceOf(CheckpointPinError);
      await restored.overwrite(row.objectKey, new TextEncoder().encode("x"));
      await expect(
        planArchiveRepin({ objects: restored, rows: [row] }),
      ).rejects.toThrow("does not match the row");
    });
  });
});

describe("plans against a target worker image (verify-restore.sh --image)", () => {
  const REPOSITORY_ID = "sample-app";
  const REPOSITORY = {
    url: "https://github.com/acme/sample-app.git",
    branch: "main",
    auth: { kind: "github_app" as const, registered: true as const },
  };
  const catalog = async () =>
    testCatalog({ repositories: { [REPOSITORY_ID]: REPOSITORY } });
  const spec = testSpecSource();
  const sessionOf = async (
    overrides: Partial<Parameters<typeof sessionClaim>[0]> = {},
  ) => ({
    branch: REPOSITORY.branch,
    model: spec.model,
    ownerId: "owner-a",
    spec,
    legacyConfigs: [] as RuntimeConfig[],
    githubAttached: false,
    repoUrl: REPOSITORY.url,
    repositoryId: REPOSITORY_ID,
    repositoryMode: "repository" as const,
    platformPrompt: null,
    ...overrides,
  });
  // What an image's worker would stamp: the output of image-runtime.ts.
  const imageOf = (
    claims: Record<string, unknown>,
    fingerprint?: Parameters<typeof imageRuntimeOf>[1],
  ) => parseImageRuntime(JSON.stringify(imageRuntimeOf(claims, fingerprint)));

  test("the claim is the session's owner and its pinned spec; a session the catalog no longer runs is refused", async () => {
    const resolved = await catalog();
    const claim = sessionClaim(await sessionOf({}), resolved);
    expect(claim.principal).toEqual({ owner_scope: "owner-a" });
    expect(claim.runtime_config).toMatchObject({
      model: spec.model,
      tools: spec.tools,
      permission_mode: spec.permission_mode,
      provider: {
        kind: spec.connection.kind,
        endpoint: spec.connection.endpoint,
      },
    });
    expect(claim).not.toHaveProperty("workspace");
    for (const [overrides, message] of [
      [{ spec: null }, "holds no spec pin"],
      [
        { spec: { ...spec, connection: { ...spec.connection, id: "gone" } } },
        "connection gone of the session's spec is not in the catalog",
      ],
      [
        { spec: { ...spec, model: "claude-retired" } },
        "no longer offers model claude-retired",
      ],
      [{ repoUrl: "https://moved.invalid/app.git" }, "is not in the catalog"],
    ] as const) {
      const session = await sessionOf(
        overrides as Partial<Parameters<typeof sessionClaim>[0]>,
      );
      expect(() => sessionClaim(session, resolved)).toThrow(message);
    }
  });

  test("a session without a repository is asked with its workspace, as the worker's claim carries it", async () => {
    const claim = sessionClaim(
      await sessionOf({
        repositoryMode: "none",
        repositoryId: null,
        repoUrl: null,
        branch: null,
      }),
      await catalog(),
    );
    expect(claim.workspace).toEqual({ repository: null });
  });

  test("a session row's platform prompt rides on every claim of it; a row without one has none", async () => {
    const prompt = { revision: 1, text: "Be brief." };
    const row = {
      id: "s",
      owner_id: "owner-a",
      model: spec.model,
      spec_source: spec,
      legacy_runtime_configs: null,
      release_github: false,
      repo_url: REPOSITORY.url,
      repository_id: REPOSITORY_ID,
      repository_mode: "repository" as const,
      branch: REPOSITORY.branch,
      platform_prompt: prompt,
    };
    const resolved = await catalog();
    expect(
      sessionClaim(claimedSessionOf(row), resolved).runtime_config,
    ).toMatchObject({ platform_prompt: prompt });
    expect(
      sessionClaim(
        claimedSessionOf({ ...row, platform_prompt: null }),
        resolved,
      ).runtime_config,
    ).not.toHaveProperty("platform_prompt");
    // A row whose spec no longer parses holds no pin a claim could run.
    expect(claimedSessionOf({ ...row, spec_source: { nope: 1 } }).spec).toBe(
      null,
    );
  });

  test("the configs a session ran before its model moved are offered as the gateway offers them, under its cap", async () => {
    const resolved = await catalog();
    const base = sessionClaim(await sessionOf({}), resolved).runtime_config;
    const earlier = (model: string): RuntimeConfig => ({ ...base, model });
    const legacyConfigs = Array.from({ length: MAX_RESTORE_CONFIGS + 2 }, (_, i) =>
      earlier(`claude-earlier-${i}`),
    );
    const claims = restoreClaims(
      { ...(await sessionOf({ legacyConfigs })), id: "s" },
      resolved,
    );
    expect(claims.map(([key]) => key)).toEqual(
      Array.from({ length: MAX_RESTORE_CONFIGS }, (_, i) =>
        legacyConfigKey("s", i),
      ),
    );
    expect(claims[0]?.[1].runtime_config.model).toBe("claude-earlier-0");
    // The built-in github server costs one config more on each, and one on
    // the config the session runs.
    const attached = restoreClaims(
      {
        ...(await sessionOf({ legacyConfigs, githubAttached: true })),
        id: "s",
      },
      resolved,
    );
    expect(attached).toHaveLength(Math.floor((MAX_RESTORE_CONFIGS - 1) / 2));
    // The digests the image computes for them are the alternates it offers,
    // one or more for each.
    const image = imageOf(Object.fromEntries(claims));
    for (const [key] of claims) {
      expect(alternateDigests(image, [key]).length).toBeGreaterThan(0);
    }
  });

  test("a checkpoint no plan is asked for matches when its digest is one the image offers", () => {
    const runtime = {
      cliVersion: "2",
      engine: "claude",
      profileSha256: "a".repeat(64),
      sdkVersion: "1",
    };
    const sealed = { ...runtime, profileSha256: "b".repeat(64) };
    expect(sealedMatchesCandidates(sealed, runtime, ["b".repeat(64)])).toEqual({
      ok: true,
    });
    expect(sealedMatchesCandidates(runtime, runtime, [])).toEqual({ ok: true });
    const lost = sealedMatchesCandidates(sealed, runtime, ["c".repeat(64)]);
    expect(lost.ok).toBe(false);
    const rebuilt = sealedMatchesCandidates(
      { ...sealed, sdkVersion: "0" },
      runtime,
      ["b".repeat(64)],
    );
    expect(rebuilt).toMatchObject({ ok: false });
    expect(!rebuilt.ok && rebuilt.detail).toContain("sdkVersion");
    // Order and repeats in what is offered do not move the digest the gate keeps.
    expect(candidatesDigest(runtime, ["c".repeat(64), "b".repeat(64)])).toBe(
      candidatesDigest(runtime, [
        "b".repeat(64),
        "c".repeat(64),
        "b".repeat(64),
      ]),
    );
    expect(candidatesDigest(runtime, [])).not.toBe(
      candidatesDigest(runtime, ["b".repeat(64)]),
    );
  });

  test("an image that resumes an earlier digest scheme offers that scheme's digests too", () => {
    const image = {
      cliVersion: "2",
      engine: "claude",
      sdkVersion: "1",
      profiles: {
        s: {
          profileSha256: "a".repeat(64),
          legacyProfileSha256: "b".repeat(64),
          earlierSchemeProfileSha256s: ["c".repeat(64), "d".repeat(64)],
        },
      },
    };
    expect(alternateDigests(image, ["s"])).toEqual([
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
    ]);
  });

  test("an image of another CLI build makes the plan incompatible", async () => {
    const claim = sessionClaim(await sessionOf({}), await catalog());
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const seeded = await seed(
      objects,
      [],
      undefined,
      imageClaimFingerprint(claim).profileSha256,
    );
    const { sessionId } = seeded.row;
    const other = parseImageRuntime(
      JSON.stringify({
        ...imageRuntimeOf({ [sessionId]: claim }),
        cliVersion: "9.9.9",
      }),
    );

    const result = await restorePlan(
      objects,
      pointerOf({
        ...seeded.row,
        manifestVersion: seeded.row.manifestVersion as string,
      }),
      seeded,
      planRuntime(seeded.manifest.runtime, other, sessionId),
    );
    expect(result.status).toBe("incompatible");
    if (result.status !== "incompatible") return;
    expect(describeMismatches(result.mismatches)).toBe(
      `cliVersion ${CLAUDE_RUNTIME_FINGERPRINT.cliVersion} → 9.9.9`,
    );
  });

  test("a session the image computed no digest for is not asked; no image asks with the sealed runtime", () => {
    const sealed = {
      ...CLAUDE_RUNTIME_FINGERPRINT,
      profileSha256: "a".repeat(64),
    };
    const image = imageOf({ refused: { principal: {} } });
    expect("error" in (image.profiles.refused ?? {})).toBe(true);
    expect(() => planRuntime(sealed, image, "refused")).toThrow(
      "the target image computed no profile digest: claim refused",
    );
    expect(() => planRuntime(sealed, image, "absent")).toThrow(
      "the target image was given no claim for this session",
    );
    expect(planRuntime(sealed, undefined, "any")).toBe(sealed);
  });

  test("an image runtime missing a field or not JSON is refused", () => {
    expect(() => parseImageRuntime("not json")).toThrow("is not JSON");
    expect(() =>
      parseImageRuntime(
        JSON.stringify({ cliVersion: "1", engine: "claude", profiles: {} }),
      ),
    ).toThrow("has no sdkVersion");
    expect(() =>
      parseImageRuntime(JSON.stringify(CLAUDE_RUNTIME_FINGERPRINT)),
    ).toThrow("has no profiles");
    expect(() =>
      parseImageRuntime(
        JSON.stringify({ ...CLAUDE_RUNTIME_FINGERPRINT, profiles: { s: {} } }),
      ),
    ).toThrow("has no profiles");
    expect(() => parseImageRuntime("null")).toThrow("has no cliVersion");
  });
});

describe("the manifest a restore check is recorded against", () => {
  const bytes = new TextEncoder().encode("manifest");

  test("bytes that hash to the recorded value are bound to it", () => {
    expect(manifestBindingProblem(bytes, sha256Hex(bytes))).toBeNull();
  });

  test("other bytes under the same key are named, so no ok is kept for the row", () => {
    const other = new TextEncoder().encode("another manifest");
    expect(manifestBindingProblem(other, sha256Hex(bytes))).toBe(
      `manifest bytes hash to ${sha256Hex(other)}, the row records ${sha256Hex(bytes)}`,
    );
  });
});
