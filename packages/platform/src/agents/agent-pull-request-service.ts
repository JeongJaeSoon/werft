import type {
  AgentPullRequestResponse,
  PutAgentPullRequestSettingsRequest,
  PutAgentPullRequestSettingsResponse,
} from "@werft-ai/contracts";
import { prepareTemplateText } from "../action/index.ts";
import type { PullRequestSettingsStore } from "../action/ports/pull-request-settings.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "../musterrolle/policy.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
} from "../musterrolle/service-errors.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";

export function createAgentPullRequestService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentStore, "get">;
  settings: Pick<PullRequestSettingsStore, "agent" | "putAgent">;
}) {
  const { authorization, settings } = deps;
  const target = (agentId: string) => ({ kind: "agent" as const, id: agentId });

  return {
    async get(
      caller: Caller,
      agentId: string,
    ): Promise<AgentPullRequestResponse> {
      await requirePermitted(
        authorization,
        caller,
        "agent.settings_read",
        target(agentId),
      );
      if ((await deps.agents.get(caller.ownerId, agentId)) === null) {
        throw NOT_FOUND();
      }
      const read = await settings.agent(agentId);
      return {
        pull_request: read.settings,
        pull_request_revision: read.revision,
      };
    },

    async put(
      caller: Caller,
      agentId: string,
      request: PutAgentPullRequestSettingsRequest,
    ): Promise<PutAgentPullRequestSettingsResponse> {
      await requirePermitted(
        authorization,
        caller,
        "agent.manage",
        target(agentId),
      );
      const userId = caller.actor?.userId;
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user" ||
        !userId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's pull request settings are saved from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const template = request.pull_request.template;
      if (template !== null) {
        const prepared = prepareTemplateText(template);
        if (!prepared.ok) {
          throw new SessionServiceError(
            "BAD_REQUEST",
            "The pull request template cannot be used",
            undefined,
            { reason_code: `template_${prepared.reason}` },
          );
        }
      }
      const result = await settings.putAgent({
        workspaceId: caller.ownerId,
        agentId,
        settings: request.pull_request,
        revision: request.revision,
        principal: caller,
        userId,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
      });
      switch (result.outcome) {
        case "stored":
          return {
            pull_request: result.settings,
            pull_request_revision: result.revision,
            receipt_id: result.receiptId,
          };
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The agent's pull request settings changed since they were read",
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type AgentPullRequestService = ReturnType<
  typeof createAgentPullRequestService
>;
