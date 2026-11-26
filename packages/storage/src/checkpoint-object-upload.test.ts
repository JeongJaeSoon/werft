import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import type { ImmutableObjectSource } from "@werft-ai/runtime-core";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
import {
  BodyStallError,
  BoundedNodeHttpHandler,
  DEFAULT_BODY_READ_BOUNDS,
  readBudgetMs,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  S3_SMALL_WRITE_FLOOR_MS,
  type S3ClientLike,
  transferBudgetMs,
} from "./s3.ts";

const KEY = "sessions/s1/checkpoints/0000000000/a/p/workspace.bundle";
const MiB = 1024 * 1024;

describe("transfer budgets grow with the object", () => {
  test("the floor up to 256 MiB, the same rate above it", () => {
    expect(transferBudgetMs(0, 300_000)).toBe(300_000);
    expect(transferBudgetMs(128 * MiB, 300_000)).toBe(300_000);
    expect(transferBudgetMs(256 * MiB, 300_000)).toBe(300_000);
    expect(transferBudgetMs(512 * MiB, 300_000)).toBe(600_000);
    expect(transferBudgetMs(1024 * MiB, 300_000)).toBe(1_200_000);
  });

  test("a read is budgeted by the size the store claims, up to the largest object anything writes", () => {
    expect(readBudgetMs(512 * MiB, 300_000)).toBe(600_000);
    expect(readBudgetMs(1024 * 1024 * MiB, 300_000)).toBe(600_000);
  });

  test("a streamed upload asks for a request timeout sized to its body", async () => {
    const timeouts: Array<number | undefined> = [];
    const client: S3ClientLike = {
      async send(command, options) {
        const name = (command as { constructor: { name: string } }).constructor
          .name;
        if (name === "GetObjectCommand") {
          throw Object.assign(new Error("no such key"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          });
        }
        timeouts.push(options?.requestTimeout);
        return { VersionId: "v1" };
      },
    };
    const store = createCheckpointObjectStore({ bucket: "bucket", client });
    // Declared large; the fake never reads the body.
    const large = { ...sourceOf(new Uint8Array(1)), bytes: 512 * MiB };

    await store.putImmutable(KEY, large);
    await store.putImmutable(`${KEY}.small`, new Uint8Array(1));
    await store.putImmutable(`${KEY}.held`, new Uint8Array(32 * MiB));

    // A body in memory starts from the small-write floor, not the upload one,
    // and grows past it at the same rate as a streamed one.
    expect(timeouts).toEqual([
      600_000,
      S3_SMALL_WRITE_FLOOR_MS,
      transferBudgetMs(32 * MiB, S3_SMALL_WRITE_FLOOR_MS),
    ]);
    expect(timeouts[2]).toBeGreaterThan(S3_SMALL_WRITE_FLOOR_MS);
  });

  test("a streamed read of a large body gets a whole-read budget sized to it", async () => {
    // 2 MiB dripped over ~400 ms: past a 50 ms floor, well inside the
    // ~2.3 s the size earns at the minimum rate.
    const size = 2 * MiB;
    const client: S3ClientLike = {
      async send() {
        return {
          Body: (async function* () {
            for (let sent = 0; sent < size; sent += size / 4) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              yield new Uint8Array(size / 4);
            }
          })(),
          ContentLength: size,
        };
      },
    };
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, maxReadMs: 50 },
      bucket: "bucket",
      client,
    });

    let read = 0;
    for await (const chunk of (await store.stream(KEY)) ?? []) {
      read += chunk.byteLength;
    }
    expect(read).toBe(size);
  });
});

type Received = {
  body: Uint8Array;
  headers: IncomingMessage["headers"];
  method: string;
};

/**
 * A streamed `putImmutable` through the real SDK and its node handler — the
 * worker's transport — against a peer that records every request whole.
 */
