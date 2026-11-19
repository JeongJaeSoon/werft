import { randomUUID } from "node:crypto";
import type { UnrecordedAllow } from "@werft-ai/platform";

/**
 * For tests that call a store directly: the allow the policy would have
 * handed over for `member.manage` by `actorUserId` in `workspaceId`.
 */
export function memberManageAllow(input: {
  workspaceId: string;
  actorUserId: string;
  requestId?: string;
}): UnrecordedAllow {
  return {
    request: {
      subject: {
        principal: {
          kind: "user",
          id: input.actorUserId,
          workspace_id: input.workspaceId,
          role: "owner",
          scopes: [],
        },
        actor_user_id: input.actorUserId,
        surface: { kind: "web" },
      },
      action: "member.manage",
      resource: {
        kind: "workspace",
        id: input.workspaceId,
        owner_scope: input.workspaceId,
      },
      request_id: input.requestId ?? randomUUID(),
    },
    decision: {
      outcome: "allow",
      reason_code: "ok",
      effective_scopes: [],
      policy_version: "test",
      decision_id: randomUUID(),
    },
  };
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
