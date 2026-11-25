import { type ApiClient, policyOf } from "./client.ts";
import { ApiError, errorFromResponse, retryAfterSeconds } from "./errors.ts";
import {
  createFrameParser,
  type RawFrame,
  readFrame,
  type SessionEventFrame,
} from "./sse.ts";

export type StreamState = "connecting" | "open" | "closed";

export interface SubscribeOptions {
  /** The caller's way to stop; the returned promise resolves once it aborts. */
  readonly signal: AbortSignal;
  /** Resume strictly after this cursor; without it the stream replays from the start. */
  readonly lastEventId?: string;
  /** An event id among the last 1,000 delivered is not delivered again. */
  readonly onEvent: (frame: SessionEventFrame) => void;
  readonly onState?: (state: StreamState) => void;
  /** An error the stream does not recover from; the subscription has ended. */
  readonly onError?: (error: ApiError) => void;
  /**
   * Before each wait to reconnect: how many attempts in a row failed to open
   * the stream. An opened stream starts the count again.
   */
  readonly onRetry?: (failedAttempts: number) => void;
  readonly retry?: RetryTiming;
}

export interface RetryTiming {
  /**
   * First wait before reconnecting; doubles per failed attempt up to maxMs.
   * Each wait is drawn between half of it and all of it, so clients dropped
   * together do not come back together.
   */
  readonly initialMs?: number;
  readonly maxMs?: number;
  /**
   * How long a refusal whose authorization could not be decided (403 with
   * `reason_code` "error", as while storage is unreachable) is retried
   * before the subscription ends with it.
   */
  readonly undecidedMs?: number;
  /**
   * No bytes for this long reads as a dead connection. The server sends a
   * keepalive comment every 15 s.
   */
  readonly idleMs?: number;
}

const OPERATION = "SSE /v1/sessions/{id}/events";
const DEDUPE_WINDOW = 1_000;

/**
 * Session events over fetch: unlike EventSource it carries the client's
 * headers, sees HTTP statuses, and resumes with Last-Event-ID after any drop.
 * Frames of a kind or envelope version this client does not know are dropped,
 * but the cursor still moves past them, or a reconnect would stall on them.
 */
export async function subscribeSessionEvents(
  client: ApiClient,
  sessionId: string,
  options: SubscribeOptions,
): Promise<void> {
  const { signal } = options;
  const policy = policyOf(client);
  const initialMs = options.retry?.initialMs ?? 1_000;
  const maxMs = options.retry?.maxMs ?? 30_000;
  const idleMs = options.retry?.idleMs ?? 45_000;
  const undecidedMs = options.retry?.undecidedMs ?? 300_000;
  // Recent ids only: a repeat can only come from a replay around a reconnect.
  const delivered = new Set<string>();
  let cursor = options.lastEventId || undefined;
  let backoff = initialMs;
  let failedAttempts = 0;
  // The first refusal the policy could not decide, while nothing has opened
  // since: the window it starts holds whatever failures follow it.
  let undecided:
    | { readonly since: number; readonly error: ApiError }
    | undefined;

  /** Returns false once the subscription must end. */
  const receive = (raw: RawFrame): boolean => {
    const reading = readFrame(raw, sessionId);
    // A repeat is an older frame replayed; following it would move the
    // cursor backwards.
    if (reading.kind === "event" && delivered.has(reading.frame.id))
      return true;
    // Every other frame moves the cursor, dropped ones too, or a reconnect
    // would stall on the same frame for good.
    if (raw.id) cursor = raw.id;
    try {
      if (reading.kind !== "event") {
        if (reading.kind === "mismatch" || policy.mode === "strict")
          policy.report(
            { operation: OPERATION, issues: reading.issues },
            200,
            null,
          );
        return true;
      }
      policy.check(
        OPERATION,
        policy.validators.sessionEvent,
        reading.wire,
        200,
        null,
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      options.onError?.(error);
      return false;
    }
    delivered.add(reading.frame.id);
    if (delivered.size > DEDUPE_WINDOW)
      delivered.delete(delivered.values().next().value as string);
    // A stream that opens and then fails at once must not retry every second.
    backoff = initialMs;
    options.onEvent(reading.frame);
    return true;
  };

  /** One connection; resolves to the wait before the next, or null to end. */
  const connect = async (): Promise<number | null> => {
    // onState("connecting") may have aborted; the listener below would never fire.
    if (signal.aborted) return null;
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    signal.addEventListener("abort", stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(stop, idleMs);
    };
    touch();
    try {
      const open = () =>
        client.GET("/v1/sessions/{id}/events", {
          params: {
            path: { id: sessionId },
            header: cursor ? { "Last-Event-ID": cursor } : {},
          },
          headers: { accept: "text/event-stream" },
          parseAs: "stream",
          signal: attempt.signal,
        });
      let result: Awaited<ReturnType<typeof open>>;
      try {
        result = await open();
      } catch {
        failedAttempts += 1;
        return signal.aborted ? null : jittered(backoff);
      }
      const { data: body, error, response } = result;
      if (!response.ok) {
        failedAttempts += 1;
        const retryAfter = retryAfterSeconds(response);
        if (response.status === 429 || response.status === 503)
          return retryAfter ? retryAfter * 1_000 : jittered(backoff);
        if (response.status >= 500 || response.status === 408)
          return jittered(backoff);
        const refusal = errorFromResponse(response, error);
        if (couldNotDecide(refusal)) {
          undecided ??= { since: Date.now(), error: refusal };
          return jittered(backoff);
        }
        options.onError?.(refusal);
        return null;
      }
      if (!body) {
        failedAttempts += 1;
        return jittered(backoff);
      }
      failedAttempts = 0;
      undecided = undefined;
      options.onState?.("open");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = createFrameParser();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        if (chunk.done) break;
        touch();
        for (const raw of parser.push(
          decoder.decode(chunk.value, { stream: true }),
        )) {
          // An onEvent that aborts must not see the rest of the chunk.
          if (signal.aborted || !receive(raw)) {
            await reader.cancel().catch(() => {});
            return null;
          }
        }
      }
      await reader.cancel().catch(() => {});
      return signal.aborted ? null : jittered(backoff);
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", stop);
    }
  };

  /** Ends the subscription with the undecided refusal once its window is over. */
  const expired = (): boolean => {
    if (!undecided || Date.now() - undecided.since < undecidedMs) return false;
    options.onError?.(undecided.error);
    return true;
  };

  try {
    while (!signal.aborted) {
      options.onState?.("connecting");
      const wait = await connect();
      if (wait === null || expired()) return;
      backoff = Math.min(backoff * 2, maxMs);
      options.onRetry?.(failedAttempts);
      // No wait, a long Retry-After included, outlasts the window.
      await sleep(
        undecided
          ? Math.min(wait, undecided.since + undecidedMs - Date.now())
          : wait,
        signal,
      );
      if (expired()) return;
    }
  } finally {
    options.onState?.("closed");
  }
}

export function jittered(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}

/**
 * The policy refused because it could not reach a decision, not because the
 * caller lacks the grant; the same refusal the Slack adapter retries.
 */
function couldNotDecide(error: ApiError): boolean {
  if (error.status !== 403) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason_code?: unknown }).reason_code === "error"
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
