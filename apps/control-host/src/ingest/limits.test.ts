import { describe, expect, test } from "bun:test";
import { ForwardQueue } from "./forward-queue.ts";
import { TraceByteBudget } from "./limits.ts";
import { decodeTraceRequest } from "./otlp-json.ts";
import { batch, CountingDrops } from "./test-support.ts";

describe("decoder bounds on repeated parts", () => {
  test("a huge scope name is cut, not carried on every span", () => {
    const body = JSON.parse(batch({}));
    body.resourceSpans[0].scopeSpans[0].scope.name = "s".repeat(1024 * 1024);
    const [span] = decodeTraceRequest(JSON.stringify(body));
    expect(span?.scope.name).toHaveLength(128);
  });

  test("the resource limit is in UTF-8 bytes", () => {
    const body = batch({ resource: [["service.name", "한".repeat(3000)]] });
    expect(() => decodeTraceRequest(body)).toThrow("too large");
  });
});

describe("TraceByteBudget", () => {
  test("a trace that used its budget stays over it after an idle hour", () => {
    let now = 0;
    const budget = new TraceByteBudget(1000, { now: () => now });
    expect(budget.charge("t", 1500).overBudget).toBe(false);
    expect(budget.charge("t", 1).overBudget).toBe(true);
    now += 2 * 60 * 60_000;
    expect(budget.charge("t", 1).overBudget).toBe(true);
  });

  test("another trace is unaffected", () => {
    const budget = new TraceByteBudget(1000, { now: () => 0 });
    budget.charge("a", 5000);
    expect(budget.charge("b", 10).overBudget).toBe(false);
  });
});

describe("ForwardQueue with a collector that never answers", () => {
  test("after several abandoned sends batches are dropped without waiting", async () => {
    const drops = new CountingDrops();
    const queue = new ForwardQueue(
      { send: () => new Promise<void>(() => {}) },
      drops,
      { maxQueuedSpans: 100, maxSpansPerSend: 1, sendTimeoutMs: 100 },
    );
    const spans = decodeTraceRequest(
      batch(...Array.from({ length: 8 }, () => ({}))),
    );
    const started = performance.now();
    queue.enqueue(spans);
    await queue.close(2000);
    // Four sends wait out their 100 ms; the other four are dropped at once.
    // Without the cap all eight wait: about 800 ms.
    expect(performance.now() - started).toBeLessThan(600);
    expect(drops.counts.send_failed).toBe(8);
  });
});
