import { describe, expect, test } from "bun:test";

import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import { createBoundedSpanExporter } from "./bounded-exporter.ts";
import { createOtelTracer } from "./otel-tracer.ts";

const settings = {
  serviceName: "werft-worker",
  sampler: { kind: "always_on", ratio: 1 },
  headers: {},
  tenantHeaders: () => ({}),
} as const;

async function finishedSpans(
  count: number,
  note = "x",
): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const tracer = createOtelTracer({
    ...settings,
    exporter: {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  for (let i = 0; i < count; i += 1) {
    await tracer.withSpan("s", { attributes: { note } }, async () => {});
  }
  await tracer.forceFlush();
  return spans;
}

function export_(
  exporter: ReturnType<typeof createBoundedSpanExporter>,
  spans: ReadableSpan[],
): void {
  exporter.export(spans, () => {});
}

describe("bounded span exporter", () => {
  test("export returns at once even when the sender never answers", async () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
    });
    const spans = await finishedSpans(3);
    const before = performance.now();
    let answered = false;
    exporter.export(spans, () => {
      answered = true;
    });
    expect(answered).toBe(true);
    expect(performance.now() - before).toBeLessThan(50);
  });

  test("sends OTLP JSON with the resource and the spans", async () => {
    const bodies: string[] = [];
    const exporter = createBoundedSpanExporter({
      send: async (body) => {
        bodies.push(new TextDecoder().decode(body));
      },
    });
    export_(exporter, await finishedSpans(2));
    await exporter.drained();
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0] as string);
    const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    expect(exporter.dropped()).toBe(0);
  });

  test("a full queue drops the oldest spans and counts them", async () => {
    const sent: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exporter = createBoundedSpanExporter({
      maxSpans: 5,
      chunkBytes: 1, // one span per request, so eviction is per span
      send: async (body) => {
        await gate;
        const parsed = JSON.parse(new TextDecoder().decode(body));
        sent.push(parsed.resourceSpans[0].scopeSpans[0].spans.length);
      },
    });
    export_(exporter, await finishedSpans(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await exporter.drained();
    expect(exporter.dropped()).toBe(3);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(5);
  });

  test("spans still waiting to be encoded count against the limit", async () => {
    const delivered: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exporter = createBoundedSpanExporter({
      send: async (body) => {
        await gate;
        delivered.push(
          JSON.parse(new TextDecoder().decode(body)).resourceSpans[0]
            .scopeSpans[0].spans.length,
        );
      },
      maxSpans: 10,
      chunkBytes: 1,
    });
    const spans = await finishedSpans(20);
    export_(exporter, spans.slice(0, 10));
    // Let the encoder start; every span yields because the chunk size is 1.
    await new Promise<void>((resolve) => setImmediate(resolve));
    export_(exporter, spans.slice(10));
    await Bun.sleep(20);

    expect(exporter.dropped()).toBeGreaterThanOrEqual(9);
    release();
    await exporter.drained();
    expect(exporter.dropped() + delivered.reduce((sum, n) => sum + n, 0)).toBe(
      20,
    );
  });

  test("spans still waiting to be encoded count against the byte limit", async () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
      maxBytes: 16 * 1024,
    });
    const spans = await finishedSpans(50, "x".repeat(4 * 1024));
    export_(exporter, spans);

    // Four spans' text fills the limit; the rest are lost, not held.
    expect(exporter.dropped()).toBeGreaterThanOrEqual(45);
  });

  test("a long error message counts against the byte limit too", async () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
      maxBytes: 16 * 1024,
    });
    const spans: ReadableSpan[] = [];
    const tracer = createOtelTracer({
      ...settings,
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    for (let i = 0; i < 50; i += 1) {
      const span = tracer.startSpan("s", {});
      span.setError("e".repeat(4 * 1024));
      span.end();
    }
    await tracer.forceFlush();
    export_(exporter, spans);

    expect(exporter.dropped()).toBeGreaterThanOrEqual(45);
  });

  test("a large attribute key counts against the byte limit", async () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
      maxBytes: 16 * 1024,
    });
    const spans: ReadableSpan[] = [];
    const tracer = createOtelTracer({
      ...settings,
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    for (let i = 0; i < 50; i += 1) {
      const span = tracer.startSpan("s", {
        attributes: { [`k${i}-${"x".repeat(4 * 1024)}`]: 1 },
      });
      span.end();
    }
    await tracer.forceFlush();
    export_(exporter, spans);

    expect(exporter.dropped()).toBeGreaterThanOrEqual(45);
  });

  test("a long array attribute counts per element against the byte limit", () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
      maxBytes: 16 * 1024,
    });
    const span = {
      name: "s",
      status: { code: 0 },
      attributes: { a: Array(1_000).fill("") },
      events: [],
      links: [],
    } as unknown as ReadableSpan;
    export_(exporter, [span]);

    expect(exporter.dropped()).toBe(1);
  });

  test("with exportOnEnd every span the SDK finishes is counted, delivered or dropped", async () => {
    const exporter = createBoundedSpanExporter({
      send: () => new Promise<void>(() => {}),
      maxSpans: 100,
    });
    const tracer = createOtelTracer({
      ...settings,
      exporter,
      exportOnEnd: true,
    });
    for (let i = 0; i < 3000; i += 1) {
      await tracer.withSpan("s", {}, async () => {});
    }
    await Bun.sleep(30);

    expect(exporter.dropped()).toBe(2900);
  });

  test("the byte limit evicts too", async () => {
    const exporter = createBoundedSpanExporter({
      maxBytes: 3000,
      chunkBytes: 1,
      send: () => new Promise<void>(() => {}),
    });
    export_(exporter, await finishedSpans(20, "y".repeat(200)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exporter.dropped()).toBeGreaterThan(10);
  });

  test("a refused request counts its spans as dropped and is not retried", async () => {
    let calls = 0;
    const exporter = createBoundedSpanExporter({
      send: async () => {
        calls += 1;
        throw new Error("503");
      },
    });
    export_(exporter, await finishedSpans(3));
    await exporter.drained();
    expect(calls).toBe(1);
    expect(exporter.dropped()).toBe(3);
  });

  test("a large batch is serialized in pieces below the chunk size", async () => {
    const sizes: number[] = [];
    const exporter = createBoundedSpanExporter({
      chunkBytes: 4096,
      send: async (body) => {
        sizes.push(body.byteLength);
      },
    });
    export_(exporter, await finishedSpans(60, "z".repeat(300)));
    await exporter.drained();
    expect(sizes.length).toBeGreaterThan(3);
    for (const size of sizes) expect(size).toBeLessThan(4096 + 2000);
  });
});
