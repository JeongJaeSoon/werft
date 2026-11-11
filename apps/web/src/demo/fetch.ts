/**
 * The demo build's whole backend: GET answers come from recorded fixtures,
 * every other method is refused with DEMO_READ_ONLY, and nothing leaves the
 * page. Timestamps move forward by the time since the recording, so "expires
 * in 3 days" and "2 hours ago" read the same on any day.
 */

export type DemoResponse =
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly sse: string };

export interface DemoFixtures {
  readonly recorded_at: string;
  /** Keyed by fixtureKey(url). */
  readonly responses: Readonly<Record<string, DemoResponse>>;
}

export interface DemoFetchOptions {
  readonly now?: () => number;
  /** Called for each refused write, before its answer. */
  readonly onWrite?: (method: string, path: string) => void;
}

export const DEMO_READ_ONLY = "DEMO_READ_ONLY";

const KEEPALIVE_MS = 15_000;
const DAY_MS = 86_400_000;
const DATE_TIME =
  /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))"/g;
const DATE = /"(\d{4}-\d{2}-\d{2})"/g;

/** Path plus the query sorted by name, so parameter order never misses. */
export function fixtureKey(url: URL): string {
  const params = [...url.searchParams].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = new URLSearchParams(params).toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * The exact recording, or else the one on the same path sharing the most
 * query parameters: a screen asks for date ranges computed from today.
 */
function findResponse(
  fixtures: DemoFixtures,
  url: URL,
): DemoResponse | undefined {
  const exact = fixtures.responses[fixtureKey(url)];
  if (exact) return exact;
  let best: DemoResponse | undefined;
  let bestScore = -1;
  for (const [key, response] of Object.entries(fixtures.responses)) {
    const recorded = new URL(key, url.origin);
    if (recorded.pathname !== url.pathname) continue;
    let score = 0;
    for (const [name, value] of url.searchParams)
      if (recorded.searchParams.getAll(name).includes(value)) score += 1;
    if (score > bestScore) {
      best = response;
      bestScore = score;
    }
  }
  return best;
}

export function shiftTimes(text: string, deltaMs: number): string {
  if (deltaMs === 0) return text;
  const days = Math.round(deltaMs / DAY_MS);
  return text
    .replace(DATE_TIME, (whole, value: string) => {
      const time = Date.parse(value);
      return Number.isNaN(time)
        ? whole
        : `"${new Date(time + deltaMs).toISOString()}"`;
    })
    .replace(DATE, (whole, value: string) => {
      const time = Date.parse(`${value}T00:00:00Z`);
      return Number.isNaN(time)
        ? whole
        : `"${new Date(time + days * DAY_MS).toISOString().slice(0, 10)}"`;
    });
}

/** The frames after `lastEventId`, or all of them. */
function framesAfter(body: string, lastEventId: string | null): string {
  if (!lastEventId) return body;
  const frames = body.split("\n\n");
  const index = frames.findIndex((frame) =>
    frame.split("\n").includes(`id: ${lastEventId}`),
  );
  return index < 0 ? body : frames.slice(index + 1).join("\n\n");
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, retryable: false } },
    { status },
  );
}

/**
 * A recorded stream replays, then stays open with keepalives (as the server's
 * does) until the caller aborts: closing it would reconnect in a loop.
 */
function streamResponse(body: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        clearInterval(timer);
        controller.error(signal.reason);
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      if (body) controller.enqueue(encoder.encode(body));
      timer = setInterval(
        () => controller.enqueue(encoder.encode(": keepalive\n\n")),
        KEEPALIVE_MS,
      );
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

export function createDemoFetch(
  fixtures: DemoFixtures,
  options: DemoFetchOptions = {},
): typeof fetch {
  const now = options.now ?? Date.now;
  const recordedAt = Date.parse(fixtures.recorded_at);
  const demoFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET") {
      options.onWrite?.(request.method, url.pathname);
      return errorResponse(
        403,
        DEMO_READ_ONLY,
        "This read-only demo does not save changes.",
      );
    }
    const found = findResponse(fixtures, url);
    if (!found)
      return errorResponse(404, "NOT_FOUND", "Not part of the demo data.");
    const delta = Number.isNaN(recordedAt) ? 0 : now() - recordedAt;
    if ("sse" in found)
      return streamResponse(
        shiftTimes(
          framesAfter(found.sse, request.headers.get("last-event-id")),
          delta,
        ),
        request.signal,
      );
    if (found.status === 204) return new Response(null, { status: 204 });
    return new Response(shiftTimes(JSON.stringify(found.json), delta), {
      status: found.status,
      headers: { "content-type": "application/json" },
    });
  };
  return demoFetch as typeof fetch;
}
