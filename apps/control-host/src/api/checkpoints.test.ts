import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  CHECKPOINT_OBJECTS_LOST_REASON,
  checkpoints,
  events,
  forgetLostCheckpoints,
  forgetLostCheckpointsAtStart,
  hasUncollectedCheckpoint,
  lostCheckpointNotices,
  OPEN_LOST_CHECKPOINT_SESSIONS_SQL,
  receipts,
  sessions,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import {
  type CheckpointStore,
  manifestRefFor,
  type WorkspaceBundleVerifier,
} from "@werft-ai/platform";
import {
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  type GitCommandRunner,
} from "@werft-ai/storage";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  createGitBundle,
  type GitBundleFixture,
} from "@werft-ai/testkit/git-bundle";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  type ApiCheckpointServiceDependencies,
  assertCheckpointBucketEncryption,
  type CheckpointStorageConfig,
  checkpointGitMemoryBytesFromEnv,
  checkpointObjectsAtStart,
  checkpointStorageConfigFromEnv,
  createApiCheckpointService,
  createApiCheckpoints,
  forgetLostCheckpointObjects,
  MIN_CHECKPOINT_GIT_MEMORY_MB,
} from "./checkpoints.ts";

/**
 * The assembly, not the service: what matters here is which verifier the API
 * hands `createCheckpointService`, so the manifest is the smallest one the
 * service will read as far as the bundle.
 */

const sessionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "attempt-1";
// What `requestCheckpoint` would have minted for the publish these tests upload.
const PUBLISH_ID = "0123456789abcdef0123456789abcdef";
const manifestRef = manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID);
const bundleKey = `${manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1)}workspace.bundle`;

const codecs: ApiCheckpointServiceDependencies["codecs"] = {
  fake: {
    engine: "fake",
    decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    encode: (manifest) => {
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      return { bytes, sha256: sha256(bytes) };
    },
    validateCompatibility: () => ({ status: "compatible" }),
  },
};

