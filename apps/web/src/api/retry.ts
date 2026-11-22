import { ApiError } from "@werft-ai/client";

/**
 * Waits before each new attempt of a safe read; one wait per retry, so its
 * length is the retry limit.
 */
export const READ_RETRY_DELAYS_MS: readonly number[] = [300, 1_000, 2_000];

/** What openapi-fetch calls: one Request, no init. */
type Fetch = (request: Request) => Promise<Response>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);
// What a proxy or load balancer answers while the API restarts behind it.
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Whether the client already asked again before this error reached the
 * caller; a query retrying it too would multiply the requests. A
 * NETWORK_ERROR is not known to be: the connection may have dropped while a
 * body was read, after the fetch had answered.
 */
export function retriedByClient(error: unknown): boolean {
  return error instanceof ApiError && GATEWAY_STATUSES.has(error.status);
}

/**
 * A fetch that asks again when a GET or HEAD meets a gateway status or a
 * dropped connection. Any other method is sent once: a write the server may
 * already have applied is never repeated. An event stream keeps its own
 * reconnect, and an answer with Retry-After is left to the caller: the server
 * said how long to wait.
 */
export function retryingFetch(
  fetch: Fetch,
  delaysMs: readonly number[] = READ_RETRY_DELAYS_MS,
): Fetch {
  return async (request) => {
    if (request.headers.get("accept")?.includes("text/event-stream"))
      return fetch(request);
    const retries = SAFE_METHODS.has(request.method.toUpperCase())
      ? delaysMs
      : [];
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries.length;
      let response: Response;
      try {
        // A body-less request can be sent again, but the original stays
        // unread so every attempt starts from the same one.
        response = await fetch(request.clone());
      } catch (cause) {
        if (last || request.signal.aborted) throw cause;
        await wait(retries[attempt] ?? 0, request.signal);
        continue;
      }
      if (!GATEWAY_STATUSES.has(response.status)) return response;
      if (last || response.headers.has("retry-after"))
        return withErrorCode(response);
      await response.body?.cancel();
      await wait(retries[attempt] ?? 0, request.signal);
    }
  };
}

/**
 * A gateway's own page has no API error code and would read as UNKNOWN; it
 * reads as BACKEND_UNAVAILABLE, so a screen says to try again shortly. An
 * answer the API wrote keeps its code.
 */
async function withErrorCode(response: Response): Promise<Response> {
  let code: unknown;
  try {
    code = JSON.parse(await response.clone().text())?.error?.code;
  } catch {}
  if (typeof code === "string") return response;
  await response.body?.cancel();
  // Only what still describes the new body: a copied Content-Length: 0 would
  // have it skipped unread.
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["x-request-id", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const body = {
    error: {
      code: "BACKEND_UNAVAILABLE",
      message: response.statusText || `HTTP ${response.status}`,
      retryable: true,
    },
  };
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
