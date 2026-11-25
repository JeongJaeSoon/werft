import { afterEach, describe, expect, test } from "bun:test";
import { ObjectIntegrityError } from "@werft-ai/runtime-core";
import {
  BodyLimitError,
  BodyStallError,
  BodyTruncatedError,
  createCheckpointObjectStore,
} from "@werft-ai/storage";

import {
  createWorkerObjectStore,
  holdingS3Client,
  isObjectStoreOutage,
  ObjectStoreToken,
  objectStoreConfigFromEnv,
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
