import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MAX_RESTORE_PROFILES } from "@werft-ai/contracts";
import {
  type CatalogProfile,
  type CheckpointPointer,
  catalogRows,
  createCheckpointService,
  type InstallationProfileRecord,
  manifestRefFor,
  parseSeedDocument,
  profileFingerprint,
  profileWithModel,
  withSeededInstallation,
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
import { databaseCatalog } from "../apps/control-host/src/api/catalog-config.ts";
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
  captureArchiveObjects,
  captureCheckpointObjects,
  claimedSessionOf,
  describeMismatches,
  earlierProfileClaims,
  earlierProfileKey,
  ownToolsKey,
  parseImageRuntime,
  pinnedObjectsOf,
  planArchiveRepin,
  planProblems,
  planRepin,
  planRuntime,
  refsOf,
  restoreClaims,
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
  const PROFILE_ID = "claude-coding-real";
  const REPOSITORY_ID = "sample-app";
  const seedDocument = async () => {
    const seed = parseSeedDocument(
      JSON.parse(
        await readFile(
          join(import.meta.dir, "fixtures/settings/real-model.json"),
          "utf8",
        ),
      ),
    );
    if (seed.profiles === null) throw new Error("the fixture seeds no profile");
    return {
      profiles: seed.profiles,
      repositories: seed.entries.repositories,
      connections: seed.entries.connections,
    };
  };
  const seededRows = async () => {
    const { profiles, repositories } = await seedDocument();
    return catalogRows(profiles, repositories);
  };
  // What verify-restore builds: those rows, credentials standing in.
  const catalogOver = async (
    rows: InstallationProfileRecord[],
    env: Record<string, string> = {},
  ) => {
    const { connections, repositories } = await seedDocument();
    return databaseCatalog({
      installations: { listAll: async () => rows },
      workspaces: { listAll: async () => [] },
      repositories: { readCatalog: async () => null },
      settings: {
        read: async () => ({
          generation: 0,
          connections: Object.entries(connections).map(([id, provider]) => ({
            id,
            provider,
          })),
          repositories: Object.entries(repositories).map(
            ([id, repository]) => ({
              id,
              repository,
            }),
          ),
          mcpServers: [],
          stored: new Map(),
          invalid: [],
        }),
      },
      credential: () => "verify-restore-reads-no-credential",
      env,
    });
  };
  const catalog = async () => catalogOver(await seededRows());
  const sessionOf = async (overrides: {
    platformPrompt?: unknown;
    branch?: string;
    model?: string | null;
    profileFingerprint?: string | null;
    profileId?: string | null;
    releaseTools?: readonly string[] | null;
    repositoryId?: string | null;
  }) => {
    const resolved = await catalog();
    const repository = resolved.repositories[REPOSITORY_ID];
    if (repository === undefined) throw new Error("no sample repository");
    const profile = resolved.profiles[PROFILE_ID] as CatalogProfile;
    return {
      branch: repository.branch,
      model: profile.model,
      ownerId: "owner-a",
      profileFingerprint: profileFingerprint(profile),
      profileId: PROFILE_ID,
      repoUrl: repository.url,
      repositoryId: REPOSITORY_ID,
      repositoryMode: "repository" as const,
      releaseTools: null,
      platformPrompt: null,
      ...overrides,
    };
  };
  const changedDigestOf = (digest: string) =>
    sha256Hex(new TextEncoder().encode(`v2:${digest}`));
  // What an image's worker would stamp: the output of image-runtime.ts.
  const imageOf = (
    claims: Record<string, unknown>,
    fingerprint?: Parameters<typeof imageRuntimeOf>[1],
  ) => parseImageRuntime(JSON.stringify(imageRuntimeOf(claims, fingerprint)));

  test("a ceiling the database holds and the settings document never had gives its session a claim", async () => {
    const rows = await seededRows();
    const imported = rows.find((row) => row.id === PROFILE_ID);
    if (imported === undefined) throw new Error("no seeded row");
    const consoleId = "op_restore_v1";
    const resolved = await catalogOver([
      ...rows,
      {
        ...imported,
        id: consoleId,
        name: "restore",
        origin: "console",
        repository_ids: [REPOSITORY_ID],
      },
    ]);
    const profile = resolved.profiles[consoleId] as CatalogProfile;
    expect(profile).toBeDefined();
    const claim = sessionClaim(
      await sessionOf({
        profileId: consoleId,
        profileFingerprint: profileFingerprint(profile),
      }),
      resolved,
    );
    expect(claim).toBeDefined();
  });

  test("a session pinned before its profile's runtime moved gets a claim while the previous worker image is configured", async () => {
    const pinned = await sessionOf({});
    const { profiles, repositories } = await seedDocument();
    const seeded = profiles[PROFILE_ID];
    if (seeded === undefined) throw new Error("no seeded profile");
    const moved = catalogRows(
      { ...profiles, [PROFILE_ID]: { ...seeded, runtime_version: "9.9.9" } },
      repositories,
    );
    const image = (sdkVersion: string) =>
      JSON.stringify({ cliVersion: "2.0.0", engine: "claude", sdkVersion });
    const before = (await catalog()).profiles[PROFILE_ID] as CatalogProfile;
    expect(
      sessionClaim(
        pinned,
        await catalogOver(moved, {
          WORKER_IMAGE_RUNTIME: image("9.9.9"),
          WORKER_IMAGE_PREVIOUS_RUNTIME: image(before.runtime_version),
        }),
      ),
    ).toBeDefined();
    await expect(
      catalogOver(moved).then((resolved) => sessionClaim(pinned, resolved)),
    ).rejects.toThrow("other settings in the catalog");
  });

  test("an image whose profile digest computation changed makes the plan incompatible; the sealing image stays ready", async () => {
    const claim = sessionClaim(await sessionOf({}), await catalog());
    const sealedDigest = imageClaimFingerprint(claim).profileSha256;
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const seeded = await seed(objects, [], undefined, sealedDigest);
    const { sessionId } = seeded.row;
    const pointer = pointerOf({
      ...seeded.row,
      manifestVersion: seeded.row.manifestVersion as string,
    });

    const same = imageOf({ [sessionId]: claim });
    expect(
      (
        await restorePlan(
          objects,
          pointer,
          seeded,
          planRuntime(seeded.manifest.runtime, same, sessionId),
        )
      ).status,
    ).toBe("ready");

    // Same engine build, same claim; only how the digest is computed moved.
    const changed = imageOf({ [sessionId]: claim }, (input) => {
      const current = imageClaimFingerprint(input);
      return {
        ...current,
        profileSha256: changedDigestOf(current.profileSha256),
      };
    });
    const changedDigest = changedDigestOf(sealedDigest);
    const result = await restorePlan(
      objects,
      pointer,
      seeded,
      planRuntime(seeded.manifest.runtime, changed, sessionId),
    );
    expect(result.status).toBe("incompatible");
    if (result.status !== "incompatible") return;
    expect(describeMismatches(result.mismatches)).toBe(
      `profileSha256 ${sealedDigest} → ${changedDigest}`,
    );
  });

  test("a session whose profile was changed is planned with the digest of the profile its checkpoint was made under", async () => {
    const resolved = await catalog();
    const earlierProfile = resolved.profiles[PROFILE_ID] as CatalogProfile;
    const repository = resolved.repositories[REPOSITORY_ID];
    if (repository === undefined) throw new Error("no sample repository");
    const switchedProfile = { ...earlierProfile, model: "claude-haiku-4-5" };
    const switchedCatalog = withSeededInstallation({
      profiles: { ...resolved.profiles, "switch-haiku": switchedProfile },
      repositories: {
        ...resolved.repositories,
        [REPOSITORY_ID]: {
          ...repository,
          profiles: [...repository.profiles, "switch-haiku"],
        },
      },
    });
    const earlierClaim = sessionClaim(await sessionOf({}), switchedCatalog);
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const seeded = await seed(
      objects,
      [],
      undefined,
      imageClaimFingerprint(earlierClaim).profileSha256,
    );
    const { sessionId } = seeded.row;
    const pointer = pointerOf({
      ...seeded.row,
      manifestVersion: seeded.row.manifestVersion as string,
    });
    const key = earlierProfileKey(sessionId, PROFILE_ID);
    const image = imageOf({
      [sessionId]: sessionClaim(
        await sessionOf({
          profileId: "switch-haiku",
          profileFingerprint: profileFingerprint(switchedProfile),
          model: switchedProfile.model,
        }),
        switchedCatalog,
      ),
      [key]: earlierClaim,
    });
    const runtime = planRuntime(seeded.manifest.runtime, image, sessionId);

    expect((await restorePlan(objects, pointer, seeded, runtime)).status).toBe(
      "incompatible",
    );
    expect(
      (
        await restorePlan(
          objects,
          pointer,
          seeded,
          runtime,
          alternateDigests(image, [key]),
        )
      ).status,
    ).toBe("ready");
    expect(alternateDigests(image, [`${sessionId}#gone`])).toEqual([]);
  });

  test("a session row's release tools reach its claims; a row without a release has none", () => {
    const row = {
      platform_prompt: null,
      branch: "main",
      id: "s1",
      model: null,
      owner_id: "owner-a",
      profile_fingerprint: null,
      profile_id: PROFILE_ID,
      release_github: null,
      release_id: "r1",
      release_tools: ["Read"],
      repo_url: null,
      repository_id: REPOSITORY_ID,
      repository_mode: "repository" as const,
    };
    expect(claimedSessionOf(row)).toMatchObject({
      releaseTools: ["Read"],
      githubAttached: false,
    });
    expect(
      claimedSessionOf({ ...row, release_id: null, release_tools: null }),
    ).toMatchObject({ releaseTools: null });
  });

  test("a session row's platform prompt rides on every claim of it; a revision 0 row plans with the digest it had before the column", async () => {
    const prompt = {
      prompt_revision: 1,
      agent_identity: { name: "code-review", description: null },
      origin_surface: "slack_channel",
      language: "ko",
      repository: "acme/app",
    };
    expect(
      claimedSessionOf({
        platform_prompt: prompt,
        branch: "main",
        id: "s1",
        model: null,
        owner_id: "owner-a",
        profile_fingerprint: null,
        profile_id: PROFILE_ID,
        release_github: null,
        release_id: "r1",
        release_tools: ["Read"],
        repo_url: null,
        repository_id: REPOSITORY_ID,
        repository_mode: "repository",
      }).platformPrompt,
    ).toEqual(prompt);

    const resolved = await catalog();
    const base = {
      ...(await sessionOf({ releaseTools: ["Read"] })),
      id: "s1",
      githubAttached: false,
    };
    const prompted = { ...base, platformPrompt: prompt };
    const claims = [
      ["s1", sessionClaim(prompted, resolved)] as const,
      ...restoreClaims(prompted, [], resolved),
    ];
    expect(claims.length).toBeGreaterThan(1);
    for (const [, claim] of claims) {
      expect(claim.runtime_config.platform_prompt).toEqual(prompt);
    }
    const plain = [
      ["s1", sessionClaim(base, resolved)] as const,
      ...restoreClaims(base, [], resolved),
    ];
    expect(
      claims.map(([key, claim]) => {
        const { platform_prompt: _, ...rest } = claim.runtime_config;
        return [key, { ...claim, runtime_config: rest }];
      }),
    ).toEqual(plain);

    // The row's value no longer reaches the image digest (a new launch
    // carries no paragraph), so a checkpoint sealed either way is ready for
    // the image asked with either.
    for (const [sealedWith, other] of [
      [base, prompted],
      [prompted, base],
    ] as const) {
      const objects = createMemoryCheckpointObjectStore({ versioned: true });
      const sealed = sessionClaim(sealedWith, resolved);
      const seeded = await seed(
        objects,
        [],
        undefined,
        imageClaimFingerprint(sealed).profileSha256,
      );
      const { sessionId } = seeded.row;
      const pointer = pointerOf({
        ...seeded.row,
        manifestVersion: seeded.row.manifestVersion as string,
      });
      for (const [claim, status] of [
        [sealed, "ready"],
        [sessionClaim(other, resolved), "ready"],
      ] as const) {
        const runtime = planRuntime(
          seeded.manifest.runtime,
          imageOf({ [sessionId]: claim }),
          sessionId,
        );
        expect(
          (await restorePlan(objects, pointer, seeded, runtime)).status,
        ).toBe(status);
      }
    }
  });

  test("a session runs its release tools and is offered the profile's: a checkpoint made with either is ready", async () => {
    const resolved = await catalog();
    const profile = resolved.profiles[PROFILE_ID] as CatalogProfile;
    const releaseTools = ["Read", "Grep"];
    const session = {
      ...(await sessionOf({ releaseTools })),
      githubAttached: false,
    };
    const runClaim = sessionClaim(session, resolved);
    expect(runClaim.runtime_config.tools).toEqual(releaseTools);
    expect(
      sessionClaim({ ...session, releaseTools: null }, resolved).runtime_config
        .tools,
    ).toEqual(profile.tools);
    // What a checkpoint from before claims ran the release's tools, or from
    // an image rolled back to one whose claims do not, was sealed under.
    const widened = {
      ...runClaim,
      runtime_config: { ...runClaim.runtime_config, tools: profile.tools },
    };
    for (const [sealedClaim, alternatesNeeded] of [
      [widened, true],
      [runClaim, false],
    ] as const) {
      const objects = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(
        objects,
        [],
        undefined,
        imageClaimFingerprint(sealedClaim).profileSha256,
      );
      const { sessionId } = seeded.row;
      const pointer = pointerOf({
        ...seeded.row,
        manifestVersion: seeded.row.manifestVersion as string,
      });
      const other = restoreClaims({ ...session, id: sessionId }, [], resolved);
      expect(
        other.map(([key, claim]) => [key, claim.runtime_config.tools]),
      ).toEqual([[ownToolsKey(sessionId, "profile"), profile.tools]]);
      const image = imageOf({
        [sessionId]: runClaim,
        ...Object.fromEntries(other),
      });
      const runtime = planRuntime(seeded.manifest.runtime, image, sessionId);
      expect(
        (await restorePlan(objects, pointer, seeded, runtime)).status,
      ).toBe(alternatesNeeded ? "incompatible" : "ready");
      expect(
        (
          await restorePlan(
            objects,
            pointer,
            seeded,
            runtime,
            alternateDigests(
              image,
              other.map(([key]) => key),
            ),
          )
        ).status,
      ).toBe("ready");
    }

    // No other list: no release, or one that keeps every profile tool. A
    // release that allows none runs a list of its own.
    const withId = { ...session, id: "s1" };
    expect(
      restoreClaims({ ...withId, releaseTools: null }, [], resolved),
    ).toEqual([]);
    expect(
      restoreClaims({ ...withId, releaseTools: profile.tools }, [], resolved),
    ).toEqual([]);
    expect(
      sessionClaim({ ...withId, releaseTools: [] }, resolved).runtime_config
        .tools,
    ).toEqual([]);
    expect(
      restoreClaims({ ...withId, releaseTools: [] }, [], resolved).map(
        ([, claim]) => claim.runtime_config.tools,
      ),
    ).toEqual([profile.tools]);

    // Earlier profiles: every profile list before any release list, so the
    // cap never drops one a checkpoint from before release lists needs.
    const earlierIds = Array.from({ length: 9 }, (_, n) => `e${n}`);
    const withEarlier = withSeededInstallation({
      ...resolved,
      profiles: {
        ...resolved.profiles,
        ...Object.fromEntries(
          earlierIds.map((id) => [id, { ...profile, model: `model-${id}` }]),
        ),
      },
    });
    const earlier = earlierIds.map((id) => {
      const made = withEarlier.profiles[id] as CatalogProfile;
      return {
        profileId: id,
        profileFingerprint: profileFingerprint(made),
        model: made.model,
      };
    });
    const offered = restoreClaims(
      { ...withId, releaseTools: ["Grep", "Read", "NotInProfile"] },
      earlier,
      withEarlier,
    );
    expect(offered.map(([key]) => key)).toEqual([
      ownToolsKey("s1", "profile"),
      ...earlierIds.map((id) => earlierProfileKey("s1", id)),
      ...earlierIds
        .slice(0, MAX_RESTORE_PROFILES - earlierIds.length - 1)
        .map((id) => `${earlierProfileKey("s1", id)}@release`),
    ]);
    expect(offered.map(([, claim]) => claim.runtime_config.tools)).toEqual([
      profile.tools,
      ...earlierIds.map(() => profile.tools),
      ...Array.from({ length: 6 }, () => ["Read", "Grep"]),
    ]);
    // With the built-in `github` server each list costs the claim two
    // configs, and the one it runs one: only the claims all of whose
    // configs the gateway offers are asked for.
    expect(
      restoreClaims(
        {
          ...withId,
          githubAttached: true,
          releaseTools: ["Grep", "Read"],
        },
        earlier,
        withEarlier,
      ).map(([key]) => key),
    ).toEqual([
      ownToolsKey("s1", "profile"),
      ...earlierIds.slice(0, 7).map((id) => earlierProfileKey("s1", id)),
    ]);
    expect(
      earlierProfileClaims(
        { ...withId, releaseTools: null },
        earlier,
        withEarlier,
      ).map(([key]) => key),
    ).toEqual(earlierIds.map((id) => earlierProfileKey("s1", id)));
  });

  test("earlier profiles are offered as the gateway's claim offers them", async () => {
    const resolved = await catalog();
    const base = resolved.profiles[PROFILE_ID] as CatalogProfile;
    const repository = resolved.repositories[REPOSITORY_ID];
    if (repository === undefined) throw new Error("no sample repository");
    const extra = Array.from({ length: 18 }, (_, n) => `p${n}`);
    const switched = withSeededInstallation({
      profiles: {
        ...resolved.profiles,
        ...Object.fromEntries(
          extra.map((id) => [id, { ...base, model: `model-${id}` }]),
        ),
      },
      // The repository no longer allows the first profile it ran.
      repositories: {
        ...resolved.repositories,
        [REPOSITORY_ID]: { ...repository, profiles: ["p0"] },
      },
    });
    const made = (id: string) => ({
      profileId: id,
      profileFingerprint: profileFingerprint(
        switched.profiles[id] as CatalogProfile,
      ),
      model: (switched.profiles[id] as CatalogProfile).model,
    });
    const session = {
      id: "s1",
      ownerId: "owner-1",
      releaseTools: null,
      repositoryMode: "repository" as const,
    };

    const unpaired = earlierProfileClaims(
      session,
      [made(PROFILE_ID)],
      switched,
    );
    expect(unpaired.map(([key]) => key)).toEqual([
      earlierProfileKey("s1", PROFILE_ID),
    ]);
    expect(unpaired[0]?.[1].principal.owner_scope).toBe("owner-1");

    expect(
      earlierProfileClaims(
        session,
        [
          {
            profileId: PROFILE_ID,
            profileFingerprint: "sha256:other",
            model: null,
          },
          { profileId: "gone", profileFingerprint: "sha256:x", model: null },
        ],
        switched,
      ),
    ).toEqual([]);

    // A checkpoint made on another of the profile's models is offered with
    // that model.
    const offering = {
      ...switched,
      profiles: {
        ...switched.profiles,
        [PROFILE_ID]: { ...base, models: ["model-long"] },
      },
    };
    const onLong = profileWithModel(
      offering.profiles[PROFILE_ID] as CatalogProfile,
      "model-long",
    );
    if (!onLong) throw new Error("the profile offers model-long");
    const longClaims = earlierProfileClaims(
      session,
      [
        {
          profileId: PROFILE_ID,
          profileFingerprint: profileFingerprint(onLong),
          model: "model-long",
        },
      ],
      offering,
    );
    expect(longClaims.map(([, claim]) => claim.runtime_config.model)).toEqual([
      "model-long",
    ]);

    const many = earlierProfileClaims(session, extra.map(made), switched);
    expect(many.map(([key]) => key)).toEqual(
      extra
        .slice(0, MAX_RESTORE_PROFILES)
        .map((id) => earlierProfileKey("s1", id)),
    );
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

  test("the claim is the session's owner and its catalog profile; a pair the catalog no longer allows is refused", async () => {
    const resolved = await catalog();
    const claim = sessionClaim(await sessionOf({}), resolved);
    expect(claim.principal).toEqual({ owner_scope: "owner-a" });
    expect(claim.runtime_config.model).toBe(
      (resolved.profiles[PROFILE_ID] as CatalogProfile).model,
    );
    // Rows without a fingerprint are pinned to the catalog at claim time.
    expect(
      sessionClaim(await sessionOf({ profileFingerprint: null }), resolved),
    ).toEqual(claim);
    for (const overrides of [
      { profileId: "gone" },
      { repositoryId: "gone" },
      { repositoryId: null },
      { branch: "re-pointed" },
    ]) {
      const session = await sessionOf(overrides);
      expect(() => sessionClaim(session, resolved)).toThrow(
        "are not an allowed pair in the catalog",
      );
    }
    const edited = await sessionOf({ profileFingerprint: "sha256:edited" });
    expect(() => sessionClaim(edited, resolved)).toThrow(
      `profile ${PROFILE_ID} has other settings in the catalog than the session was created with`,
    );
    expect(claim).not.toHaveProperty("workspace");
  });

  test("a session without a repository is asked with its workspace, as the worker's claim carries it", async () => {
    const resolved = await catalog();
    const base = resolved.profiles[PROFILE_ID] as CatalogProfile;
    const general: CatalogProfile = {
      ...base,
      repository: "optional",
      project_settings: { claude_md: true },
    };
    const withGeneral = withSeededInstallation({
      ...resolved,
      profiles: { ...resolved.profiles, general },
    });
    const session = {
      branch: null,
      model: general.model,
      ownerId: "owner-a",
      profileFingerprint: profileFingerprint(general),
      profileId: "general",
      repoUrl: null,
      releaseTools: null,
      repositoryId: null,
      repositoryMode: "none" as const,
    };
    const claim = sessionClaim(session, withGeneral);
    expect(claim.workspace).toEqual({ repository: null });
    expect(claim.runtime_config).not.toHaveProperty("project_settings");
    const { workspace: _workspace, ...asRepository } = claim;
    expect(imageClaimFingerprint(claim).profileSha256).not.toBe(
      imageClaimFingerprint(asRepository).profileSha256,
    );
    const [earlier] = earlierProfileClaims(
      {
        id: "s1",
        ownerId: "owner-a",
        releaseTools: null,
        repositoryMode: "none",
      },
      [
        {
          profileId: "general",
          profileFingerprint: profileFingerprint(general),
          model: general.model,
        },
      ],
      withGeneral,
    );
    expect(earlier?.[1]).toEqual(claim);
    expect(() =>
      sessionClaim(
        {
          ...session,
          profileId: PROFILE_ID,
          profileFingerprint: profileFingerprint(base),
        },
        withGeneral,
      ),
    ).toThrow(`profile ${PROFILE_ID} may not run without a repository`);
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
