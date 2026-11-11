import type {
  AgentCallerLimits,
  PutAgentCallerLimitsRequest,
  PutAgentCallerLimitsResponse,
} from "@werft-ai/contracts";
import type { AgentCallerLimitsStore } from "../ports/agent-caller-limits-store.ts";
import { personOf } from "./agent-admin-service.ts";
import { ifMatchOf } from "./env-variable-service.ts";
import type { Caller } from "./policy.ts";
import { type AuthorizationPolicy, MANAGEMENT_ROLES } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import {
  NOT_FOUND,
  SessionServiceError,
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "./service-errors.ts";

// What a caller may do through an agent (94S-917): the rules and who edits
// them. Like the usage setting, only those who edit read it (`agent.usage.manage`),
// and nothing here decides a session; whoever enforces the rules reads them
// through the store's own read inside its transaction.

const NO_LONGER_MANAGER = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds agent.usage.manage",
    undefined,
    { reason_code: "role" },
  );

export function createAgentCallerLimitsService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentCallerLimitsStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const managerRoles = MANAGEMENT_ROLES["agent.usage.manage"] ?? [];

  return {
    async getAgentCallerLimits(
      caller: Caller,
      agentId: string,
    ): Promise<AgentCallerLimits> {
      await requirePermitted(authorization, caller, "agent.usage.manage", {
        kind: "agent",
        id: agentId,
      });
      const limits = await store.get(caller.ownerId, agentId);
      if (!limits) throw NOT_FOUND();
      return limits;
    },

    /** Replaces the whole set; `ifMatch` is the raw `If-Match` header. */
    async putAgentCallerLimits(
      caller: Caller,
      agentId: string,
      request: PutAgentCallerLimitsRequest,
      ifMatch: string | undefined,
    ): Promise<PutAgentCallerLimitsResponse> {
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
        rules: request.rules,
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
        case "repository_not_in_catalog":
          throw new SessionServiceError(
            "BAD_REQUEST",
            "A repository this edit adds is not in the catalog",
            undefined,
            {
              reason_code: "repository_not_in_catalog",
              repository_ids: result.repositoryIds,
            },
          );
        case "version_mismatch":
          throw new SessionServiceError(
            "VERSION_MISMATCH",
            "The caller limits changed since they were read; read them again",
            undefined,
            { current_version: result.current },
          );
        case "unchanged":
          return { limits: result.limits, receipt_id: null };
        default:
          return { limits: result.limits, receipt_id: receiptId };
      }
    },
  };
}

export type AgentCallerLimitsService = ReturnType<
  typeof createAgentCallerLimitsService
>;
