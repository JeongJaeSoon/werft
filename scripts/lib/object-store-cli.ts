/**
 * The object store steps of scripts/backup.sh, restore.sh and
 * verify-restore.sh, through the production S3 adapter, so the
 * scripts run the same against the compose project's LocalStack and against
 * any S3-compatible store, AWS S3 included:
 *
 *   bun run scripts/lib/object-store-cli.ts download <dir>
 *   bun run scripts/lib/object-store-cli.ts check-target [--create] [--source-bucket <b>]
 *   bun run scripts/lib/object-store-cli.ts upload <dir> [<skip-keys-file>]
 *   bun run scripts/lib/object-store-cli.ts count
 *   bun run scripts/lib/object-store-cli.ts read <key> <version> <out-file>
 *   bun run scripts/lib/object-store-cli.ts create-only-check
 *
 * Environment: S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless the store is AWS S3
 * itself — the variables the API reads (`checkpointStorageConfigFromEnv`).
 *
 * Exit 2 on usage, 4 when check-target refuses the bucket as a restore
 * target (the source's own, or not empty), 1 on anything else.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  describeBucketEncryption,
  describeBucketProtection,
  type S3ClientLike,
  type StorageS3Settings,
} from "@werft-ai/storage";
import { backupPath } from "./checkpoint-pins.ts";

const EXIT_TARGET_REFUSED = 4;

class TargetRefusedError extends Error {}

export function s3SettingsFromEnv(): StorageS3Settings {
  const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
  return {
    credentials: {
      accessKeyId: required("AWS_ACCESS_KEY_ID"),
      secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    },
    ...(endpoint ? { endpoint } : {}),
    region: required("AWS_REGION"),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Refuses a restore target that is not a fresh, locked bucket: one named
 * like the source installation's bucket, a bucket missing versioning, Object
 * Lock or SSE-S3, or one that holds a single object version or delete
 * marker. Reads only; `create` makes a missing bucket first (the restore's
 * own LocalStack).
 *
 * The name alone decides "the source's bucket": one store answers under
 * several endpoint spellings (AWS S3's global, regional and dual-stack
 * names, a loopback alias), and no spelling comparison proves two of them
 * apart. A drill into another store under the same name is refused too;
 * it takes a bucket of another name.
 */
async function checkRestoreTarget(input: {
  readonly bucket: string;
  readonly client: S3ClientLike;
  readonly create?: { readonly region: string };
  readonly sourceBucket?: string;
}): Promise<void> {
  const { bucket, client } = input;
  if (input.sourceBucket === bucket) {
    throw new TargetRefusedError(
      `bucket ${bucket} has the source installation's bucket name; restore only into a new, empty bucket of another name`,
    );
  }
  if (input.create !== undefined && !(await bucketExists(client, bucket))) {
    const { region } = input.create;
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the one region S3 refuses to be named in.
        ...(region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
            }),
        ObjectLockEnabledForBucket: true,
      }),
    );
    await client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [
            { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      }),
    );
  }
  // What the restored API refuses to start `locked` on, and what re-pinning
  // needs: versions to pin, holds to place, SSE-S3 for every object written.
  const protection = await describeBucketProtection(client, bucket);
  if (protection.versioning !== "Enabled" || !protection.objectLock) {
    throw new Error(
      `bucket ${bucket} has versioning ${protection.versioning} and Object Lock ${protection.objectLock ? "enabled" : "not configured"}; a restore needs both`,
    );
  }
  // A default retention would lock every version written here, the probe's
  // scratch key included, so a failed restore could never empty it again;
  // checkpoints are protected by legal holds alone.
  const lock = (await client.send(
    new GetObjectLockConfigurationCommand({ Bucket: bucket }),
  )) as { ObjectLockConfiguration?: { Rule?: { DefaultRetention?: unknown } } };
  if (lock.ObjectLockConfiguration?.Rule?.DefaultRetention !== undefined) {
    throw new Error(
      `bucket ${bucket} has an Object Lock default retention; a restore needs a bucket protected by legal holds alone`,
    );
  }
  const encryption = await describeBucketEncryption(client, bucket);
  if (encryption !== "AES256") {
    throw new Error(
      `bucket ${bucket} encrypts new objects with ${encryption}; a restore needs the bucket default SSE-S3 (AES256)`,
    );
  }
  // Delete markers and noncurrent versions count: an object once written
  // here may be what some other installation's checkpoint pins.
  const page = (await client.send(
    new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1 }),
  )) as { DeleteMarkers?: unknown[]; Versions?: unknown[] };
  if ((page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0) > 0) {
    throw new TargetRefusedError(
      `bucket ${bucket} is not empty (it has object versions or delete markers); restore only into a new, empty bucket`,
    );
  }
}

async function bucketExists(client: S3ClientLike, bucket: string) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`${path} is neither a file nor a directory`);
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Each chunk copied: the stream may refill a buffer it already handed out. */
function writeChunks(chunks: AsyncIterable<Uint8Array>, path: string) {
  return pipeline(
    (async function* () {
      for await (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    createWriteStream(path, { mode: 0o600 }),
  );
}

function isPreconditionFailed(error: unknown): boolean {
  const found = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return (
    found?.name === "PreconditionFailed" ||
    found?.$metadata?.httpStatusCode === 412
  );
}

/**
 * The store must refuse to replace an object: a scratch key is written
 * once, then again with If-None-Match, which has to fail with 412; any other
 * failure leaves the object untouched for the wrong reason. Every version
 * and delete marker of the scratch key is then deleted by id, and the check
 * fails unless none is left, so the bucket reads as it did before.
 */
async function createOnlyCheck(
  client: S3ClientLike,
  bucket: string,
): Promise<number> {
  const key = `create-only-check/${Date.now()}-${process.pid}`;
  const put = (body: string) =>
    client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: bucket,
        IfNoneMatch: "*",
        Key: key,
      }),
    );
  let verdict = 0;
  try {
    await put("one");
    try {
      await put("two");
      console.error(`create-only-check: a second write to ${key} was accepted`);
      verdict = 1;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  } finally {
    for (const version of await scratchVersions(client, bucket, key)) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: version,
        }),
      );
    }
    const left = await scratchVersions(client, bucket, key);
    if (left.length > 0) {
      console.error(
        `create-only-check: ${key} still has ${left.length} version(s) or delete marker(s)`,
      );
      verdict = 1;
    }
  }
  return verdict;
}