const store: CheckpointStore = {
  async readPointer() {
    return null;
  },
  async listCheckpoints() {
    return [];
  },
  async listPinnedCommits() {
    return [];
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let bundle: GitBundleFixture;

beforeAll(async () => {
  bundle = await createGitBundle();
});

async function checkpointWith(bytes: Uint8Array, commit: string) {
  const objects = createMemoryCheckpointObjectStore();
  await objects.overwrite(bundleKey, bytes);
  const manifest = {
    createdAt: "2026-09-23T00:00:00.000Z",
    cwd: "/workspace",
    engine: "fake",
    resume: "r",
    revision: 0,
    runtime: {
      cliVersion: "0",
      engine: "fake",
      profileSha256: "p",
      sdkVersion: "0",
    },
    sessionId,
    transcripts: {
      root: { entryCount: 0, parts: [], sha256: sha256(new Uint8Array()) },
      subagents: {},
    },
    version: 2 as const,
    workspace: {
      bundle: {
        bytes: bytes.byteLength,
        key: bundleKey,
        sha256: sha256(bytes),
      },
      gitCommit: commit,
      untracked: [],
    },
  };
  const codec = codecs.fake;
  if (!codec) throw new Error("fake codec missing");
  const encoded = codec.encode(manifest);
  await objects.overwrite(manifestRef, encoded.bytes);
  return {
    objects,
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      revision: 0,
    },
  };
}

describe("API checkpoint composition", () => {
  test("hands the injected verifier the stored bundle and the pinned commit", async () => {
    const calls: Array<{ bytes: number; commit: string; key: string }> = [];
    const spy: WorkspaceBundleVerifier = {
      async verify({ bytes, commit, key }) {
        calls.push({ bytes, commit, key });
        return { status: "restorable" };
      },
    };
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      objects,
      store,
      workspaceBundles: spy,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
    expect(calls).toEqual([
      { bytes: bundle.bytes.byteLength, commit: bundle.commit, key: bundleKey },
    ]);
  });

  test("by default verifies bundles with git: a real bundle passes", async () => {
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      objects,
      store,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
  });

  test("by default verifies bundles with git: a header that lies about its tip is rejected", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const header = text.slice(0, text.indexOf("\n\n"));
    const commit = "1".repeat(40);
    const bytes = new Uint8Array(bundle.bytes);
    bytes.set(
      new TextEncoder().encode(header.replace(bundle.commit, commit)),
      0,
    );
    const { objects, checkpoint } = await checkpointWith(bytes, commit);
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      objects,
      store,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("rejected");
    if (verdict.status === "rejected") {
      expect(verdict.reason).toContain("git fetch failed");
    }
  });

  test("starts every verifying git under the configured memory cap", async () => {
    const memory: Array<number | undefined> = [];
    const gitRunner: GitCommandRunner = (args, options) => {
      memory.push(options.limits?.memoryBytes);
      return defaultGitRunner(args, options);
    };
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const maxGitMemoryBytes = checkpointGitMemoryBytesFromEnv({
      CHECKPOINT_GIT_MEMORY_MB: "768",
    });
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      gitRunner,
      maxGitMemoryBytes,
      objects,
      store,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
    expect(memory.length).toBeGreaterThan(0);
    expect(new Set(memory)).toEqual(new Set([768 * 1024 * 1024]));
  });

  test("keeps the verifier's default cap when the environment names none", () => {
    expect(checkpointGitMemoryBytesFromEnv({})).toBe(
      DEFAULT_MAX_GIT_MEMORY_BYTES,
    );
    expect(
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: " " }),
    ).toBe(DEFAULT_MAX_GIT_MEMORY_BYTES);
    expect(
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: " 2048 " }),
    ).toBe(2048 * 1024 * 1024);
  });

  test.each([
    "0",
    "-1536",
    "1536.5",
    "1e3",
    "0x600",
    "1.5g",
    "abc",
    String(MIN_CHECKPOINT_GIT_MEMORY_MB - 1),
    "99999999999999",
  ])("refuses CHECKPOINT_GIT_MEMORY_MB=%s at startup", (value) => {
    expect(() =>
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: value }),
    ).toThrow(/^CHECKPOINT_GIT_MEMORY_MB must be a whole number of MiB/);
  });

  test("pins and holds checkpoint objects unless degrading is said out loud", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    const protection = (value?: string) => {
      const config = checkpointStorageConfigFromEnv(
        value === undefined
          ? full
          : { ...full, CHECKPOINT_OBJECT_PROTECTION: value },
      );
      return config === "disabled" ? config : config.protection;
    };
    expect(protection()).toBe("locked");
    expect(protection(" ")).toBe("locked");
    expect(protection("locked")).toBe("locked");
    expect(protection("unversioned")).toBe("unversioned");
    expect(() => protection("off")).toThrow(
      /^CHECKPOINT_OBJECT_PROTECTION must be "locked" \(default\) or "unversioned", not off$/,
    );
  });

  test("enforces the bucket encryption check unless warning is said out loud", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    const check = (value?: string) => {
      const config = checkpointStorageConfigFromEnv(
        value === undefined
          ? full
          : { ...full, CHECKPOINT_OBJECT_ENCRYPTION_CHECK: value },
      );
      return config === "disabled" ? config : config.encryptionCheck;
    };
    expect(check()).toBeUndefined();
    expect(check(" ")).toBeUndefined();
    expect(check("enforce")).toBeUndefined();
    expect(check("warn")).toBe("warn");
    expect(() => check("off")).toThrow(
      /^CHECKPOINT_OBJECT_ENCRYPTION_CHECK must be "enforce" \(default\) or "warn", not off$/,
    );
  });

  test("gives lost checkpoints up at start only on a test installation whose object store is LocalStack", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    const lost = (extra: Record<string, string>) => {
      const config = checkpointStorageConfigFromEnv({ ...full, ...extra });
      return config === "disabled" ? config : config.objectsLost;
    };
    const trial = {
      AWS_ENDPOINT_URL: "http://localstack:4566",
      INSTALLATION_PROFILE: "test",
    };
    expect(lost({})).toBeUndefined();
    expect(lost(trial)).toBeUndefined();
    expect(lost({ ...trial, CHECKPOINT_OBJECTS_LOST: " " })).toBeUndefined();
    expect(lost({ CHECKPOINT_OBJECTS_LOST: "refuse" })).toBeUndefined();
    expect(lost({ ...trial, CHECKPOINT_OBJECTS_LOST: "forget" })).toBe(
      "forget",
    );
    // The Service name as a pod in another namespace reaches it.
    expect(
      lost({
        ...trial,
        AWS_ENDPOINT_URL: "http://localstack.werft.svc.cluster.local:4566",
        CHECKPOINT_OBJECTS_LOST: "forget",
      }),
    ).toBe("forget");
    expect(() => lost({ CHECKPOINT_OBJECTS_LOST: "drop" })).toThrow(
      /^CHECKPOINT_OBJECTS_LOST must be "refuse" \(default\) or "forget", not drop$/,
    );

    // A production installation refuses it, whatever the object store.
    const production =
      /^CHECKPOINT_OBJECTS_LOST=forget gives up lost checkpoints without asking, so it is accepted only on a test installation: INSTALLATION_PROFILE must be test$/;
    for (const profile of [undefined, "", "production"]) {
      expect(() =>
        lost({
          AWS_ENDPOINT_URL: "http://localstack:4566",
          CHECKPOINT_OBJECTS_LOST: "forget",
          ...(profile === undefined ? {} : { INSTALLATION_PROFILE: profile }),
        }),
      ).toThrow(production);
    }
    // So does a test installation on any store that is not LocalStack: AWS
    // itself, another host, or a host that only contains the name.
    const notLocalstack =
      /^CHECKPOINT_OBJECTS_LOST=forget is accepted only when the object store is LocalStack, which empties on a restart: the host of AWS_ENDPOINT_URL must start with the label localstack$/;
    for (const endpoint of [
      undefined,
      "http://minio:9000",
      "https://s3.ap-northeast-1.amazonaws.com",
      "http://my-localstack:4566",
      "http://s3.localstack.example:4566",
    ]) {
      expect(() =>
        lost({
          CHECKPOINT_OBJECTS_LOST: "forget",
          INSTALLATION_PROFILE: "test",
          ...(endpoint === undefined ? {} : { AWS_ENDPOINT_URL: endpoint }),
        }),
      ).toThrow(notLocalstack);
    }
    expect(() => lost({ INSTALLATION_PROFILE: "staging" })).toThrow(
      /^INSTALLATION_PROFILE must be "production" \(default\) or "test", not staging$/,
    );
  });

  test("reads the object store from the environment and refuses a silent absence", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    expect(checkpointStorageConfigFromEnv(full)).toEqual({
      bucket: "claude-sessions",
      credentials: { accessKeyId: "id", secretAccessKey: "s" },
      endpoint: "http://127.0.0.1:4566",
      protection: "locked",
      region: "ap-northeast-1",
    });
    const { AWS_ENDPOINT_URL: _endpoint, ...aws } = full;
    expect(
      checkpointStorageConfigFromEnv({ ...aws, CHECKPOINT_OBJECT_STORE: "s3" }),
    ).not.toHaveProperty("endpoint");
    expect(
      checkpointStorageConfigFromEnv({ CHECKPOINT_OBJECT_STORE: "disabled" }),
    ).toBe("disabled");
    // Disabled has to be said: the missing bucket is a misconfiguration.
    expect(() => checkpointStorageConfigFromEnv({})).toThrow(
      /S3_BUCKET is required/,
    );
    expect(() =>
      checkpointStorageConfigFromEnv({ ...full, S3_BUCKET: " " }),
    ).toThrow(/S3_BUCKET/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "localstack:4566",
      }),
    ).toThrow(/not an http\(s\) URL/);
    // Neither refusal repeats the value: it may carry a credential.
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "ftp://user:hunter2@host",
      }),
    ).toThrow(/^AWS_ENDPOINT_URL is not an http\(s\) URL$/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "http://user:hunter2@host:4566",
      }),
    ).toThrow(/^AWS_ENDPOINT_URL must not carry userinfo$/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        CHECKPOINT_OBJECT_STORE: "memory",
      }),
    ).toThrow(/CHECKPOINT_OBJECT_STORE/);
  });

  test("without static keys leaves the credentials to the default chain, and refuses one key alone", () => {
    const keyless = {
      AWS_REGION: "ap-northeast-1",
      S3_BUCKET: "claude-sessions",
    };
    expect(checkpointStorageConfigFromEnv(keyless)).toEqual({
      bucket: "claude-sessions",
      protection: "locked",
      region: "ap-northeast-1",
    });
    expect(
      checkpointStorageConfigFromEnv({
        ...keyless,
        AWS_ACCESS_KEY_ID: " ",
        AWS_SECRET_ACCESS_KEY: "",
      }),
    ).not.toHaveProperty("credentials");
    // Neither refusal repeats the key that was set.
    expect(() =>
      checkpointStorageConfigFromEnv({ ...keyless, AWS_ACCESS_KEY_ID: "id" }),
    ).toThrow(
      /^AWS_SECRET_ACCESS_KEY is required with AWS_ACCESS_KEY_ID; set both, or neither to use the default AWS credential chain$/,
    );
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...keyless,
        AWS_SECRET_ACCESS_KEY: "s",
      }),
    ).toThrow(/^AWS_ACCESS_KEY_ID is required with AWS_SECRET_ACCESS_KEY;/);
    expect(() =>
      checkpointStorageConfigFromEnv({ S3_BUCKET: "claude-sessions" }),
    ).toThrow(/^AWS_REGION is required/);
  });

  test("without an object store the gateway gets the fail-closed verifier and no protocol", async () => {
    const wired = createApiCheckpoints({} as never, "disabled");
    expect(wired.protocol).toBeUndefined();
    expect(
      await wired.verifier.verify({
        fence: {
          sessionId,
          attemptId,
          leaseEpoch: 0,
          executionGeneration: 0,
          authRevision: 0,
        },
        turnId: "1",
        checkpoint: {
          manifest_ref: manifestRef,
          manifest_sha256: "0".repeat(64),
          revision: 0,
        },
        at: new Date(),
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("without an object store a session has no outputs rather than unreadable ones", async () => {
    const { outputs } = createApiCheckpoints({} as never, "disabled");
    expect(await outputs.readOutputs(sessionId)).toEqual({ status: "none" });
    expect(await outputs.openOutput(sessionId, "out/report.md")).toEqual({
      status: "missing",
    });
  });
});

describe("checkpoint bucket encryption at startup", () => {
  const config: CheckpointStorageConfig = {
    bucket: "claude-sessions",
    protection: "locked",
    region: "ap-northeast-1",
  };
  const bucketEncryptedWith = (algorithm: "none" | "aws:kms" | "AES256") => ({
    async send() {
      if (algorithm === "none") {
        throw Object.assign(new Error("not found"), {
          name: "ServerSideEncryptionConfigurationNotFoundError",
        });
      }
      return {
        ServerSideEncryptionConfiguration: {
          Rules: [
            { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: algorithm } },
          ],
        },
      };
    },
  });
  const run = async (
    algorithm: "none" | "aws:kms" | "AES256",
    target: CheckpointStorageConfig = config,
  ) => {
    const warnings: string[] = [];
    await assertCheckpointBucketEncryption(target, {
      client: bucketEncryptedWith(algorithm),
      warn: (message) => warnings.push(message),
    });
    return warnings;
  };

  test("starts on a bucket that defaults to SSE-S3", async () => {
    expect(await run("AES256")).toEqual([]);
  });

  test("refuses a bucket with no default encryption", async () => {
    await expect(run("none")).rejects.toThrow(
      /^Checkpoint bucket claude-sessions encrypts new objects with none; checkpoints need the bucket default SSE-S3 \(AES256\) \(set CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn to start anyway\)$/,
    );
  });

  test("refuses a bucket that defaults to another algorithm, SSE-KMS included", async () => {
    await expect(run("aws:kms")).rejects.toThrow(
      /encrypts new objects with aws:kms; checkpoints need the bucket default SSE-S3/,
    );
    // Whatever the protection mode: unversioned objects are still stored.
    await expect(
      run("aws:kms", { ...config, protection: "unversioned" }),
    ).rejects.toThrow(/aws:kms/);
  });

  test("the explicit opt-out starts anyway and says why", async () => {
    const warned = { ...config, encryptionCheck: "warn" as const };
    expect(await run("none", warned)).toEqual([
      "Checkpoint bucket claude-sessions encrypts new objects with none; checkpoints need the bucket default SSE-S3 (AES256)",
    ]);
    expect(await run("aws:kms", warned)).toHaveLength(1);
    expect(await run("AES256", warned)).toEqual([]);
  });
});

describe("checkpoint objects present at startup", () => {
  const config: CheckpointStorageConfig = {
    bucket: "claude-sessions",
    protection: "locked",
    region: "ap-northeast-1",
  };
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const sessionId = crypto.randomUUID();
  let listed = 0;
  const bucketListing = (page: Record<string, unknown>) => ({
    async send() {
      listed += 1;
      return page;
    },
  });
  let forgot = 0;
  const run = (page: Record<string, unknown>) =>
    checkpointObjectsAtStart(config, {
      client: bucketListing(page),
      hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
      forget: async () => {
        forgot += 1;
        return { held: [], unchanged: [] };
      },
    });

  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
    });
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("starts without reading the bucket when no checkpoint is left", async () => {
    await run({});
    expect(listed).toBe(0);
  });

  test("refuses an empty bucket, or one of delete markers only, while a checkpoint is left", async () => {
    await db.insert(checkpoints).values({
      sessionId,
      revision: 1,
      manifestRef: "s3://claude-sessions/manifest.json",
      manifestSha256: "sha256",
    });
    const refusal =
      /^Checkpoint bucket claude-sessions holds no object version, but the database still has checkpoints that restores read: .*S3 volume.*older LocalStack.*`scripts\/restore\.sh`.*`scripts\/verify-restore\.sh`.*`scripts\/local\.sh forget-lost-checkpoints`.*`scripts\/local\.sh reset` or `scripts\/local\.sh reset --fake-model`/;
    await expect(run({})).rejects.toThrow(refusal);
    await expect(
      run({ DeleteMarkers: [{ Key: "manifest.json", VersionId: "dm" }] }),
    ).rejects.toThrow(refusal);
    // Refusing is the default: nothing is given up.
    expect(forgot).toBe(0);
  });

  test("starts when the bucket still holds a version", async () => {
    await run({ Versions: [{ Key: "manifest.json", VersionId: "v1" }] });
  });

  test("a collected checkpoint expects nothing in the bucket", async () => {
    await db
      .update(checkpoints)
      .set({ collectedAt: new Date() })
      .where(eq(checkpoints.sessionId, sessionId));
    listed = 0;
    await run({});
    expect(listed).toBe(0);
  });
});

