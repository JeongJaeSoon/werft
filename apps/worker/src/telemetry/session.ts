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
import type { EventCodec } from "@werft-ai/runtime-core";

import type { ContentMasker } from "./content.ts";
import { NO_TURN_SPANS, SpanEmitter } from "./turn-spans.ts";

export type EnabledTelemetry = Extract<ClaimTelemetry, { enabled: true }>;

export type SpanSource = Pick<SpanEmitter, "noteEngineStart" | "beginTurn">;

export interface TelemetrySession {
  readonly emitter: SpanSource;
  flush(): void;
  shutdown(timeoutMs: number): Promise<void>;
  dropped(): number;
}

export interface TelemetryInput {
  readonly telemetry: EnabledTelemetry;
  readonly claim: BootstrapClaimResponse;
  readonly execution: { readonly id: string; readonly generation: number };
  readonly masker: ContentMasker;
}

export type TelemetryFactory = (input: TelemetryInput) => TelemetrySession;

/**
 * What the host holds: a factory or session that throws costs the attempt its
 * spans, never a turn, an answer or the release.
 */
export function protectSession(
  build: () => TelemetrySession,
): TelemetrySession | undefined {
  let session: TelemetrySession;
  try {
    session = build();
  } catch {
    return undefined;
  }
  return {
    emitter: {
      noteEngineStart(start, end) {
        try {
          session.emitter.noteEngineStart(start, end);
        } catch {}
      },
      beginTurn(start, policy) {
        try {
          return session.emitter.beginTurn(start, policy);
        } catch {
          return NO_TURN_SPANS;
        }
      },
    },
    flush() {
      try {
        session.flush();
      } catch {}
    },
    async shutdown(timeoutMs) {
      try {
        await session.shutdown(timeoutMs);
      } catch {}
    },
    dropped() {
      try {
        return session.dropped();
      } catch {
        return 0;
      }
    },
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface IngestOptions {
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs: number;
  readonly queue?: { readonly maxSpans?: number; readonly maxBytes?: number };
  readonly onSession?: (session: TelemetrySession) => void;
  /** The codec of the runtime kind the session runs, when its adapter has one. */
  readonly eventCodecFor?: (kind: string) => EventCodec | undefined;
}

function ingestSender(
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
      body: new TextDecoder().decode(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Telemetry ingest answered ${response.status}`);
  };
}

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
      exportOnEnd: true,
      resourceAttributes: {
        "werft.execution_id": execution.id,
        "werft.attempt_id": claim.attempt_id,
        "werft.execution_generation": execution.generation,
      },
    });
    const codec = options.eventCodecFor?.(claim.runtime.kind);
    const session: TelemetrySession = {
      emitter: new SpanEmitter({
        tracer,
        masker,
        ...(codec === undefined
          ? {}
          : { neutralize: (event) => codec.withNeutralFields(event) }),
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
