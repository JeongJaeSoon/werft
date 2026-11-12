import {
  type ApiErrorCode,
  githubRefusalStatus,
  idempotencyKeySchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import {
  type Caller,
  InvalidCursorError,
  type PushActor,
  SessionServiceError,
} from "@werft-ai/platform";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  type ApiEnvironment,
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";

// The one table from a service error code to its HTTP status on the /v1
// routes. A code missing here answers 500.
const STATUS_BY_CODE: Partial<Record<ApiErrorCode, ContentfulStatusCode>> = {
  BAD_REQUEST: 400,
  // Only the Slack channel search's own cursor; session events would answer 410.
  CURSOR_EXPIRED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  OWNER_PROTECTED: 403,
  SELF_PROTECTED: 403,
  SCOPE_NOT_GRANTABLE: 403,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  REQUEST_STALE: 409,
  REQUEST_EXPIRED: 409,
  CHECKPOINT_UNAVAILABLE: 409,
  SESSION_PAUSED: 409,
  SESSION_RESUMING: 409,
  PAUSE_COMMITTING: 409,
  SESSION_STOPPED: 409,
  SESSION_CLOSED: 409,
  SESSION_CLOSING: 409,
  RECOVERY_REQUIRED: 409,
  PENDING_REQUESTS_OPEN: 409,
  TEAM_MANAGES_AGENTS: 409,
  TURN_NOT_STARTED: 409,
  TAKEOVER_REQUIRED: 409,
  SLACK_NOT_INSTALLED: 409,
  LINK_TEAM_MISMATCH: 409,
  LINK_TAKEN: 409,
  LINK_EXISTS: 409,
  AGENT_IDENTITY_TAKEN: 409,
  CONFIG_TOKEN_INVALID: 409,
  SLACK_APP_CREATING: 409,
  SLACK_APP_GONE: 409,
  SLACK_LINK_NOT_CONFIGURED: 409,
  GITHUB_LINK_NOT_CONFIGURED: 409,
  AGENT_NOT_ACTIVE: 409,
  SLACK_INSTALL_STATE_INVALID: 409,
  SLACK_INSTALL_DENIED: 409,
  SLACK_INSTALL_REJECTED: 409,
  SLACK_INSTALL_CONFLICT: 409,
  RELEASE_SPEC_UNAVAILABLE: 409,
  CREDENTIAL_UNBOUND: 409,
  AGENT_NOT_RUNNABLE: 409,
  CREDENTIAL_REF_IN_USE: 409,
  VARIABLE_NAME_INVALID: 400,
  VARIABLE_NAME_RESERVED: 400,
  VARIABLE_VALUE_INVALID: 400,
  VARIABLE_VALUE_TOO_LARGE: 400,
  VARIABLE_QUOTA_EXCEEDED: 409,
  VARIABLE_UNRESOLVED: 409,
  SECRET_ACK_REQUIRED: 400,
  SECRET_GRANT_ALL_FORBIDDEN: 400,
  SECRET_ENV_UNSUPPORTED: 400,
  VERSION_MISMATCH: 412,
  PRECONDITION_REQUIRED: 428,
  ALREADY_EXISTS: 409,
  INVITE_USED: 409,
  LAST_OWNER: 409,
  MEMBER_DISABLED: 409,
  ACCOUNT_DISABLED: 409,
  INVITE_EXPIRED: 410,
  STORAGE_LIMIT_EXCEEDED: 413,
  UNSUPPORTED_CAPABILITY: 422,
  RATE_LIMITED: 429,
  BACKEND_UNAVAILABLE: 503,
  PUSH_SOURCE_MISSING: 409,
  PUSH_REQUEST_OPEN: 409,
  PUSH_REQUEST_DECIDED: 409,
  PUSH_REQUEST_RESOLVED: 409,
  CHECKPOINT_MOVED: 409,
  PUSH_NOT_PUSHED: 409,
  CATALOG_MISMATCH: 409,
  PULL_REQUEST_MISSING: 409,
  PULL_REQUEST_MERGED: 409,
  PULL_REQUEST_MERGE_BLOCKED: 409,
  PULL_REQUEST_CLOSED: 409,
  // 403 when details.reason_code is a policy refusal; mapped() decides.
  GITHUB_REFUSED: 409,
  GITHUB_APP_CONFLICT: 409,
  GITHUB_UNAVAILABLE: 502,
  INSTALLATION_SUSPENDED: 409,
};

// Storage outages need nothing here: the app's error hook answers them.
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionServiceError) {
      throw new ApiHttpError(
        error.code === "GITHUB_REFUSED"
          ? githubRefusalStatus(
              (error.details as { reason_code?: unknown } | null)?.reason_code,
            )
          : (STATUS_BY_CODE[error.code] ?? 500),
        error.code,
        error.message,
        error.retry !== undefined,
        error.retry?.afterSeconds,
        error.details,
      );
    }
    if (error instanceof InvalidCursorError) {
      throw new ApiHttpError(400, "BAD_REQUEST", "Invalid cursor");
    }
    throw error;
  }
}

export function requireIdempotencyKey(
  context: Context<ApiEnvironment>,
): string {
  const key = idempotencyKeySchema.safeParse(
    context.req.header("Idempotency-Key"),
  );
  if (!key.success) {
    throw new ApiHttpError(
      400,
      "BAD_REQUEST",
      "Idempotency-Key header is required",
    );
  }
  return key.data;
}

// A malformed id is indistinguishable from a missing session on purpose.
export function requireParams<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): z.infer<T> {
  const params = schema.safeParse(context.req.param());
  if (!params.success) {
    throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
  }
  return params.data;
}

export function requireQuery<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): z.infer<T> {
  const query = schema.safeParse(context.req.query());
  if (!query.success) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Query parameters are invalid");
  }
  return query.data;
}

export function sessionControlRoute<
  Req extends z.ZodType,
  Res extends z.ZodType,
>(
  router: ApiRouter,
  operationId: Parameters<typeof apiRoute>[1],
  requestSchema: Req,
  responseSchema: Res,
  call: (
    caller: Caller,
    sessionId: string,
    input: { idempotencyKey: string; body: z.infer<Req> },
  ) => Promise<z.input<Res>>,
): void {
  apiRoute(router, operationId, async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, requestSchema);
    const accepted = await mapped(() =>
      call(context.get("caller"), params.id, { idempotencyKey: key, body }),
    );
    return jsonWithSchema(context, responseSchema, accepted, 202);
  });
}

export function rateLimited(retryAfterMs: number, what: string): ApiHttpError {
  return new ApiHttpError(
    429,
    "RATE_LIMITED",
    `${what}, try again later`,
    true,
    Math.ceil(retryAfterMs / 1000),
  );
}

export function actorOf(context: Context<ApiEnvironment>): PushActor {
  return {
    caller: context.get("caller"),
    principal: context.get("principal"),
    ownerId: context.get("ownerId"),
    verified: context.get("verified"),
  };
}
