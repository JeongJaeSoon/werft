import {
  AGENT_IDENTITY_LIST_LIMIT,
  AGENT_IDENTITY_MESSAGES,
  type AgentIdentity,
  type LinkAgentIdentityRequest,
  type LinkAgentIdentityResponse,
  type ListAgentIdentitiesResponse,
  type RevokeAgentIdentityResponse,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  AgentIdentityRecord,
  AgentIdentityStore,
  SlackEventAgent,
  SlackEventKey,
} from "../ports/agent-identity-store.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  SessionServiceError,
} from "./service-errors.ts";

// Linking an agent to its Slack app is part of installing that app for the
// agent: design 4.1's "Slack 앱 설치·채널 설정" row, `binding.manage` on
// the agent, which owner, admin and that agent's admins hold.
const ACTION = "binding.manage";
const MANAGERS: readonly WorkspaceRole[] = MANAGEMENT_ROLES[ACTION] ?? [];

export function agentIdentityView(record: AgentIdentityRecord): AgentIdentity {
  return {
    id: record.id,
    agent_id: record.agentId,
    provider: record.provider,
    app_id: record.appId,
    team_id: record.teamId,
    bot_user_id: record.externalPrincipalId,
    credential_ref: record.credentialRef,
    status: record.status,
    revision: record.revision,
    created_by: record.createdBy,
    created_at: record.createdAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
  };
}

export function createAgentIdentityService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentIdentityStore;
}) {
  const { authorization, store } = deps;

  const permitted = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, ACTION, {
      kind: "agent",
      id: agentId,
    });

  return {
    async linkAgentIdentity(
      caller: Caller,
      agentId: string,
      request: LinkAgentIdentityRequest,
    ): Promise<LinkAgentIdentityResponse> {
      await permitted(caller, agentId);
      const result = await store.link({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        key: { appId: request.app_id, teamId: request.team_id },
        credentialRef: request.credential_ref,
        managerRoles: MANAGERS,
      });
      switch (result.outcome) {
        case "linked":
          return {
            agent_identity: agentIdentityView(result.identity),
            receipt_id: result.receiptId,
          };
        case "agent_not_found":
          throw NOT_FOUND();
        case "not_installed":
          throw new SessionServiceError(
            "SLACK_NOT_INSTALLED",
            AGENT_IDENTITY_MESSAGES.notInstalled,
          );
        case "taken":
          throw new SessionServiceError(
            "AGENT_IDENTITY_TAKEN",
            AGENT_IDENTITY_MESSAGES.taken,
          );
        case "exists":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            AGENT_IDENTITY_MESSAGES.exists,
          );
        case "credential_ref_in_use":
          throw new SessionServiceError(
            "CREDENTIAL_REF_IN_USE",
            AGENT_IDENTITY_MESSAGES.refInUse,
          );
        case "outranked":
          throw OUTRANKED();
        default:
          throw ACTOR_INACTIVE();
      }
    },

    async listAgentIdentities(
      caller: Caller,
      agentId: string,
    ): Promise<ListAgentIdentitiesResponse> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const rows = await store.list(
        caller.ownerId,
        agentId,
        AGENT_IDENTITY_LIST_LIMIT,
      );
      return { items: rows.map(agentIdentityView) };
    },

    async revokeAgentIdentity(
      caller: Caller,
      agentId: string,
      identityId: string,
    ): Promise<RevokeAgentIdentityResponse> {
      await permitted(caller, agentId);
      const result = await store.revoke({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        identityId,
        managerRoles: MANAGERS,
      });
      switch (result.outcome) {
        case "revoked":
          return {
            agent_identity: agentIdentityView(result.identity),
            receipt_id: result.receiptId,
          };
        case "already_revoked":
          return {
            agent_identity: agentIdentityView(result.identity),
            receipt_id: null,
          };
        case "not_found":
          throw NOT_FOUND();
        case "outranked":
          throw OUTRANKED();
        default:
          throw ACTOR_INACTIVE();
      }
    },
  };
}

export type AgentIdentityService = ReturnType<
  typeof createAgentIdentityService
>;

/**
 * The agent a Slack event moves, for the Slack channel to call on every
 * event it processes (design A.7): read now, never cached. `agentId` is the
 * agent the event's request URL names, when it names one; an event for
 * another agent than the app's is dropped.
 */
export async function agentForSlackEvent(
  store: Pick<AgentIdentityStore, "resolveSlackEvent">,
  event: SlackEventKey & { agentId?: string },
): Promise<SlackEventAgent> {
  const resolved = await store.resolveSlackEvent({
    appId: event.appId,
    teamId: event.teamId,
  });
  if (
    resolved.status === "resolved" &&
    event.agentId !== undefined &&
    event.agentId.toLowerCase() !== resolved.agentId
  ) {
    return { status: "dropped", reason: "agent_mismatch" };
  }
  return resolved;
}
