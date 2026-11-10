// The telemetry ingest listener's request handler: a fetch function with no
// Bun or Postgres in it. `worker -> POST /v1/traces (OTLP/JSON, bearer session
// credential) -> checks -> rewrite -> queue -> collector`. It answers from
// local state only; the collector is behind the queue.

import type { ContentMode } from "@werft-ai/observability";
import type { ForwardQueue } from "./forward-queue.ts";
import { AttemptRateLimiter, TraceByteBudget } from "./limits.ts";
import { decodeTraceRequest, OtlpDecodeError } from "./otlp-json.ts";
import type {
  AttemptAuthenticator,
  Clock,
  DropCounter,
  TurnTraceDirectory,
  ValueMasker,
} from "./ports.ts";
import { sanitizeSpan } from "./sanitize.ts";

export interface IngestLimits {
  readonly maxRequestBytes: number;
  readonly maxBytesPerMinute: number;
  readonly maxBytesPerTrace: number;
  readonly fencedGraceSec: number;
  /** Requests being read or checked at once; more get a 503. */
  readonly maxConcurrent: number;
}

export interface IngestDeps {
  readonly authenticator: AttemptAuthenticator;
  readonly turns: TurnTraceDirectory;
  readonly queue: ForwardQueue;
  readonly masker: ValueMasker;
  readonly drops: DropCounter;
  readonly limits: IngestLimits;
  /** The installation's ceiling; a workspace's own mode is not plumbed yet. */
  readonly contentMode: () => ContentMode;
  readonly clock?: Clock;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

/** Reads at most `limit` bytes; undefined when the body is larger. */
async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

export function createIngestHandler(
  deps: IngestDeps,
): (request: Request) => Promise<Response> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const { limits } = deps;
  const rate = new AttemptRateLimiter(limits.maxBytesPerMinute, clock);
  const budget = new TraceByteBudget(limits.maxBytesPerTrace, clock);
  let inFlight = 0;

  async function handle(request: Request): Promise<Response> {
    const token = bearer(request);
    if (token === undefined) {
      return reply(401, { error: "A bearer session credential is required" });
    }
    const attempt = await deps.authenticator.authenticate(token);
    if (attempt === null) {
      return reply(401, { error: "The credential is unknown or expired" });
    }
    let fenced = false;
    if (attempt.fence.state === "lost") {
      const lostForMs = clock.now() - attempt.fence.lostAt.getTime();
      if (lostForMs > limits.fencedGraceSec * 1000) {
        return reply(409, { error: "The attempt no longer owns its session" });
      }
      fenced = true;
    }

    const bytes = await readBounded(request, limits.maxRequestBytes);
    if (bytes === undefined) return reply(413, { error: "Body too large" });
    const limited = rate.admit(attempt.attemptId, bytes.byteLength);
    if (limited !== undefined) {
      deps.drops.dropped("rate_limited", 1);
      return reply(
        429,
        { error: "Per-minute telemetry byte limit reached" },
        { "retry-after": String(limited.retryAfterSec) },
      );
    }

    let spans: ReturnType<typeof decodeTraceRequest>;
    try {
      spans = decodeTraceRequest(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof OtlpDecodeError) {
        return reply(400, { error: error.message });
      }
      throw error;
    }

    const allowed = await deps.turns.traceIdsOf(attempt);
    const contentMode = deps.contentMode();
    const accepted = [];
    let rejected = 0;
    for (const span of spans) {
      if (!allowed.has(span.traceId)) {
        rejected += 1;
        continue;
      }
      const size = JSON.stringify(span).length;
      const { overBudget } = budget.charge(span.traceId, size);
      accepted.push(
        sanitizeSpan(span, {
          attempt,
          contentMode,
          contentDropped: overBudget,
          fenced,
          masker: deps.masker,
        }),
      );
    }
    if (rejected > 0) deps.drops.dropped("foreign_trace", rejected);
    const refused = deps.queue.enqueue(accepted);
    rejected += refused;
    return reply(
      200,
      rejected === 0 ? {} : { partialSuccess: { rejectedSpans: rejected } },
    );
  }

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/traces") {
      return reply(404, { error: "Not found" });
    }
    if (request.method !== "POST") {
      return reply(405, { error: "POST only" }, { allow: "POST" });
    }
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      return reply(415, { error: "Send OTLP/JSON as application/json" });
    }
    if (request.headers.get("content-encoding")) {
      return reply(415, { error: "Content-Encoding is not accepted" });
    }
    if (inFlight >= limits.maxConcurrent) {
      return reply(503, { error: "Busy" }, { "retry-after": "1" });
    }
    inFlight += 1;
    try {
      return await handle(request);
    } catch {
      return reply(500, { error: "Telemetry ingest failed" });
    } finally {
      inFlight -= 1;
    }
  };
}
