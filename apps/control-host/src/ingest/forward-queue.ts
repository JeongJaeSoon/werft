// Bounded, asynchronous hand-off to the collector. `enqueue` never waits for
// the sink, so a collector that stops answering costs a drop count, not the
// latency of a heartbeat or next-input served by the same process.

import type { IngestSpan } from "@werft-ai/observability";
import type { DropCounter, SpanSink } from "./ports.ts";

export interface ForwardQueueOptions {
  readonly maxQueuedSpans: number;
  readonly maxSpansPerSend: number;
  /** A send that takes longer is abandoned and its spans counted as dropped. */
  readonly sendTimeoutMs: number;
}

export const DEFAULT_FORWARD_QUEUE: ForwardQueueOptions = {
  maxQueuedSpans: 20_000,
  maxSpansPerSend: 512,
  sendTimeoutMs: 15_000,
};

export class ForwardQueue {
  private readonly pending: IngestSpan[] = [];
  private draining: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly sink: SpanSink,
    private readonly drops: DropCounter,
    private readonly options: ForwardQueueOptions = DEFAULT_FORWARD_QUEUE,
  ) {}

  /** Returns how many of `spans` were refused because the queue is full. */
  enqueue(spans: readonly IngestSpan[]): number {
    const room = this.closed
      ? 0
      : Math.max(0, this.options.maxQueuedSpans - this.pending.length);
    const accepted = spans.slice(0, room);
    this.pending.push(...accepted);
    const refused = spans.length - accepted.length;
    if (refused > 0) this.drops.dropped("queue_full", refused);
    if (accepted.length > 0) this.draining ??= this.drain();
    return refused;
  }

  /** Stops accepting and gives the queue `ms` to empty. */
  async close(ms: number): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
    if (this.pending.length > 0) {
      this.drops.dropped("send_failed", this.pending.length);
      this.pending.length = 0;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.options.maxSpansPerSend);
        await this.send(batch);
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async send(batch: IngestSpan[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("collector send timed out")),
          this.options.sendTimeoutMs,
        );
      });
      // The sink's own promise is left running when the timeout wins; it can
      // only hold its own socket, not this queue.
      const sent = this.sink.send(batch);
      sent.catch(() => {});
      await Promise.race([sent, timedOut]);
    } catch {
      this.drops.dropped("send_failed", batch.length);
    } finally {
      clearTimeout(timer);
    }
  }
}
