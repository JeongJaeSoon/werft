import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@werft-ai/contracts";
import { currentDeadline } from "@werft-ai/db/pool";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { createApiApp } from "./app.ts";
import {
  beyondRequest,
  CLOSING_IDLE_TIMEOUT_SECONDS,
  readBodyWithin,
} from "./deadline.ts";

function appWith(
  options: Pick<
    Parameters<typeof createApiApp>[0] & object,
    "registerRoutes" | "registerPublicRoutes" | "registerInternalRoutes"
  >,
) {
  const sink = new MemoryLogSink();
  const app = createApiApp({
    authMode: "none",
    logger: new StructuredLogger({ sinks: [sink] }),
    requestDeadlineMs: 50,
    ...options,
  });
  return { app, sink };
}

const owner = { "X-Owner-Id": "local-owner" };
const never = new Promise<never>(() => {});

describe("request deadline", () => {
  test("a /v1 handler that outlives the deadline answers a retryable 503", async () => {
    const { app, sink } = appWith({
      registerRoutes: (router) => {
        router.get("/stuck", async () => await never);
      },
    });
    const started = performance.now();
    const response = await app.request("/v1/stuck", { headers: owner });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(response.status).toBe(503);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(body.error.request_id).toBe(
      response.headers.get("X-Request-Id") ?? "",
    );
    expect(
      sink.records.find(
        (record) => record.message === "API request deadline exceeded",
      )?.fields,
    ).toMatchObject({ method: "GET", path: "/v1/stuck", deadline_ms: 50 });
  });

  test("covers the public /v1 routes but not /internal", async () => {
    const { app } = appWith({
      registerPublicRoutes: (router) => {
        router.get("/auth/stuck", async () => await never);
      },
      registerInternalRoutes: (router) => {
        router.get("/slow", async (context) => {
          await Bun.sleep(120);
          return context.json({ ok: true });
        });
      },
    });
    expect((await app.request("/v1/auth/stuck")).status).toBe(503);
    // A worker long poll legitimately waits longer than any API deadline.
    expect((await app.request("/internal/slow")).status).toBe(200);
  });

  test("what a timed-out handler must still write runs under a deadline of its own", async () => {
    let late: Promise<Array<number | undefined>> | undefined;
    const { app } = appWith({
      registerRoutes: (router) => {
        router.get("/slow", async () => {
          late = (async () => {
            await Bun.sleep(80);
            return [
              currentDeadline()?.remainingMs(),
              await beyondRequest(async () =>
                currentDeadline()?.remainingMs(),
              )(),
            ];
          })();
          return await never;
        });
      },
    });
    const response = await app.request("/v1/slow", { headers: owner });
    expect(response.status).toBe(503);
    const [ofRequest, ofItsOwn] = (await late) ?? [];
    expect(ofRequest).toBeLessThanOrEqual(0);
    expect(ofItsOwn).toBeGreaterThan(0);
  });

  test("statements see the budget while the handler runs and none once it has answered", async () => {
    let during: number | undefined;
    let afterward: number | undefined = -1;
    let late: number | undefined = -1;
    let resume = () => {};
    const { app } = appWith({
      registerRoutes: (router) => {
        router.get("/stream", () => {
          during = currentDeadline()?.remainingMs();
          // An SSE stream reads long after the handler returned.
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(80);
              afterward = currentDeadline()?.remainingMs();
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
            },
          });
          return new Response(body);
        });
        router.get("/abandoned", async () => {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
          late = currentDeadline()?.remainingMs();
          return new Response("too late");
        });
      },
    });
    const streamed = await app.request("/v1/stream", { headers: owner });
    expect(await streamed.text()).toBe("ok");
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(50);
    expect(afterward).toBeUndefined();

    // After an expiry the deadline stays in force for the handler that was
    // abandoned, so its next statement fails instead of writing.
    expect(
      (await app.request("/v1/abandoned", { headers: owner })).status,
    ).toBe(503);
    resume();
    await Bun.sleep(0);
    expect(late).toBeLessThanOrEqual(0);
  });

  test("a handler that answers in time is untouched", async () => {
    const { app } = appWith({
      registerRoutes: (router) => {
        router.get("/quick", (context) => context.json({ ok: true }));
        router.get("/fails", () => {
          throw new Error("boom");
        });
      },
    });
    expect(
      await (await app.request("/v1/quick", { headers: owner })).json(),
    ).toEqual({ ok: true });
    // Hono's own error path still decides the answer before the deadline.
    expect((await app.request("/v1/fails", { headers: owner })).status).toBe(
      500,
    );
  });
  // Bun keeps a socket whose request bytes are unread open for the whole idle
  // clock, `Connection: close` or not.
  test("a response that closes the connection gets the short idle clock", async () => {
    const { app } = appWith({
      registerRoutes: (router) => {
        router.post("/closing", (context) => {
          context.header("Connection", "close");
          return context.json({ ok: false }, 408);
        });
      },
    });
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    const response = await app.request(
      "/v1/closing",
      { method: "POST", headers: owner },
      env,
    );
    expect(response.status).toBe(408);
    expect(calls.at(-1)).toBe(CLOSING_IDLE_TIMEOUT_SECONDS);
  });

  test("an NDJSON export leaves the idle clock off, like an event stream", async () => {
    const { app } = appWith({
      registerRoutes: (router) => {
        router.get("/export", (context) => {
          context.header("Content-Type", "application/x-ndjson");
          return context.body("{}\n");
        });
      },
    });
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    const response = await app.request("/v1/export", { headers: owner }, env);
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toBe(0);
  });
});

describe("readBodyWithin", () => {
  const post = (body: ReadableStream<Uint8Array> | string) =>
    new Request("http://api.test/v1/x", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

  test("a sender that drips bytes forever is cut off at the deadline and its read cancelled", async () => {
    let cancelled = false;
    const drip = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(10);
        controller.enqueue(new Uint8Array([0x20]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    const read = await readBodyWithin(post(drip), 100, 1024);
    expect(read.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1_000);
    await Bun.sleep(20);
    expect(cancelled).toBe(true);
  });

  test("returns the bytes of a body that arrives in time", async () => {
    const read = await readBodyWithin(post('{"a":1}'), 1_000, 1024);
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(new TextDecoder().decode(read.bytes)).toBe('{"a":1}');
    expect(read.size).toBe(7);
  });

  test("drains an oversized body but keeps none of it", async () => {
    const read = await readBodyWithin(post("x".repeat(2048)), 1_000, 1024);
    expect(read).toMatchObject({ kind: "read", size: 2048 });
    if (read.kind !== "read") return;
    expect(read.bytes.byteLength).toBe(0);
  });
});