describe("forgetting the checkpoints an emptied bucket lost", () => {
  const config: CheckpointStorageConfig = {
    bucket: "claude-sessions",
    protection: "locked",
    region: "ap-northeast-1",
  };
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const restorable = crypto.randomUUID();
  const pausing = crypto.randomUUID();
  const restoresFailed = crypto.randomUUID();
  const closed = crypto.randomUUID();
  const pauseReceipt = crypto.randomUUID();
  let listed = 0;
  const forget = (page: Record<string, unknown>) =>
    forgetLostCheckpointObjects(config, {
      client: {
        async send() {
          listed += 1;
          return page;
        },
      },
      hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
      forget: () => forgetLostCheckpoints(db, new Date()),
    });
  const sessionRow = async (id: string) => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    return row;
  };

  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
    });
    for (const [id, admissionState, restoreFailureCount] of [
      [restorable, "stopped", 0],
      [pausing, "pausing", 0],
      // Its failed restores made retry_restore eligible before the loss.
      [restoresFailed, "recovery_required", 3],
      [closed, "closed", 0],
    ] as const) {
      await db.insert(sessions).values({
        id,
        ownerId: "owner",
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
        status: "stopped",
        admissionState,
        checkpointRevision: 1,
        restoreFailureCount,
        restoreFailureReason: restoreFailureCount > 0 ? "execution_gone" : null,
      });
      await db.insert(checkpoints).values({
        sessionId: id,
        revision: 1,
        manifestRef: `s3://claude-sessions/${id}/manifest.json`,
        manifestSha256: "sha256",
      });
    }
    await db.insert(receipts).values({
      id: pauseReceipt,
      ownerId: "owner",
      operation: "pause",
      targetRef: { session_id: pausing, turn_id: null, request_id: null },
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("changes nothing while the bucket still holds a version", async () => {
    await expect(
      forget({ Versions: [{ Key: "manifest.json", VersionId: "v1" }] }),
    ).rejects.toThrow(
      "Checkpoint bucket claude-sessions still holds object versions, so it did not lose its checkpoints; nothing was changed",
    );
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    expect((await sessionRow(restorable))?.admissionState).toBe("stopped");
  });

  test("on an empty bucket, collects every checkpoint and holds every open session that would restore one", async () => {
    const before = await sessionRow(restorable);
    const lost = await forget({});
    expect([...lost.held].sort()).toEqual(
      [restorable, pausing, restoresFailed].sort(),
    );
    expect(lost.unchanged).toEqual([closed]);
    expect(await hasUncollectedCheckpoint(db)).toBe(false);
    expect(await sessionRow(restorable)).toMatchObject({
      admissionState: "recovery_required",
      status: "failed",
      revision: (before?.revision ?? 0) + 1,
      checkpointRevision: 1,
      // Retired, so no path takes it for a restore point any more.
      contextResetCheckpointRevision: 1,
      contextResetTurnSequence: null,
    });
    // The failed restores were of the retired checkpoint: retry_restore no
    // longer applies.
    for (const id of [pausing, restoresFailed]) {
      expect(await sessionRow(id)).toMatchObject({
        admissionState: "recovery_required",
        contextResetCheckpointRevision: 1,
        restoreFailureCount: 0,
        restoreFailureReason: null,
      });
    }
    const [receipt] = await db
      .select({ status: receipts.status, error: receipts.error })
      .from(receipts)
      .where(eq(receipts.id, pauseReceipt));
    expect(receipt).toEqual({
      status: "failed",
      error: {
        code: "RECOVERY_REQUIRED",
        message:
          "the object store lost the session's checkpoints; an operator recovery decision is required",
      },
    });
    expect((await sessionRow(closed))?.admissionState).toBe("closed");
    const recorded = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, restorable))
      .orderBy(asc(events.id));
    expect(recorded).toEqual([
      {
        type: "system",
        payload: {
          type: "system",
          subtype: CHECKPOINT_OBJECTS_LOST_REASON,
          retired_checkpoint_revision: 1,
        },
      },
      {
        type: "status",
        payload: {
          phase: "failed",
          admission_state: "recovery_required",
          reason: "checkpoint_objects_lost",
        },
      },
    ]);
    // The startup guard now lets the API start on the empty bucket.
    listed = 0;
    await checkpointObjectsAtStart(config, {
      client: {
        async send() {
          listed += 1;
          return {};
        },
      },
      hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
      forget: () => forgetLostCheckpoints(db, new Date()),
    });
    expect(listed).toBe(0);
  });

  test("a second run finds nothing lost and reads no bucket", async () => {
    listed = 0;
    expect(await forget({})).toEqual({ held: [], unchanged: [] });
    expect(listed).toBe(0);
  });
});

