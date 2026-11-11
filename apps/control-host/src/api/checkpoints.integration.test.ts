import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
} from "@aws-sdk/client-s3";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import { commitCheckpoint } from "@werft-ai/db/testing/checkpoints";
import { launchSession } from "@werft-ai/db/testing/launches";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import {
  type CheckpointService,
  createWorkerGateway,
  manifestRefFor,
  sessionObjectPrefix,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { finalizeCheckpoint } from "@werft-ai/platform/testing/checkpoints";
import {
  installedCheckpointCodecs,
  installedDescriptors,
} from "@werft-ai/runtime-codecs";
import { transcriptDigestFor } from "@werft-ai/runtime-codecs/testing";
import type {
  CheckpointManifest,
  CheckpointObjectStore,
} from "@werft-ai/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
} from "@werft-ai/storage";
import {
  createGitBundle,
  type GitBundleFixture,
} from "@werft-ai/testkit/git-bundle";
import {
  createLocalstackBucket,
  type LocalstackBucket,
  localstackEnabled,
} from "@werft-ai/testkit/localstack";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { testCatalog } from "../testing/catalog.ts";
import { releaseIn, TEST_OWNER } from "../testing/releases.ts";
import {
  assertCheckpointBucketProtection,
  type CheckpointStorageConfig,
  createApiCheckpoints,
} from "./checkpoints.ts";

/**
 * The product composition against real stores: the worker gateway bound to
 * `createApiCheckpoints` over LocalStack S3 and PostgreSQL, driven the way a
 * worker drives it — ask, upload, finalize, ask for the restore plan.
 */
const integration =
  testDatabaseUrl() && localstackEnabled() ? describe : describe.skip;

const PROFILE_SHA = "c".repeat(64);
const ENGINE = "claude";
const claudeCheckpointCodec = installedOrThrow(
  installedCheckpointCodecs.find((codec) => codec.engine === ENGINE),
);
const claudeDescriptor = installedOrThrow(
  installedDescriptors.find(
    (descriptor) => descriptor.checkpointEngine === ENGINE,
  ),
);
/** The build the installed codec stamps a checkpoint with, short of a profile. */
const engineBuild = {
  cliVersion: claudeDescriptor.engineVersion,
  engine: claudeDescriptor.checkpointEngine,
  sdkVersion: claudeDescriptor.runtimeVersion,
};
const digestParts = transcriptDigestFor(ENGINE);

