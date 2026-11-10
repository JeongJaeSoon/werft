/**
 * The checkpoint-object steps of scripts/backup.sh, restore.sh and
 * verify-restore.sh, run on the host against an installation's
 * published ports. See scripts/lib/checkpoint-pins.ts for what each checks.
 *
 *   bun run scripts/lib/checkpoint-pins-cli.ts capture <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts repin <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts plans [--image <worker image> <config dir>]
 *
 * Environment: DATABASE_URL, S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless the store is AWS S3
 * itself. Problems go to stderr; exit 1
 * when capture or repin refuses, 5 when a plan check fails.
 */

import * as schema from "@werft-ai/db";
import {
  createPostgresCatalogRepositoryStore,
  createPostgresCheckpointStore,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
  createPostgresWorkspaceProfileStore,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { claudeCheckpointCodec } from "@werft-ai/runtime-claude-codec";
import type { RuntimeFingerprint } from "@werft-ai/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  describeBucketProtection,
} from "@werft-ai/storage";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseCatalog } from "../../apps/control-host/src/api/catalog-config.ts";
import {
  API_CHECKPOINT_CODECS,
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  createApiCheckpointService,
} from "../../apps/control-host/src/api/checkpoints.ts";
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
  type ImageRuntime,
  manifestBindingProblem,
  parseImageRuntime,
  pinnedObjectsOf,
  planArchiveRepin,
  planProblems,
  planRepin,
  planRuntime,
  restoreClaims,
  type SessionRow,
  sealedMatchesCandidates,
  sessionClaim,
  sha256Hex,
} from "./checkpoint-pins.ts";
import { s3SettingsFromEnv } from "./object-store-cli.ts";

const EXIT_VERIFY_FAILED = 5;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const [command, objectsDir, imageName, ...extra] = process.argv.slice(2);
// Only a run against an image can say whether the image set that stays can
// restore a checkpoint, so only that run is recorded.
const record = extra.length === 1 && extra[0] === "--record";
if (
  (extra.length > 0 && !(record && objectsDir === "--image")) ||
  !(
    (command === "capture" && objectsDir && imageName === undefined) ||
    (command === "repin" && objectsDir && imageName === undefined) ||
    (command === "plans" && objectsDir === undefined) ||
    (command === "plans" && objectsDir === "--image" && imageName)
  )
) {
  console.error(
    "usage: checkpoint-pins-cli.ts capture <objects-dir> | repin <objects-dir> | plans [--image <worker image> [--record]]",
  );
  process.exit(2);
}
// The content id is fixed once, before the image runs: a tag moved while the
// check is under way must not leave one image's verdict under another's id.
const image =
  imageName === undefined
    ? undefined
    : { name: imageName, id: await imageDigestOf(imageName) };

const s3 = s3SettingsFromEnv();
const bucket = env("S3_BUCKET");
const client = createStorageS3Client({ s3 });
const objects = createCheckpointObjectStore({ bucket, client });
const pool = createEnforcedPool(
  env("DATABASE_URL"),
  createLogger(),
  "checkpoint-pins",
  JOB_POOL_TIMEOUTS,
);
const codecs = API_CHECKPOINT_CODECS;

// A row garbage collection marked is no longer restorable and its objects
// are gone or going: neither backed up nor re-pinned.
async function readRows(): Promise<CheckpointRow[]> {
  const { rows } = await pool.query<{
    manifest_ref: string;
    manifest_sha256: string;
    manifest_version: string | null;
    revision: number;
    session_id: string;
  }>(
    `SELECT session_id, revision, manifest_ref, manifest_sha256, manifest_version
     FROM checkpoints WHERE collected_at IS NULL ORDER BY session_id, revision`,
  );
  return rows.map((row) => ({
    manifestRef: row.manifest_ref,
    manifestSha256: row.manifest_sha256,
    manifestVersion: row.manifest_version,
    revision: Number(row.revision),
    sessionId: row.session_id,
  }));
}