async function scratchVersions(
  client: S3ClientLike,
  bucket: string,
  key: string,
): Promise<string[]> {
  const found: string[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = (await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        Prefix: key,
        VersionIdMarker: versionMarker,
      }),
    )) as {
      DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
      IsTruncated?: boolean;
      NextKeyMarker?: string;
      NextVersionIdMarker?: string;
      Versions?: Array<{ Key?: string; VersionId?: string }>;
    };
    for (const entry of [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? []),
    ]) {
      if (entry.Key === key) found.push(entry.VersionId ?? "null");
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  return found;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const bucket = required("S3_BUCKET");
  const s3 = s3SettingsFromEnv();
  const client = createStorageS3Client({ s3 });
  const objects = createCheckpointObjectStore({ bucket, client });
  try {
    switch (command) {
      // Every current object, key = path under <dir>. The pinned versions
      // are checkpoint-pins-cli.ts capture's job afterwards.
      case "download": {
        const [dir] = args;
        if (!dir) return usage();
        const keys = await objects.list("");
        // Two keys one file name apart on a case-insensitive or
        // normalizing file system would leave one file for both.
        const folded = new Map<string, string>();
        for (const key of keys) {
          const fold = key.normalize("NFC").toLowerCase();
          const other = folded.get(fold);
          if (other !== undefined) {
            throw new Error(
              `keys ${JSON.stringify(other)} and ${JSON.stringify(key)} may share one file in a backup directory`,
            );
          }
          folded.set(fold, key);
        }
        for (const key of keys) {
          const path = backupPath(dir, key);
          const chunks = await objects.stream(key);
          // Gone since the listing, as a sync would find it; a key some
          // checkpoint pins is fetched by version afterwards anyway.
          if (chunks === undefined) {
            console.error(`download: warning — ${key} was listed but is gone`);
            continue;
          }
          await mkdir(dirname(path), { recursive: true });
          const staged = `${path}.download-${process.pid}`;
          await writeChunks(chunks, staged);
          await rename(staged, path);
        }
        console.log(keys.length);
        return 0;
      }
      case "check-target": {
        let create = false;
        let sourceBucket: string | undefined;
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i];
          if (arg === "--create") create = true;
          else if (arg === "--source-bucket") sourceBucket = args[++i];
          else return usage();
        }
        await checkRestoreTarget({
          bucket,
          client,
          ...(create ? { create: { region: s3.region } } : {}),
          ...(sourceBucket === undefined ? {} : { sourceBucket }),
        });
        console.error(
          `check-target: bucket ${bucket} is versioned, Object Lock, SSE-S3 and empty`,
        );
        return 0;
      }
      // Create-only: the target was checked empty, so any key already there
      // was written by someone else meanwhile, and the restore stops.
      case "upload": {
        const [dir, skipFile] = args;
        if (!dir) return usage();
        const skip = new Set(
          skipFile === undefined
            ? []
            : (await readFile(skipFile, "utf8")).split("\n").filter(Boolean),
        );
        let uploaded = 0;
        for await (const path of files(dir)) {
          const key = relative(dir, path);
          if (backupPath(dir, key) !== path) {
            throw new Error(`${path} maps to no object key`);
          }
          if (skip.has(key)) continue;
          const source = {
            bytes: (await stat(path)).size,
            open: () => createReadStream(path),
            sha256: await sha256OfFile(path),
          };
          const result = await objects.putImmutable(key, source);
          if (result.outcome !== "created") {
            throw new Error(
              `${key}: the target already holds an object there (${result.outcome}); it was not empty when the upload ran`,
            );
          }
          uploaded += 1;
        }
        console.log(uploaded);
        return 0;
      }
      case "count": {
        console.log((await objects.list("")).length);
        return 0;
      }
      // Bytes to <out-file>, the legal hold (ON or OFF) on stdout; exit 1
      // when that version is not there.
      case "read": {
        const [key, version, out] = args;
        if (!key || !version || !out) return usage();
        const chunks = await objects.stream(key, version);
        if (chunks === undefined) {
          console.error(`read: ${key} has no version ${version}`);
          return 1;
        }
        await writeChunks(chunks, out);
        const head = await objects.head(key, version);
        console.log(head?.held === true ? "ON" : "OFF");
        return 0;
      }
      case "create-only-check":
        return await createOnlyCheck(client, bucket);
      default:
        return usage();
    }
  } finally {
    client.destroy();
  }
}

function usage(): number {
  console.error(
    "usage: object-store-cli.ts download <dir> | check-target [--create] [--source-bucket <b>] | upload <dir> [<skip-keys-file>] | count | read <key> <version> <out> | create-only-check",
  );
  return 2;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${process.argv[2]}: ${error instanceof Error ? error.message : String(error)}`,
    );
    code = error instanceof TargetRefusedError ? EXIT_TARGET_REFUSED : 1;
  }
  process.exit(code);
}
