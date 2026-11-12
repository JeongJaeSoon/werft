import type { ApiErrorCode } from "@werft-ai/contracts";

// The service error every platform domain throws, not only sessions: the name is public surface of @werft-ai/platform.
export class SessionServiceError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retry?: { afterSeconds: number },
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");

export const ACTOR_INACTIVE = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "This principal is no longer a member of the workspace",
  );

export const TEAM_NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "No team in this workspace has that id");

/**
 * Anyone but an owner or admin names, as a managing team, only a team they
 * are in, and names no admin team at all (agent-rbac design (b)).
 */
export const TEAM_NOT_ALLOWED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller may not name that team here",
    undefined,
    { reason_code: "team_not_allowed" },
  );

export const TEAM_HOLDING = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "That team only holds agents that had no managing team; pick another team",
    undefined,
    { reason_code: "team_holding" },
  );

export const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds this right",
    undefined,
    { reason_code: "role" },
  );

export const NO_LONGER_MANAGER = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds agent.usage.manage",
    undefined,
    { reason_code: "role" },
  );

export const SECRET_STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
    undefined,
    { reason_code: "secret_store_off" },
  );
