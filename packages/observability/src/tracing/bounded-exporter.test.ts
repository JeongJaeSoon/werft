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
