import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import {
  GetBucketVersioningCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  bucketHoldsObjectVersion,
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
  describeBucketEncryption,
  describeBucketProtection,
} from "./checkpoint-objects.ts";
import { createStorageS3Client, type StorageS3Settings } from "./index.ts";
import {
  DEFAULT_BODY_READ_BOUNDS,
  isObjectStoreUnreachable,
  S3_MAX_ATTEMPTS,
  S3_METADATA_REQUEST_TIMEOUT_MS,
  S3_REQUEST_BOUNDS,
} from "./s3.ts";
import { listen } from "./testing/listen.ts";

/**
 * The other half of the problem `body-stall.test.ts` pins down: not a peer
 * that stops mid-body but one that never answers at all. The SDK's node
 * handler has no timeout of its own, so such a call never settles and never
 * retries, and every await above it stops.
 *
 * Reads and writes are bounded separately on purpose. A read sends almost
 * nothing, so it fails fast; an upload of a 128 MiB workspace bundle needs
 * minutes on a slow link and must not be cut off for using them.
 */
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("storage S3 client request bounds", () => {
  test("a read gives up on a peer that accepts and never answers", async () => {
    const { accepted, endpoint } = await silentPeer();
    const client = createStorageS3Client(configFor(endpoint));
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, requestTimeoutMs: 500 },
      bucket: "bucket",
      client,
    });

    const startedAt = Date.now();
    const outcome = await store.get("94s-223/silent-peer").then(
      () => "resolved",
      (error: Error) => error.name,
    );
    client.destroy();

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // Per attempt, not per call: the client retries, and stops.
    expect(accepted.length).toBe(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("the client's own bound ends a call that sends no read timeout", async () => {
    const { endpoint } = await silentPeer();
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 500,
    });

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new PutObjectCommand({
          Body: "body",
          Bucket: "bucket",
          Key: "94s-223/silent-peer",
        }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("a peer that never answers, refuses the connection or stops mid-answer is one a caller may wait out", async () => {
    const { endpoint: silent } = await silentPeer();
    const closed = createServer();
    const refusing = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const stalling = await stallingXmlPeer(200);

    for (const endpoint of [silent, refusing, stalling]) {
      const client = createStorageS3Client(configFor(endpoint), {
        ...S3_REQUEST_BOUNDS,
        bodyIdleMs: 300,
        requestTimeout: 300,
      });
      const failure = await client
        .send(new GetBucketVersioningCommand({ Bucket: "bucket" }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      client.destroy();
      expect(isObjectStoreUnreachable(failure)).toBe(true);
    }
  }, 20_000);

  test("an answer that says no is not one to wait out", () => {
    const answered = (status: number, name: string) =>
      Object.assign(new Error(name), {
        name,
        $metadata: { httpStatusCode: status },
      });
    expect(isObjectStoreUnreachable(answered(503, "ServiceUnavailable"))).toBe(
      true,
    );
    expect(isObjectStoreUnreachable(answered(429, "TooManyRequests"))).toBe(
      true,
    );
    expect(isObjectStoreUnreachable(answered(400, "RequestTimeout"))).toBe(
      true,
    );
    expect(isObjectStoreUnreachable(answered(404, "NoSuchBucket"))).toBe(false);
    expect(isObjectStoreUnreachable(answered(403, "AccessDenied"))).toBe(false);
    // What Bun's resolver reports while a cluster's DNS is not up yet.
    expect(
      isObjectStoreUnreachable(
        Object.assign(new Error("getaddrinfo ENOTIMP"), {
          code: "ENOTIMP",
          $metadata: { attempts: 1 },
        }),
      ),
    ).toBe(true);
    // No response either, but nothing a wait changes.
    expect(
      isObjectStoreUnreachable(
        Object.assign(new Error("Could not load credentials"), {
          name: "CredentialsProviderError",
        }),
      ),
    ).toBe(false);
    expect(
      isObjectStoreUnreachable(
        Object.assign(new TypeError("Invalid URL"), {
          code: "ERR_INVALID_URL",
        }),
      ),
    ).toBe(false);
  });

  test("lets a slow but advancing upload finish", async () => {
    // Why the client's bound is measured in minutes: it covers the upload
    // itself. Here the peer drains 64 KiB at a time, so the PUT takes far
    // longer than a read would be given, and it must still land.
    const server = createHttpServer((request, response) => {
      let received = 0;
      request.pause();
      const pump = setInterval(() => {
        const chunk = request.read(64 * 1024) as Buffer | null;
        if (chunk !== null) received += chunk.byteLength;
      }, 100);
      request.on("end", () => {
        clearInterval(pump);
        response.writeHead(200, { etag: `"${received}"` });
        response.end();
      });
    });
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const endpoint = await listen(server);
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 30_000,
    });

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new PutObjectCommand({
          Body: new Uint8Array(2 * 1024 * 1024),
          Bucket: "bucket",
          Key: "94s-223/slow-upload",
        }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("resolved");
    // Slower than a read is ever given, and not punished for it.
    expect(Date.now() - startedAt).toBeGreaterThan(1_000);
  }, 30_000);

  /**
   * The bodies `bodyBytes()` never sees. On any status >= 300 — and for a
   * ListObjectsV2 page on 200 — the SDK reads the body itself, inside
   * `send()`, after both request timeouts have been cleared by the arriving
   * headers. An `abortSignal` passed to `send()` does not reach these bodies.
   */
  test("gives up on an error body that stops mid-XML", async () => {
    const endpoint = await stallingXmlPeer(503);
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      bodyIdleMs: 300,
    });
    const store = createCheckpointObjectStore({ bucket: "bucket", client });

    const startedAt = Date.now();
    const outcome = await store.get("94s-223/stalled-error").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    // The SDK hands our own stall error back out of `send()`, so the read
    // treats it as one: retried on a fresh request, then given up on.
    expect(outcome).toContain("stalled 3 times");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("gives up on a list page that stops mid-XML", async () => {
    const endpoint = await stallingXmlPeer(200);
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      bodyIdleMs: 300,
    });
    const store = createCheckpointObjectStore({ bucket: "bucket", client });

    const startedAt = Date.now();
    const outcome = await store.list("94s-223/").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("delivered nothing for 300ms");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("every metadata request gives up on a silent store within its bound, and says so once", async () => {
    const { endpoint } = await silentPeer();
    const warned: Array<Record<string, unknown>> = [];
    // The shipped bounds: the client's own requestTimeout stays upload-sized,
    // so only the per-request bound can end these calls in time.
    const client = createStorageS3Client(
      configFor(endpoint),
      S3_REQUEST_BOUNDS,
      (message, fields) => warned.push({ message, ...fields }),
    );
    const store = createCheckpointObjectStore({ bucket: "bucket", client });
    const collector = createCheckpointObjectCollector({
      bucket: "bucket",
      client,
    });
    const key = "94s-2218/secret-key-name";
    const calls: Record<string, () => Promise<unknown>> = {
      HeadObject: () => store.head(key),
      PutObjectLegalHold: () =>
        (store.hold as NonNullable<typeof store.hold>)(key, "v1"),
      ListObjectsV2: () => store.list("94s-2218/"),
      ListObjectVersions: () => collector.listVersions("94s-2218/"),
      DeleteObject: () =>
        collector.purge({ deleteMarker: true, key, version: "v1" }),
      BucketHoldsObjectVersion: () =>
        bucketHoldsObjectVersion(client, "bucket"),
      GetBucketVersioning: () => describeBucketProtection(client, "bucket"),
      GetBucketEncryption: () => describeBucketEncryption(client, "bucket"),
    };

    const startedAt = Date.now();
    const outcomes = await Promise.all(
      Object.entries(calls).map(async ([name, call]) => {
        const outcome = await call().then(
          () => "resolved",
          (error: Error) => error.name,
        );
        return [name, outcome, Date.now() - startedAt] as const;
      }),
    );
    client.destroy();

    // Each try waits out the bound, then the SDK's backoff between tries.
    const budget = S3_METADATA_REQUEST_TIMEOUT_MS * S3_MAX_ATTEMPTS + 5_000;
    for (const [name, outcome, elapsed] of outcomes) {
      expect([name, outcome]).toEqual([name, "TimeoutError"]);
      expect(elapsed).toBeLessThan(budget);
    }
    expect(warned.map((line) => line.operation).sort()).toEqual(
      [
        "DeleteObject",
        "GetBucketEncryption",
        "GetBucketVersioning",
        "HeadObject",
        "ListObjectVersions",
        "ListObjectVersions",
        "ListObjectsV2",
        "PutObjectLegalHold",
      ].sort(),
    );
    for (const line of warned) {
      expect(line).toMatchObject({
        attempts: S3_MAX_ATTEMPTS,
        bucket: "bucket",
        message: "S3 request got no answer within its bound",
      });
      expect(line.elapsedMs as number).toBeGreaterThanOrEqual(
        S3_METADATA_REQUEST_TIMEOUT_MS * S3_MAX_ATTEMPTS,
      );
      expect(JSON.stringify(line)).not.toContain("secret-key-name");
      expect(JSON.stringify(line)).not.toContain(endpoint);
    }
  }, 60_000);

  test("keeps the shipped bounds in the shape the SDK needs", () => {
    // @smithy/node-http-handler 4.12.1 logs a warning and keeps waiting when
    // `requestTimeout` expires without this flag, which is indistinguishable
    // from having set no bound at all.
    expect(S3_REQUEST_BOUNDS.throwOnRequestTimeout).toBe(true);
    // 128 MiB at ~437 KiB/s still fits inside the client's bound.
    expect(S3_REQUEST_BOUNDS.requestTimeout).toBeGreaterThanOrEqual(300_000);
    // And a read never waits that long.
    expect(DEFAULT_BODY_READ_BOUNDS.requestTimeoutMs).toBeLessThan(
      S3_REQUEST_BOUNDS.requestTimeout,
    );
  });
});

async function silentPeer(): Promise<{
  accepted: Socket[];
  endpoint: string;
}> {
  const accepted: Socket[] = [];
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.resume();
  });
  closers.push(() => {
    for (const socket of accepted) socket.destroy();
    server.close();
  });
  return { accepted, endpoint: await listen(server) };
}

/** Answers with `status` and a few bytes of XML, then stops. */
async function stallingXmlPeer(status: number): Promise<string> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(status, {
      "content-length": "200",
      "content-type": "application/xml",
    });
    response.write("<?xml version=");
  });
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return listen(server);
}

function configFor(s3Endpoint: string): { s3: StorageS3Settings } {
  return {
    s3: {
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      endpoint: s3Endpoint,
      region: "ap-northeast-1",
    },
  };
}
