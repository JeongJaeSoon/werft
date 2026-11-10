import {
  type BootstrapClaimResponse,
  type ClaimTelemetry,
  claimTelemetrySampler,
} from "@werft-ai/contracts";
import {
  type BoundedSpanExporter,
  createBoundedSpanExporter,
  createOtelTracer,
} from "@werft-ai/observability/otel";

import type { ContentMasker } from "./content.ts";
import { SpanEmitter } from "./turn-spans.ts";

export type EnabledTelemetry = Extract<ClaimTelemetry, { enabled: true }>;

/** What the host holds for an attempt that traces: where spans are made, and how they leave. */
export interface TelemetrySession {
  readonly emitter: SpanEmitter;
  /** Starts sending what has finished; never waits for the network. */
  flush(): void;
  /** One bounded chance to send the tail, then give up. */
  shutdown(timeoutMs: number): Promise<void>;
  /** Spans lost to a full queue or a refusing ingest, since the attempt began. */
  dropped(): number;
}

export interface TelemetryInput {
  readonly telemetry: EnabledTelemetry;
  readonly claim: BootstrapClaimResponse;
  /** The execution this worker was launched as; the claim does not repeat it. */
  readonly execution: { readonly id: string; readonly generation: number };
  readonly masker: ContentMasker;
}

/** Builds the attempt's telemetry once its claim says tracing is on. */
export type TelemetryFactory = (input: TelemetryInput) => TelemetrySession;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface IngestOptions {
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs: number;
  /** Queue limits; the exporter's defaults (2048 spans, 16 MiB) when absent. */
  readonly queue?: { readonly maxSpans?: number; readonly maxBytes?: number };
  /** Receives each session built, for a caller that wants its drop count. */
  readonly onSession?: (session: TelemetrySession) => void;
}

/**
 * One POST of an OTLP JSON body to the API's ingest listener, authorized by
 * the session credential and nothing else. A non-2xx answer or a timeout is a
 * rejection; the exporter counts it as dropped and never retries.
 */
export function ingestSender(
  ingestUrl: string,
  credential: () => string,
  options: IngestOptions,
): (body: Uint8Array) => Promise<void> {
  const endpoint = `${ingestUrl.replace(/\/$/, "")}/v1/traces`;
  const call: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (body) => {
    const response = await call(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential()}`,
      },
      // OTLP JSON is UTF-8 text.
      body: new TextDecoder().decode(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Telemetry ingest answered ${response.status}`);
  };
}

/**
 * The production factory. Its own fetch and its own bounded queue: nothing
 * here shares a connection, a retry or a limit with `/append-events`.
 */
export function createIngestTelemetry(
  options: IngestOptions,
): TelemetryFactory {
  return ({ telemetry, claim, execution, masker }) => {
    const exporter: BoundedSpanExporter = createBoundedSpanExporter({
      send: ingestSender(
        telemetry.ingest_url,
        () => claim.session_credential,
        options,
      ),
      ...options.queue,
    });
    const tracer = createOtelTracer({
      serviceName: "werft-worker",
      sampler: claimTelemetrySampler(telemetry),
      headers: {},
      tenantHeaders: () => ({}),
      exporter,
      resourceAttributes: {
        "werft.execution_id": execution.id,
        "werft.attempt_id": claim.attempt_id,
        "werft.execution_generation": execution.generation,
      },
    });
    const session: TelemetrySession = {
      emitter: new SpanEmitter({
        tracer,
        masker,
        scope: { sessionId: claim.session_id, attemptId: claim.attempt_id },
        dropped: () => exporter.dropped(),
      }),
      flush: () => {
        void tracer.forceFlush().catch(() => {});
      },
      shutdown: async (timeoutMs) => {
        await Promise.race([
          tracer.shutdown().catch(() => {}),
          new Promise<void>((resolve) =>
            setTimeout(resolve, timeoutMs).unref(),
          ),
        ]);
      },
      dropped: () => exporter.dropped(),
    };
    options.onSession?.(session);
    return session;
  };
}
