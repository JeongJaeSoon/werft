import type {
  AgentUsage,
  PutAgentUsageRequest,
  PutAgentUsageResponse,
} from "@werft-ai/contracts";
import type { AgentUsageStore } from "../ports/agent-usage-store.ts";
import { personOf } from "./agent-admin-service.ts";
import { ifMatchOf } from "./env-variable-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import {
  NO_LONGER_MANAGER,
  NOT_FOUND,
  SessionServiceError,
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "./service-errors.ts";

// Who may use an agent: its scope and teams, edited by owners,
// admins and the agent's admins (`agent.usage.manage`), who are also the only
// ones to read it: a plain member of the managing team reads settings but not
// who else may use the agent. The setting decides nothing here; a session
// create or input reads it elsewhere.

export function createAgentUsageService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentUsageStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const managerRoles = MANAGEMENT_ROLES["agent.usage.manage"] ?? [];

  return {
    async getAgentUsage(caller: Caller, agentId: string): Promise<AgentUsage> {
      await requirePermitted(authorization, caller, "agent.usage.manage", {
        kind: "agent",
        id: agentId,
      });
      const usage = await store.get(caller.ownerId, agentId);
      if (!usage) throw NOT_FOUND();
      return usage;
    },

    /** Replaces the whole setting; `ifMatch` is the raw `If-Match` header. */
    async putAgentUsage(
      caller: Caller,
      agentId: string,
      request: PutAgentUsageRequest,
      ifMatch: string | undefined,
    ): Promise<PutAgentUsageResponse> {
      await requirePermitted(authorization, caller, "agent.usage.manage", {
        kind: "agent",
        id: agentId,
      });
      const expected = ifMatchOf(ifMatch);
      const { userId, workspaceId } = personOf(caller);
      const receiptId = newId();
      const result = await store.put({
        actor: { principal: caller, workspaceId, userId },
        receiptId,
        agentId,
        scope: request.scope,
        teamIds: request.teams.map((team) => team.id),
        ifMatch: expected,
        managerRoles,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "team_not_found":
          throw TEAM_NOT_FOUND();
        case "team_not_allowed":
          throw TEAM_NOT_ALLOWED();
        case "actor_inactive":
          throw NO_LONGER_MANAGER();
        case "version_mismatch":
          throw new SessionServiceError(
            "VERSION_MISMATCH",
            "Who may use the agent changed since it was read; read it again",
            undefined,
            { current_version: result.current },
          );
        case "unchanged":
          return { usage: result.usage, receipt_id: null };
        default:
          return { usage: result.usage, receipt_id: receiptId };
      }
    },
  };
}

export type AgentUsageService = ReturnType<typeof createAgentUsageService>;
