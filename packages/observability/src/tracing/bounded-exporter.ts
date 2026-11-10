import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import type { SpanExporterLike } from "./otel-tracer.ts";

export const DEFAULT_QUEUE_MAX_SPANS = 2048;
export const DEFAULT_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const SERIALIZE_CHUNK_BYTES = 64 * 1024;

export interface BoundedExporterOptions {
  readonly send: (body: Uint8Array) => Promise<void>;
  readonly maxSpans?: number;
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
}

export interface BoundedSpanExporter extends SpanExporterLike {
  dropped(): number;
  drained(): Promise<void>;
}

interface Chunk {
  readonly body: Uint8Array;
  readonly spans: number;
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export function createBoundedSpanExporter(
  options: BoundedExporterOptions,
): BoundedSpanExporter {
  const maxSpans = options.maxSpans ?? DEFAULT_QUEUE_MAX_SPANS;
  const maxBytes = options.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? SERIALIZE_CHUNK_BYTES;
  // Spans not yet encoded, then encoded chunks not yet sent. Together with the
  // group being encoded they are what `maxSpans` bounds.
  const pending: { span: ReadableSpan; bytes: number }[] = [];
  const queue: Chunk[] = [];
  let group: ReadableSpan[] = [];
  let groupBytes = 0;
  let pendingBytes = 0;
  let queuedSpans = 0;
  let queuedBytes = 0;
  let dropped = 0;
  let encoding = false;
  let encoder: Promise<void> = Promise.resolve();
  let draining: Promise<void> | undefined;

  const serialize = (spans: ReadableSpan[]): Uint8Array | undefined =>
    JsonTraceSerializer.serializeRequest(spans);

  const held = (): number => queuedSpans + pending.length + group.length;
  const heldBytes = (): number => queuedBytes + pendingBytes + groupBytes;

  // The size a span will have once serialized is unknown until then; its
  // strings are nearly all of it.
  function estimateBytes(span: ReadableSpan): number {
    let bytes = Buffer.byteLength(span.name) + 256;
    bytes += Buffer.byteLength(span.status.message ?? "");
    for (const event of span.events) {
      bytes += Buffer.byteLength(event.name) + 64;
      for (const value of Object.values(event.attributes ?? {})) {
        bytes += typeof value === "string" ? Buffer.byteLength(value) : 16;
      }
    }
    for (const value of Object.values(span.attributes)) {
      if (typeof value === "string") bytes += Buffer.byteLength(value);
      else bytes += 16;
    }
    return bytes;
  }

  function evictOldest(): boolean {
    const oldest = queue.shift();
    if (oldest !== undefined) {
      queuedSpans -= oldest.spans;
      queuedBytes -= oldest.body.byteLength;
      dropped += oldest.spans;
      return true;
    }
    const waiting = pending.shift();
    if (waiting !== undefined) {
      pendingBytes -= waiting.bytes;
      dropped += 1;
      return true;
    }
    return false;
  }

  function enqueue(chunk: Chunk): void {
    if (chunk.spans > maxSpans || chunk.body.byteLength > maxBytes) {
      dropped += chunk.spans;
      return;
    }
    while (
      queue.length > 0 &&
      (held() + chunk.spans > maxSpans ||
        heldBytes() + chunk.body.byteLength > maxBytes)
    ) {
      evictOldest();
    }
    queue.push(chunk);
    queuedSpans += chunk.spans;
    queuedBytes += chunk.body.byteLength;
  }

  function flushGroup(): void {
    if (group.length === 0) return;
    const spans = group;
    group = [];
    groupBytes = 0;
    let body: Uint8Array | undefined;
    try {
      body = serialize(spans);
    } catch {
      body = undefined;
    }
    if (body === undefined) dropped += spans.length;
    else enqueue({ body, spans: spans.length });
  }

  async function encodePending(): Promise<void> {
    let size = 0;
    try {
      // Spans that end in the same tick leave in one request.
      await yieldToEventLoop();
      while (pending.length > 0) {
        const waiting = pending.shift() as {
          span: ReadableSpan;
          bytes: number;
        };
        pendingBytes -= waiting.bytes;
        const span = waiting.span;
        let single: Uint8Array | undefined;
        try {
          single = serialize([span]);
        } catch {
          single = undefined;
        }
        if (single === undefined) {
          dropped += 1;
          continue;
        }
        if (group.length > 0 && size + single.byteLength > chunkBytes) {
          flushGroup();
          size = 0;
          await yieldToEventLoop();
        }
        group.push(span);
        size += single.byteLength;
        groupBytes += single.byteLength;
      }
      flushGroup();
    } finally {
      encoding = false;
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      await encoder;
      const next = queue.shift();
      if (next === undefined) return;
      queuedSpans -= next.spans;
      queuedBytes -= next.body.byteLength;
      try {
        await options.send(next.body);
      } catch {
        dropped += next.spans;
      }
    }
  }

  function kick(): void {
    if (draining !== undefined) return;
    draining = drain().finally(() => {
      draining = undefined;
      if (queue.length > 0) kick();
    });
  }

  async function drained(): Promise<void> {
    for (;;) {
      await encoder;
      if (draining === undefined && queue.length === 0) return;
      await draining;
    }
  }

  return {
    export(spans, resultCallback) {
      resultCallback({ code: 0 });
      for (const span of spans) {
        const bytes = estimateBytes(span);
        pending.push({ span, bytes });
        pendingBytes += bytes;
      }
      // Spans not yet encoded count too, or a stalled sender lets them pile up.
      while ((held() > maxSpans || heldBytes() > maxBytes) && evictOldest()) {}
      if (!encoding && pending.length > 0) {
        encoding = true;
        encoder = encodePending();
      }
      kick();
    },
    forceFlush: drained,
    shutdown: drained,
    dropped: () => dropped,
    drained,
  };
}
