import {
  lastEventIdHeadersSchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import type { EventPage, SessionService } from "@werft-ai/platform";
import { streamSSE } from "hono/streaming";
import { ApiHttpError, type ApiRouter, apiRoute } from "../../app.ts";
import type { SessionEventWakeup } from "../../session-notifier.ts";
import { mapped, requireParams } from "../errors.ts";

// api.md § 이벤트: 15 s keepalive, and a revoked key ends the stream within
// the same window: a credential check is re-run every half interval and a
// stream never outlives its last successful check by more than one.
const SSE_KEEPALIVE_MS = 15_000;
// Per-connection replay page: at most this many rows and, past the first
// row, at most this many payload bytes are held in memory between writes.
// With the admission caps below that bounds replay memory to
// SSE_MAX_STREAMS × SSE_REPLAY_MAX_BYTES (256 MiB) whatever the history.
const SSE_REPLAY_BATCH = 100;
const SSE_REPLAY_MAX_BYTES = 1024 * 1024;

// Admission caps: a stream is a resident handle plus a query every
// keepalive, so a runaway client must not be able to open them without
// bound. Sized for the alpha's single API process; raise via server env.
const SSE_MAX_STREAMS = 256;
const SSE_MAX_STREAMS_PER_OWNER = 8;

export interface EventStreamOptions {
  wakeup: SessionEventWakeup;
  keepaliveMs?: number;
  batchSize?: number;
  batchMaxBytes?: number;
  maxStreams?: number;
  maxStreamsPerOwner?: number;
  logger?: Pick<StructuredLogger, "info" | "warn">;
}

export interface EventStreamHandle {
  activeStreams(): number;
}

function sleep(ms: number, signal: AbortSignal): Promise<"tick" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("tick");
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireLastEventId(
  headerValue: string | undefined,
): string | undefined {
  // An empty header is what a client sends after seeing no id yet; treat it
  // as absent rather than as a malformed cursor.
  const parsed = lastEventIdHeadersSchema.safeParse({
    "last-event-id": headerValue || undefined,
  });
  if (!parsed.success) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Last-Event-ID is invalid");
  }
  return parsed.data["last-event-id"];
}

