import {
  type AuthorizationSubject,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";

/**
 * A service caller authenticated the way AUTH_MODE=none authenticates: a
 * legacy API key named by its owner partition, holding `scopes`.
 */
export function testCaller(
  ownerId: string,
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): { ownerId: string; subject: AuthorizationSubject; requestId: string } {
  return {
    ownerId,
    subject: {
      principal: {
        kind: "api_key",
        id: ownerId,
        owner_id: ownerId,
        workspace_id: null,
        scopes: [...scopes],
      },
      surface: { kind: "api" },
    },
    requestId: crypto.randomUUID(),
  };
}

/**
 * A web user holding what `role` grants, for the platform's `callerFor`:
 * testkit does not depend on the platform.
 */
export function userPrincipal(
  id: string,
  workspaceId: string,
  role: WorkspaceRole,
): Principal {
  return {
    kind: "user",
    id,
    workspace_id: workspaceId,
    role,
    scopes: [...scopesForRole(role)],
  };
}
