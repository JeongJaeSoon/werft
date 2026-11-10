import { describe, expect, test } from "bun:test";
import {
  formatTraceparent,
  MemoryLogSink,
  noopTracer,
  StructuredLogger,
  turnTraceId,
} from "@werft-ai/observability";
import { createOtelTracer } from "@werft-ai/observability/otel";
import { Hono } from "hono";
import { createApiApp } from "./app.ts";
import { RequestTracing } from "./request-tracing.ts";

type Exported = Parameters<
  NonNullable<Parameters<typeof createOtelTracer>[0]["exporter"]>["export"]
>[0][number];

// The real OTel adapter with an exporter that keeps what it is given, so the
// tests read the spans a collector would receive.
function recordingTracer() {
  const spans: Exported[] = [];
  const tracer = createOtelTracer({
    serviceName: "werft-api-test",
    sampler: { kind: "always_on", ratio: 1 },
    headers: {},
    tenantHeaders: () => ({}),
    exporter: {
      export(batch, done) {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  return { tracer, spans };
}

const SESSION = "00000000-0000-4000-8000-000000000001";
// `authMode: "none"` takes the owner from this header.
const OWNER = { headers: { "X-Owner-Id": "owner-1" } };
const CLIENT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  sampled: false,
};

function apiWith(tracer: ReturnType<typeof recordingTracer>["tracer"]) {
  const sink = new MemoryLogSink();
  const logger = new StructuredLogger({ sinks: [sink] });
  const app = createApiApp({
    authMode: "none",
    logger,
    tracer,
    registerRoutes: (router) => {
      router.get("/sessions/:id/ping", (context) => context.json({ ok: true }));
    },
    readiness: async () => ({ ready: true }) as never,
  });
  return { app, sink };
}

describe("API request span", () => {
  test("names the span by route template and stamps its ids on the log line", async () => {
    const { tracer, spans } = recordingTracer();
    const { app, sink } = apiWith(tracer);

    const response = await app.request(`/v1/sessions/${SESSION}/ping`, OWNER);
    expect(response.status).toBe(200);
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    const [span] = spans as [Exported];
    expect(span.name).toBe("GET /v1/sessions/:id/ping");
    expect(span.name).not.toContain(SESSION);
    expect(span.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/v1/sessions/:id/ping",
      "http.response.status_code": 200,
      "werft.request_id": response.headers.get("X-Request-Id"),
      "werft.session_id": SESSION,
    });

    const completed = sink.records.find(
      (record) => record.event === "api.request.completed",
    );
    expect(completed?.trace_id).toBe(span.spanContext().traceId);
    expect(completed?.span_id).toBe(span.spanContext().spanId);
  });

  test("records a client traceparent as a link, never as the parent", async () => {
    const { tracer, spans } = recordingTracer();
    const { app } = apiWith(tracer);

    // sampled=00: the client cannot switch the API span off.
    await app.request(`/v1/sessions/${SESSION}/ping`, {
      headers: { ...OWNER.headers, traceparent: formatTraceparent(CLIENT) },
    });
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    const [span] = spans as [Exported];
    expect(span.spanContext().traceId).not.toBe(CLIENT.traceId);
    expect(span.parentSpanContext).toBeUndefined();
    expect(
      span.links.map((link) => [link.context.traceId, link.context.spanId]),
    ).toEqual([[CLIENT.traceId, CLIENT.spanId]]);
  });

  test("ignores a malformed traceparent and skips probes", async () => {
    const { tracer, spans } = recordingTracer();
    const { app } = apiWith(tracer);

    await app.request(`/v1/sessions/${SESSION}/ping`, {
      headers: { ...OWNER.headers, traceparent: "not-a-traceparent" },
    });
    await app.request("/healthz");
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.links).toHaveLength(0);
  });

  test("marks a 5xx span failed and leaves a 4xx unmarked", async () => {
    const { tracer, spans } = recordingTracer();
    const app = createApiApp({
      authMode: "none",
      tracer,
      registerRoutes: (router) => {
        router.get("/boom", (context) => context.text("x", 503));
        router.get("/missing", (context) => context.text("x", 404));
      },
    });

    await app.request("/v1/boom", OWNER);
    await app.request("/v1/missing", OWNER);
    await tracer.shutdown();

    const byName = new Map(spans.map((span) => [span.name, span]));
    expect(byName.get("GET /v1/boom")?.status.code).toBe(2);
    expect(byName.get("GET /v1/boom")?.attributes["error.type"]).toBe(
      "http_503",
    );
    expect(byName.get("GET /v1/missing")?.status.code).not.toBe(2);
  });

  test("with tracing off the responses and log lines are unchanged", async () => {
    const sink = new MemoryLogSink();
    const app = createApiApp({
      authMode: "none",
      logger: new StructuredLogger({ sinks: [sink] }),
      registerRoutes: (router) => {
        router.get("/ping", (context) => context.json({ ok: true }));
      },
    });

    const response = await app.request("/v1/ping", OWNER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    for (const record of sink.records) {
      expect(record).not.toHaveProperty("trace_id");
      expect(record).not.toHaveProperty("span_id");
    }
  });
});

describe("worker gateway call span", () => {
  function gatewayApp(tracing: RequestTracing) {
    const app = new Hono();
    app.post("/internal/worker/next-input", (context) =>
      tracing.traceGatewayCall(
        context,
        { session_id: SESSION, turn_id: "1" },
        async () => context.json({ ok: true }),
      ),
    );
    return app;
  }

  async function post(
    app: Hono,
    headers: Record<string, string>,
  ): Promise<void> {
    const response = await app.request("/internal/worker/next-input", {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
  }

  const turnContext = {
    traceId: turnTraceId(SESSION, 1),
    spanId: "00f067aa0ba902b7",
    sampled: true,
  };

  test("becomes a child span only for this turn's trace id", async () => {
    const { tracer, spans } = recordingTracer();
    const app = gatewayApp(new RequestTracing(tracer));

    await post(app, { traceparent: formatTraceparent(turnContext) });
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    const [span] = spans as [Exported];
    expect(span.name).toBe("POST /internal/worker/next-input");
    expect(span.spanContext().traceId).toBe(turnContext.traceId);
    expect(span.parentSpanContext?.spanId).toBe(turnContext.spanId);
    expect(span.attributes["http.response.status_code"]).toBe(200);
  });

  test("makes no span without a traceparent or for another trace id", async () => {
    const { tracer, spans } = recordingTracer();
    const app = gatewayApp(new RequestTracing(tracer));

    await post(app, {});
    await post(app, { traceparent: formatTraceparent(CLIENT) });
    // Another turn of the same session is another trace too.
    await post(app, {
      traceparent: formatTraceparent({
        ...turnContext,
        traceId: turnTraceId(SESSION, 2),
      }),
    });
    await tracer.shutdown();

    expect(spans).toHaveLength(0);
  });

  test("the default tracing creates nothing", async () => {
    const app = gatewayApp(new RequestTracing(noopTracer));
    await post(app, { traceparent: formatTraceparent(turnContext) });
  });
});
