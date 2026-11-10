// The tracing port. Nothing here imports an OpenTelemetry package: services
// depend on this file, and the SDK adapter (`./otel-tracer.ts`) implements it.
import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  /** 32 lowercase hex. */
  readonly traceId: string;
  /** 16 lowercase hex. */
  readonly spanId: string;
  readonly sampled: boolean;
}

export type SpanAttributeValue = string | number | boolean;

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Marks the span failed. `message` is a redacted string, never an Error object. */
  setError(message: string): void;
  end(): void;
}

export interface StartSpanOptions {
  readonly kind?: "server" | "client" | "internal";
  readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
  /** Spans this one is related to without being their child. */
  readonly links?: readonly SpanContext[];
  /** Parent given explicitly; omitted means the active span, "root" forces a new root. */
  readonly parent?: SpanContext | "root";
  /** A trace id chosen by the caller, for `werft.turn` only. */
  readonly traceId?: string;
}

export interface Tracer {
  /** Runs `fn` with the new span active; ends it, and marks it failed if `fn` throws. */
  withSpan<T>(
    name: string,
    options: StartSpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T>;
}

const activeSpanContext = new AsyncLocalStorage<SpanContext>();

/** The span active in the current async context, if any. The logger reads this. */
export function currentSpanContext(): SpanContext | undefined {
  return activeSpanContext.getStore();
}

/** For tracer implementations: makes `context` the active span while `fn` runs. */
export function runWithSpanContext<T>(context: SpanContext, fn: () => T): T {
  return activeSpanContext.run(context, fn);
}

export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/** Returns undefined for anything that is not a version 00 traceparent with non-zero ids. */
export function parseTraceparent(value: string): SpanContext | undefined {
  const match = TRACEPARENT.exec(value);
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

const TWO_POW_64 = 2 ** 64;

/**
 * Ratio sampling decided by the trace id alone, so the API and the worker
 * reach the same verdict for one turn: the low 8 bytes read as a big-endian
 * unsigned integer `x` are recorded when `x < floor(ratio * 2^64)`.
 */
export function sampleByTraceId(traceId: string, ratio: number): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  const x = BigInt(`0x${traceId.slice(16)}`);
  return x < BigInt(Math.floor(ratio * TWO_POW_64));
}

const INERT_SPAN: Span = {
  context: { traceId: ZERO_TRACE_ID, spanId: ZERO_SPAN_ID, sampled: false },
  setAttribute() {},
  setError() {},
  end() {},
};

/** The tracer used while tracing is off: creates no span and exports nothing. */
export const noopTracer: Tracer = {
  withSpan: (_name, _options, fn) => fn(INERT_SPAN),
};