describe("streamed putImmutable over HTTP", () => {
  let server: Server | undefined;
  let client: S3Client | undefined;

  afterEach(() => {
    client?.destroy();
    server?.closeAllConnections();
    server?.close();
  });

  async function peer(
    answer: (
      request: Received,
      puts: number,
      // null: the request is taken whole and never answered.
    ) => {
      status: number;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
    } | null,
    bounds: { uploadStallMs?: number } = {},
  ) {
    const received: Received[] = [];
    server = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      try {
        for await (const part of request) parts.push(part as Buffer);
      } catch {
        // Cut by the client before its body ended: never taken whole.
        return;
      }
      const entry = {
        body: new Uint8Array(Buffer.concat(parts)),
        headers: request.headers,
        method: request.method ?? "",
      };
      received.push(entry);
      const puts = received.filter(({ method }) => method === "PUT").length;
      const answered = answer(entry, puts);
      if (answered === null) return;
      response.writeHead(answered.status, answered.headers);
      response.end(answered.body);
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test peer did not bind a port");
    }
    client = new S3Client({
      credentials: { accessKeyId: "id", secretAccessKey: "test" },
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      maxAttempts: S3_MAX_ATTEMPTS,
      region: "ap-northeast-1",
      requestHandler: new BoundedNodeHttpHandler(S3_REQUEST_BOUNDS),
    });
    return {
      received,
      store: createCheckpointObjectStore({
        bucket: "bucket",
        client,
        ...bounds,
      }),
    };
  }

  const missing = {
    status: 404,
    headers: { "content-type": "application/xml" },
    body: "<Error><Code>NoSuchKey</Code><Message>none</Message></Error>",
  };

  test("sends the body with its length and checksum, not aws-chunked, and a fresh pass on a retry", async () => {
    const bytes = new Uint8Array(randomBytes(3 * 64 * 1024 + 11));
    const source = sourceOf(bytes);
    const { received, store } = await peer((request, puts) => {
      if (request.method === "GET") return missing;
      return puts === 1
        ? {
            status: 500,
            headers: { "content-type": "application/xml" },
            body: "<Error><Code>InternalError</Code><Message>try again</Message></Error>",
          }
        : { status: 200, headers: { "x-amz-version-id": "v7" } };
    });

    expect(await store.putImmutable(KEY, source)).toEqual({
      outcome: "created",
      version: "v7",
    });

    const puts = received.filter(({ method }) => method === "PUT");
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.body).toEqual(bytes);
      expect(put.headers["content-length"]).toBe(String(bytes.byteLength));
      expect(put.headers["content-encoding"]).toBeUndefined();
      expect(put.headers["x-amz-checksum-sha256"]).toBe(
        Buffer.from(source.sha256, "hex").toString("base64"),
      );
      expect(put.headers["if-none-match"]).toBe("*");
    }
    // One pass per attempt, and none opened for nothing.
    expect(source.opened()).toBe(2);
  }, 20_000);

  test("a key that already holds the same bytes is a duplicate, read through without holding it", async () => {
    const bytes = new Uint8Array(randomBytes(200 * 1024));
    const source = sourceOf(bytes);
    const { received, store } = await peer((request) =>
      request.method === "GET"
        ? {
            status: 200,
            headers: {
              "content-length": String(bytes.byteLength),
              "x-amz-version-id": "v1",
            },
            body: bytes,
          }
        : { status: 500 },
    );

    expect(await store.putImmutable(KEY, source)).toEqual({
      outcome: "duplicate",
      version: "v1",
    });
    expect(received.filter(({ method }) => method === "PUT")).toHaveLength(0);
    expect(source.opened()).toBe(0);
  }, 20_000);

  test("an upload the store takes and never answers is cut at the stall bound and sent again with a fresh pass", async () => {
    const bytes = new Uint8Array(randomBytes(64 * 1024 + 11));
    const source = sourceOf(bytes);
    const { received, store } = await peer(
      (request, puts) => {
        if (request.method === "GET") return missing;
        return puts === 1
          ? null
          : { status: 200, headers: { "x-amz-version-id": "v2" } };
      },
      { uploadStallMs: 300 },
    );

    const startedAt = Date.now();
    expect(await store.putImmutable(KEY, source)).toEqual({
      outcome: "created",
      version: "v2",
    });

    // The stall bound, not the five minutes its request timeout allows.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const puts = received.filter(({ method }) => method === "PUT");
    expect(puts.map(({ body }) => body)).toEqual([bytes, bytes]);
    expect(source.opened()).toBe(2);
  }, 20_000);

  test("a store that never answers fails the upload as a stall once its attempts are spent", async () => {
    const source = sourceOf(new Uint8Array(randomBytes(698)));
    const { received, store } = await peer(
      (request) => (request.method === "GET" ? missing : null),
      { uploadStallMs: 200 },
    );

    const startedAt = Date.now();
    const failure = await store.putImmutable(KEY, source).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BodyStallError);
    // The bound, and the moment the 698 bytes need at the slowest link.
    expect((failure as Error).message).toMatch(
      /moved nothing for 20\dms after 698 of 698 bytes/,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(received.filter(({ method }) => method === "PUT")).toHaveLength(
      S3_MAX_ATTEMPTS,
    );
    expect(source.opened()).toBe(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("an upload cut for a stall closes the source it was reading", async () => {
    const piece = new Uint8Array(randomBytes(1024));
    const bytes = new Uint8Array(Buffer.concat([piece, piece]));
    let opened = 0;
    let closed = 0;
    // The second chunk comes after the stall bound, so each attempt is cut
    // with its source still part read.
    const source: ImmutableObjectSource = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async *open() {
        opened += 1;
        try {
          yield piece;
          await new Promise((resolve) => setTimeout(resolve, 400));
          yield piece;
        } finally {
          closed += 1;
        }
      },
    };
    const { store } = await peer(
      (request) => (request.method === "GET" ? missing : null),
      { uploadStallMs: 150 },
    );

    const failure = await store.putImmutable(KEY, source).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BodyStallError);
    expect(opened).toBe(S3_MAX_ATTEMPTS);
    const by = Date.now() + 2_000;
    while (closed < opened && Date.now() < by) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(closed).toBe(opened);
  }, 20_000);

  test("an upload that keeps moving is not cut, however long it takes", async () => {
    const piece = new Uint8Array(randomBytes(1024));
    const bytes = new Uint8Array(Buffer.concat([piece, piece, piece, piece]));
    let opened = 0;
    // A chunk every 150 ms: 600 ms in all, each gap inside the 300 ms bound.
    const source: ImmutableObjectSource = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async *open() {
        opened += 1;
        for (let sent = 0; sent < 4; sent += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          yield piece;
        }
      },
    };
    const { received, store } = await peer(
      (request) => (request.method === "GET" ? missing : { status: 200 }),
      { uploadStallMs: 300 },
    );

    expect(await store.putImmutable(KEY, source)).toEqual({
      outcome: "created",
    });
    expect(opened).toBe(1);
    expect(received.find(({ method }) => method === "PUT")?.body).toEqual(
      bytes,
    );
  }, 20_000);
});

function sourceOf(
  bytes: Uint8Array,
): ImmutableObjectSource & { opened(): number } {
  let opened = 0;
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    async *open() {
      opened += 1;
      // One buffer refilled per chunk, as a file read may hand them out.
      const buffer = new Uint8Array(64 * 1024);
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        const piece = bytes.subarray(offset, offset + 64 * 1024);
        buffer.set(piece);
        yield buffer.subarray(0, piece.byteLength);
      }
    },
    opened: () => opened,
  };
}