function installedOrThrow<T>(value: T | undefined): T {
  if (value === undefined) throw new Error(`No ${ENGINE} codec is installed`);
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The publish id is the server's to mint, so only the shape around it is known.
function mintedRef(sessionId: string, revision: number, attemptId: string) {
  const [directory, file] = manifestRefFor(
    sessionId,
    revision,
    attemptId,
    "<publish>",
  ).split("<publish>") as [string, string];
  return expect.stringMatching(
    new RegExp(`^${escapeRegExp(directory)}[0-9a-f]{32}${escapeRegExp(file)}$`),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

integration("API checkpoint composition on LocalStack and PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let bucket: LocalstackBucket;
  let bundle: GitBundleFixture;
  let objects: CheckpointObjectStore;
  let gateway: ReturnType<typeof createWorkerGateway>;
  // The protocol createApiCheckpoints binds is the service itself; its
  // manifest verifier is reached through it.
  let service: CheckpointService;
  const clock = new Date("2026-09-23T00:00:00.000Z");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "api_ckpt_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await migrate(db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
    });
    // Object Lock, as the compose bucket is: the composition pins and holds
    // checkpoint objects by default.
    bucket = await createLocalstackBucket({
      objectLock: true,
      prefix: "api-ckpt-it",
    });
    bundle = await createGitBundle();
    // The worker's side of the store: same bucket, its own client.
    objects = createCheckpointObjectStore({
      bucket: bucket.bucket,
      client: createStorageS3Client({ s3: bucket.env }),
    });
    const checkpoints = createApiCheckpoints(db, storageConfig(bucket));
    if (checkpoints.protocol === undefined) {
      throw new Error("an object store was configured; expected a protocol");
    }
    service = checkpoints.protocol as CheckpointService;
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testCatalog({
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: {
            kind: "api_key",
            value: "catalog-provider-key",
            ref: { value_env: "PROVIDER_KEY" },
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true } as const,
          },
        },
      }),
      checkpoints: checkpoints.verifier,
      checkpointProtocol: checkpoints.protocol,
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        now: () => clock,
        sleep: async () => {},
      },
    });
  }, 120_000);

  afterAll(async () => {
    await bucket?.destroy();
    await pool?.end();
    await database?.drop();
  });

  /** A worker's upload: create-only, recording the version it landed as. */
  async function put(key: string, bytes: Uint8Array) {
    const result = await objects.putImmutable(key, bytes);
    if (result.outcome !== "created" || result.version === undefined) {
      throw new Error(`upload of ${key} did not land with a version`);
    }
    return {
      bytes: bytes.byteLength,
      key,
      sha256: sha256(bytes),
      version: result.version,
    };
  }

  async function claimedSession() {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: TEST_OWNER },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "hash",
      agentReleaseId: await releaseIn(db),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "hello worker",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const launch = await launchSession(db, {
      sessionId: accepted.response.session_id,
    });
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: launch.executionId,
        execution_generation: launch.generation,
        credential: { kind: "launch_nonce", nonce: launch.nonce },
      },
    );
    const principal: WorkerPrincipal = {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
    const scope = {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
    const next = await gateway.nextInput(principal, scope);
    if (!next.input) throw new Error("no input delivered");
    return { claimed, principal, scope, turnId: next.input.turn_id };
  }

  test.each([
    ["checkpoint_lease_held", "Another checkpoint holds the lease"],
    // a ready run whose publish failed reports it the same way.
    ["publish_failed", "workspace: 12000 untracked files, over the 10000"],
  ] as const)(
    "a checkpoint refused as %s is recorded and the pointer stays",
    async (reason, detail) => {
      const { claimed, principal, scope } = await claimedSession();
      const pointer = async () =>
        (
          await db
            .select({
              revision: schema.sessions.checkpointRevision,
              pending: schema.sessions.checkpointPendingReason,
            })
            .from(schema.sessions)
            .where(eq(schema.sessions.id, claimed.session_id))
        )[0];
      const before = await pointer();

      expect(
        await gateway.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "rejected", reason, detail },
        }),
      ).toEqual({ status: "blocked", reason, detail });
      // Nothing published: the pointer is where it was, and the refusal is
      // what the session detail shows as its pending reason.
      expect(await pointer()).toEqual({
        revision: before?.revision ?? null,
        pending: reason,
      });
      // It holds nothing back: the next request is answered from that pointer.
      expect(
        await gateway.requestCheckpoint(principal, {
          ...scope,
          preparation: { status: "ready" },
        }),
      ).toEqual({
        status: "ready",
        revision: 0,
        manifest_ref: mintedRef(claimed.session_id, 0, claimed.attempt_id),
      });
    },
    60_000,
  );

  test("a manifest refused at finalize leaves the key free to finalize the turn without one", async () => {
    const { principal, scope, turnId } = await claimedSession();
    const asked = await gateway.requestCheckpoint(principal, {
      ...scope,
      preparation: { status: "ready" },
    });
    if (asked.status !== "ready") throw new Error("expected a key");
    const terminal = {
      status: "completed" as const,
      reason: null,
      result: null,
      usage: null,
    };
    // Nothing was uploaded under the key, so verification refuses it before
    // finalizeAtomic stores anything for the turn.
    const refused = {
      ...scope,
      turn_id: turnId,
      finalize_key: "fin-1",
      final_source_sequence: 0,
      terminal,
      checkpoint: {
        revision: asked.revision,
        manifest_ref: asked.manifest_ref,
        manifest_sha256: "f".repeat(64),
      },
    };
    await expect(gateway.finalize(principal, refused)).rejects.toMatchObject({
      status: 409,
      code: "CHECKPOINT_UNAVAILABLE",
    });

    expect(
      await gateway.finalize(principal, { ...refused, checkpoint: null }),
    ).toMatchObject({ status: "completed", checkpoint_revision: null });

    // The refused body never becomes the stored one: replaying it now is a
    // different request under a settled key.
    await expect(gateway.finalize(principal, refused)).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  }, 60_000);

  test("a worker asks, uploads, finalizes with a verified checkpoint and gets a restore plan back", async () => {
    const { claimed, principal, scope, turnId } = await claimedSession();
    const sessionId = claimed.session_id;
    const prefix = sessionObjectPrefix(sessionId);

    const asked = await gateway.requestCheckpoint(principal, {
      ...scope,
      preparation: { status: "ready" },
    });
    expect(asked).toEqual({
      status: "ready",
      revision: 0,
      manifest_ref: mintedRef(sessionId, 0, claimed.attempt_id),
    });
    if (asked.status !== "ready") return;

    const rootPart = await put(
      `${prefix}mirror/root-0.jsonl`,
      new TextEncoder().encode('{"type":"user"}\n'),
    );
    const bundleRef = await put(
      // Beside the manifest, in the directory this publish was handed.
      `${asked.manifest_ref.slice(0, asked.manifest_ref.lastIndexOf("/") + 1)}workspace.bundle`,
      bundle.bytes,
    );
    const manifest: CheckpointManifest = {
      createdAt: clock.toISOString(),
      cwd: "/workspace",
      engine: "claude",
      resume: "sdk-session-1",
      revision: 0,
      runtime: { ...engineBuild, profileSha256: PROFILE_SHA },
      sessionId,
      transcripts: {
        root: {
          entryCount: 1,
          parts: [rootPart],
          sha256: digestParts([rootPart]),
        },
        subagents: {},
      },
      version: 2,
      workspace: {
        bundle: bundleRef,
        gitCommit: bundle.commit,
        untracked: [],
      },
    };
    const encoded = claudeCheckpointCodec.encode(manifest);
    const stored = await put(asked.manifest_ref, encoded.bytes);

    const terminal = {
      status: "completed" as const,
      reason: null,
      result: null,
      usage: null,
    };
    // A digest that does not match what was uploaded never moves the pointer.
    await expect(
      gateway.finalize(principal, {
        ...scope,
        turn_id: turnId,
        finalize_key: "fin-bad",
        final_source_sequence: 0,
        terminal,
        checkpoint: {
          revision: 0,
          manifest_ref: asked.manifest_ref,
          manifest_sha256: "f".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });

    const finalized = await gateway.finalize(principal, {
      ...scope,
      turn_id: turnId,
      finalize_key: "fin-ok",
      final_source_sequence: 0,
      terminal,
      checkpoint: {
        revision: 0,
        manifest_ref: asked.manifest_ref,
        manifest_sha256: encoded.sha256,
        manifest_version: stored.version,
      },
    });
    expect(finalized).toMatchObject({
      status: "completed",
      checkpoint_revision: 0,
    });

    // The next request is built from the pointer that finalize moved.
    expect(
      await gateway.requestCheckpoint(principal, {
        ...scope,
        preparation: { status: "ready" },
      }),
    ).toEqual({
      status: "ready",
      revision: 1,
      manifest_ref: mintedRef(sessionId, 1, claimed.attempt_id),
    });

    const runtime = {
      engine: "claude",
      sdk_version: engineBuild.sdkVersion,
      cli_version: engineBuild.cliVersion,
      profile_sha256: PROFILE_SHA,
    };
    expect(await gateway.restorePlan(principal, { ...scope, runtime })).toEqual(
      {
        status: "ready",
        plan: {
          revision: 0,
          manifest_ref: asked.manifest_ref,
          manifest_sha256: encoded.sha256,
          manifest_version: stored.version,
          engine: "claude",
          resume: "sdk-session-1",
          cwd: "/workspace",
          git_commit: bundle.commit,
          artifacts: [
            { kind: "transcript_root", label: "", objects: [rootPart] },
            { kind: "workspace_bundle", label: "", objects: [bundleRef] },
          ],
          object_keys: [rootPart.key, bundleRef.key],
        },
      },
    );
    expect(
      await gateway.restorePlan(principal, {
        ...scope,
        runtime: { ...runtime, sdk_version: "0.0.1" },
      }),
    ).toMatchObject({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        {
          field: "sdkVersion",
          expected: "0.0.1",
          found: engineBuild.sdkVersion,
        },
      ],
    });
  }, 60_000);

  test("what finalize verified is what restore gets, whatever happens to the keys afterwards", async () => {
    const { claimed, principal, scope, turnId } = await claimedSession();
    const sessionId = claimed.session_id;
    const prefix = sessionObjectPrefix(sessionId);
    const asked = await gateway.requestCheckpoint(principal, {
      ...scope,
      preparation: { status: "ready" },
    });
    if (asked.status !== "ready") throw new Error(asked.status);
    const attemptDir = asked.manifest_ref.slice(
      0,
      asked.manifest_ref.lastIndexOf("/") + 1,
    );
    const transcript = new TextEncoder().encode('{"type":"user"}\n');
    const rootPart = await put(`${prefix}mirror/root-0.jsonl`, transcript);
    const bundleRef = await put(`${attemptDir}workspace.bundle`, bundle.bytes);
    const notes = await put(
      `${attemptDir}untracked/notes.md`,
      new TextEncoder().encode("notes\n"),
    );
    const manifest: CheckpointManifest = {
      createdAt: clock.toISOString(),
      cwd: "/workspace",
      engine: "claude",
      resume: "sdk-session-1",
      revision: 0,
      runtime: { ...engineBuild, profileSha256: PROFILE_SHA },
      sessionId,
      transcripts: {
        root: {
          entryCount: 1,
          parts: [rootPart],
          sha256: digestParts([rootPart]),
        },
        subagents: {},
      },
      version: 2,
      workspace: {
        bundle: bundleRef,
        gitCommit: bundle.commit,
        untracked: [{ ...notes, path: "notes.md" }],
      },
    };
    const encoded = claudeCheckpointCodec.encode(manifest);
    const stored = await put(asked.manifest_ref, encoded.bytes);
    const terminal = {
      status: "completed" as const,
      reason: null,
      result: null,
      usage: null,
    };
    const finalize = (finalizeKey: string, version?: string) =>
      gateway.finalize(principal, {
        ...scope,
        turn_id: turnId,
        finalize_key: finalizeKey,
        final_source_sequence: 0,
        terminal,
        checkpoint: {
          revision: 0,
          manifest_ref: asked.manifest_ref,
          manifest_sha256: encoded.sha256,
          ...(version === undefined ? {} : { manifest_version: version }),
        },
      });
    // Locked: a checkpoint that does not name its manifest by version is
    // refused before anything is read.
    await expect(finalize("fin-unpinned")).rejects.toMatchObject({
      status: 409,
      code: "CHECKPOINT_UNAVAILABLE",
      message: expect.stringMatching(/not named by version/),
    });
    expect(await finalize("fin-pinned", stored.version)).toMatchObject({
      status: "completed",
      checkpoint_revision: 0,
    });
    const [row] = await db
      .select({
        held: schema.checkpoints.versionsHeld,
        version: schema.checkpoints.manifestVersion,
      })
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.sessionId, sessionId));
    // The gateway records the verifier's word, not the worker's.
    expect(row).toEqual({ held: true, version: stored.version });

    // Every version the checkpoint names is held: deleting it is refused
    // even with the governance bypass.
    for (const ref of [rootPart, bundleRef, notes, stored]) {
      const refused = await bucket.s3
        .send(
          new DeleteObjectCommand({
            Bucket: bucket.bucket,
            BypassGovernanceRetention: true,
            Key: ref.key,
            VersionId: ref.version,
          }),
        )
        .then(
          () => undefined,
          (error: { $metadata?: { httpStatusCode?: number } }) => error,
        );
      expect(refused?.$metadata?.httpStatusCode).toBe(403);
    }

    // Now the keys move: the transcript part and the manifest are
    // overwritten with other bytes (the part keeps its length), the bundle
    // is hidden behind a delete marker and a create-only write lands in its
    // place, and the untracked file is deleted.
    const overwrite = (key: string, body: string) =>
      bucket.s3.send(
        new PutObjectCommand({
          Body: new TextEncoder().encode(body),
          Bucket: bucket.bucket,
          Key: key,
        }),
      );
    await overwrite(rootPart.key, '{"type":"evil"}\n');
    await overwrite(asked.manifest_ref, "{}\n");
    await bucket.s3.send(
      new DeleteObjectCommand({ Bucket: bucket.bucket, Key: bundleRef.key }),
    );
    expect(
      (await objects.putImmutable(bundleRef.key, new Uint8Array([1, 2, 3])))
        .outcome,
    ).toBe("created");
    await bucket.s3.send(
      new DeleteObjectCommand({ Bucket: bucket.bucket, Key: notes.key }),
    );

    const runtime = {
      engine: "claude",
      sdk_version: engineBuild.sdkVersion,
      cli_version: engineBuild.cliVersion,
      profile_sha256: PROFILE_SHA,
    };
    const plan = await gateway.restorePlan(principal, { ...scope, runtime });
    expect(plan).toEqual({
      status: "ready",
      plan: {
        revision: 0,
        manifest_ref: asked.manifest_ref,
        manifest_sha256: encoded.sha256,
        manifest_version: stored.version,
        engine: "claude",
        resume: "sdk-session-1",
        cwd: "/workspace",
        git_commit: bundle.commit,
        artifacts: [
          { kind: "transcript_root", label: "", objects: [rootPart] },
          { kind: "workspace_bundle", label: "", objects: [bundleRef] },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [{ ...notes, path: "notes.md" }],
          },
        ],
        object_keys: [rootPart.key, bundleRef.key, notes.key],
      },
    });
    // And those versions still serve the bytes that were verified.
    expect(await objects.get(rootPart.key, rootPart.version)).toEqual(
      transcript,
    );
    expect(await objects.get(bundleRef.key, bundleRef.version)).toEqual(
      bundle.bytes,
    );
    expect(await objects.get(rootPart.key)).not.toEqual(transcript);
  }, 60_000);

  test("a damaged pointer restores the newest held revision below it, and the session and its event stream say so", async () => {
    const { claimed, principal, scope, turnId } = await claimedSession();
    const sessionId = claimed.session_id;
    const prefix = sessionObjectPrefix(sessionId);
    const { kind: _kind, ...fence } = principal as Extract<
      WorkerPrincipal,
      { kind: "session" }
    >;
    const runtime = {
      engine: "claude",
      sdk_version: engineBuild.sdkVersion,
      cli_version: engineBuild.cliVersion,
      profile_sha256: PROFILE_SHA,
    };
    const first = await put(
      `${prefix}mirror/root-0.jsonl`,
      new TextEncoder().encode('{"type":"user","n":0}\n'),
    );
    const second = await put(
      `${prefix}mirror/root-1.jsonl`,
      new TextEncoder().encode('{"type":"user","n":1}\n'),
    );
    /** Uploads revision `revision`'s bundle and manifest as a worker would. */
    async function publish(revision: number, parts: (typeof first)[]) {
      const manifestRef = manifestRefFor(
        sessionId,
        revision,
        claimed.attempt_id,
        crypto.randomUUID().replaceAll("-", ""),
      );
      const attemptDir = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
      const bundleRef = await put(
        `${attemptDir}workspace.bundle`,
        bundle.bytes,
      );
      const manifest: CheckpointManifest = {
        createdAt: clock.toISOString(),
        cwd: "/workspace",
        engine: "claude",
        resume: `sdk-session-${revision}`,
        revision,
        runtime: { ...engineBuild, profileSha256: PROFILE_SHA },
        sessionId,
        transcripts: {
          root: {
            entryCount: parts.length,
            parts,
            sha256: digestParts(parts),
          },
          subagents: {},
        },
        version: 2,
        workspace: {
          bundle: bundleRef,
          gitCommit: bundle.commit,
          untracked: [],
        },
      };
      const encoded = claudeCheckpointCodec.encode(manifest);
      const stored = await put(manifestRef, encoded.bytes);
      return {
        manifest_ref: manifestRef,
        manifest_sha256: encoded.sha256,
        manifest_version: stored.version,
        revision,
      };
    }

    // Revision 0 closes the delivered turn; revision 1 is a turn-less
    // commit on top of it that adds a transcript part.
    const older = await publish(0, [first]);
    expect(
      await gateway.finalize(principal, {
        ...scope,
        turn_id: turnId,
        finalize_key: "fin-0",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: older,
      }),
    ).toMatchObject({ checkpoint_revision: 0 });
    const newer = await publish(1, [first, second]);
    expect(
      await finalizeCheckpoint(
        service,
        (input) => commitCheckpoint(db, input),
        { checkpoint: newer, fence, now: clock, sessionId, turnId: null },
      ),
    ).toEqual({ outcome: "committed", revision: 1 });

    // Only an operator with the hold permission can do this: lift the hold
    // on revision 1's new part and destroy that version.
    await bucket.s3.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket.bucket,
        Key: second.key,
        VersionId: second.version,
        LegalHold: { Status: "OFF" },
      }),
    );
    await bucket.s3.send(
      new DeleteObjectCommand({
        Bucket: bucket.bucket,
        Key: second.key,
        VersionId: second.version,
      }),
    );

    const plan = await gateway.restorePlan(principal, { ...scope, runtime });
    expect(plan).toMatchObject({
      status: "ready",
      plan: {
        revision: 0,
        manifest_ref: older.manifest_ref,
        manifest_sha256: older.manifest_sha256,
        manifest_version: older.manifest_version,
        resume: "sdk-session-0",
        artifacts: [{ kind: "transcript_root", objects: [first] }, {}],
        fallback: {
          pointer_revision: 1,
          skipped: [
            {
              revision: 1,
              reason: `manifest references a missing object: ${second.key} (version ${second.version})`,
            },
          ],
        },
      },
    });

    // Not silent: the session detail and the event stream both carry it.
    const detail = await createPostgresSessionReader(db).getSession(
      TEST_OWNER,
      sessionId,
    );
    expect(detail?.checkpoint_revision).toBe(1);
    expect(detail?.durability.checkpoint_fallback_revision).toBe(0);
    const announced = await db
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.sessionId, sessionId),
          sql`${schema.events.payload}->>'subtype' = 'checkpoint_restore_fallback'`,
        ),
      );
    expect(announced).toEqual([
      {
        payload: {
          type: "system",
          subtype: "checkpoint_restore_fallback",
          attempt_id: claimed.attempt_id,
          pointer_revision: 1,
          restored_revision: 0,
          skipped: [
            {
              revision: 1,
              reason: `manifest references a missing object: ${second.key} (version ${second.version})`,
            },
          ],
        },
      },
    ]);

    // Garbage collection releasing revision 0 takes it out of the running:
    // a fallback only ever lands on a generation still protected.
    await bucket.s3.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket.bucket,
        Key: older.manifest_ref,
        VersionId: older.manifest_version,
        LegalHold: { Status: "OFF" },
      }),
    );
    const refused = await gateway.restorePlan(principal, { ...scope, runtime });
    expect(refused).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
    if (refused.status !== "unavailable") return;
    expect(refused.reason).toContain(
      "earlier revision 0 is refused, and a refusal is not damage",
    );
  }, 60_000);

  test("a locked deployment refuses to start on a bucket that cannot pin or hold versions; an unversioned one says so and starts", async () => {
    await assertCheckpointBucketProtection(storageConfig(bucket));
    const plain = await createLocalstackBucket({ prefix: "api-ckpt-plain" });
    try {
      await expect(
        assertCheckpointBucketProtection(storageConfig(plain)),
      ).rejects.toThrow(
        /has versioning Off and Object Lock not configured; CHECKPOINT_OBJECT_PROTECTION=locked needs both/,
      );
      await assertCheckpointBucketProtection({
        ...storageConfig(plain),
        protection: "unversioned",
      });
    } finally {
      await plain.destroy();
    }
  }, 60_000);
});

function storageConfig(target: LocalstackBucket): CheckpointStorageConfig {
  return {
    bucket: target.bucket,
    credentials: {
      accessKeyId: target.env.accessKeyId,
      secretAccessKey: target.env.secretAccessKey,
    },
    endpoint: target.env.endpoint,
    protection: "locked",
    region: target.env.region,
  };
}
