// A span as the telemetry ingest listener handles it: plain data decoded from
// OTLP/JSON, rewritten, then handed to a sink. No imports, so neither the
// listener nor the SDK adapter depends on the other.

export type IngestAttributeValue = string | number | boolean;
export type IngestAttributes = Readonly<Record<string, IngestAttributeValue>>;

export interface IngestSpanEvent {
  readonly name: string;
  /** Unix epoch nanoseconds as a decimal string (exceeds 2^53). */
  readonly timeUnixNano: string;
  readonly attributes: IngestAttributes;
}

export interface IngestSpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: IngestAttributes;
}

export interface IngestSpan {
  /** 32 lowercase hex. */
  readonly traceId: string;
  /** 16 lowercase hex. */
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  /** OTLP SpanKind number: 0 unspecified .. 5 consumer. */
  readonly kind: number;
  readonly startUnixNano: string;
  readonly endUnixNano: string;
  readonly attributes: IngestAttributes;
  readonly events: readonly IngestSpanEvent[];
  readonly links: readonly IngestSpanLink[];
  /** OTLP StatusCode: 0 unset, 1 ok, 2 error. */
  readonly status: { readonly code: number; readonly message?: string };
  readonly resource: IngestAttributes;
  readonly scope: { readonly name: string; readonly version?: string };
}
