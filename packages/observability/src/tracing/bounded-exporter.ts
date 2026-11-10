// A span exporter for a sender that may be slow or gone: export() never waits
// on the network, the queue is bounded, and whatever does not fit is dropped
// oldest first and counted. The wire is OTLP/HTTP JSON; the caller supplies
// the transport.
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import type { SpanExporterLike } from "./otel-tracer.ts";

export const DEFAULT_QUEUE_MAX_SPANS = 2048;
export const DEFAULT_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
/** Serialization runs in pieces this size, yielding between them. */
export const SERIALIZE_CHUNK_BYTES = 64 * 1024;

export interface BoundedExporterOptions {
  /** Sends one serialized OTLP JSON request. A rejection drops that request's spans. */
  readonly send: (body: Uint8Array) => Promise<void>;
  readonly maxSpans?: number;
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
}

export interface BoundedSpanExporter extends SpanExporterLike {
  /** Spans lost so far: evicted from a full queue, or refused by the sender. */
  dropped(): number;
  /** Resolves once everything queued so far has been sent or dropped. */
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
  const queue: Chunk[] = [];
  let queuedSpans = 0;
  let queuedBytes = 0;
  let dropped = 0;
  let encoding: Promise<void> = Promise.resolve();
  let draining: Promise<void> | undefined;

  const serialize = (spans: ReadableSpan[]): Uint8Array | undefined =>
    JsonTraceSerializer.serializeRequest(spans);

  function enqueue(chunk: Chunk): void {
    if (chunk.spans > maxSpans || chunk.body.byteLength > maxBytes) {
      dropped += chunk.spans;
      return;
    }
    while (
      queue.length > 0 &&
      (queuedSpans + chunk.spans > maxSpans ||
        queuedBytes + chunk.body.byteLength > maxBytes)
    ) {
      const oldest = queue.shift() as Chunk;
      queuedSpans -= oldest.spans;
      queuedBytes -= oldest.body.byteLength;
      dropped += oldest.spans;
    }
    queue.push(chunk);
    queuedSpans += chunk.spans;
    queuedBytes += chunk.body.byteLength;
  }

  async function encode(spans: ReadableSpan[]): Promise<void> {
    // Sizes are measured one span at a time so no single pass over a large
    // batch holds the event loop; the group is serialized once it is full.
    let group: ReadableSpan[] = [];
    let size = 0;
    const flushGroup = (): void => {
      if (group.length === 0) return;
      const body = serialize(group);
      if (body === undefined) dropped += group.length;
      else enqueue({ body, spans: group.length });
      group = [];
      size = 0;
    };
    for (const span of spans) {
      const single = serialize([span]);
      if (single === undefined) {
        dropped += 1;
        continue;
      }
      if (group.length > 0 && size + single.byteLength > chunkBytes) {
        flushGroup();
        await yieldToEventLoop();
      }
      group.push(span);
      size += single.byteLength;
    }
    flushGroup();
  }

  async function drain(): Promise<void> {
    for (;;) {
      await encoding;
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
      await encoding;
      if (draining === undefined && queue.length === 0) return;
      await draining;
    }
  }

  return {
    export(spans, resultCallback) {
      // The caller is told it worked at once: nothing here is its business.
      resultCallback({ code: 0 });
      // Spans are read now; the SDK may reuse nothing, but the encoding
      // below runs later and must not see a mutated array.
      const batch = [...spans];
      encoding = encoding
        .then(() => encode(batch))
        .catch(() => {
          dropped += batch.length;
        });
      kick();
    },
    forceFlush: drained,
    shutdown: drained,
    dropped: () => dropped,
    drained,
  };
}