describe("checkpoints given up at start (CHECKPOINT_OBJECTS_LOST=forget)", () => {
  const config: CheckpointStorageConfig = {
    bucket: "claude-sessions",
    endpoint: "http://localstack:4566",
    objectsLost: "forget",
    protection: "locked",
    region: "ap-northeast-1",
  };
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const open = crypto.randomUUID();
  const closed = crypto.randomUUID();
  // One listing per look at the bucket: the last one repeats.
  const start = (...pages: Record<string, unknown>[]) => {
    let looks = 0;
    return checkpointObjectsAtStart(config, {
      client: {
        async send() {
          const page = pages[Math.min(looks, pages.length - 1)];
          looks += 1;
          return page ?? {};
        },
      },
      hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
      forget: (stillLost) =>
        forgetLostCheckpointsAtStart(db, new Date(), stillLost),
    });
  };
  const admissionState = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.id, id)))[0]
      ?.admissionState;
  const openCount = async () =>
    (await client.query<{ n: number }>(OPEN_LOST_CHECKPOINT_SESSIONS_SQL))
      .rows[0]?.n;

  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
    });
    for (const [id, state] of [
      [open, "stopped"],
      [closed, "closed"],
    ] as const) {
      await db.insert(sessions).values({
        id,
        ownerId: "owner",
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
        status: "stopped",
        admissionState: state,
        checkpointRevision: 1,
      });
      await db.insert(checkpoints).values({
        sessionId: id,
        revision: 1,
        manifestRef: `s3://claude-sessions/${id}/manifest.json`,
        manifestSha256: "sha256",
      });
    }
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("a bucket that lost only some objects is not forgotten: the API starts as before", async () => {
    // One session's manifest is still there, the other's is gone.
    expect(
      await start({
        Versions: [{ Key: `${closed}/manifest.json`, VersionId: "v1" }],
      }),
    ).toBeUndefined();
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    expect(await admissionState(open)).toBe("stopped");
    expect(await openCount()).toBe(0);
  });

  test("a checkpoint written between the first look and the locks keeps everything", async () => {
    // Empty when the start decided, an object by the time the sessions are
    // locked: an API beside this one committed a checkpoint in between.
    expect(
      await start(
        {},
        { Versions: [{ Key: `${open}/manifest.json`, VersionId: "v2" }] },
      ),
    ).toBeUndefined();
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    expect(await admissionState(open)).toBe("stopped");
    expect(await db.select().from(lostCheckpointNotices)).toHaveLength(0);
  });

  test("a second look the bucket never answers fails the start with nothing given up", async () => {
    let looks = 0;
    await expect(
      checkpointObjectsAtStart(config, {
        client: {
          send() {
            looks += 1;
            // The first look answers "empty"; the second hangs.
            return looks === 1 ? Promise.resolve({}) : new Promise(() => {});
          },
        },
        hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
        forget: (stillLost) =>
          forgetLostCheckpointsAtStart(db, new Date(), stillLost),
        secondLookDeadlineMs: 20,
      }),
    ).rejects.toThrow(
      "Checkpoint bucket claude-sessions did not answer within 20 ms when it was read again before giving up its lost checkpoints; nothing was given up",
    );
    expect(looks).toBe(2);
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    expect(await admissionState(open)).toBe("stopped");
    expect(await db.select().from(lostCheckpointNotices)).toHaveLength(0);
  });

  test("an empty bucket starts: the checkpoints are given up, their sessions wait in recovery_required, and the loss is recorded", async () => {
    expect(await start({})).toEqual({ held: [open], unchanged: [closed] });
    expect(await hasUncollectedCheckpoint(db)).toBe(false);
    expect(await admissionState(open)).toBe("recovery_required");
    expect(await admissionState(closed)).toBe("closed");
    const notices = await db.select().from(lostCheckpointNotices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ closedAt: null, closedBy: null });
    expect([...(notices[0]?.sessionIds ?? [])].sort()).toEqual(
      [open, closed].sort(),
    );
    expect(await openCount()).toBe(2);
  });

  test("the next start, and a second API that starts beside the first, find nothing left and record nothing", async () => {
    expect(await start({})).toBeUndefined();
    expect(
      await forgetLostCheckpointsAtStart(db, new Date(), async () => true),
    ).toEqual({ held: [], unchanged: [] });
    expect(await db.select().from(lostCheckpointNotices)).toHaveLength(1);
  });

  test("a start PostgreSQL picked as a deadlock victim runs again, second look included", async () => {
    const victim = crypto.randomUUID();
    await db.insert(sessions).values({
      id: victim,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${victim}`,
      status: "stopped",
      admissionState: "stopped",
      checkpointRevision: 1,
    });
    await db.insert(checkpoints).values({
      sessionId: victim,
      revision: 1,
      manifestRef: `s3://claude-sessions/${victim}/manifest.json`,
      manifestSha256: "sha256",
    });
    let looks = 0;
    expect(
      await forgetLostCheckpointsAtStart(db, new Date(), async () => {
        looks += 1;
        if (looks === 1) {
          throw Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          });
        }
        return true;
      }),
    ).toEqual({ held: [victim], unchanged: [] });
    expect(looks).toBe(2);
    // The first attempt was rolled back whole: one more row, not two.
    expect(await db.select().from(lostCheckpointNotices)).toHaveLength(2);
    expect(await openCount()).toBe(3);
  });

  test("a closed notice no longer counts", async () => {
    await db.update(lostCheckpointNotices).set({ closedAt: new Date() });
    expect(await openCount()).toBe(0);
  });
});
