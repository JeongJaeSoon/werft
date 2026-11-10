// OTLP/HTTP JSON ExportTraceServiceRequest -> IngestSpan[]. Only what the
// listener rewrites and forwards is read; anything malformed throws
// OtlpDecodeError, which the listener answers with 400.

import type {
  IngestAttributes,
  IngestAttributeValue,
  IngestSpan,
} from "@werft-ai/observability";

export class OtlpDecodeError extends Error {}

type Json = Record<string, unknown>;

const MAX_RESOURCE_BYTES = 8 * 1024;
// The scope repeats on every span like the resource does, and names a
// library; a longer value is cut rather than refused.
const MAX_SCOPE_CHARS = 128;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const NANOS = /^[0-9]{1,20}$/;

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OtlpDecodeError(`${what} must be an object`);
  }
  return value as Json;
}

function list(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new OtlpDecodeError(`${what} must be a list`);
  return value;
}

function text(value: unknown, what: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") {
    throw new OtlpDecodeError(`${what} must be a string`);
  }
  return value;
}

function hexId(value: unknown, what: string, pattern: RegExp): string {
  const id = text(value, what).toLowerCase();
  if (!pattern.test(id)) throw new OtlpDecodeError(`${what} is not valid hex`);
  return id;
}

function nanos(value: unknown, what: string): string {
  // JSON encoders write 64-bit integers as strings; a bare number is accepted.
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !NANOS.test(raw)) {
    throw new OtlpDecodeError(`${what} must be unix nanoseconds`);
  }
  return raw;
}

function int(value: unknown, what: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new OtlpDecodeError(`${what} must be an integer`);
  }
  return value;
}

/** Arrays and maps are kept as JSON text: a span attribute is a scalar here. */
function anyValue(value: unknown): IngestAttributeValue | undefined {
  const v = object(value, "attribute value");
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "number") return v.intValue;
  if (typeof v.intValue === "string" && /^-?[0-9]+$/.test(v.intValue)) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : v.intValue;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (v.arrayValue !== undefined || v.kvlistValue !== undefined) {
    return JSON.stringify(v.arrayValue ?? v.kvlistValue);
  }
  return undefined;
}

function attributes(value: unknown, what: string): IngestAttributes {
  const out: Record<string, IngestAttributeValue> = {};
  for (const entry of list(value, what)) {
    const kv = object(entry, `${what} entry`);
    const parsed = anyValue(kv.value);
    if (parsed !== undefined) out[text(kv.key, `${what} key`)] = parsed;
  }
  return out;
}

function spanOf(
  raw: unknown,
  resource: IngestAttributes,
  scope: IngestSpan["scope"],
): IngestSpan {
  const s = object(raw, "span");
  const parent = s.parentSpanId;
  const status = s.status === undefined ? {} : object(s.status, "status");
  const message = status.message;
  return {
    traceId: hexId(s.traceId, "traceId", TRACE_ID),
    spanId: hexId(s.spanId, "spanId", SPAN_ID),
    ...(typeof parent === "string" && parent !== ""
      ? { parentSpanId: hexId(parent, "parentSpanId", SPAN_ID) }
      : {}),
    name: text(s.name, "span name"),
    kind: int(s.kind, "kind", 0),
    startUnixNano: nanos(s.startTimeUnixNano, "startTimeUnixNano"),
    endUnixNano: nanos(s.endTimeUnixNano, "endTimeUnixNano"),
    attributes: attributes(s.attributes, "span attributes"),
    events: list(s.events, "events").map((e) => {
      const event = object(e, "event");
      return {
        name: text(event.name, "event name"),
        timeUnixNano: nanos(event.timeUnixNano, "event timeUnixNano"),
        attributes: attributes(event.attributes, "event attributes"),
      };
    }),
    links: list(s.links, "links").map((l) => {
      const link = object(l, "link");
      return {
        traceId: hexId(link.traceId, "link traceId", TRACE_ID),
        spanId: hexId(link.spanId, "link spanId", SPAN_ID),
        attributes: attributes(link.attributes, "link attributes"),
      };
    }),
    status: {
      code: int(status.code, "status code", 0),
      ...(typeof message === "string" ? { message } : {}),
    },
    resource,
    scope,
  };
}

export function decodeTraceRequest(body: string): IngestSpan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OtlpDecodeError("The body is not valid JSON");
  }
  const request = object(parsed, "request");
  const spans: IngestSpan[] = [];
  for (const rs of list(request.resourceSpans, "resourceSpans")) {
    const resourceSpans = object(rs, "resourceSpans entry");
    const resource = attributes(
      resourceSpans.resource === undefined
        ? undefined
        : object(resourceSpans.resource, "resource").attributes,
      "resource attributes",
    );
    // Every span repeats its resource, so a large one multiplies the work of
    // the whole request; real resources are a handful of short attributes.
    if (Buffer.byteLength(JSON.stringify(resource)) > MAX_RESOURCE_BYTES) {
      throw new OtlpDecodeError("The resource attributes are too large");
    }
    for (const ss of list(resourceSpans.scopeSpans, "scopeSpans")) {
      const scopeSpans = object(ss, "scopeSpans entry");
      const rawScope =
        scopeSpans.scope === undefined ? {} : object(scopeSpans.scope, "scope");
      const version = rawScope.version;
      const scope = {
        name: text(rawScope.name, "scope name", "").slice(0, MAX_SCOPE_CHARS),
        ...(typeof version === "string" && version !== ""
          ? { version: version.slice(0, MAX_SCOPE_CHARS) }
          : {}),
      };
      for (const span of list(scopeSpans.spans, "spans")) {
        spans.push(spanOf(span, resource, scope));
      }
    }
  }
  return spans;
}