async function readArchiveRows(): Promise<ArchiveRow[]> {
  const { rows } = await pool.query<{
    bytes: string;
    from_id: string;
    object_key: string;
    session_id: string;
    sha256: string;
    version_id: string;
  }>(
    `SELECT session_id, from_id, object_key, version_id, sha256, bytes
     FROM session_event_archives ORDER BY session_id, from_id`,
  );
  return rows.map((row) => ({
    bytes: Number(row.bytes),
    fromId: Number(row.from_id),
    objectKey: row.object_key,
    sessionId: row.session_id,
    sha256: row.sha256,
    versionId: row.version_id,
  }));
}

async function capture(dir: string) {
  const rows = await readRows();
  const archiveRows = await readArchiveRows();
  const { replaced } = await captureCheckpointObjects({
    codecs,
    objects,
    objectsDir: dir,
    rows,
  });
  const archives = await captureArchiveObjects({
    objects,
    objectsDir: dir,
    rows: archiveRows,
  });
  for (const key of [...replaced, ...archives.replaced]) {
    console.error(
      `capture: warning — ${key} now holds the bytes its row pinned; the bucket's current object differs or is gone`,
    );
  }
  console.log(
    JSON.stringify({
      checkpoints: rows.length,
      archives: archiveRows.length,
      replaced: replaced.length + archives.replaced.length,
    }),
  );
}

