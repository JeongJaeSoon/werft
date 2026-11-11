import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../../musterrolle/index.ts";
import type { PushActor } from "../change-request/push-decision.ts";
import type { GitHubMcpServices } from "./handler.ts";

/** The session services, made with the authorization they run under. */
export type SessionServices = (
  authorization: AuthorizationPolicy,
) => GitHubMcpServices;

/**
 * The authorization the services see on this route: the attempt's own
 * session, to read and to submit to, and nothing else. The attempt's
 * authority comes from the egress fence, which the proxy re-asks on every
 * exchange; no scope is held, so no push can be decided.
 */
export function sessionBoundAuthorization(
  sessionId: string,
): AuthorizationPolicy {
  return {
    async authorize(request) {
      const allowed =
        (request.action === "session.read" ||
          request.action === "session.submit") &&
        request.resource.kind === "session" &&
        request.resource.id === sessionId;
      return {
        outcome: allowed ? "allow" : "deny",
        reason_code: allowed ? "ok" : "surface_ceiling",
        effective_scopes: [],
        policy_version: "github-mcp-1",
        decision_id: randomUUID(),
      };
    },
  };
}

export function actorFor(
  ownerId: string,
  receiptActor: ReceiptActor,
  requestId: string,
): PushActor {
  const { principal } = receiptActor;
  // No scope: a push decision refuses it, and a pull request opens only from
  // a pushed request (design github-agent.md §2 decision 6).
  const unscoped = {
    kind: "api_key" as const,
    id: principal.id,
    owner_id: ownerId,
    workspace_id: null,
    scopes: [],
  };
  const caller: Caller = {
    ownerId,
    // What the receipts name (receiptActorOf).
    actor: {
      principal,
      userId: receiptActor.actor_user_id,
      workspaceId: null,
      apiKeyId: principal.kind === "api_key" ? principal.id : null,
      agentId: receiptActor.agent_id,
    },
    // Only sessionBoundAuthorization reads this, and it judges the session.
    subject: { principal: unscoped, surface: { kind: "api" } },
    requestId,
  };
  return { caller, principal: unscoped, ownerId, verified: true };
}
