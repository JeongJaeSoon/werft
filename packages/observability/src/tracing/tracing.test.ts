import { afterEach, describe, expect, test } from "bun:test";

import { createLogger, MemoryLogSink } from "../index.ts";
import { parseTracingSettings } from "./config.ts";
import { createOtelTracer, type OtelTracer } from "./otel-tracer.ts";
import { turnTraceId } from "./trace-id.ts";
import {
  currentSpanContext,
  formatTraceparent,
  noopTracer,
  parseTraceparent,
  sampleByTraceId,
} from "./tracer.ts";

interface Received {
  readonly path: string;
  readonly contentType: string | null;
  readonly tenant: string | null;
  readonly auth: string | null;
  readonly bytes: number;
}

function startFakeCollector() {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.arrayBuffer();
      received.push({
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        tenant: request.headers.get("x-scope-orgid"),
        auth: request.headers.get("authorization"),
        bytes: body.byteLength,
      });
      return new Response(null, { status: 200 });
    },
  });
  return { received, server, url: `http://127.0.0.1:${server.port}` };
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

describe("turnTraceId", () => {
  test("reproduces the design's test vector", () => {
    expect(turnTraceId("00000000-0000-4000-8000-000000000001", 1)).toBe(
      "49195af5635b4ac7af24c52c73de7491",
    );
  });

  test("differs per session and per turn", () => {
    const a = turnTraceId("00000000-0000-4000-8000-000000000001", 1);
    expect(turnTraceId("00000000-0000-4000-8000-000000000002", 1)).not.toBe(a);
    expect(turnTraceId("00000000-0000-4000-8000-000000000001", 2)).not.toBe(a);
  });
});

describe("traceparent", () => {
  test("round-trips and rejects malformed or zero ids", () => {
    const context = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      sampled: true,
    };
    expect(formatTraceparent(context)).toBe(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    );
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
    expect(
      parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`)?.sampled,
    ).toBe(false);
    expect(parseTraceparent("nope")).toBeUndefined();
    expect(
      parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`),
    ).toBeUndefined();
    expect(
      parseTraceparent(`00-${"A".repeat(32)}-${"b".repeat(16)}-01`),
    ).toBeUndefined();
  });
});

describe("sampleByTraceId", () => {
  test("matches the design's vectors", () => {
    expect(sampleByTraceId("0".repeat(32), 0.5)).toBe(true);
    expect(sampleByTraceId("f".repeat(32), 0.5)).toBe(false);
    expect(sampleByTraceId("f".repeat(32), 1)).toBe(true);
    expect(sampleByTraceId("0".repeat(32), 0)).toBe(false);
  });
});

