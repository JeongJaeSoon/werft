import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutObjectLegalHoldCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type LocalstackEnv = {
  accessKeyId: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};

export type LocalstackBucket = {
  bucket: string;
  /**
   * Deletes every object under the prefix — every version and delete marker,
   * releasing legal holds and bypassing governance retention on the way, so a
   * versioned or Object Lock bucket empties too. An empty prefix empties the
   * bucket. Returns how many versions and markers went.
   */
  deletePrefix(prefix: string): Promise<number>;
  /** Empties and deletes the bucket, then releases the client. */
  destroy(): Promise<void>;
  env: LocalstackEnv;
  s3: S3Client;
};

/** LocalStack tests run only when `STORAGE_LOCALSTACK_TEST=1`, as CI does. */
export function localstackEnabled(): boolean {
  return process.env.STORAGE_LOCALSTACK_TEST === "1";
}

export function localstackEnv(): LocalstackEnv {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "LocalStack integration environment is incomplete: AWS_ENDPOINT_URL, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required",
    );
  }
  return { accessKeyId, endpoint, region, secretAccessKey };
}

export function localstackClient(env: LocalstackEnv = localstackEnv()) {
  return new S3Client({
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    endpoint: env.endpoint,
    forcePathStyle: true,
    region: env.region,
  });
}

export type LocalstackBucketOptions = {
  env?: LocalstackEnv;
  /**
   * Create the bucket with Object Lock, which also turns versioning on — the
   * shape a `locked` checkpoint deployment requires.
   */
  objectLock?: boolean;
  prefix?: string;
};

export async function createLocalstackBucket(
  options: LocalstackBucketOptions = {},
): Promise<LocalstackBucket> {
  const env = options.env ?? localstackEnv();
  const bucket = `${options.prefix ?? "testkit-it"}-${randomUUID()}`;
  const s3 = localstackClient(env);
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: {
          LocationConstraint: env.region as "ap-northeast-1",
        },
        ...(options.objectLock === true
          ? { ObjectLockEnabledForBucket: true }
          : {}),
      }),
    );
  } catch (error) {
    s3.destroy();
    throw error;
  }
  const deletePrefix = async (prefix: string) => {
    let deleted = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          Prefix: prefix,
          VersionIdMarker: versionMarker,
        }),
      );
      const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter(
          (entry): entry is { Key: string; VersionId?: string } =>
            typeof entry.Key === "string",
        )
        .map(({ Key, VersionId }) => ({ Key, VersionId }));
      // A held version refuses deletion even with the governance bypass, so
      // the hold goes first. Only where there is one: asking a bucket without
      // Object Lock is an error.
      for (const version of page.Versions ?? []) {
        if (options.objectLock !== true || !version.Key) continue;
        await s3.send(
          new PutObjectLegalHoldCommand({
            Bucket: bucket,
            Key: version.Key,
            LegalHold: { Status: "OFF" },
            VersionId: version.VersionId,
          }),
        );
      }
      if (entries.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            // Sent at all, the header is refused by a bucket without Object Lock.
            ...(options.objectLock === true
              ? { BypassGovernanceRetention: true }
              : {}),
            Delete: { Objects: entries, Quiet: true },
          }),
        );
        deleted += entries.length;
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return deleted;
  };
  return {
    bucket,
    deletePrefix,
    destroy: async () => {
      try {
        await deletePrefix("");
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        s3.destroy();
      }
    },
    env,
    s3,
  };
}

export async function withLocalstackBucket<T>(
  fn: (bucket: LocalstackBucket) => Promise<T>,
  options: LocalstackBucketOptions = {},
): Promise<T> {
  const bucket = await createLocalstackBucket(options);
  try {
    return await fn(bucket);
  } finally {
    await bucket.destroy();
  }
}
