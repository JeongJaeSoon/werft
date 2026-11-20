import { AUDIT_EXPORT_MEDIA_TYPE } from "@werft-ai/contracts";
import { RequestDeadline, runWithDeadline } from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import type { Context, Next } from "hono";
import type { ApiEnvironment } from "./app.ts";

// One /v1 request, start to response: the key lookup, the body, the pool
// wait and the whole transaction. Each pool stage has its own timeout
// (apps/control-host/src/api/pool.ts), but a degraded database that answers every
// statement just inside statement_timeout would otherwise stack them past any
// proxy's patience; this is the sum's cap.
export const REQUEST_DEADLINE_MS = 30_000;
// Bun's idle clock while a /v1 handler works: a backstop above the deadline,
// so the deadline's 503 is always what the client sees and a handler stuck
// outside the database is still cut off eventually.
export const REQUEST_IDLE_TIMEOUT_SECONDS = 40;
// Bun's default, restored once the response is decided so a kept-alive
// connection that sends nothing more is closed rather than held forever.
// Event streams stay off it: they write on their own keepalive clock.
export const RESPONSE_IDLE_TIMEOUT_SECONDS = 10;
// After a response that says `Connection: close`. Bun does not close on that
// header while request bytes are still unread, and rounds its idle clock to
// ~4 s ticks, so the 10 s default held a stalled sender's socket 8-12 s past
// the 408.
export const CLOSING_IDLE_TIMEOUT_SECONDS = 1;

const STREAM_MEDIA_TYPES = ["text/event-stream", AUDIT_EXPORT_MEDIA_TYPE];

export interface RequestDeadlineOptions {
  deadlineMs?: number;
  logger: StructuredLogger;
  // The response the client gets when the deadline passes first.
  expired: () => Error;
}

export function requestDeadline(options: RequestDeadlineOptions) {
  const deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
  return async (context: Context<ApiEnvironment>, next: Next) => {
    const setIdleTimeout = context.env?.setIdleTimeout ?? (() => {});
    const deadline = new RequestDeadline(performance.now() + deadlineMs);
    context.set("handlerIdleSeconds", REQUEST_IDLE_TIMEOUT_SECONDS);
    setIdleTimeout(REQUEST_IDLE_TIMEOUT_SECONDS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    // Hono's compose turns a handler error into the onError response inside
    // next(), so this settles with the route's answer either way.
    const handled = runWithDeadline(deadline, next).then(() => "done" as const);
    const outcome = await Promise.race([handled, expired]);
    clearTimeout(timer);
    if (outcome === "expired") {
      // Whatever the handler holds is dropped now, a statement in flight
      // included; if that statement was a COMMIT the server had already
      // applied, the client's retry with its Idempotency-Key replays the
      // result.
      deadline.expire();
      handled.catch(() => {});
      options.logger.warn("API request deadline exceeded", {
        method: context.req.method,
        path: context.req.path,
        deadline_ms: deadlineMs,
      });
      setIdleTimeout(RESPONSE_IDLE_TIMEOUT_SECONDS);
      throw options.expired();
    }
    // The response is decided, and is what the client gets even if the timer
    // was merely late: a handler that finished has nothing left to cancel.
    // Anything that keeps running for the response (an SSE stream) runs on
    // its own clocks, as it did before the deadline existed.
    deadline.finish();
    // An audit export can sit between pages longer than the default idle
    // clock; its own deadline and watchdog bound it.
    const contentType = context.res.headers.get("Content-Type") ?? "";
    const streaming = STREAM_MEDIA_TYPES.some((type) =>
      contentType.startsWith(type),
    );
    const closing = context.res.headers.get("Connection") === "close";
    setIdleTimeout(
      streaming
        ? 0
        : closing
          ? CLOSING_IDLE_TIMEOUT_SECONDS
          : RESPONSE_IDLE_TIMEOUT_SECONDS,
    );
  };
}

// Wall-clock cap on receiving a body. The idle clock alone never fires on a
// sender that drips a byte at a time. 64 KiB (REQUEST_BODY_MAX_BYTES) in
// 15 s is 4 KiB/s; the time also counts against REQUEST_DEADLINE_MS.
export const BODY_DEADLINE_MS = 15_000;

export type BodyRead =
  | { kind: "read"; bytes: ArrayBuffer; size: number }
  | { kind: "timeout" };

// Reads the whole body, keeping at most `keepBytes` of it (the caller refuses
// anything larger, but draining the rest lets the client read that refusal
// instead of a reset). On timeout the read is cancelled rather than left
// pending behind the response.
export async function readBodyWithin(
  request: Request,
  deadlineMs: number,
  keepBytes: number,
): Promise<BodyRead> {
  if (!request.body) {
    return { kind: "read", bytes: new ArrayBuffer(0), size: 0 };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "timeout") {
        reader.cancel().catch(() => {});
        return { kind: "timeout" };
      }
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size <= keepBytes) {
        chunks.push(next.value);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(size <= keepBytes ? size : 0);
  if (size <= keepBytes) {
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return { kind: "read", bytes: bytes.buffer, size };
}
