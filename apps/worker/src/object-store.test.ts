import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { ObjectIntegrityError } from "@werft-ai/runtime-core";
import {
  BodyLimitError,
  BodyStallError,
  BodyTruncatedError,
  createCheckpointObjectStore,
  createObjectRouteClient,
  S3_METADATA_REQUEST_TIMEOUT_MS,
} from "@werft-ai/storage";

import {
  createWorkerObjectStore,
  holdingS3Client,
  isObjectStoreOutage,
  ObjectStoreToken,
  objectStoreConfigFromEnv,
  resentUntilLeaseEnds,
  TRANSCRIPT_RESEND_CEILING_MS,
} from "./object-store.ts";

const base = {
  AWS_REGION: "ap-northeast-1",
  S3_BUCKET: "claude-sessions",
  WORKER_OBJECT_PREFIX: "sessions/s1/",
};
const ROUTE = "http://egress-proxy:3129";

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("holdingS3Client", () => {
  test("each request of a write waits while ownership is unconfirmed, and none is sent once it is lost", async () => {
    const sent: string[] = [];
    const doubt = Promise.withResolvers<void>();
    let unconfirmed: Promise<void> | undefined;
    const store = createCheckpointObjectStore({
      bucket: "claude-sessions",
      client: holdingS3Client(
        {
          async send(command) {
            const { name } = (command as { constructor: { name: string } })
              .constructor;
            sent.push(name);
            if (name !== "GetObjectCommand") return {};
            // The write's own existence read answers, and ownership goes
            // unconfirmed before the PUT that read decides.
            unconfirmed = doubt.promise;
            throw Object.assign(new Error("no such key"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            });
          },
        },
        () => unconfirmed,
      ),
    });

    const put = store.putImmutable("sessions/s1/a", new Uint8Array([1]));
    await Bun.sleep(5);
    expect(sent).toEqual(["GetObjectCommand"]);

    doubt.resolve();
    unconfirmed = undefined;
    expect(await put).toEqual({ outcome: "created" });
    expect(sent).toEqual(["GetObjectCommand", "PutObjectCommand"]);

    unconfirmed = Promise.reject(new Error("Not sent: the lease was lost"));
    await expect(
      store.putImmutable("sessions/s1/b", new Uint8Array([2])),
    ).rejects.toThrow("Not sent");
    expect(sent).toHaveLength(2);
  });

  test("a held request reads ownership again when its wait ends, before it is sent", async () => {
    const sent: unknown[] = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let unconfirmed: Promise<void> | undefined = first.promise;
    const client = holdingS3Client(
      {
        async send(command) {
          sent.push(command);
          return {};
        },
      },
      () => unconfirmed,
    );
    // Confirmed, and unconfirmed again before the held request resumes.
    void first.promise.then(() => {
      unconfirmed = second.promise;
    });

    const request = client.send("put");
    first.resolve();
    await Bun.sleep(5);
    expect(sent).toEqual([]);

    unconfirmed = undefined;
    second.resolve();
    await request;
    expect(sent).toEqual(["put"]);
  });
});