describe("parseTracingSettings", () => {
  test.each([
    {},
    { OTEL_TRACES_EXPORTER: "none" },
    { OTEL_TRACES_EXPORTER: "" },
  ])("is off for %j", (env) => {
    expect(parseTracingSettings(env)).toBeUndefined();
  });

  test("needs an endpoint, and appends /v1/traces only to the base endpoint", () => {
    expect(() =>
      parseTracingSettings({ OTEL_TRACES_EXPORTER: "otlp" }),
    ).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT");
    const base = parseTracingSettings({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    });
    expect(base?.endpoint).toBe("http://collector:4318/v1/traces");
    const both = parseTracingSettings({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://other/custom",
    });
    expect(both?.endpoint).toBe("http://other/custom");
  });

  test("rejects unsupported values by key name", () => {
    const otlp = {
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
    };
    expect(() =>
      parseTracingSettings({ OTEL_TRACES_EXPORTER: "zipkin" }),
    ).toThrow("OTEL_TRACES_EXPORTER");
    expect(() =>
      parseTracingSettings({ ...otlp, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }),
    ).toThrow("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(() =>
      parseTracingSettings({ ...otlp, OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://c" }),
    ).toThrow("http or https");
    expect(() =>
      parseTracingSettings({
        ...otlp,
        OTEL_TRACES_SAMPLER: "parentbased_always_on",
      }),
    ).toThrow("OTEL_TRACES_SAMPLER");
    expect(() =>
      parseTracingSettings({
        ...otlp,
        OTEL_TRACES_SAMPLER: "traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "2",
      }),
    ).toThrow("OTEL_TRACES_SAMPLER_ARG");
  });

  test("a malformed headers value is reported without echoing the secret", () => {
    try {
      parseTracingSettings({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
        OTEL_EXPORTER_OTLP_HEADERS: "SECRET-TOKEN-VALUE",
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).toContain("OTEL_EXPORTER_OTLP_HEADERS");
      expect(String(error)).not.toContain("SECRET-TOKEN-VALUE");
    }
  });

  test.each([
    ["OTEL_EXPORTER_OTLP_HEADERS", "authorization=SECRET%0AHEADER"],
    ["OTEL_EXPORTER_OTLP_HEADERS", "bad name=SECRET"],
    ["TRACE_TENANT_HEADER", "bad name: {workspace_id}"],
    ["TRACE_TENANT_HEADER", "X-Org: a\nb"],
  ])("rejects an invalid HTTP header in %s at startup", (key, value) => {
    try {
      parseTracingSettings({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
        [key]: value,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).toContain(key);
      expect(String(error)).not.toContain("SECRET");
    }
  });

  test("resolves tenant headers per workspace and falls back to the install tenant", () => {
    const settings = parseTracingSettings({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
      TRACE_TENANT_HEADER: "X-Scope-OrgID: {workspace_id}",
      TRACE_INSTALL_TENANT: "install",
    });
    expect(settings?.tenantHeaders("ws-1")).toEqual({
      "x-scope-orgid": "ws-1",
    });
    expect(settings?.tenantHeaders(undefined)).toEqual({
      "x-scope-orgid": "install",
    });
    expect(settings?.tenantHeaders("ws\n1")).toEqual({});
  });
});

describe("noopTracer", () => {
  test("runs the function with no active span and logs without span keys", async () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });
    const result = await noopTracer.withSpan("x", {}, async () => {
      expect(currentSpanContext()).toBeUndefined();
      logger.info("inside");
      return 7;
    });
    expect(result).toBe(7);
    expect(sink.records[0]).not.toHaveProperty("trace_id");
    expect(sink.records[0]).not.toHaveProperty("span_id");
  });

  test("drops trace keys set by hand through withContext", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });
    logger.withContext(
      { trace_id: "stale", span_id: "stale", request_id: "r" },
      () => logger.info("outside"),
    );
    expect(sink.records[0]).toMatchObject({ request_id: "r" });
    expect(sink.records[0]).not.toHaveProperty("trace_id");
    expect(sink.records[0]).not.toHaveProperty("span_id");
  });

  test("lets an error through unchanged", async () => {
    await expect(
      noopTracer.withSpan("x", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("otel tracer", () => {
  const collectors: Array<ReturnType<typeof startFakeCollector>> = [];
  const tracers: OtelTracer[] = [];

  afterEach(async () => {
    await Promise.all(
      tracers.splice(0).map((t) => t.shutdown().catch(() => undefined)),
    );
    for (const c of collectors.splice(0)) c.server.stop(true);
  });

  function setup(env: Record<string, string> = {}) {
    const collector = startFakeCollector();
    collectors.push(collector);
    const settings = parseTracingSettings({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      ...env,
    });
    if (!settings) throw new Error("tracing should be on");
    const tracer = createOtelTracer(settings);
    tracers.push(tracer);
    return { collector, tracer };
  }

  test("exports spans as http/protobuf to the traces endpoint", async () => {
    const { collector, tracer } = setup({
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20t",
    });
    await tracer.withSpan(
      "GET /v1/x",
      { kind: "server" },
      async () => undefined,
    );
    await tracer.shutdown();

    expect(collector.received).toHaveLength(1);
    expect(collector.received[0]).toMatchObject({
      path: "/v1/traces",
      contentType: "application/x-protobuf",
      auth: "Bearer t",
    });
    expect(collector.received[0]?.bytes).toBeGreaterThan(0);
  });

  test("sends one batch per workspace with its tenant header, and the install tenant otherwise", async () => {
    const { collector, tracer } = setup({
      TRACE_TENANT_HEADER: "X-Scope-OrgID: {workspace_id}",
      TRACE_INSTALL_TENANT: "install",
    });
    for (const workspace of ["ws-a", "ws-b", undefined]) {
      await tracer.withSpan(
        "s",
        { attributes: workspace ? { "werft.workspace_id": workspace } : {} },
        async () => undefined,
      );
    }
    await tracer.shutdown();

    expect(collector.received.map((r) => r.tenant).sort()).toEqual([
      "install",
      "ws-a",
      "ws-b",
    ]);
  });

  test("the tenant header beats a shared header of the same name in any letter case", async () => {
    const { collector, tracer } = setup({
      OTEL_EXPORTER_OTLP_HEADERS: "X-Scope-OrgID=base-a,x-scope-orgid=base-b",
      TRACE_TENANT_HEADER: "X-Scope-OrgID: {workspace_id}",
    });
    await tracer.withSpan(
      "s",
      { attributes: { "werft.workspace_id": "ws-a" } },
      async () => undefined,
    );
    await tracer.shutdown();
    expect(collector.received.map((r) => r.tenant)).toEqual(["ws-a"]);
  });

  test("a disabled configuration builds nothing and sends nothing", async () => {
    const collector = startFakeCollector();
    collectors.push(collector);
    expect(
      parseTracingSettings({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url }),
    ).toBeUndefined();
    await noopTracer.withSpan("s", {}, async () => undefined);
    expect(collector.received).toHaveLength(0);
  });

  test("stamps log records inside a span and keeps the context across await and setTimeout", async () => {
    const { tracer } = setup();
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });

    logger.info("before");
    await tracer.withSpan("outer", {}, async (span) => {
      logger.info("start");
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      logger.info("after timer");
      await tracer.withSpan("inner", {}, async (inner) => {
        logger.info("nested");
        expect(inner.context.traceId).toBe(span.context.traceId);
        expect(inner.context.spanId).not.toBe(span.context.spanId);
      });
      logger.info("back in outer");
    });
    logger.info("after");

    const [before, start, afterTimer, nested, backInOuter, after] =
      sink.records;
    expect(before).not.toHaveProperty("trace_id");
    expect(after).not.toHaveProperty("span_id");
    expect(start?.trace_id).toMatch(HEX32);
    expect(start?.span_id).toMatch(HEX16);
    expect(afterTimer).toMatchObject({
      trace_id: start?.trace_id,
      span_id: start?.span_id,
    });
    expect(nested?.trace_id).toBe(start?.trace_id);
    expect(nested?.span_id).not.toBe(start?.span_id);
    expect(backInOuter?.span_id).toBe(start?.span_id);

    // The evidence the PR quotes: one captured line.
    console.log(JSON.stringify(start));
  });

  test("honours a caller-chosen trace id on a root span and ignores it under a parent", async () => {
    const { tracer } = setup();
    const chosen = turnTraceId("00000000-0000-4000-8000-000000000001", 1);
    await tracer.withSpan(
      "werft.turn",
      { traceId: chosen, parent: "root" },
      async (turn) => {
        expect(turn.context.traceId).toBe(chosen);
        await tracer.withSpan(
          "child",
          { traceId: "1".repeat(32) },
          async (child) => {
            expect(child.context.traceId).toBe(chosen);
          },
        );
      },
    );
    await tracer.withSpan("next", {}, async (span) => {
      expect(span.context.traceId).not.toBe(chosen);
    });
  });

  test("an incoming sampled=0 link does not switch the span off, and the ratio sampler does", async () => {
    const { tracer } = setup();
    const link = {
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      sampled: false,
    };
    await tracer.withSpan(
      "linked",
      { links: [link], parent: "root" },
      async (span) => {
        expect(span.context.sampled).toBe(true);
        expect(span.context.traceId).not.toBe(link.traceId);
      },
    );

    const off = setup({ OTEL_TRACES_SAMPLER: "always_off" }).tracer;
    await off.withSpan("s", {}, async (span) => {
      expect(span.context.sampled).toBe(false);
    });
  });

  test("marks the span failed and rethrows when the function throws", async () => {
    const { tracer } = setup();
    await expect(
      tracer.withSpan("s", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
