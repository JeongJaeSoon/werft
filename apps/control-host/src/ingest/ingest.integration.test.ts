// Real sockets: the listener, the SDK sink and a fake collector. No database.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import { parseTracingSettings } from "@werft-ai/observability";
import { createOtelSpanSink } from "@werft-ai/observability/otel";
import {
  attemptOf,
  authenticatorOf,
  batch,
  CountingDrops,
  TURN_TRACE,
  turnsOf,
} from "../testing/ingest.ts";
import { LoggedDropCounter, valueMasker } from "./adapters.ts";
import { startIngestListener } from "./start.ts";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const stops: Array<() => unknown> = [];
afterAll(async () => {
  for (const stop of stops) await stop();
});

interface Seen {
  headers: Record<string, string>;
  bytes: number;
}

function collector(answer: "ok" | "never") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({
        headers: Object.fromEntries(request.headers),
        bytes: (await request.arrayBuffer()).byteLength,
      });
      if (answer === "never") return new Promise<Response>(() => {});
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });
  stops.push(() => server.stop(true));
  return { seen, url: `http://127.0.0.1:${server.port}/v1/traces` };
}

function settingsFor(endpoint: string, extra: Record<string, string> = {}) {
  const settings = parseTracingSettings({
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    TRACE_INGEST_URL: "http://ingest.test:4319",
    ...extra,
  });
  if (settings === undefined) throw new Error("tracing off");
  return settings;
}

function listenerFor(
  settings: ReturnType<typeof settingsFor>,
  workspaces: Record<string, string | undefined>,
) {
  const sink = createOtelSpanSink(settings);
  const listener = startIngestListener({
    settings,
    port: 0,
    authenticator: authenticatorOf(
      Object.fromEntries(
        Object.entries(workspaces).map(([token, workspaceId], i) => [
          token,
          attemptOf({ attemptId: `att_${i}`, workspaceId }),
        ]),
      ),
    ),
    turns: turnsOf([TURN_TRACE]),
    sink,
    masker: valueMasker,
    drops: new CountingDrops(),
  });
  stops.push(() => listener.stop(true));
  return `http://127.0.0.1:${listener.port}/v1/traces`;
}

function send(url: string, body: string, token: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
  });
}

async function until(done: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
}

describe("tenant headers reach the collector per workspace", () => {
  test("TRACE_TENANT_HEADER and TRACE_TENANT_HEADERS_FILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-headers-"));
    try {
      const file = join(dir, "headers.json");
      writeFileSync(
        file,
        JSON.stringify({ [WS_B]: { "X-Collector-Key": "key-for-b" } }),
      );
      chmodSync(file, 0o600);
      const fake = collector("ok");
      const url = listenerFor(
        settingsFor(fake.url, {
          TRACE_TENANT_HEADER: "X-Scope-OrgID: {workspace_id}",
          TRACE_TENANT_HEADERS_FILE: file,
        }),
        { "tok-a": WS_A, "tok-b": WS_B, "tok-none": undefined },
      );
      for (const token of ["tok-a", "tok-b", "tok-none"]) {
        expect((await send(url, batch({}), token)).status).toBe(200);
      }
      await until(() => fake.seen.length >= 3);
      const tenants = fake.seen.map((s) => s.headers["x-scope-orgid"]);
      expect(tenants.sort()).toEqual([WS_A, WS_B, undefined].sort());
      const forB = fake.seen.find((s) => s.headers["x-scope-orgid"] === WS_B);
      expect(forB?.headers["x-collector-key"]).toBe("key-for-b");
      const forA = fake.seen.find((s) => s.headers["x-scope-orgid"] === WS_A);
      expect(forA?.headers["x-collector-key"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a collector that never answers", () => {
  test("ingest and a neighbouring heartbeat-like route keep their latency", async () => {
    const fake = collector("never");
    const url = listenerFor(settingsFor(fake.url), { tok: WS_A });
    // Stands in for heartbeat and next-input: any route the same process serves.
    const heartbeat = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    stops.push(() => heartbeat.stop(true));

    const ingestMs: number[] = [];
    const heartbeatMs: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      let started = performance.now();
      const response = await send(url, batch({}), "tok");
      ingestMs.push(performance.now() - started);
      expect(response.status).toBe(200);
      started = performance.now();
      await fetch(`http://127.0.0.1:${heartbeat.port}/heartbeat`);
      heartbeatMs.push(performance.now() - started);
    }
    await until(() => fake.seen.length > 0);
    expect(fake.seen.length).toBeGreaterThan(0);
    const max = (xs: number[]) => Math.max(...xs).toFixed(1);
    console.log(
      `stalled collector: ingest max ${max(ingestMs)} ms, heartbeat max ${max(heartbeatMs)} ms over 30 rounds`,
    );
    expect(Math.max(...ingestMs)).toBeLessThan(500);
    expect(Math.max(...heartbeatMs)).toBeLessThan(500);
  });
});

describe("two ports, one batch", () => {
  const big = batch({
    attributes: [["gen_ai.tool.call.result", "x".repeat(1024 * 1024)]],
  });

  test("the ingest port takes a batch the public port's cap refuses", async () => {
    expect(big.length).toBeGreaterThan(REQUEST_BODY_MAX_BYTES * 2);
    const fake = collector("ok");
    const url = listenerFor(settingsFor(fake.url), { tok: WS_A });
    expect((await send(url, big, "tok")).status).toBe(200);

    const publicLike = Bun.serve({
      port: 0,
      maxRequestBodySize: REQUEST_BODY_MAX_BYTES * 2,
      fetch: () => new Response("accepted"),
    });
    stops.push(() => publicLike.stop(true));
    const refused = await send(
      `http://127.0.0.1:${publicLike.port}/`,
      big,
      "tok",
    ).catch(() => undefined);
    expect(refused === undefined || refused.status === 413).toBe(true);
  });

  test("the public server's own cap is still the one in server.ts", async () => {
    const source = await Bun.file(
      new URL("../api/server.ts", import.meta.url),
    ).text();
    expect(source).toContain("maxRequestBodySize: REQUEST_BODY_MAX_BYTES * 2");
    expect(source).not.toContain("TRACE_INGEST_MAX_REQUEST_BYTES");
  });
});

test("LoggedDropCounter counts per reason", () => {
  const warnings: unknown[] = [];
  const drops = new LoggedDropCounter({
    warn: (...args) => void warnings.push(args),
  });
  drops.dropped("queue_full", 3);
  drops.dropped("queue_full", 2);
  expect(drops.snapshot().queue_full).toBe(5);
  expect(warnings).toHaveLength(1);
});