describe("a streamed upload the route takes and never answers", () => {
  test("is cut at the stall bound, and is not sent again once the lease is lost", async () => {
    const accepted: Socket[] = [];
    let puts = 0;
    let lost = false;
    const server = createServer((socket) => {
      accepted.push(socket);
      socket.on("data", (chunk) => {
        if (!chunk.toString("latin1").startsWith("PUT ")) return;
        puts += 1;
        // The lease ends while the first upload is still out.
        lost = true;
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(() => {
      for (const socket of accepted) socket.destroy();
      server.close();
    });
    const { port } = server.address() as { port: number };
    // As `createWorkerObjectStore` builds it, with a stall bound a test can wait out.
    const store = createCheckpointObjectStore({
      bucket: base.S3_BUCKET,
      client: holdingS3Client(
        createObjectRouteClient({
          endpoint: `http://127.0.0.1:${port}/object-store`,
          region: base.AWS_REGION,
          token: () => "weo_token",
        }),
        () =>
          lost
            ? Promise.reject(new Error("Not sent: the lease was lost"))
            : undefined,
      ),
      uploadStallMs: 300,
    });
    const bytes = new Uint8Array(698).fill(7);

    const startedAt = Date.now();
    const failure = await store
      .putImmutable(
        "sessions/s1/workspace.bundle",
        {
          bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          async *open() {
            yield bytes;
          },
        },
        { contentAddressed: true },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // One upload went out and was cut; the retries after it were never sent.
    expect((failure as Error | undefined)?.message).toContain("Not sent");
    expect(puts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 20_000);
});

describe("objectStoreConfigFromEnv", () => {
  test("reads the bucket, region and session prefix, and goes through the route", () => {
    expect(objectStoreConfigFromEnv(base, ROUTE)).toEqual({
      bucket: "claude-sessions",
      endpoint: "http://egress-proxy:3129/object-store",
      region: "ap-northeast-1",
      scope: "sessions/s1/",
    });
  });

  test("an object store credential in the environment is not read", () => {
    // the worker is never handed one, and one that turned up anyway
    // would not be used to reach the store.
    const config = objectStoreConfigFromEnv(
      {
        ...base,
        AWS_ACCESS_KEY_ID: "control-host-key",
        AWS_SECRET_ACCESS_KEY: "control-host-secret",
        AWS_ENDPOINT_URL: "http://localstack:4566",
      } as typeof base,
      ROUTE,
    );
    expect(JSON.stringify(config)).not.toContain("control-host");
    expect(config.endpoint).toBe("http://egress-proxy:3129/object-store");
  });

  test("every variable is required and the prefix must be a key prefix", () => {
    for (const name of [
      "AWS_REGION",
      "S3_BUCKET",
      "WORKER_OBJECT_PREFIX",
    ] as const) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, [name]: undefined }, ROUTE),
      ).toThrow(name);
      expect(() =>
        objectStoreConfigFromEnv({ ...base, [name]: " " }, ROUTE),
      ).toThrow(name);
    }
    for (const prefix of [
      "sessions/s1",
      "/sessions/s1/",
      "sessions/../",
      "sessions/./s1/",
      "sessions//s1/",
      "/",
    ]) {
      expect(() =>
        objectStoreConfigFromEnv(
          { ...base, WORKER_OBJECT_PREFIX: prefix },
          ROUTE,
        ),
      ).toThrow("WORKER_OBJECT_PREFIX");
    }
  });
});

/** Records what reaches it and answers like S3 would a create-only put. */
type Seen = { method: string; url: string; headers: Headers };

function fakeRoute(): { requests: Seen[]; url: string } {
  const requests: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      // Copied: Bun empties a request once its handler is done with it.
      requests.push({
        method: request.method,
        url: request.url,
        headers: new Headers(request.headers),
      });
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    },
  });
  closers.push(() => server.stop(true));
  return { requests, url: `http://127.0.0.1:${server.port}` };
}

describe("createWorkerObjectStore against a route that never answers", () => {
  test("a request gives up within its bound, says so in one line, and counts as an outage", async () => {
    const accepted: Socket[] = [];
    const server = createServer((socket) => {
      accepted.push(socket);
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(() => {
      for (const socket of accepted) socket.destroy();
      server.close();
    });
    const { port } = server.address() as { port: number };
    const token = new ObjectStoreToken();
    token.useToken("weo_token");
    const warned: Array<Record<string, unknown>> = [];
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv(base, `http://127.0.0.1:${port}`),
      () => token.current(),
      undefined,
      (message, fields) => warned.push({ message, ...fields }),
    );

    const startedAt = Date.now();
    const failure = await store.head("sessions/s1/manifest").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error | undefined)?.name).toBe("TimeoutError");
    expect(isObjectStoreOutage(failure)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(
      S3_METADATA_REQUEST_TIMEOUT_MS * 3 + 5_000,
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      bucket: "claude-sessions",
      code: "ETIMEDOUT",
      message: "S3 request ended without an answer",
      operation: "HeadObject",
    });
    expect(JSON.stringify(warned)).not.toContain("manifest");
    expect(JSON.stringify(warned)).not.toContain("weo_token");
  }, 40_000);
});

