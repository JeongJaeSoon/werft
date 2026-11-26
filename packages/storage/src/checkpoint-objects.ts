import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
} from "@aws-sdk/client-s3";
import type {
  CheckpointObjectCollector,
  StoredObjectVersion,
} from "@werft-ai/platform";
import {
  type CheckpointObjectStore,
  type ImmutableObjectSource,
  isImmutableObjectSource,
  type PutImmutableResult,
} from "@werft-ai/runtime-core";

import {
  type BodyReadBounds,
  BodyStallError,
  getObjectVersion,
  isConditionalConflict,
  isMissingObject,
  isPreconditionFailed,
  isUnreadableVersion,
  S3_MAX_ATTEMPTS,
  S3_METADATA_REQUEST_TIMEOUT_MS,
  S3_REQUEST_BOUNDS,
  S3_SMALL_WRITE_FLOOR_MS,
  S3_UPLOAD_STALL_MS,
  type S3ClientLike,
  sha256,
  storedVersion,
  streamObjectVersion,
  transferBudgetMs,
} from "./s3.ts";

// Bounded: a 409 means retry, but an endpoint that answers 409 forever must
// surface as a failure rather than an unbounded loop inside a mirror write.
const CONFLICT_ATTEMPTS = 4;

/** What every request that moves no object body is sent with. */
const METADATA = { requestTimeout: S3_METADATA_REQUEST_TIMEOUT_MS } as const;

export type CheckpointObjectStoreOptions = {
  /** Defaults to `DEFAULT_BODY_READ_BOUNDS`; tests pin shorter bounds. */
  readonly bodyRead?: BodyReadBounds;
  readonly bucket: string;
  readonly client: S3ClientLike;
  /** Defaults to `S3_UPLOAD_STALL_MS`; tests pin a shorter one. */
  readonly uploadStallMs?: number;
};

/**
 * The SHA-256 S3 keeps for an object written in one PUT that carried or asked
 * for it, in hex. A multipart upload's is a checksum of part checksums
 * (`COMPOSITE`, base64 then `-<parts>`), which is not the body's digest.
 */
function fullObjectSha256(head: {
  ChecksumSHA256?: string;
  ChecksumType?: string;
}): string | undefined {
  const { ChecksumSHA256: checksum } = head;
  if (checksum === undefined || head.ChecksumType === "COMPOSITE") {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(checksum)) return undefined;
  return Buffer.from(checksum, "base64").toString("hex");
}

/**
 * S3-backed checkpoint objects.
 *
 * `putImmutable` is the reason this exists: a worker whose lease has already
 * been taken over may still be holding a manifest upload. `If-None-Match: *`
 * makes that upload fail instead of replacing the body the live worker wrote,
 * and the 412 path reads the stored bytes back so a retry of the *same* body
 * reports `duplicate` rather than a false conflict.
 *
 * On a versioned bucket every write answers with its VersionId and every read
 * can ask for one; `hold` places an Object Lock legal hold, which needs a
 * bucket with Object Lock enabled. On a bucket without versioning none of
 * that is reported and asking for a version finds nothing.
 */
