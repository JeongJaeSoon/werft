import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  localstackEnabled,
  withLocalstackBucket,
} from "@werft-ai/testkit/localstack";

import {
  createCheckpointObjectStore,
  describeBucketEncryption,
  describeBucketProtection,
} from "./checkpoint-objects.ts";
import {
  ObjectScopeError,
  scopedCheckpointObjectStore,
} from "./scoped-objects.ts";

const localstackTest = localstackEnabled() ? test : test.skip;

localstackTest(
  "a manifest key is create-only against a real S3 endpoint",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/checkpoints/0000000000/manifest.json";
        const published = encode('{"revision":0,"resume":"live"}\n');

        expect(await store.putImmutable(key, published)).toEqual({
          outcome: "created",
        });
        // The same worker retrying its own upload is not a conflict.
        expect(await store.putImmutable(key, published)).toEqual({
          outcome: "duplicate",
        });
        // A worker from the previous epoch finishing its upload is.
        const stale = await store.putImmutable(
          key,
          encode('{"revision":0,"resume":"stale"}\n'),
        );
        expect(stale.outcome).toBe("conflict");
        expect(await store.get(key)).toEqual(published);
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// What lets a remembered bundle verdict be confirmed without reading the
// bundle again: a workspace bundle is uploaded as a stream with its digest.
localstackTest(
  "a body streamed with its digest is stored with a SHA-256 the HEAD reports",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/checkpoints/0000000000/a/p/workspace.bundle";
        const body = encode("bundle bytes\n");
        const sha256 = createHash("sha256").update(body).digest("hex");
        expect(
          await store.putImmutable(key, {
            bytes: body.byteLength,
            async *open() {
              yield body;
            },
            sha256,
          }),
        ).toEqual({ outcome: "created" });
        expect(await store.head(key)).toEqual({
          bytes: body.byteLength,
          sha256,
        });
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// checkpoint writes name no encryption, so the bucket default the
// API checks at startup is what every object is stored with.
localstackTest(
  "checkpoint objects are stored with the bucket's SSE-S3 default",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        await s3.send(
          new PutBucketEncryptionCommand({
            Bucket: bucket,
            ServerSideEncryptionConfiguration: {
              Rules: [
                {
                  ApplyServerSideEncryptionByDefault: {
                    SSEAlgorithm: "AES256",
                  },
                },
              ],
            },
          }),
        );
        expect(await describeBucketEncryption(s3, bucket)).toBe("AES256");

        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const manifest = "sessions/s1/checkpoints/0000000000/manifest.json";
        const part = "sessions/s1/mirror/part-0000000000.jsonl";
        await store.putImmutable(manifest, encode("{}"));
        await store.putImmutable(part, encode("one\n"));
        for (const key of [manifest, part]) {
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key }),
          );
          expect(head.ServerSideEncryption).toBe("AES256");
        }
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

