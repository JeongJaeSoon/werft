import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
  healthResponseSchema,
  LINK_MESSAGES,
  ownerScopeOf,
  PAYLOAD_TOO_LARGE_ISSUE,
  type Principal,
  REQUEST_BODY_MAX_BYTES,
  type RequestBodyInvalidDetails,
  readyResponseSchema,
} from "@werft-ai/contracts";
import {
  isConnectionFailure,
  RequestDeadlineExceededError,
} from "@werft-ai/db/pool";
import {
  createLogger,
  type StructuredLogger,
  type Tracer,
} from "@werft-ai/observability";
import {
  type AuthorizationPolicy,
  type Caller,
  callerFor,
  type IdentityStore,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import type { Context, Handler, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { registerApiReferenceRoutes } from "./api-reference.ts";
import { createAuthenticator, csrfViolation } from "./auth.ts";
import {
  BODY_DEADLINE_MS,
  CLOSING_IDLE_TIMEOUT_SECONDS,
  readBodyWithin,
  requestDeadline,
} from "./deadline.ts";
import type { ApiKeyStore } from "./keys.ts";
import {
  type ApiOperationId,
  apiRouteConfig,
  buildOpenApiDocument,
} from "./openapi.ts";
import type { ReadinessProbe } from "./readiness.ts";
import { RequestTracing } from "./request-tracing.ts";
import { actionForScope, missingScope } from "./scope-policy.ts";
import { createWebDistHandler } from "./web-dist.ts";

interface ApiVariables {
  // The alpha partition key; every existing route authorizes on it alone.
  ownerId: string;
  principal: Principal;
  // What every session service is called as.
  caller: Caller;
  verified: boolean;
  // Present on the cookie path only.
  webSession?: ResolvedWebSession;
  requestId: string;
  // Re-runs the credential check that admitted this request; false once the
  // key is revoked. Long-lived responses (SSE) call it on their clock so a
  // revocation ends the stream instead of outliving it.
  reauthenticate: () => Promise<boolean>;
  // The idle clock while the handler does database work: above the request
  // deadline under /v1, off (0) elsewhere.
  handlerIdleSeconds?: number;
}

interface ApiBindings {
  // Sets the server's idle clock for this request, in seconds; 0 stops it.
  // The app lifts it above the request deadline (or stops it) for database
  // work so a response that waits on the pool's timeouts is not reset
  // mid-flight, and re-arms it while it ingests a body so a slow sender is
  // still cut off.
  setIdleTimeout?: (seconds: number) => void;
}

export type ApiEnvironment = {
  Bindings: ApiBindings;
  Variables: ApiVariables;
};

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// What a connection gets while bytes are still expected; above
// BODY_DEADLINE_MS, so a sender that stops outright gets the 408 too rather
// than a reset.
export const BODY_IDLE_TIMEOUT_SECONDS = 20;

export type ApiRouter = OpenAPIHono<ApiEnvironment>;

function registerOpenApiRoute(
  router: ApiRouter,
  operationId: ApiOperationId,
  handler: Handler<ApiEnvironment>,
  options: {
    basePath?: string;
    middleware?: MiddlewareHandler<ApiEnvironment>;
  } = {},
): void {
  const route = apiRouteConfig(operationId, options.basePath);
  const registered = options.middleware
    ? { ...route, middleware: options.middleware }
    : route;
  // The config is found by operation id at runtime, so there is no per-route
  // type for OpenAPIHono to check the handler against.
  router.openapi(registered as never, handler as never);
}

export function apiRoute(
  router: ApiRouter,
  operationId: ApiOperationId,
  handler: Handler<ApiEnvironment>,
): void;
export function apiRoute(
  router: ApiRouter,
  operationId: ApiOperationId,
  middleware: MiddlewareHandler<ApiEnvironment>,
  handler: Handler<ApiEnvironment>,
): void;
export function apiRoute(
  router: ApiRouter,
  operationId: ApiOperationId,
  middlewareOrHandler:
    | MiddlewareHandler<ApiEnvironment>
    | Handler<ApiEnvironment>,
  handler?: Handler<ApiEnvironment>,
): void {
  registerOpenApiRoute(
    router,
    operationId,
    handler ?? (middlewareOrHandler as Handler<ApiEnvironment>),
    {
      basePath: "/v1",
      ...(handler ? { middleware: middlewareOrHandler } : {}),
    },
  );
}

export interface CreateApiAppOptions {
  authMode?: string;
  keyStore?: ApiKeyStore;
  // Enables the cookie-session path of the /v1 middleware.
  identity?: IdentityStore;
  logger?: StructuredLogger;
  registerRoutes?: (router: ApiRouter) => void;
  // Mounted under /v1 ahead of the auth middleware: the public allowlist
  // (bootstrap, login, invite accept). Anything not registered here still
  // falls through to the authenticated router and answers 401. Each route
  // attaches ingestThenStopClock itself.
  registerPublicRoutes?: (router: ApiRouter) => void;
  // Mounted under /internal, outside the /v1 API-key middleware; each
  // internal route family brings its own authentication.
  registerInternalRoutes?: (router: ApiRouter) => void;
  // Backs GET /readyz; without one the process reports 503 NOT_READY, so a
  // build that forgot to wire the probe is never routed traffic.
  readiness?: ReadinessProbe;
  // Overrides REQUEST_DEADLINE_MS, for tests.
  requestDeadlineMs?: number;
  webDistDir?: string;
  authorization?: AuthorizationPolicy;
  // Without one, requests are not traced and nothing else changes.
  tracer?: Tracer;
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    // Sent as Retry-After: when a retry is worth making, not a promise.
    readonly retryAfterSeconds?: number,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

// A lost connection (isConnectionFailure), insufficient resources (53xxx:
// too many connections, disk full), operator intervention (57xxx: admin
// shutdown, and 57014 for a statement_timeout cancel), a transaction rolled
// back for losing to a concurrent one (40001 serialization, 40P01 deadlock,
// 55P03 a lock_timeout: nothing it wrote landed, so the same request can
// simply be sent again), or the request's own deadline. Walks the cause
// chain because Drizzle and pg-pool both wrap the original error.
export function isStorageUnavailable(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    if (
      current instanceof RequestDeadlineExceededError ||
      isConnectionFailure(current)
    ) {
      return true;
    }
    const code = (current as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      (code.startsWith("53") ||
        code.startsWith("57") ||
        code === "40001" ||
        code === "40P01" ||
        code === "55P03")
    ) {
      return true;
    }
    if (!(current instanceof Error) || !current.cause) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

// Which of the storage failures above it was, for the log: a statement
// timeout and a lock timeout read the same to the caller.
function sqlstateOf(error: unknown): string | null {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    const code = (current as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    if (!(current instanceof Error)) return null;
    current = current.cause;
  }
  return null;
}

export function storageUnavailableError(): ApiHttpError {
  return new ApiHttpError(
    503,
    "BACKEND_UNAVAILABLE",
    "Storage is unavailable, retry later",
    true,
    1,
  );
}

// What the app answers around the handlers; route tests need not produce
// these to match the OpenAPI document (route-error-coverage.ts).
// The error hook, on any route, for a failure nothing mapped.
export const globalRouteErrors = [500];
// The auth middleware, on every authenticated /v1 route.
export const rootRouteErrors = [401, 503];
// What the same middleware adds on an unsafe method: the CSRF refusal of a
// cookie principal.
export const mutationRouteErrors = [403];
// What every /v1 route that reads a body can answer before its handler runs,
// public or not: the body deadline.
export const bodyRouteErrors = [408];

const missingKeyStore: ApiKeyStore = {
  async find() {
    return null;
  },
};

function errorResponse(
  context: Context<ApiEnvironment>,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryable = false,
  details: unknown = null,
): Response {
  return context.json(
    apiErrorResponseSchema.parse({
      error: {
        code,
        message,
        retryable,
        request_id: context.get("requestId"),
        details,
      },
    }),
    status,
  );
}

export async function parseJsonBody<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): Promise<z.infer<T>> {
  // Measure the bytes actually received; Content-Length can be absent or lie.
  const raw = await context.req.arrayBuffer();
  if (raw.byteLength > REQUEST_BODY_MAX_BYTES) {
    throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiHttpError(400, "BAD_REQUEST", "Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const oversized = parsed.error.issues.some(
      (issue) =>
        issue.code === "custom" &&
        issue.params?.code === PAYLOAD_TOO_LARGE_ISSUE,
    );
    if (oversized) {
      throw new ApiHttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request field too large",
      );
    }
    const details: RequestBodyInvalidDetails = {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
    throw new ApiHttpError(
      400,
      "BAD_REQUEST",
      "Request body is invalid",
      false,
      undefined,
      details,
    );
  }
  return parsed.data;
}

export function jsonWithSchema<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
  value: z.input<T>,
  status: ContentfulStatusCode = 200,
): Response {
  return context.json(schema.parse(value), status);
}

function setHandlerClock(context: Context<ApiEnvironment>): void {
  (context.env?.setIdleTimeout ?? (() => {}))(
    context.get("handlerIdleSeconds") ?? 0,
  );
}

// Read and bound a body under the idle clock and BODY_DEADLINE_MS; the
// caller sets the handler's clock afterwards for its database work. The bytes
// go into Hono's body cache, so parseJsonBody reads the same bytes. Returns
// the 408 or 413 to send, or null.
async function ingestBody(
  context: Context<ApiEnvironment>,
  maxBytes = REQUEST_BODY_MAX_BYTES,
): Promise<Response | null> {
  if (BODYLESS_METHODS.has(context.req.method)) {
    return null;
  }
  const setIdleTimeout = context.env?.setIdleTimeout ?? (() => {});
  setIdleTimeout(BODY_IDLE_TIMEOUT_SECONDS);
  const read = await readBodyWithin(
    context.req.raw,
    BODY_DEADLINE_MS,
    maxBytes,
  );
  if (read.kind === "timeout") {
    // The rest of the body may still be on its way; close rather than keep
    // the connection for the next request behind it.
    context.header("Connection", "close");
    // Outside /v1 no deadline middleware follows to shorten the clock.
    setIdleTimeout(CLOSING_IDLE_TIMEOUT_SECONDS);
    // Nothing has run yet, so sending the same request again is safe.
    return errorResponse(
      context,
      408,
      "REQUEST_TIMEOUT",
      "Request body was not received in time",
      true,
    );
  }
  if (read.size > maxBytes) {
    return errorResponse(
      context,
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body too large",
    );
  }
  // Hono keeps the pending read per body type here (#cachedBody); its
  // declared type is the Body interface, not what it actually stores.
  (
    context.req.bodyCache as unknown as { arrayBuffer?: Promise<ArrayBuffer> }
  ).arrayBuffer = Promise.resolve(read.bytes);
  return null;
}

// Body under the clock, then the handler's clock: what every route outside
// the /v1 principal middleware does. Public /v1 routes attach
// it per route, never as a `*` middleware: that router is mounted ahead of
// the authenticated one, so a wildcard there would read every /v1 body
// before authentication and undo the auth-before-body rule.
export function ingestThenStopClockWithin(maxBytes: number) {
  return async (
    context: Context<ApiEnvironment>,
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const rejected = await ingestBody(context, maxBytes);
    if (rejected) {
      return rejected;
    }
    setHandlerClock(context);
    await next();
    return undefined;
  };
}

export const ingestThenStopClock = ingestThenStopClockWithin(
  REQUEST_BODY_MAX_BYTES,
);

export function createApiApp(options: CreateApiAppOptions = {}): ApiRouter {
  const authMode = options.authMode ?? process.env.AUTH_MODE;
  const keyStore = options.keyStore ?? missingKeyStore;
  const logger = options.logger ?? createLogger();
  const app = new OpenAPIHono<ApiEnvironment>({ strict: false });
  const v1 = new OpenAPIHono<ApiEnvironment>({ strict: false });
  const tracing = new RequestTracing(options.tracer);
  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    // The span encloses the completion log below, so that line carries it.
    await logger.withContext({ request_id: requestId }, () =>
      tracing.traceApiRequest(context, requestId, async () => {
        try {
          await next();
        } finally {
          const status = context.res.status;
          // Worker routes are too frequent to log every call; their 5xx are
          // what a lost lease is traced back to.
          if (
            context.req.path === "/v1" ||
            context.req.path.startsWith("/v1/") ||
            (status >= 500 && context.req.path.startsWith("/internal/"))
          ) {
            logger.info("API request completed", {
              event: "api.request.completed",
              operation: "api_request",
              outcome:
                status < 400
                  ? "succeeded"
                  : status < 500
                    ? "client_error"
                    : "server_error",
              reason_code: status < 400 ? "none" : `http_${status}`,
              route_template: context.req.routePath,
              method: context.req.method,
              status,
              duration_ms: Math.round(performance.now() - startedAt),
            });
          }
        }
      }),
    );
  });

  if (authMode === "none") {
    logger.warn("API authentication is disabled", { auth_mode: "none" });
  }

  // Probes sit outside /v1 so an orchestrator needs no API key to call them.
  registerOpenApiRoute(app, "getHealth", (context) =>
    jsonWithSchema(context, healthResponseSchema, { status: "ok" }),
  );
  registerOpenApiRoute(app, "getReady", async (context) => {
    const result = options.readiness
      ? await options.readiness()
      : ({
          ready: false,
          check: "config",
          reason: "no readiness probe",
        } as const);
    if (!result.ready) {
      logger.warn("API readiness check failed", {
        check: result.check,
        reason: result.reason,
      });
      return errorResponse(
        context,
        503,
        "NOT_READY",
        `Not ready: ${result.check} check failed`,
        true,
        { check: result.check },
      );
    }
    return jsonWithSchema(context, readyResponseSchema, {
      status: "ready",
      checks: { database: "ok", schema: "ok", config: "ok" },
    });
  });

  registerApiReferenceRoutes(app);

  const authenticator = createAuthenticator({
    authMode,
    keyStore,
    logger,
    ...(options.identity ? { identity: options.identity } : {}),
  });
  // Ahead of both /v1 routers, so the public routes are bounded too.
  app.use(
    "/v1/*",
    requestDeadline({
      logger,
      expired: storageUnavailableError,
      ...(options.requestDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.requestDeadlineMs }),
    }),
  );
  registerOpenApiRoute(app, "getOpenApiDocument", (context) =>
    context.json(buildOpenApiDocument()),
  );
  v1.use("*", async (context, next) => {
    // Authenticate before touching the body, so an unauthenticated sender
    // cannot hold a connection open by dripping bytes; the key lookup is
    // database work, which requestDeadline already set the clock for.
    const authenticated = await authenticator.authenticate(context);
    if (!authenticated) {
      logger.warn("API authentication failed", {
        method: context.req.method,
        path: context.req.path,
      });
      return errorResponse(
        context,
        401,
        "UNAUTHORIZED",
        // A link opened from Slack lands here before any login; the person
        // may have no account at all, and should learn who can invite them.
        context.req.path.startsWith("/v1/linked-accounts")
          ? LINK_MESSAGES.signInRequired
          : "Authentication is required",
      );
    }
    const violation = csrfViolation(context, authenticated.principal);
    if (violation) {
      logger.warn("API request refused by CSRF check", {
        method: context.req.method,
        path: context.req.path,
        reason: violation,
      });
      return errorResponse(context, 403, "FORBIDDEN", `Refused: ${violation}`);
    }
    const missing = missingScope(
      context.req.method,
      context.req.path,
      authenticated.principal,
    );
    const caller = callerFor(
      authenticated.principal,
      { kind: authenticated.webSession ? "web" : "api" },
      context.get("requestId"),
      authenticated.storedKey,
    );
    if (missing) {
      logger.warn("API request refused for a missing scope", {
        method: context.req.method,
        path: context.req.path,
        scope: missing,
      });
      await options.authorization
        ?.authorize({
          subject: caller.subject,
          action: actionForScope(missing),
          resource: { kind: "session", id: null, owner_scope: caller.ownerId },
          request_id: caller.requestId,
        })
        .catch(() => undefined);
      return errorResponse(
        context,
        403,
        "FORBIDDEN",
        `This credential does not hold ${missing}`,
      );
    }
    context.set("principal", authenticated.principal);
    context.set("ownerId", ownerScopeOf(authenticated.principal));
    context.set("caller", caller);
    context.set("verified", authenticated.verified);
    context.set("reauthenticate", authenticated.reauthenticate);
    if (authenticated.webSession) {
      context.set("webSession", authenticated.webSession);
    }

    // Ingest and bound the body under the idle clock, then hand the request
    // to the route with the handler's clock for its database work.
    if (!BODYLESS_METHODS.has(context.req.method)) {
      const rejected = await ingestBody(context);
      if (rejected) {
        return rejected;
      }
      setHandlerClock(context);
    }
    await next();
  });

  const rootHandler = (context: Context<ApiEnvironment>) =>
    jsonWithSchema(context, apiRootResponseSchema, {
      status: "ok",
      owner_id: context.get("ownerId"),
    });
  apiRoute(v1, "getApiRoot", rootHandler);
  options.registerRoutes?.(v1);
  if (options.registerPublicRoutes) {
    // No middleware here: see ingestThenStopClock.
    const publicV1 = new OpenAPIHono<ApiEnvironment>({ strict: false });
    options.registerPublicRoutes(publicV1);
    app.route("/v1", publicV1);
  }
  app.route("/v1", v1);
  if (options.registerInternalRoutes) {
    const internal = new OpenAPIHono<ApiEnvironment>({ strict: false });
    // These routes are outside the /v1 middleware but need the same clock
    // management, and more of it: the gateway's long poll holds a connection
    // open for longer than the server's idle default, so a poll that finds
    // no input would be cut off mid-wait. Each internal family authenticates
    // itself, so the body is read under the clock and the clock is then
    // stopped for the handler.
    // Hono routes on the decoded path, but the ALB's 404 rule for /internal
    // matches the path as sent, so /%69nternal would pass the ALB through the
    // console's "/" rule and land here. Only the undecoded prefix counts.
    internal.use("*", async (context, next) => {
      const sent = new URL(context.req.url).pathname;
      if (sent !== "/internal" && !sent.startsWith("/internal/")) {
        return errorResponse(context, 404, "NOT_FOUND", "Resource not found");
      }
      await next();
    });
    internal.use("*", ingestThenStopClock);
    options.registerInternalRoutes(internal);
    app.route("/internal", internal);
  }

  if (options.webDistDir) {
    const serveWeb = createWebDistHandler(options.webDistDir);
    app.get(
      "*",
      async (context) => (await serveWeb(context)) ?? context.notFound(),
    );
  }

  app.notFound((context) =>
    errorResponse(context, 404, "NOT_FOUND", "Resource not found"),
  );
  app.onError((error, context) => {
    if (error instanceof ApiHttpError) {
      if (error.retryAfterSeconds !== undefined) {
        context.header("Retry-After", String(error.retryAfterSeconds));
      }
      return errorResponse(
        context,
        error.status,
        error.code,
        error.message,
        error.retryable,
        error.details,
      );
    }
    // The key lookup in the auth middleware runs before any route, so a
    // database outage must map to 503 here, not only inside the handlers.
    if (isStorageUnavailable(error)) {
      const unavailable = storageUnavailableError();
      logger.warn("Storage unavailable during API request", {
        method: context.req.method,
        path: context.req.path,
        sqlstate: sqlstateOf(error),
      });
      context.header("Retry-After", String(unavailable.retryAfterSeconds));
      return errorResponse(
        context,
        unavailable.status,
        unavailable.code,
        unavailable.message,
        unavailable.retryable,
      );
    }
    logger.error("Unhandled API request error", {
      error_name: error instanceof Error ? error.name : "UnknownError",
      method: context.req.method,
      path: context.req.path,
    });
    return errorResponse(
      context,
      500,
      "INTERNAL_ERROR",
      "Internal server error",
    );
  });

  return app;
}