describe("createWorkerObjectStore", () => {
  test("refuses a key outside the session prefix without touching the network", async () => {
    const route = fakeRoute();
    const token = new ObjectStoreToken();
    token.useToken("weo_token");
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv(base, route.url),
      () => token.current(),
    );
    await expect(store.get("sessions/s2/x")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
    await expect(store.list("sessions/")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
    expect(route.requests).toEqual([]);
  });

  test("opens a connection for every request, so an upload never rides one kept from the request before", async () => {
    let connections = 0;
    const accepted: Socket[] = [];
    // Answers on a connection it would gladly keep open.
    const server = createServer((socket) => {
      connections += 1;
      accepted.push(socket);
      socket.on("data", () =>
        socket.write("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(() => {
      for (const socket of accepted) socket.destroy();
      server.close();
    });
    const { port } = server.address() as { port: number };
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv(base, `http://127.0.0.1:${port}`),
      () => "weo_token",
    );

    expect(await store.head("sessions/s1/a")).toBeUndefined();
    expect(await store.head("sessions/s1/b")).toBeUndefined();
    expect(await store.head("sessions/s1/c")).toBeUndefined();
    expect(connections).toBe(3);
  });

  test("sends nothing before the claim hands out its token", async () => {
    const route = fakeRoute();
    const token = new ObjectStoreToken();
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv(base, route.url),
      () => token.current(),
    );
    await expect(
      store.putImmutable("sessions/s1/x", new TextEncoder().encode("x")),
    ).rejects.toThrow("used before the claim");
    expect(route.requests).toEqual([]);
  });

  test("an S3 request goes to the route with the token where the access key id goes", async () => {
    const route = fakeRoute();
    const token = new ObjectStoreToken();
    token.useToken("weo_token");
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv(base, route.url),
      () => token.current(),
    );
    await store.putImmutable(
      "sessions/s1/transcript/part-0",
      new Uint8Array([1, 2]),
      { contentAddressed: true },
    );
    expect(route.requests).toHaveLength(1);
    const [put] = route.requests;
    expect(put?.method).toBe("PUT");
    expect(put?.headers.get("if-none-match")).toBe("*");
    expect(new URL(put?.url ?? "http://missing").pathname).toBe(
      "/object-store/claude-sessions/sessions/s1/transcript/part-0",
    );
    expect(put?.headers.get("authorization")).toContain(
      "Credential=weo_token/",
    );
  });
});