async function repin(dir: string) {
  // The restored API refuses to start `locked` on anything less, and holds
  // need Object Lock; better to stop before writing a single manifest.
  const protection = await describeBucketProtection(client, bucket);
  if (protection.versioning !== "Enabled" || !protection.objectLock) {
    throw new Error(
      `restored bucket ${bucket} has versioning ${protection.versioning} and Object Lock ${protection.objectLock ? "enabled" : "not configured"}; re-pinning needs both`,
    );
  }
  await assertCheckpointBucketEncryption(
    { ...s3, bucket, protection: "locked" },
    { client, warn: () => {} },
  );
  const rows = await readRows();
  const planned = await planRepin({ codecs, objects, objectsDir: dir, rows });
  const archives = await planArchiveRepin({
    objects,
    rows: await readArchiveRows(),
  });
  const repinned = await applyRepin({ objects, planned });
  await applyArchiveRepin({ objects, planned: archives });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const { row, version } of archives) {
      const updated = await db.query(
        `UPDATE session_event_archives SET version_id = $3
         WHERE session_id = $1 AND from_id = $2 AND version_id = $4`,
        [row.sessionId, row.fromId, version, row.versionId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `archive ${row.sessionId}@${row.fromId} changed while it was re-pinned`,
        );
      }
    }
    for (const row of repinned) {
      const updated = await db.query(
        `UPDATE checkpoints
         SET manifest_sha256 = $3, manifest_version = $4, versions_held = true
         WHERE session_id = $1 AND revision = $2 AND manifest_sha256 = $5`,
        [
          row.sessionId,
          row.revision,
          row.manifestSha256,
          row.manifestVersion,
          row.previousSha256,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `checkpoint ${row.sessionId}@${row.revision} changed while it was re-pinned`,
        );
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  console.log(
    JSON.stringify({
      checkpoints: repinned.length,
      archives: archives.length,
    }),
  );
}

/**
 * What the restored API itself would answer: the startup bucket check, then
 * `getRestorePlan` through the production wiring in `locked` mode for every
 * session pointer, and every object of every ready plan read back by the
 * version the plan names and found held. With an image, each plan is asked
 * for as a worker of that image would ask: its engine build, and the profile
 * digest its code computes from the claim the database's settings give.
 */
async function plans(
  image: { name: string; id: string } | undefined,
): Promise<number> {
  const config = {
    ...s3,
    bucket,
    protection: "locked" as const,
  };
  let failed = 0;
  const fail = (message: string) => {
    failed += 1;
    console.log(`FAIL ${message}`);
  };
  try {
    const found = await describeBucketProtection(client, bucket);
    await assertCheckpointBucketProtection(config);
    await assertCheckpointBucketEncryption(config, { client, warn: () => {} });
    console.log(
      `PASS bucket ${bucket}: ${JSON.stringify(found)}, passes the locked startup check`,
    );
  } catch (error) {
    fail(`bucket ${bucket}: ${(error as Error).message}`);
    return failed;
  }
  // createApiCheckpoints' own wiring, with the service itself in hand.
  const service = createApiCheckpointService({
    codecs: API_CHECKPOINT_CODECS,
    objectProtection: config.protection,
    objects,
    store: createPostgresCheckpointStore(drizzle(pool, { schema })),
  });
  const { rows: pointers } = await pool.query<
    SessionRow & {
      manifest_ref: string | null;
      manifest_sha256: string | null;
      manifest_version: string | null;
      revision: number;
    }
  >(
    `SELECT s.id, s.checkpoint_revision AS revision, c.manifest_ref, c.manifest_sha256, c.manifest_version,
            s.owner_id, s.profile_id, s.profile_fingerprint, s.model, s.repository_id, s.repository_mode, s.repo_url, s.branch,
            s.agent_release_id AS release_id, r.runtime_config_snapshot->'tools' AS release_tools,
            s.runtime_tools_source AS tools_source, r.effective_tools->'tools' AS release_effective_tools,
            r.policy_pins ? 'github' AS release_github,
            s.platform_prompt
     FROM sessions s LEFT JOIN checkpoints c
       ON c.session_id = s.id AND c.revision = s.checkpoint_revision
     LEFT JOIN agent_releases r ON r.id = s.agent_release_id
     WHERE s.checkpoint_revision IS NOT NULL ORDER BY s.id`,
  );
  // The profiles each session's restorable checkpoints were made under other
  // than its own, newest first, as a claim offers them
  // (worker-unit-of-work.ts withRestoreProfiles, worker-gateway.ts
  // restoreRuntimesOf).
  const { rows: earlier } = await pool.query<{
    model: string | null;
    profile_fingerprint: string;
    profile_id: string;
    session_id: string;
  }>(
    `SELECT c.session_id, c.profile_id, c.profile_fingerprint, c.model
     FROM checkpoints c JOIN sessions s ON s.id = c.session_id
     WHERE c.revision <= s.checkpoint_revision
       AND c.profile_id IS NOT NULL AND c.profile_fingerprint IS NOT NULL
       AND NOT (c.profile_id IS NOT DISTINCT FROM s.profile_id
                AND c.profile_fingerprint IS NOT DISTINCT FROM s.profile_fingerprint
                AND (c.model IS NULL OR c.model IS NOT DISTINCT FROM s.model))
     GROUP BY c.session_id, c.profile_id, c.profile_fingerprint, c.model
     ORDER BY c.session_id, max(c.revision) DESC`,
  );
  const earlierKeys = new Map<string, string[]>();
  const claimErrors = new Map<string, string>();
  let imageRuntime: ImageRuntime | undefined;
  if (image !== undefined) {
    // Credentials are resolved to a stand-in: the claim carries a token in
    // their place and the digest reads neither.
    const db = drizzle(pool, { schema });
    const catalog = await databaseCatalog({
      installations: createPostgresInstallationProfileStore(db),
      workspaces: createPostgresWorkspaceProfileStore(db),
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: createPostgresInstallationSettingsStore(db, null),
      credential: () => "verify-restore-reads-no-credential",
      env: process.env,
    });
    const claims: Record<string, unknown> = {};
    for (const pointer of pointers) {
      const session = claimedSessionOf(pointer);
      try {
        claims[pointer.id] = sessionClaim(session, catalog);
        const made = restoreClaims(
          session,
          earlier
            .filter((row) => row.session_id === pointer.id)
            .map((row) => ({
              profileId: row.profile_id,
              profileFingerprint: row.profile_fingerprint,
              model: row.model,
            })),
          catalog,
        );
        for (const [key, claim] of made) claims[key] = claim;
        earlierKeys.set(
          pointer.id,
          made.map(([key]) => key),
        );
      } catch (error) {
        claimErrors.set(pointer.id, (error as Error).message);
      }
    }
    imageRuntime = await readImageRuntime(image.id, claims);
  }
  // The checkpoints a restore may fall back to carry no plan of their own:
  // the digest they were sealed with must be one the image offers for the
  // session, the way the worker matches it.
  const fallbackVerdict = async (
    row: CheckpointRow,
    target: ImageRuntime,
  ): Promise<
    | { ok: true; offered: string }
    | {
        ok: false;
        outcome: RestoreCheck["outcome"] | "other_build";
        detail: string;
        offered?: string;
      }
  > => {
    const claimError = claimErrors.get(row.sessionId);
    if (claimError !== undefined) {
      return {
        ok: false,
        outcome: "error",
        detail: `no claim for the target image: ${claimError}`,
      };
    }
    const bytes = await objects.get(
      row.manifestRef,
      row.manifestVersion ?? undefined,
    );
    if (bytes === undefined) {
      return {
        ok: false,
        outcome: "error",
        detail: `no manifest at ${row.manifestRef}`,
      };
    }
    const unbound = manifestBindingProblem(bytes, row.manifestSha256);
    if (unbound !== null) {
      return { ok: false, outcome: "error", detail: unbound };
    }
    try {
      const sealed = claudeCheckpointCodec.decode(bytes).runtime;
      const runtime = planRuntime(sealed, target, row.sessionId);
      const alternates = [
        ...new Set(
          alternateDigests(target, [
            row.sessionId,
            ...(earlierKeys.get(row.sessionId) ?? []),
          ]).filter((digest) => digest !== runtime.profileSha256),
        ),
      ];
      const offered = candidatesDigest(runtime, alternates);
      const found = sealedMatchesCandidates(sealed, runtime, alternates);
      if (found.ok) return { ok: true, offered };
      return {
        ok: false,
        outcome: found.kind === "build" ? "other_build" : "mismatch",
        detail: found.detail,
        offered,
      };
    } catch (error) {
      return { ok: false, outcome: "error", detail: (error as Error).message };
    }
  };
  // What `--record` keeps for the gate in migration 0255: one verdict per
  // live checkpoint, bound to the manifest it read.
  const checks: RestoreCheck[] = [];
  const note = (
    session: string,
    revision: number,
    manifestSha256: string | null,
    outcome: RestoreCheck["outcome"],
    detail: string | null,
    offered: string = candidatesDigest(EMPTY_RUNTIME, []),
  ) => {
    if (record && manifestSha256 !== null) {
      checks.push({
        session,
        revision,
        manifestSha256,
        candidates: offered,
        outcome,
        detail,
      });
    }
  };
  for (const pointer of pointers) {
    const tag = `${pointer.id}@${pointer.revision} plan`;
    if (pointer.manifest_ref === null || pointer.manifest_version === null) {
      fail(`${tag}: pointer has no versioned checkpoints row`);
      continue;
    }
    const failPlan = (
      message: string,
      outcome: RestoreCheck["outcome"],
      offered?: string,
    ) => {
      fail(message);
      note(
        pointer.id,
        pointer.revision,
        pointer.manifest_sha256,
        outcome,
        message,
        offered,
      );
    };
    // The plan is judged on storage, not on this host's engine build: the
    // runtime asked for is the target image's, or with none the one the
    // manifest was sealed under. A pointer whose version is gone still gets
    // the service's own verdict, so the runtime then comes from whatever the
    // key holds.
    const manifestBytes = await objects.get(
      pointer.manifest_ref,
      pointer.manifest_version,
    );
    const runtimeSource =
      manifestBytes ?? (await objects.get(pointer.manifest_ref));
    if (runtimeSource === undefined) {
      failPlan(
        `${tag}: no manifest at ${pointer.manifest_ref} at all`,
        "error",
      );
      continue;
    }
    const claimError = claimErrors.get(pointer.id);
    if (claimError !== undefined) {
      failPlan(`${tag}: no claim for the target image: ${claimError}`, "error");
      continue;
    }
    let runtime: RuntimeFingerprint;
    try {
      runtime = planRuntime(
        claudeCheckpointCodec.decode(runtimeSource).runtime,
        imageRuntime,
        pointer.id,
      );
    } catch (error) {
      failPlan(`${tag}: ${(error as Error).message}`, "error");
      continue;
    }
    const alternates =
      imageRuntime === undefined
        ? []
        : [
            ...new Set(
              alternateDigests(imageRuntime, [
                pointer.id,
                ...(earlierKeys.get(pointer.id) ?? []),
              ]).filter((digest) => digest !== runtime.profileSha256),
            ),
          ];
    const offered = candidatesDigest(runtime, alternates);
    const result = await service.getRestorePlan({
      runtime,
      ...(alternates.length === 0
        ? {}
        : { alternateProfileSha256s: alternates }),
      sessionId: pointer.id,
    });
    if (result.status === "incompatible") {
      const message = `${tag}: incompatible with the target image (checkpoint → image): ${describeMismatches(result.mismatches)}`;
      // Sealed on another engine build is another retained image's checkpoint:
      // it is not recorded here, so it stays unchecked until that image has
      // been run, instead of failing for being on the wrong one.
      if (result.mismatches.some(({ field }) => field !== "profileSha256")) {
        fail(message);
      } else failPlan(message, "mismatch", offered);
      continue;
    }
    if (result.status !== "ready" || manifestBytes === undefined) {
      failPlan(`${tag}: ${JSON.stringify(result)}`, "error", offered);
      continue;
    }
    const { plan } = result;
    const problems: string[] = [];
    if (plan.manifestVersion !== pointer.manifest_version) {
      problems.push(
        `plan names manifest version ${plan.manifestVersion}, the pointer ${pointer.manifest_version}`,
      );
    }
    const pinned = pinnedObjectsOf(
      plan,
      claudeCheckpointCodec.decode(manifestBytes),
      manifestBytes,
    );
    problems.push(...(await planProblems(objects, pinned)));
    for (const problem of problems) fail(`${tag}: ${problem}`);
    if (problems.length === 0) {
      console.log(
        `PASS ${tag}: ready under locked${image === undefined ? "" : ` for image ${image.name}`}, ${pinned.length} versions read back and held`,
      );
    }
    note(
      pointer.id,
      pointer.revision,
      pointer.manifest_sha256,
      problems.length === 0 ? "ok" : "error",
      problems.length === 0 ? null : problems.join("; "),
      offered,
    );
  }
  // The checkpoints a restore may fall back to, which no plan is asked for:
  // each must carry a digest the target image offers for its session.
  if (record && imageRuntime !== undefined) {
    const pointed = new Set(
      pointers.map((pointer) => `${pointer.id}@${pointer.revision}`),
    );
    for (const row of await readRows()) {
      if (pointed.has(`${row.sessionId}@${row.revision}`)) continue;
      const tag = `${row.sessionId}@${row.revision} fallback`;
      const verdict = await fallbackVerdict(row, imageRuntime);
      if (verdict.ok) {
        console.log(`PASS ${tag}: sealed under a digest the image offers`);
        note(
          row.sessionId,
          row.revision,
          row.manifestSha256,
          "ok",
          null,
          verdict.offered,
        );
      } else if (verdict.outcome === "other_build") {
        // Another build's checkpoint is another retained image's to verify.
        console.log(`SKIP ${tag}: ${verdict.detail}`);
      } else {
        fail(`${tag}: ${verdict.detail}`);
        note(
          row.sessionId,
          row.revision,
          row.manifestSha256,
          verdict.outcome,
          verdict.detail,
          verdict.offered,
        );
      }
    }
  }
  if (record && image !== undefined && imageRuntime !== undefined) {
    await recordChecks(checks, image.id, imageRuntime);
  }
  if (pointers.length === 0) {
    console.error("plans: warning — no session has a checkpoint pointer");
  }
  // Archived events are read by the version their row names.
  for (const row of await readArchiveRows()) {
    const tag = `archive ${row.sessionId}@${row.fromId}`;
    const bytes = await objects.get(row.objectKey, row.versionId);
    if (
      bytes === undefined ||
      bytes.byteLength !== row.bytes ||
      sha256Hex(bytes) !== row.sha256
    ) {
      fail(
        `${tag}: ${row.objectKey} version ${row.versionId} does not read back`,
      );
      continue;
    }
    const head = await objects.head(row.objectKey, row.versionId);
    if (head?.held !== true) {
      fail(`${tag}: ${row.objectKey} version ${row.versionId} is not held`);
      continue;
    }
    console.log(`PASS ${tag}: read back and held`);
  }
  return failed;
}

type RestoreCheck = {
  candidates: string;
  detail: string | null;
  manifestSha256: string;
  outcome: "ok" | "mismatch" | "error";
  revision: number;
  session: string;
};

// A run that never reached a digest comparison offers none.
const EMPTY_RUNTIME: RuntimeFingerprint = {
  cliVersion: "",
  engine: "",
  profileSha256: "",
  sdkVersion: "",
};

/** The image's content id, which is what a deployment pins and the gate binds to. */
async function imageDigestOf(name: string): Promise<string> {
  const run = async (args: string[]) => {
    const child = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out: stdout.trim(), err: stderr.trim(), code };
  };
  const inspect = ["image", "inspect", "--format", "{{.Id}}", name];
  let found = await run(inspect);
  if (found.code !== 0) {
    // `docker run` pulls a missing image, and this check used to rely on it.
    const pulled = await run(["pull", "--quiet", name]);
    if (pulled.code !== 0) {
      throw new Error(`could not pull image ${name}: ${pulled.err}`);
    }
    found = await run(inspect);
  }
  if (found.code !== 0 || !found.out) {
    throw new Error(`could not inspect image ${name}: ${found.err}`);
  }
  return found.out;
}

