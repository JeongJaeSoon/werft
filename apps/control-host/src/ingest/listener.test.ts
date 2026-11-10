import { describe, expect, test } from "bun:test";
import { turnTraceId } from "@werft-ai/observability";
import { valueMasker } from "./adapters.ts";
import { ForwardQueue } from "./forward-queue.ts";
import { createIngestHandler, type IngestLimits } from "./listener.ts";
import {
  attemptOf,
  authenticatorOf,
  batch,
  CountingDrops,
  post,
  RecordingSink,
  SESSION,
  TURN_TRACE,
  turnsOf,
} from "./test-support.ts";

const LIMITS: IngestLimits = {
  maxRequestBytes: 4 * 1024 * 1024,
  maxBytesPerMinute: 32 * 1024 * 1024,
  maxBytesPerTrace: 20 * 1024 * 1024,
  fencedGraceSec: 300,
  maxConcurrent: 8,
};

function setup(
  options: {
    limits?: Partial<IngestLimits>;
    attempts?: Parameters<typeof authenticatorOf>[0];
    now?: () => number;
  } = {},
) {
  const sink = new RecordingSink();
  const drops = new CountingDrops();
  const handler = createIngestHandler({
    authenticator: authenticatorOf(options.attempts ?? { tok: attemptOf() }),
    turns: turnsOf([TURN_TRACE]),
    queue: new ForwardQueue(sink, drops),
    masker: valueMasker,
    drops,
    contentMode: () => "full",
    limits: { ...LIMITS, ...options.limits },
    ...(options.now === undefined ? {} : { clock: { now: options.now } }),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { handler, sink, drops, flush };
}

describe("authentication and fence", () => {
  test("another session's credential, a missing one and a wrong one are refused", async () => {
    const { handler, sink } = setup();
    const unknown = await handler(post(batch({}), "other-session-token"));
    expect(unknown.status).toBe(401);
    const none = await handler(
      new Request("http://ingest.test/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: batch({}),
      }),
    );
    expect(none.status).toBe(401);
    expect(sink.sent).toHaveLength(0);
  });

  test("an attempt that lost its fence is refused after the grace", async () => {
    const now = 10_000_000;
    const { handler, sink, flush } = setup({
      now: () => now,
      attempts: {
        tok: attemptOf({
          fence: { state: "lost", lostAt: new Date(now - 301_000) },
        }),
      },
    });
    expect((await handler(post(batch({})))).status).toBe(409);
    await flush();
    expect(sink.sent).toHaveLength(0);
  });

  test("inside the grace the data is taken and marked fenced", async () => {
    const now = 10_000_000;
    const { handler, sink, flush } = setup({
      now: () => now,
      attempts: {
        tok: attemptOf({
          fence: { state: "lost", lostAt: new Date(now - 60_000) },
        }),
      },
    });
    expect((await handler(post(batch({})))).status).toBe(200);
    await flush();
    expect(sink.sent[0]?.attributes["werft.fenced"]).toBe(true);
  });

  test("a held attempt's spans carry no fenced mark", async () => {
    const { handler, sink, flush } = setup();
    await handler(post(batch({})));
    await flush();
    expect("werft.fenced" in (sink.sent[0]?.attributes ?? {})).toBe(false);
  });
});

describe("trace id pinning", () => {
  test("a span outside this attempt's turns is dropped and counted", async () => {
    const { handler, sink, drops, flush } = setup();
    const foreign = turnTraceId(SESSION, 99);
    const response = await handler(
      post(batch({ traceId: foreign }, {}, { traceId: foreign })),
    );
    await flush();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedSpans: 2 },
    });
    expect(sink.sent).toHaveLength(1);
    expect(drops.counts.foreign_trace).toBe(2);
  });

  test("the same turn number in another session is a different trace id", () => {
    expect(turnTraceId("00000000-0000-4000-8000-000000000002", 1)).not.toBe(
      TURN_TRACE,
    );
  });
});

describe("limits", () => {
  test("a body over the ingest limit is refused with 413", async () => {
    const { handler } = setup({ limits: { maxRequestBytes: 1024 } });
    const big = batch({
      attributes: [["gen_ai.tool.call.result", "x".repeat(4096)]],
    });
    expect((await handler(post(big))).status).toBe(413);
  });

  test("a batch of nearly 4 MiB is accepted", async () => {
    const { handler, sink, flush } = setup();
    const body = batch({
      attributes: [["gen_ai.tool.call.result", "x".repeat(3.9 * 1024 * 1024)]],
    });
    expect(body.length).toBeLessThanOrEqual(LIMITS.maxRequestBytes);
    expect((await handler(post(body))).status).toBe(200);
    await flush();
    expect(sink.sent).toHaveLength(1);
  });

  test("past the per-minute byte cap the answer is 429 and the drop is counted", async () => {
    let now = 5_000_000;
    const body = batch({});
    const { handler, drops } = setup({
      now: () => now,
      limits: { maxBytesPerMinute: body.length * 2 },
    });
    expect((await handler(post(body))).status).toBe(200);
    expect((await handler(post(body))).status).toBe(200);
    const limited = await handler(post(body));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(drops.counts.rate_limited).toBe(1);
    now += 61_000;
    expect((await handler(post(body))).status).toBe(200);
  });

  test("past the per-trace cap later spans lose content and say so", async () => {
    const { handler, sink, flush } = setup({
      limits: { maxBytesPerTrace: 2000 },
    });
    const content: [string, string][] = [
      ["gen_ai.tool.call.result", "y".repeat(3000)],
    ];
    await handler(post(batch({ attributes: content })));
    await handler(post(batch({ attributes: content })));
    await flush();
    const [first, second] = sink.sent;
    expect(first?.attributes["gen_ai.tool.call.result"]).toBeDefined();
    expect("gen_ai.tool.call.result" in (second?.attributes ?? {})).toBe(false);
    expect(second?.attributes["werft.content_dropped"]).toBe(true);
  });

  test("a full queue drops spans and counts them", async () => {
    const drops = new CountingDrops();
    const stuck = { send: () => new Promise<void>(() => {}) };
    const queue = new ForwardQueue(stuck, drops, {
      maxQueuedSpans: 2,
      maxSpansPerSend: 1,
      sendTimeoutMs: 60_000,
    });
    const handler = createIngestHandler({
      authenticator: authenticatorOf({ tok: attemptOf() }),
      turns: turnsOf([TURN_TRACE]),
      queue,
      masker: valueMasker,
      drops,
      contentMode: () => "full",
      limits: LIMITS,
    });
    for (let i = 0; i < 5; i += 1) await handler(post(batch({})));
    expect(drops.counts.queue_full).toBeGreaterThan(0);
  });
});

describe("request shape", () => {
  test("only POST /v1/traces with application/json and no encoding", async () => {
    const { handler } = setup();
    const get = await handler(new Request("http://ingest.test/v1/traces"));
    expect(get.status).toBe(405);
    const other = await handler(
      new Request("http://ingest.test/v1/metrics", { method: "POST" }),
    );
    expect(other.status).toBe(404);
    const proto = await handler(
      post(batch({}), "tok", { "content-type": "application/x-protobuf" }),
    );
    expect(proto.status).toBe(415);
    const gzip = await handler(
      post(batch({}), "tok", { "content-encoding": "gzip" }),
    );
    expect(gzip.status).toBe(415);
    expect((await handler(post("not json"))).status).toBe(400);
  });
});
