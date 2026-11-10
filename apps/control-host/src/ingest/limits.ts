// Byte budgets the listener enforces. Both keep their state in memory and
// forget idle entries, so a long-lived api does not grow with every attempt.

import type { Clock } from "./ports.ts";

const WINDOW_MS = 60_000;

/** Fixed one-minute window of request bytes per attempt. */
export class AttemptRateLimiter {
  private readonly windows = new Map<
    string,
    { startedAt: number; bytes: number }
  >();

  constructor(
    private readonly maxBytesPerMinute: number,
    private readonly clock: Clock,
  ) {}

  /** Seconds to wait when the request does not fit; undefined when admitted. */
  admit(
    attemptId: string,
    bytes: number,
  ): { retryAfterSec: number } | undefined {
    const now = this.clock.now();
    this.forgetExpired(now);
    let window = this.windows.get(attemptId);
    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      window = { startedAt: now, bytes: 0 };
      this.windows.set(attemptId, window);
    }
    if (window.bytes + bytes > this.maxBytesPerMinute) {
      return {
        retryAfterSec: Math.max(
          1,
          Math.ceil((window.startedAt + WINDOW_MS - now) / 1000),
        ),
      };
    }
    window.bytes += bytes;
    return undefined;
  }

  private forgetExpired(now: number): void {
    if (this.windows.size < 1024) return;
    for (const [id, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(id);
    }
  }
}

const TRACE_IDLE_MS = 60 * 60_000;
const MAX_TRACKED_TRACES = 10_000;

/** Bytes forwarded per trace; past the cap a trace loses its content, not its spans. */
export class TraceByteBudget {
  private readonly traces = new Map<
    string,
    { bytes: number; lastSeen: number }
  >();

  constructor(
    private readonly maxBytesPerTrace: number,
    private readonly clock: Clock,
  ) {}

  /** Records `bytes` and says whether the trace was already over its cap. */
  charge(traceId: string, bytes: number): { overBudget: boolean } {
    const now = this.clock.now();
    this.forgetIdle(now);
    const entry = this.traces.get(traceId) ?? { bytes: 0, lastSeen: now };
    const overBudget = entry.bytes >= this.maxBytesPerTrace;
    entry.bytes += bytes;
    entry.lastSeen = now;
    // Re-inserted last, so Map order is least-recently-seen first.
    this.traces.delete(traceId);
    this.traces.set(traceId, entry);
    return { overBudget };
  }

  private forgetIdle(now: number): void {
    for (const [id, entry] of this.traces) {
      const oldest = now - entry.lastSeen >= TRACE_IDLE_MS;
      if (!oldest && this.traces.size < MAX_TRACKED_TRACES) return;
      this.traces.delete(id);
    }
  }
}