export function createCheckpointObjectStore(
  options: CheckpointObjectStoreOptions,
): CheckpointObjectStore {
  const { bodyRead, bucket, client } = options;
  const uploadStallMs = options.uploadStallMs ?? S3_UPLOAD_STALL_MS;

  function read(key: string, version?: string) {
    return getObjectVersion(client, bucket, key, {
      ...(bodyRead === undefined ? {} : { bounds: bodyRead }),
      ...(version === undefined ? {} : { version }),
    });
  }

  /**
   * What the key holds now, as a digest: read through once and never held,
   * since the body may be a workspace bundle.
   */
  async function stored(
    key: string,
  ): Promise<{ sha256: string; version?: string } | undefined> {
    const found = await streamObjectVersion(client, bucket, key, {
      ...(bodyRead === undefined ? {} : { bounds: bodyRead }),
    });
    if (found === undefined) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of found.chunks) hash.update(chunk);
    const digest = hash.digest("hex");
    return found.version === undefined
      ? { sha256: digest }
      : { sha256: digest, version: found.version };
  }

  function compare(
    found: { sha256: string; version?: string },
    expected: string,
  ): PutImmutableResult {
    if (found.sha256 !== expected) {
      return { outcome: "conflict", sha256: found.sha256 };
    }
    return found.version === undefined
      ? { outcome: "duplicate" }
      : { outcome: "duplicate", version: found.version };
  }

  function send(key: string, body: Uint8Array | ImmutableObjectSource) {
    if (!isImmutableObjectSource(body)) {
      return client.send(
        new PutObjectCommand({
          Body: body,
          Bucket: bucket,
          IfNoneMatch: "*",
          Key: key,
        }),
        {
          requestTimeout: transferBudgetMs(
            body.byteLength,
            S3_SMALL_WRITE_FLOOR_MS,
          ),
        },
      );
    }
    // The length and the checksum up front keep the SDK from switching to
    // `aws-chunked`, which the worker's object store route refuses; S3 still
    // checks the body against both.
    const put = async () => {
      const cut = new AbortController();
      let handed = 0;
      let stalledMs: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Armed again by each chunk the client takes, and left running once
      // the last is taken: the answer is due within the same bound.
      const moved = (bytes: number) => {
        handed += bytes;
        const ms = uploadStallMs + transferBudgetMs(handed, 0);
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalledMs = ms;
          cut.abort();
        }, ms);
      };
      moved(0);
      try {
        return await client.send(
          new PutObjectCommand({
            Body: pass(body, moved),
            Bucket: bucket,
            ChecksumSHA256: Buffer.from(body.sha256, "hex").toString("base64"),
            ContentLength: body.bytes,
            IfNoneMatch: "*",
            Key: key,
          }),
          {
            abortSignal: cut.signal,
            requestTimeout: transferBudgetMs(
              body.bytes,
              S3_REQUEST_BOUNDS.requestTimeout,
            ),
          },
        );
      } catch (error) {
        throw stalledMs === undefined
          ? error
          : new BodyStallError(
              `S3 upload moved nothing for ${stalledMs}ms after ${handed} of ${body.bytes} bytes`,
            );
      } finally {
        clearTimeout(timer);
      }
    };
    return retried(put);
  }

  return {
    async get(key, version) {
      return (await read(key, version))?.bytes;
    },

    async stream(key, version) {
      const found = await streamObjectVersion(client, bucket, key, {
        ...(bodyRead === undefined ? {} : { bounds: bodyRead }),
        ...(version === undefined ? {} : { version }),
      });
      return found?.chunks;
    },

    async head(key, version) {
      try {
        const response = (await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            ChecksumMode: "ENABLED",
            Key: key,
            VersionId: version,
          }),
          METADATA,
        )) as {
          ChecksumSHA256?: string;
          ChecksumType?: string;
          ContentLength?: number;
          ObjectLockLegalHoldStatus?: "ON" | "OFF";
          VersionId?: string;
        };
        const found = storedVersion(response.VersionId);
        const digest = fullObjectSha256(response);
        return {
          bytes: response.ContentLength ?? 0,
          ...(response.ObjectLockLegalHoldStatus === "ON"
            ? { held: true }
            : {}),
          ...(digest === undefined ? {} : { sha256: digest }),
          ...(found === undefined ? {} : { version: found }),
        };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        if (version !== undefined && isUnreadableVersion(error))
          return undefined;
        throw error;
      }
    },

    async hold(key, version) {
      await client.send(
        new PutObjectLegalHoldCommand({
          Bucket: bucket,
          Key: key,
          LegalHold: { Status: "ON" },
          VersionId: version,
        }),
        METADATA,
      );
    },

    async list(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            Prefix: prefix,
          }),
          METADATA,
        )) as {
          Contents?: Array<{ Key?: string }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key);
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken !== undefined);
      return keys.sort();
    },

    async putImmutable(key, body, options) {
      const expected = isImmutableObjectSource(body)
        ? body.sha256
        : sha256(body);
      // The read is not the guarantee — the precondition below is — but it
      // keeps an endpoint that silently ignores If-None-Match from turning a
      // late upload into an overwrite outside the narrow concurrent window.
      // Under a content-addressed key such an overwrite writes the same
      // bytes, so the read would cost a request and buy nothing.
      if (options?.contentAddressed !== true) {
        const existing = await stored(key);
        if (existing !== undefined) return compare(existing, expected);
      }
      for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
        try {
          const response = (await send(key, body)) as { VersionId?: string };
          const version = storedVersion(response.VersionId);
          return version === undefined
            ? { outcome: "created" }
            : { outcome: "created", version };
        } catch (error) {
          if (isPreconditionFailed(error)) {
            const found = await stored(key);
            // Rejected, yet nothing is stored: a lifecycle rule or a delete,
            // not a second writer. Refuse rather than retry; the caller keeps
            // its pointer.
            return found === undefined
              ? { outcome: "conflict", sha256: "" }
              : compare(found, expected);
          }
          if (!isConditionalConflict(error)) throw error;
          // 409 says the write overlapped another conditional write, not that
          // this one lost. If the winner already stored something, that is the
          // answer; otherwise nobody holds the key yet and the retry stands.
          const found = await stored(key);
          if (found !== undefined) return compare(found, expected);
        }
      }
      // Never report "created" for a write that was not observed to land.
      throw new Error(`Conditional write to ${key} kept conflicting`);
    },
  };
}

/**
 * One pass over a streamed body. Each chunk is copied, because the stream
 * buffers ahead of the socket and the source may refill what it handed out.
 * `moved` hears of each chunk as the client takes it.
 */
function pass(
  source: ImmutableObjectSource,
  moved: (bytes: number) => void,
): Readable {
  return Readable.from(
    (async function* () {
      for await (const chunk of source.open()) {
        moved(chunk.byteLength);
        yield Buffer.from(chunk);
      }
    })(),
  );
}