describe("resentUntilLeaseEnds", () => {
  const outage = () =>
    Object.assign(new Error("status 503"), {
      $metadata: { httpStatusCode: 503 },
    });
  /** A clock the waits advance, and a lease that runs down on it. */
  function leased(leftMs: () => number) {
    let now = 0;
    const waits: number[] = [];
    return {
      waits,
      leaseLeftMs: () => Math.max(0, leftMs() - now),
      hooks: {
        now: () => now,
        sleep: async (ms: number) => {
          waits.push(ms);
          now += ms;
        },
      },
    };
  }

  test("a write the store did not answer is kept and sent again on the heartbeat's backoff until it lands", async () => {
    const lease = leased(() => 20_000);
    const held: unknown[] = [];
    const resent: number[] = [];
    let refused = 3;
    let landed = 0;
    await resentUntilLeaseEnds(
      async () => {
        if (refused-- > 0) throw outage();
        landed += 1;
      },
      lease.leaseLeftMs,
      {
        ...lease.hooks,
        onHeld: (error) => held.push(error),
        onResent: (outages) => resent.push(outages),
      },
    );
    expect(landed).toBe(1);
    expect(lease.waits).toEqual([1_000, 2_000, 4_000]);
    expect(held).toHaveLength(1);
    expect(resent).toEqual([3]);
  });

  test("an outage is never taken for the store's answer: the write fails at the lease's end, never reported done", async () => {
    const lease = leased(() => 10_000);
    let sent = 0;
    const done = resentUntilLeaseEnds(
      async () => {
        sent += 1;
        throw outage();
      },
      lease.leaseLeftMs,
      {
        ...lease.hooks,
        onResent: () => {
          throw new Error("reported done without the store taking it");
        },
      },
    );
    await expect(done).rejects.toThrow("status 503");
    // The last wait is cut to what the lease had left, and nothing is sent
    // once it is over.
    expect(lease.waits).toEqual([1_000, 2_000, 4_000, 3_000]);
    expect(sent).toBe(4);
  });

  test("a lease renewed meanwhile keeps the batch being sent, and no send starts past the ceiling", async () => {
    let now = 0;
    const waits: number[] = [];
    const sentAt: number[] = [];
    const done = resentUntilLeaseEnds(
      async () => {
        sentAt.push(now);
        throw outage();
      },
      // Renewed at every look: always five seconds left.
      () => 5_000,
      {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    );
    await expect(done).rejects.toThrow("status 503");
    // Past the five seconds the lease had at the first outage, to the ceiling.
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(now).toBe(TRANSCRIPT_RESEND_CEILING_MS);
    expect(Math.max(...sentAt)).toBeLessThan(TRANSCRIPT_RESEND_CEILING_MS);
  });

  test("a lease that ends during the wait is not written under", async () => {
    let now = 0;
    const sentAt: number[] = [];
    const done = resentUntilLeaseEnds(
      async () => {
        sentAt.push(now);
        throw outage();
      },
      () => Math.max(0, 1_000 - now),
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    await expect(done).rejects.toThrow("status 503");
    expect(sentAt).toEqual([0]);
  });

  test("a refusal, or an outage with no lease left, fails the write at once", async () => {
    const lease = leased(() => 20_000);
    const refusal = Object.assign(new Error("status 403"), {
      $metadata: { httpStatusCode: 403 },
    });
    await expect(
      resentUntilLeaseEnds(
        async () => {
          throw refusal;
        },
        lease.leaseLeftMs,
        lease.hooks,
      ),
    ).rejects.toBe(refusal);
    const none = leased(() => 0);
    await expect(
      resentUntilLeaseEnds(
        async () => {
          throw outage();
        },
        none.leaseLeftMs,
        none.hooks,
      ),
    ).rejects.toThrow("status 503");
    expect([...lease.waits, ...none.waits]).toEqual([]);
  });
});

describe("isObjectStoreOutage", () => {
  const answered = (status: number) =>
    Object.assign(new Error(`status ${status}`), {
      $metadata: { httpStatusCode: status },
    });
  const coded = (code: string) =>
    Object.assign(new Error(`failed: ${code}`), { code });

  test("is the store failing to answer", () => {
    for (const error of [
      answered(500),
      answered(503),
      answered(408),
      answered(429),
      coded("ECONNREFUSED"),
      coded("ECONNRESET"),
      coded("ConnectionRefused"),
      Object.assign(
        new Error("S3 endpoint name was not resolved within 3000ms"),
        {
          name: "TimeoutError",
        },
      ),
      new Error("S3 object body stalled 3 times: k", {
        cause: new BodyStallError("stalled"),
      }),
      new BodyTruncatedError("S3 object k ended after 3 of its 9 bytes"),
    ]) {
      expect({
        error: error.message,
        outage: isObjectStoreOutage(error),
      }).toEqual({ error: error.message, outage: true });
    }
  });

  test("is not an answer, however unwelcome", () => {
    for (const error of [
      answered(400),
      answered(401),
      answered(403),
      answered(404),
      new ObjectIntegrityError("k"),
      new BodyLimitError("too long"),
      new Error("S3 object has no body: k"),
      coded("ENOSPC"),
      "ECONNRESET",
    ]) {
      expect(isObjectStoreOutage(error)).toBe(false);
    }
  });
});
