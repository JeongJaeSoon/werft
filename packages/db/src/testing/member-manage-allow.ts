import { randomUUID } from "node:crypto";
import {
  type AuthorizationAction,
  type AuthorizationResource,
  type SessionScope,
  scopesForRole,
} from "@werft-ai/contracts";
import type { UnrecordedAllow } from "@werft-ai/platform";

/**
 * For tests that call a store directly: the allow the policy would have
 * handed over for `action` by `actorUserId` in `workspaceId`, holding
 * `scopes` (an owner's by default).
 */
export function allowOf(input: {
  workspaceId: string;
  actorUserId: string;
  action: AuthorizationAction;
  resource?: Pick<AuthorizationResource, "kind" | "id">;
  scopes?: readonly SessionScope[];
  requestId?: string;
}): UnrecordedAllow {
  const scopes = [...(input.scopes ?? scopesForRole("owner"))];
  return {
    request: {
      subject: {
        principal: {
          kind: "user",
          id: input.actorUserId,
          workspace_id: input.workspaceId,
          role: "owner",
          scopes,
        },
        actor_user_id: input.actorUserId,
        surface: { kind: "web" },
      },
      action: input.action,
      resource: {
        ...(input.resource ?? { kind: "workspace", id: input.workspaceId }),
        owner_scope: input.workspaceId,
      },
      request_id: input.requestId ?? randomUUID(),
    },
    decision: {
      outcome: "allow",
      reason_code: "ok",
      effective_scopes: scopes,
      policy_version: "test",
      decision_id: randomUUID(),
    },
  };
}

export function memberManageAllow(input: {
  workspaceId: string;
  actorUserId: string;
  requestId?: string;
}): UnrecordedAllow {
  return allowOf({ ...input, action: "member.manage" });
}

/** memberManageAllow for the acting owner a store call already names. */
export function allowFor(actor: {
  workspaceId: string;
  userId: string;
}): UnrecordedAllow {
  return memberManageAllow({
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
  });
}