/**
 * The SDK retries nothing whose body is a stream — it cannot send a spent
 * stream again — so a streamed upload retries here, with a fresh pass each
 * time, on what the SDK would have retried: a server fault or a request
 * that never got an answer, one cut for moving nothing included. A 4xx is
 * the answer, the preconditions included, and goes back to the caller.
 */
async function retried<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      const answered = status !== undefined && status < 500;
      if (answered || tried >= S3_MAX_ATTEMPTS) throw error;
    }
  }
}

/**
 * The garbage collector's side of the checkpoint bucket. Its credentials
 * must be the control plane's: releasing a hold is exactly the permission a
 * worker must never have.
 *
 * No `BypassGovernanceRetention`: checkpoints are protected by legal holds
 * alone. A bucket that also has default retention is an operator saying
 * time protects them too, and a delete then fails loudly instead of
 * overriding that.
 */
export function createCheckpointObjectCollector(options: {
  readonly bucket: string;
  readonly client: S3ClientLike;
}): CheckpointObjectCollector {
  const { bucket, client } = options;
  return {
    async listVersions(prefix) {
      const found: StoredObjectVersion[] = [];
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            KeyMarker: keyMarker,
            Prefix: prefix,
            VersionIdMarker: versionMarker,
          }),
          METADATA,
        )) as {
          DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextVersionIdMarker?: string;
          Versions?: Array<{ Key?: string; VersionId?: string }>;
        };
        const add = (
          entries: Array<{ Key?: string; VersionId?: string }> | undefined,
          deleteMarker: boolean,
        ) => {
          for (const entry of entries ?? []) {
            const version = storedVersion(entry.VersionId);
            if (entry.Key === undefined || version === undefined) continue;
            found.push({ deleteMarker, key: entry.Key, version });
          }
        };
        add(page.Versions, false);
        add(page.DeleteMarkers, true);
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker !== undefined);
      return found;
    },

    async purge(entry) {
      // A held version refuses deletion, so the hold goes first. A delete
      // that then fails leaves the version unheld but present, and the next
      // pass, finding it still unreachable, deletes it.
      if (!entry.deleteMarker) {
        await client.send(
          new PutObjectLegalHoldCommand({
            Bucket: bucket,
            Key: entry.key,
            LegalHold: { Status: "OFF" },
            VersionId: entry.version,
          }),
          METADATA,
        );
      }
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: entry.key,
          VersionId: entry.version,
        }),
        METADATA,
      );
    },
  };
}

/**
 * Whether the bucket holds any object version at all. Delete markers do not
 * count: a bucket where every key ends in one has lost the bytes every
 * checkpoint pins.
 */
export async function bucketHoldsObjectVersion(
  client: S3ClientLike,
  bucket: string,
): Promise<boolean> {
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = (await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
      }),
      METADATA,
    )) as {
      IsTruncated?: boolean;
      NextKeyMarker?: string;
      NextVersionIdMarker?: string;
      Versions?: unknown[];
    };
    if ((page.Versions?.length ?? 0) > 0) return true;
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  return false;
}

export type BucketProtection = {
  /** True when the bucket has an Object Lock configuration, so holds work. */
  readonly objectLock: boolean;
  readonly versioning: "Enabled" | "Suspended" | "Off";
};

/**
 * What a bucket can promise a checkpoint: whether its writes get versions,
 * and whether a version can be held. Read at startup, so a deployment that
 * requires both finds out before the first finalize rather than on it.
 */
export async function describeBucketProtection(
  client: S3ClientLike,
  bucket: string,
): Promise<BucketProtection> {
  const versioning = (await client.send(
    new GetBucketVersioningCommand({ Bucket: bucket }),
    METADATA,
  )) as { Status?: string };
  let objectLock = false;
  try {
    const found = (await client.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucket }),
      METADATA,
    )) as { ObjectLockConfiguration?: { ObjectLockEnabled?: string } };
    objectLock = found.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
  } catch (error) {
    if (!isMissingLockConfiguration(error)) throw error;
  }
  return {
    objectLock,
    versioning:
      versioning.Status === "Enabled" || versioning.Status === "Suspended"
        ? versioning.Status
        : "Off",
  };
}

/**
 * The algorithm a bucket encrypts new objects with when a write names none —
 * which is every checkpoint write — or `"none"` when it has no default
 * encryption. Read at startup next to `describeBucketProtection`.
 */
export async function describeBucketEncryption(
  client: S3ClientLike,
  bucket: string,
): Promise<string> {
  try {
    const found = (await client.send(
      new GetBucketEncryptionCommand({ Bucket: bucket }),
      METADATA,
    )) as {
      ServerSideEncryptionConfiguration?: {
        Rules?: Array<{
          ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string };
        }>;
      };
    };
    const rule = found.ServerSideEncryptionConfiguration?.Rules?.find(
      (candidate) => candidate.ApplyServerSideEncryptionByDefault,
    );
    return rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? "none";
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "ServerSideEncryptionConfigurationNotFoundError")
      return "none";
    throw error;
  }
}

function isMissingLockConfiguration(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "ObjectLockConfigurationNotFoundError";
}
