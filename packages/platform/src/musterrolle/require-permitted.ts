import type {
  AuthorizationAction,
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationResource,
} from "@werft-ai/contracts";
import { type AuthorizationPolicy, type Caller, scopeOf } from "./policy.ts";
import type { UnrecordedAllow } from "./ports/decision-log.ts";
import { SessionServiceError } from "./service-errors.ts";

// No admin contact: whoever may not use a private agent is not told who to ask.
export function agentPrivateError(): SessionServiceError {
  return new SessionServiceError(
    "FORBIDDEN",
    "This agent is private; it is open only to the teams its administrators chose",
    undefined,
    { reason_code: "agent_private" },
  );
}

export function isAgentPrivate(error: unknown): error is SessionServiceError {
  return (
    error instanceof SessionServiceError &&
    error.code === "FORBIDDEN" &&
    (error.details as { reason_code?: unknown } | undefined)?.reason_code ===
      "agent_private"
  );
}

// Service entries authorize before store calls, except receipt reads that
// must resolve their target before authorizing disclosure. Over HTTP the edge has
// already refused a missing scope, so only a caller without HTTP meets the
// FORBIDDEN here, with the same message. A decision that cannot be reached
// is a refusal.
export async function requirePermitted(
  authorization: AuthorizationPolicy,
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  justification?: string,
): Promise<void> {
  await requireAllowed(authorization, caller, action, resource, justification);
}

/** requirePermitted, for a caller that records which decision allowed it. */
export async function requireAllowed(
  authorization: AuthorizationPolicy,
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  // A manager's reason for acting outside a session's share; recorded with
  // the decision.
  justification?: string,
): Promise<AuthorizationDecision> {
  const request = requestOf(caller, action, resource, justification);
  const decision = await authorization.authorize(request).catch(() => null);
  if (decision?.outcome === "allow") return decision;
  refuse(action, decision);
}

/**
 * requireAllowed for an act whose store decides more under its locks: the
 * allow comes back unrecorded, for the store to keep as the request's one
 * decision row. A refusal here is the policy's to keep.
 */
export async function requireAllowedUnrecorded(
  authorization: AuthorizationPolicy,
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
): Promise<UnrecordedAllow> {
  const request = requestOf(caller, action, resource);
  const decision = await authorization
    .authorize(request, { record: "deny" })
    .catch(() => null);
  if (decision?.outcome === "allow") return { request, decision };
  refuse(action, decision);
}

function requestOf(
  caller: Caller,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  justification?: string,
): AuthorizationRequest {
  return {
    subject:
      justification === undefined
        ? caller.subject
        : { ...caller.subject, justification },
    action,
    resource: { ...resource, owner_scope: caller.ownerId },
    request_id: caller.requestId,
  };
}

function refuse(
  action: AuthorizationAction,
  decision: AuthorizationDecision | null,
): never {
  if (decision?.reason_code === "not_found") {
    throw new SessionServiceError("NOT_FOUND", "Resource not found");
  }
  if (decision?.reason_code === "justification_required") {
    throw new SessionServiceError(
      "FORBIDDEN",
      "This action on this session needs a justification",
      undefined,
      { reason_code: "justification_required" },
    );
  }
  if (decision?.reason_code === "self_approval") {
    throw new SessionServiceError(
      "FORBIDDEN",
      "The key that started this session cannot approve its requests; another key or a person approves them",
      undefined,
      { reason_code: "self_approval" },
    );
  }
  if (decision?.reason_code === "agent_private") throw agentPrivateError();
  if (decision?.reason_code === "credential_unbound") {
    throw new SessionServiceError(
      "CREDENTIAL_UNBOUND",
      "A credential this agent's release uses is no longer bound to the agent",
      undefined,
      { reason_code: "credential_unbound" },
    );
  }
  const scope = scopeOf(action);
  throw new SessionServiceError(
    "FORBIDDEN",
    scope !== undefined && decision?.effective_scopes.includes(scope)
      ? `This principal holds ${scope} but may not use it on this session`
      : `This principal does not hold ${scope ?? action}`,
    undefined,
    // The policy's reason, so a screen can say why (design 3.3).
    { reason_code: decision?.reason_code ?? "error" },
  );
}
