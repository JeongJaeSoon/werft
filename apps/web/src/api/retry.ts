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
 * A fetch that asks again when a GET or HEAD meets a gateway status or a
 * dropped connection. Any other method is sent once: a write the server may
 * already have applied is never repeated.
 */
export function retryingFetch(
  fetch: Fetch,
  delaysMs: readonly number[] = READ_RETRY_DELAYS_MS,
): Fetch {
  return async (request) => {
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
      if (last) return withErrorCode(response);
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
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
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
