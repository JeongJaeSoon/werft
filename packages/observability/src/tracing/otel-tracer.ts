// The only file that imports @opentelemetry/*. It implements the `Tracer` port
// with the official SDK; services never see an SDK type.
import {
  type Context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type IdGenerator,
  RandomIdGenerator,
  type ReadableSpan,
  type Sampler,
  SamplingDecision,
  SimpleSpanProcessor,
  type SpanExporter,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { sanitizeText } from "../redaction.ts";
import type { TracingSettings } from "./config.ts";
import {
  currentSpanContext,
  runWithSpanContext,
  type Span,
  type SpanContext,
  type StartSpanOptions,
  sampleByTraceId,
  type Tracer,
} from "./tracer.ts";

/** Same shape as the SDK's exporter, so a worker can plug in an ingest exporter. */
export type SpanExporterLike = SpanExporter;

// Only what the exporter reads: content and ingest settings are the API's and
// the listener's, not the tracer's.
export interface OtelTracerConfig
  extends Pick<
    TracingSettings,
    "serviceName" | "sampler" | "headers" | "tenantHeaders"
  > {
  readonly endpoint?: string;
  readonly resourceAttributes?: Readonly<Record<string, string | number>>;
  /** Replaces the OTLP exporter; endpoint and headers are then unused. */
  readonly exporter?: SpanExporterLike;
  /**
   * Hands each finished span straight to `exporter` instead of buffering it in
   * the SDK, whose full queue drops the newest span without counting it. Only
   * for an exporter that bounds and counts its own queue.
   */
  readonly exportOnEnd?: boolean;
}

export type OtelTracer = Tracer & {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export {
  type BoundedExporterOptions,
  type BoundedSpanExporter,
  createBoundedSpanExporter,
} from "./bounded-exporter.ts";

const WORKSPACE_ATTRIBUTE = "werft.workspace_id";

/**
 * Sends each workspace's spans as their own batch with that workspace's
 * tenant headers. Spans without a workspace go out with the install tenant's.
 */
class WorkspaceBatchExporter implements SpanExporter {
  private readonly exporters = new Map<string, SpanExporter>();

  constructor(
    private readonly createExporter: (
      headers: Readonly<Record<string, string>>,
    ) => SpanExporter,
    private readonly baseHeaders: Readonly<Record<string, string>>,
    private readonly tenantHeaders: TracingSettings["tenantHeaders"],
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter["export"]>[1],
  ): void {
    const batches = new Map<string | undefined, ReadableSpan[]>();
    for (const span of spans) {
      const raw = span.attributes[WORKSPACE_ATTRIBUTE];
      const workspaceId = typeof raw === "string" ? raw : undefined;
      const batch = batches.get(workspaceId);
      if (batch) batch.push(span);
      else batches.set(workspaceId, [span]);
    }

    let pending = batches.size;
    let failure: Parameters<typeof resultCallback>[0] | undefined;
    if (pending === 0) {
      resultCallback({ code: 0 });
      return;
    }
    for (const [workspaceId, batch] of batches) {
      this.exporterFor(workspaceId).export(batch, (result) => {
        if (result.code !== 0) failure ??= result;
        pending -= 1;
        if (pending === 0) resultCallback(failure ?? { code: 0 });
      });
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all(
      [...this.exporters.values()].map((e) => e.forceFlush?.()),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.exporters.values()].map((e) => e.shutdown()));
  }

  private exporterFor(workspaceId: string | undefined): SpanExporter {
    // Tenant headers win over the shared ones, as the design's precedence says.
    const headers = { ...this.baseHeaders, ...this.tenantHeaders(workspaceId) };
    const key = JSON.stringify(Object.entries(headers).sort());
    let exporter = this.exporters.get(key);
    if (!exporter) {
      exporter = this.createExporter(headers);
      this.exporters.set(key, exporter);
    }
    return exporter;
  }
}

/** Decides from the trace id alone; the caller's sampled flag is never consulted. */
class TraceIdSampler implements Sampler {
  constructor(private readonly ratio: number) {}

  shouldSample(_context: Context, traceId: string) {
    return {
      decision: sampleByTraceId(traceId, this.ratio)
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD,
    };
  }

  toString(): string {
    return `TraceIdSampler{${this.ratio}}`;
  }
}

/** Hands out the caller-chosen trace id once, for the next root span only. */
class ForcedTraceIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  forcedTraceId: string | undefined;

  generateTraceId(): string {
    return this.forcedTraceId ?? this.random.generateTraceId();
  }

  generateSpanId(): string {
    return this.random.generateSpanId();
  }
}

const KINDS = {
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  internal: SpanKind.INTERNAL,
} as const;

function toOtelContext(parent: SpanContext | undefined): Context {
  if (!parent) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

const SDK_HEADER_ENV = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
] as const;

/**
 * The OTLP exporter reads these two variables itself while it is built and
 * merges them case-sensitively with the headers it is given, which can send a
 * stale duplicate or override a tenant header. `parseTracingSettings` already
 * applied them, so the SDK must not see them.
 */
function buildWithoutSdkHeaderEnv<T>(build: () => T): T {
  const saved = SDK_HEADER_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of SDK_HEADER_ENV) delete process.env[key];
  try {
    return build();
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

export function createOtelTracer(config: OtelTracerConfig): OtelTracer {
  // Without a URL the SDK would quietly post to localhost:4318.
  if (config.exporter === undefined && config.endpoint === undefined) {
    throw new Error("createOtelTracer needs an endpoint or an exporter");
  }
  const idGenerator = new ForcedTraceIdGenerator();
  const exporter =
    config.exporter ??
    new WorkspaceBatchExporter(
      (headers) =>
        buildWithoutSdkHeaderEnv(
          () =>
            new OTLPTraceExporter({
              ...(config.endpoint === undefined
                ? {}
                : { url: config.endpoint }),
              headers: { ...headers },
            }),
        ),
      config.headers,
      config.tenantHeaders,
    );
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      ...config.resourceAttributes,
      "service.name": config.serviceName,
      "service.namespace": "werft",
    }),
    sampler: new TraceIdSampler(config.sampler.ratio),
    idGenerator,
    spanProcessors: [
      config.exportOnEnd === true
        ? new SimpleSpanProcessor({ exporter })
        : new BatchSpanProcessor({ exporter }),
    ],
  });
  const tracer = provider.getTracer("@werft-ai/observability");

  function startSpan(name: string, options: StartSpanOptions): Span {
    const parent =
      options.parent === "root"
        ? undefined
        : (options.parent ?? currentSpanContext());
    idGenerator.forcedTraceId = parent ? undefined : options.traceId;
    let otelSpan: ReturnType<typeof tracer.startSpan>;
    try {
      otelSpan = tracer.startSpan(
        name,
        {
          kind: KINDS[options.kind ?? "internal"],
          attributes: { ...options.attributes },
          links: (options.links ?? []).map((link) => ({
            context: {
              traceId: link.traceId,
              spanId: link.spanId,
              traceFlags: link.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
            },
          })),
          ...(options.startTime === undefined
            ? {}
            : { startTime: options.startTime }),
        },
        toOtelContext(parent),
      );
    } finally {
      idGenerator.forcedTraceId = undefined;
    }

    const raw = otelSpan.spanContext();
    const context: SpanContext = {
      traceId: raw.traceId,
      spanId: raw.spanId,
      sampled: (raw.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
    };
    let ended = false;
    return {
      context,
      setAttribute: (key, value) => {
        otelSpan.setAttribute(key, value);
      },
      setError: (message) => {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      },
      end: (endTime) => {
        if (ended) return;
        ended = true;
        otelSpan.end(endTime);
      },
    };
  }

  return {
    startSpan,
    async withSpan<T>(
      name: string,
      options: StartSpanOptions,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      const span = startSpan(name, options);
      const context = span.context;
      try {
        return await runWithSpanContext(context, () => fn(span));
      } catch (error) {
        span.setError(
          sanitizeText(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      } finally {
        span.end();
      }
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
