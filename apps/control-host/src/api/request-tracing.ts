import {
  noopTracer,
  parseTraceparent,
  type SpanContext,
  type Tracer,
  turnTraceId,
} from "@werft-ai/observability";
import type { Context } from "hono";
import { routePath } from "hono/route";

// The route hono reports when nothing but the catch-all matched.
const UNMATCHED_ROUTES = new Set(["*", "/*"]);
const TURN_SEQUENCE = /^[1-9][0-9]*$/;

/** `POST /v1/sessions/:id/turns`; just the method when no route matched. */
function spanName(context: Context): string {
  const template = routePath(context, -1);
  return UNMATCHED_ROUTES.has(template)
    ? context.req.method
    : `${context.req.method} ${template}`;
}

function sessionIdParam(context: Context): string | undefined {
  return context.req.path.startsWith("/v1/sessions/")
    ? context.req.param("id")
    : undefined;
}

/**
 * HTTP spans for the API, kept out of the Hono wiring so the rules in the
 * design (decision record "observability-otel-and-tool-call-audit", 4.2 and
 * 5.3) live in one place and run against any `Tracer`.
 */
export class RequestTracing {
  constructor(private readonly tracer: Tracer = noopTracer) {}

  /**
   * Runs `work` inside the span of a `/v1` request. The span is always a new
   * root: the client's `traceparent` becomes a link, and its sampled flag is
   * not followed, so a client can neither join another trace nor mute ours.
   */
  async traceApiRequest<T>(
    context: Context,
    requestId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const path = context.req.path;
    if (path !== "/v1" && !path.startsWith("/v1/")) return work();

    const sent = context.req.header("traceparent");
    const client = sent === undefined ? undefined : parseTraceparent(sent);
    const route = routePath(context, -1);
    return this.tracer.withSpan(
      spanName(context),
      {
        kind: "server",
        parent: "root",
        ...(client === undefined ? {} : { links: [client] }),
        attributes: {
          "http.request.method": context.req.method,
          ...(UNMATCHED_ROUTES.has(route) ? {} : { "http.route": route }),
          "werft.request_id": requestId,
        },
      },
      async (span) => {
        try {
          return await work();
        } finally {
          const status = context.res.status;
          span.setAttribute("http.response.status_code", status);
          const sessionId = sessionIdParam(context);
          if (sessionId !== undefined) {
            span.setAttribute("werft.session_id", sessionId);
          }
          if (status >= 500) {
            span.setAttribute("error.type", `http_${status}`);
            span.setError(`HTTP ${status}`);
          }
        }
      },
    );
  }

  /**
   * A worker gateway call is traced only as a child of its turn's trace: the
   * `traceparent` must carry the trace id derived from the session and turn
   * the call acts for. Anything else (no header, another trace, no turn)
   * gets no span, because heartbeats and long polls would otherwise fill the
   * collector with single-span traces.
   */
  async traceGatewayCall(
    context: Context,
    scope: { readonly session_id?: unknown; readonly turn_id?: unknown },
    work: () => Promise<Response>,
  ): Promise<Response> {
    const parent = this.turnParent(context, scope);
    if (parent === undefined) return work();
    return this.tracer.withSpan(
      spanName(context),
      {
        kind: "server",
        parent,
        attributes: {
          "http.request.method": context.req.method,
          "http.route": routePath(context, -1),
          "werft.session_id": String(scope.session_id),
        },
      },
      async (span) => {
        // A handler that throws has no response yet; withSpan marks it failed.
        const response = await work();
        span.setAttribute("http.response.status_code", response.status);
        return response;
      },
    );
  }

  private turnParent(
    context: Context,
    scope: { readonly session_id?: unknown; readonly turn_id?: unknown },
  ): SpanContext | undefined {
    const sent = context.req.header("traceparent");
    if (sent === undefined) return undefined;
    const { session_id: sessionId, turn_id: turnId } = scope;
    if (typeof sessionId !== "string" || typeof turnId !== "string") {
      return undefined;
    }
    if (!TURN_SEQUENCE.test(turnId)) return undefined;
    const parent = parseTraceparent(sent);
    if (parent === undefined) return undefined;
    return parent.traceId === turnTraceId(sessionId, Number(turnId))
      ? parent
      : undefined;
  }
}