/**
 * Appends one row per checked checkpoint to `checkpoint_restore_check`. Rows
 * are never updated: the gate reads the latest per checkpoint and manifest.
 */
async function recordChecks(
  checks: readonly RestoreCheck[],
  imageDigest: string,
  runtime: ImageRuntime,
) {
  if (checks.length === 0) return;
  const { profiles: _profiles, ...printed } = runtime;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const check of checks) {
      await db.query(
        `INSERT INTO checkpoint_restore_check
           (session_id, revision, manifest_sha256, candidates_digest, image_digest, image_runtime, outcome, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          check.session,
          check.revision,
          check.manifestSha256,
          check.candidates,
          imageDigest,
          JSON.stringify(printed),
          check.outcome,
          check.detail,
        ],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  console.log(
    `recorded ${checks.length} check(s) for image ${imageName} (${imageDigest})`,
  );
}

/**
 * Runs the image's own bun with no network on the claims
 * (apps/worker/src/image-runtime.ts). The image has no label for any of it.
 */
async function readImageRuntime(
  name: string,
  claims: Record<string, unknown>,
): Promise<ImageRuntime> {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--entrypoint",
      "bun",
      name,
      "run",
      "apps/worker/src/image-runtime.ts",
    ],
    {
      stdin: new Blob([JSON.stringify(claims)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `could not read the runtime of image ${name} (exit ${code}): ${stderr.trim()}`,
    );
  }
  return parseImageRuntime(stdout.trim());
}

let exitCode = 0;
try {
  if (command === "capture") await capture(objectsDir as string);
  else if (command === "repin") await repin(objectsDir as string);
  else if ((await plans(image)) > 0) exitCode = EXIT_VERIFY_FAILED;
} catch (error) {
  if (error instanceof CheckpointPinError) {
    console.error(`${command}: ${error.message}`);
  } else {
    console.error(`${command}: ${(error as Error).stack ?? String(error)}`);
  }
  exitCode = 1;
} finally {
  await pool.end();
  client.destroy();
}
process.exit(exitCode);