export function registerEventRoutes(
  router: ApiRouter,
  service: SessionService,
  options: EventStreamOptions,
): EventStreamHandle {
  const keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS;
  const batchSize = options.batchSize ?? SSE_REPLAY_BATCH;
  const batchMaxBytes = options.batchMaxBytes ?? SSE_REPLAY_MAX_BYTES;
  const maxStreams = options.maxStreams ?? SSE_MAX_STREAMS;
  const maxStreamsPerOwner =
    options.maxStreamsPerOwner ?? SSE_MAX_STREAMS_PER_OWNER;
  const logger = options.logger ?? createLogger();
  let active = 0;
  const activeByOwner = new Map<string, number>();

  // Reserved before any database work so an over-limit client costs nothing
  // but this check; released when the stream ends or the request fails.
  const admit = (ownerId: string): (() => void) => {
    const mine = activeByOwner.get(ownerId) ?? 0;
    if (active >= maxStreams || mine >= maxStreamsPerOwner) {
      throw new ApiHttpError(
        429,
        "RATE_LIMITED",
        "Too many open event streams",
        true,
      );
    }
    active += 1;
    activeByOwner.set(ownerId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const rest = (activeByOwner.get(ownerId) ?? 1) - 1;
      if (rest <= 0) activeByOwner.delete(ownerId);
      else activeByOwner.set(ownerId, rest);
    };
  };

  apiRoute(router, "streamSessionEvents", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    // The UUID contract accepts either case; Postgres renders lowercase and
    // NOTIFY carries that spelling, so the waiter key must match it.
    const sessionId = params.id.toLowerCase();
    const actor = context.get("caller");
    const reauthenticate = context.get("reauthenticate");
    const after = requireLastEventId(context.req.header("Last-Event-ID"));
    let release: () => void;
    try {
      release = admit(actor.ownerId);
    } catch (error) {
      // Seconds: the earliest a slot can plausibly free up.
      context.header("Retry-After", String(Math.ceil(keepaliveMs / 1000)));
      throw error;
    }
    const read = (cursor: string | undefined) =>
      mapped(() =>
        service.readEvents(actor, sessionId, {
          ...(cursor === undefined ? {} : { after: cursor }),
          limit: batchSize,
          maxBytes: batchMaxBytes,
        }),
      );
    // A waiter is armed before every read, this first one included, so a
    // NOTIFY that lands between the read and the decision to wait is not
    // lost; the notifier only wakes waiters that exist when it fires.
    const armWait = (closed: AbortSignal) => {
      const wake = new AbortController();
      const unlink = () => wake.abort();
      closed.addEventListener("abort", unlink, { once: true });
      const notified = options.wakeup.wait(sessionId, wake.signal);
      const armed = {
        signal: wake.signal,
        notified,
        // Set by a NOTIFY, which may be a share change: the page being sent
        // stops there and the next read decides whether the stream may go on.
        fired: false,
        release() {
          closed.removeEventListener("abort", unlink);
          wake.abort();
        },
      };
      notified.then(() => {
        if (!wake.signal.aborted) armed.fired = true;
      });
      return armed;
    };
    const closed = new AbortController();
    const closeWith = (reason: string) => {
      if (!closed.signal.aborted) closed.abort(reason);
    };
    // Credential watchdog, independent of whatever the loop is awaiting: a
    // read can span several pool timeouts and a write can sit on
    // backpressure, and neither may stretch the revocation window. A
    // verification is good for one keepalive from the moment it started;
    // the next one starts halfway through and has the other half to answer,
    // so the stream is never more than one keepalive past a check that
    // would have said no. Nothing is written past `verifiedUntil`: a frame
    // that finds it expired waits for the in-flight check (or runs one)
    // instead of closing, because on a busy event loop the timer itself can
    // fire late and a late timer is not a revoked key. The first
    // verification is the middleware's, before the first read.
    let onRevoked: (() => void) | undefined;
    let verifiedUntil = Date.now() + keepaliveMs;
    let inflight: Promise<boolean> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const verify = async (): Promise<boolean> => {
      const startedAt = Date.now();
      let bound: ReturnType<typeof setTimeout> | undefined;
      let verdict: boolean;
      try {
        verdict = await Promise.race([
          reauthenticate(),
          new Promise<boolean>((resolve) => {
            bound = setTimeout(() => resolve(false), keepaliveMs / 2);
          }),
        ]);
      } catch {
        verdict = false;
      } finally {
        clearTimeout(bound);
      }
      if (verdict) verifiedUntil = startedAt + keepaliveMs;
      return verdict;
    };
    const armWatchdog = () => {
      if (closed.signal.aborted) return;
      watchdog = setTimeout(
        async () => {
          inflight = verify();
          const verdict = await inflight;
          inflight = undefined;
          if (closed.signal.aborted) return;
          if (!verdict) {
            closeWith("credential_revoked");
            onRevoked?.();
            return;
          }
          armWatchdog();
        },
        Math.max(0, verifiedUntil - Date.now() - keepaliveMs / 2),
      );
    };
    const disarmWatchdog = () => clearTimeout(watchdog);
    armWatchdog();

    let armed = armWait(closed.signal);
    // The first page is read before the response commits to a stream, so an
    // unknown session, a foreign owner, a bad cursor and a storage outage are
    // still ordinary HTTP errors with the API envelope.
    let firstPage: EventPage;
    try {
      firstPage = await read(after);
      if (closed.signal.aborted) {
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Authentication is required",
        );
      }
    } catch (error) {
      // Abort first: a verification in flight would otherwise re-arm the
      // watchdog after this request is gone and keep polling the key store.
      closeWith("read_failed");
      armed.release();
      disarmWatchdog();
      release();
      throw error;
    }

    // Reverse proxies buffer responses by default; nginx honours this header
    // and the Cache-Control that streamSSE sets.
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      // Abort the body too: a write blocked on backpressure or a read still
      // in flight would otherwise keep the connection open past the verdict.
      onRevoked = () => stream.abort();
      stream.onAbort(() => closeWith("client_disconnected"));
      context.req.raw.signal.addEventListener(
        "abort",
        () => closeWith("client_disconnected"),
        { once: true },
      );

      let sent = 0;
      let cursor = after;
      // A write blocks on client backpressure. Past one keepalive the
      // connection is treated as dead: the body is aborted so the pending
      // write fails instead of holding the credential check hostage. The
      // timer is cleared when the write wins, so a fast replay does not
      // leave one pending timer per frame.
      const writeBounded = async (write: () => Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), keepaliveMs);
        });
        try {
          return await Promise.race([write().then(() => true), stalled]);
        } finally {
          clearTimeout(timer);
        }
      };
      logger.info("SSE stream opened", {
        session_id: sessionId,
        after: after ?? null,
        active_streams: active,
      });
      try {
        let page = firstPage;
        while (!closed.signal.aborted) {
          let interrupted = false;
          for (const event of page.items) {
            if (closed.signal.aborted) break;
            if (armed.fired) {
              interrupted = true;
              break;
            }
            // The watchdog closes the stream on a "no"; this guard keeps a
            // frame from going out while the answer is still pending.
            if (Date.now() > verifiedUntil) {
              const verdict = await (inflight ?? verify());
              if (closed.signal.aborted) break;
              if (!verdict || Date.now() > verifiedUntil) {
                closeWith("credential_revoked");
                break;
              }
            }
            const written = await writeBounded(() =>
              stream.writeSSE({
                id: event.id,
                event: event.event,
                data: JSON.stringify(event.data),
              }),
            );
            if (!written) {
              closeWith("write_stalled");
              stream.abort();
              break;
            }
            cursor = event.id;
            sent += 1;
          }
          if (closed.signal.aborted) break;
          // No more means the high-watermark is reached: wait for a NOTIFY,
          // bounded by the keepalive so a lost notification costs at most
          // one interval. Otherwise keep replaying; the high-watermark is
          // simply the last id sent.
          if (!page.more && !interrupted) {
            const outcome = await Promise.race([
              armed.notified.then(() => "notify" as const),
              sleep(keepaliveMs, armed.signal),
            ]);
            if (closed.signal.aborted) break;
            if (outcome === "tick") {
              if (
                !(await writeBounded(() => stream.write(": keepalive\n\n")))
              ) {
                closeWith("write_stalled");
                stream.abort();
                break;
              }
            }
          }
          armed.release();
          armed = armWait(closed.signal);
          page = await read(cursor);
        }
      } catch (error) {
        // A re-read the session's share no longer allows (a narrowed share
        // wakes the stream): end it, and the reconnect is refused with 404.
        if (error instanceof ApiHttpError && error.status === 404) {
          closeWith("not_visible");
        } else if (
          error instanceof ApiHttpError &&
          (error.status === 401 || error.status === 403) &&
          !(await (inflight ?? verify()))
        ) {
          // A read re-checks the caller's grant, so a key revoked during the
          // wait can refuse it before the watchdog's own check answers. The
          // same check decides: the stream ends as a revocation, not as a
          // failed read.
          closeWith("credential_revoked");
        } else {
          // Headers are gone, so there is no error envelope to send; the
          // client reconnects with the last id it saw and the read is
          // repeated then.
          logger.warn("SSE stream failed", {
            session_id: sessionId,
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
          closeWith("read_failed");
        }
      } finally {
        armed.release();
        disarmWatchdog();
        release();
        logger.info("SSE stream closed", {
          session_id: sessionId,
          reason: closed.signal.aborted ? String(closed.signal.reason) : "eof",
          events_sent: sent,
          active_streams: active,
        });
      }
    });
  });

  return { activeStreams: () => active };
}