localstackTest(
  "lists a session's checkpoint objects in revision order",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        for (const revision of [2, 0, 1]) {
          await store.putImmutable(
            `sessions/s1/checkpoints/${String(revision).padStart(10, "0")}/manifest.json`,
            encode(`{"revision":${revision}}\n`),
          );
        }
        await store.putImmutable(
          "sessions/s2/checkpoints/0000000000/manifest.json",
          encode("{}"),
        );

        expect(await store.list("sessions/s1/checkpoints/")).toEqual([
          "sessions/s1/checkpoints/0000000000/manifest.json",
          "sessions/s1/checkpoints/0000000001/manifest.json",
          "sessions/s1/checkpoints/0000000002/manifest.json",
        ]);
        expect(
          await store.get("sessions/s1/checkpoints/0000000009/manifest.json"),
        ).toBeUndefined();
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// The store also reads before it writes, which would mask an endpoint that
// ignores the precondition. This asserts the precondition itself, because it is
// the only thing that holds under two workers uploading at once.
localstackTest(
  "the endpoint enforces the create-only precondition itself",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const key = "sessions/s1/checkpoints/0000000000/manifest.json";
        await s3.send(
          new PutObjectCommand({
            Body: encode("live"),
            Bucket: bucket,
            Key: key,
          }),
        );

        const refused = await s3
          .send(
            new PutObjectCommand({
              Body: encode("stale"),
              Bucket: bucket,
              IfNoneMatch: "*",
              Key: key,
            }),
          )
          .then(
            () => undefined,
            (error: { $metadata?: { httpStatusCode?: number } }) => error,
          );

        expect(refused?.$metadata?.httpStatusCode).toBe(412);
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// the sequential case above cannot show that the endpoint serializes
// two workers racing for one manifest key, which is the case the precondition
// exists for. Run with and without Object Lock, the `locked` deployment shape.
const RACERS = 16;
const racingBodies = () =>
  Array.from({ length: RACERS }, (_, racer) =>
    encode(`{"revision":0,"racer":${racer}}\n`),
  );

for (const objectLock of [false, true]) {
  localstackTest(
    `racing create-only writes to one key: exactly one lands and its bytes stay${objectLock ? " (Object Lock)" : ""}`,
    async () => {
      await withLocalstackBucket(
        async ({ bucket, s3 }) => {
          const store = createCheckpointObjectStore({ bucket, client: s3 });
          const key = "sessions/s1/checkpoints/0000000000/manifest.json";
          const bodies = racingBodies();

          const statuses = await Promise.all(
            bodies.map((body) =>
              s3
                .send(
                  new PutObjectCommand({
                    Body: body,
                    Bucket: bucket,
                    IfNoneMatch: "*",
                    Key: key,
                  }),
                )
                .then(
                  (response) => response.$metadata.httpStatusCode,
                  (error: { $metadata?: { httpStatusCode?: number } }) =>
                    error.$metadata?.httpStatusCode,
                ),
            ),
          );
          expect(statuses.filter((status) => status === 200)).toHaveLength(1);
          // 409 is S3's answer to a write that overlapped another conditional
          // write; it refuses just the same.
          expect(
            statuses.filter(
              (status) => status !== 200 && status !== 409 && status !== 412,
            ),
          ).toEqual([]);
          const winner = bodies[statuses.indexOf(200)];
          const loser = bodies.find((body) => body !== winner);
          if (!winner || !loser) throw new Error("the race had no outcome");
          expect(await store.get(key)).toEqual(winner);

          // After the race, the store's own retry semantics hold on top of it.
          expect((await store.putImmutable(key, winner)).outcome).toBe(
            "duplicate",
          );
          expect((await store.putImmutable(key, loser)).outcome).toBe(
            "conflict",
          );
          expect(await store.get(key)).toEqual(winner);
        },
        { objectLock, prefix: "checkpoint-objects-it" },
      );
    },
    30_000,
  );
}

// The same race through the path a worker takes: of every racer, one creates
// and the rest learn they lost, including those that got 409 and retried.
localstackTest(
  "racing putImmutable calls: one is created, every other one conflicts",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/checkpoints/0000000000/manifest.json";
        const bodies = racingBodies();

        const outcomes = (
          await Promise.all(bodies.map((body) => store.putImmutable(key, body)))
        ).map(({ outcome }) => outcome);

        expect(
          outcomes.filter((outcome) => outcome === "created"),
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome === "conflict"),
        ).toHaveLength(RACERS - 1);
        expect(await store.get(key)).toEqual(
          bodies[outcomes.indexOf("created")],
        );
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

function encode(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

// The worker holds bucket-wide credentials and is confined to its session by
// the wrapper alone; see `scopedCheckpointObjectStore` for why that is not a
// credential boundary. This shows the confinement against the real endpoint:
// another session's object is out of reach even though the key exists.
localstackTest(
  "a session-scoped store reaches its own prefix and nothing else",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const unscoped = createCheckpointObjectStore({ bucket, client: s3 });
        const own = "sessions/s1/checkpoints/0000000000/a1/manifest.json";
        const foreign = "sessions/s2/checkpoints/0000000000/a1/manifest.json";
        await unscoped.putImmutable(foreign, encode("{}"));

        const scoped = scopedCheckpointObjectStore(unscoped, "sessions/s1/");
        expect(
          await scoped.putImmutable(own, encode('{"revision":0}')),
        ).toEqual({ outcome: "created" });
        expect(await scoped.get(own)).toEqual(encode('{"revision":0}'));
        expect(await scoped.list("sessions/s1/")).toEqual([own]);

        await expect(scoped.get(foreign)).rejects.toThrow(ObjectScopeError);
        await expect(scoped.putImmutable(foreign, encode("x"))).rejects.toThrow(
          ObjectScopeError,
        );
        await expect(scoped.list("sessions/")).rejects.toThrow(
          ObjectScopeError,
        );
        // Untouched: the refusal happened before any request was sent.
        expect(await unscoped.get(foreign)).toEqual(encode("{}"));
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// against the real endpoint: a version is what a checkpoint names
// so what the key holds later — an overwrite, a delete marker, a create-only
// write landing again behind the marker — cannot reach it, and a held version
// cannot be deleted by anyone who has not released the hold.
localstackTest(
  "a versioned Object Lock bucket answers versions, reads them back and refuses to delete a held one",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/mirror/part-0000000000.jsonl";
        expect(await describeBucketProtection(s3, bucket)).toEqual({
          objectLock: true,
          versioning: "Enabled",
        });

        const created = await store.putImmutable(key, encode("one\n"));
        expect(created).toEqual({
          outcome: "created",
          version: expect.any(String),
        });
        const version = (created as { version: string }).version;
        // A retry of the same bytes names the write that already landed.
        expect(await store.putImmutable(key, encode("one\n"))).toEqual({
          outcome: "duplicate",
          version,
        });

        await s3.send(
          new PutObjectCommand({
            Body: encode("two\n"),
            Bucket: bucket,
            Key: key,
          }),
        );
        expect(await store.get(key)).toEqual(encode("two\n"));
        expect(await store.get(key, version)).toEqual(encode("one\n"));
        expect(await store.head(key, version)).toEqual({ bytes: 4, version });

        await store.hold?.(key, version);
        expect(await store.head(key, version)).toEqual({
          bytes: 4,
          held: true,
          version,
        });
        const refused = await s3
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              BypassGovernanceRetention: true,
              Key: key,
              VersionId: version,
            }),
          )
          .then(
            () => undefined,
            (error: { $metadata?: { httpStatusCode?: number } }) => error,
          );
        expect(refused?.$metadata?.httpStatusCode).toBe(403);

        // A delete marker hides the key and lets create-only land again,
        // and neither touches the version a checkpoint names.
        const marker = (await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        )) as { DeleteMarker?: boolean; VersionId?: string };
        expect(marker.DeleteMarker).toBe(true);
        expect(await store.get(key)).toBeUndefined();
        // A manifest naming the marker's own id names nothing readable: S3
        // answers 405 there, which is absence, not an outage to retry.
        expect(await store.head(key, marker.VersionId)).toBeUndefined();
        expect(await store.get(key, marker.VersionId)).toBeUndefined();
        const reused = await store.putImmutable(key, encode("three\n"));
        expect(reused.outcome).toBe("created");
        expect(await store.get(key, version)).toEqual(encode("one\n"));

        // A version the bucket never issued reads as absent, not as an outage.
        expect(await store.get(key, "no-such-version")).toBeUndefined();
        expect(await store.head(key, "no-such-version")).toBeUndefined();
      },
      { objectLock: true, prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

localstackTest(
  "a bucket without versioning reports none, and cannot hold",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/mirror/part-0000000000.jsonl";
        expect(await describeBucketProtection(s3, bucket)).toEqual({
          objectLock: false,
          versioning: "Off",
        });
        expect(await store.putImmutable(key, encode("one\n"))).toEqual({
          outcome: "created",
        });
        expect(await store.head(key)).toEqual({ bytes: 4 });
        expect(await store.get(key, "some-version")).toBeUndefined();
        await expect(store.hold?.(key, "null")).rejects.toThrow();
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);
