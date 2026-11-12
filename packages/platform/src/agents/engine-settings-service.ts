import {
  type AgentEngineSettingsResponse,
  type EngineSettingsSource,
  type PutEngineSettingsRequest,
  type PutEngineSettingsResponse,
  type StoredEngineSettings,
  type ToolCatalogView,
  validateEngineSettingsAcrossCatalogs,
  type WorkspaceEngineSettingsResponse,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";
import type {
  EngineSettingsStore,
  PutEngineSettingsResult,
} from "../ports/engine-settings-store.ts";

const GRANT_LISTS = [
  ["permissions", "allow"],
  ["auto_mode", "allow"],
  ["auto_mode", "environment"],
] as const;

const listOf = (
  settings: StoredEngineSettings,
  [group, key]: (typeof GRANT_LISTS)[number],
): readonly string[] =>
  (settings[group] as Record<string, string[] | undefined>)[key] ?? [];

/**
 * What the agent's allow lists do next to the workspace's. A grant needs both
 * sides (the merge intersects them), so an agent entry the workspace does not
 * share does nothing, and a workspace list the agent leaves empty does not
 * reach the agent's sessions. The console says so; the merge is not repeated.
 */
export function reachOf(
  workspace: StoredEngineSettings,
  agent: StoredEngineSettings,
): AgentEngineSettingsResponse["reach"] {
  const without = GRANT_LISTS.map((grant) => {
    const shared = new Set(listOf(workspace, grant));
    return listOf(agent, grant).filter((entry) => !shared.has(entry));
  });
  return {
    agent_allow_without_effect: {
      permissions: without[0] ?? [],
      auto_mode_allow: without[1] ?? [],
      auto_mode_environment: without[2] ?? [],
    },
    workspace_allow_inactive: GRANT_LISTS.some(
      (grant) =>
        listOf(workspace, grant).length > 0 &&
        listOf(agent, grant).length === 0,
    ),
  };
}

/**
 * The saved engine rules of a workspace and of an agent: what the engine is
 * told to ask about or refuse. A save is checked against every installed tool
 * catalog (see `validateEngineSettingsAcrossCatalogs`) before anything is
 * locked, because the check depends on the request alone. Saving needs a
 * signed-in console session; reading does not.
 */
export function createEngineSettingsService(deps: {
  authorization: AuthorizationPolicy;
  store: EngineSettingsStore;
  catalogs: readonly ToolCatalogView[];
}) {
  const { authorization, store, catalogs } = deps;

  const requireConsoleUser = (caller: Caller, what: string): string => {
    const userId = caller.actor?.userId;
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      !userId
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        `${what} are saved from a signed-in console session, not with an API key`,
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return userId;
  };

  const checked = (
    request: PutEngineSettingsRequest,
    source: EngineSettingsSource,
  ): StoredEngineSettings => {
    const result = validateEngineSettingsAcrossCatalogs(
      catalogs,
      request.settings,
      source,
    );
    if ("refusal" in result) {
      const { reason_code, rule, message } = result.refusal;
      throw new SessionServiceError("BAD_REQUEST", message, undefined, {
        field: "settings",
        reason_code,
        rule,
      });
    }
    return result.settings;
  };

  const answer = (
    result: PutEngineSettingsResult,
    expected: number | null,
  ): PutEngineSettingsResponse => {
    switch (result.outcome) {
      case "saved":
        return {
          settings_revision: result.revision,
          receipt_id: result.receiptId,
        };
      case "conflict":
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          `The engine settings are at revision ${result.revision ?? "none"}, not ${expected ?? "none"}`,
        );
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      default:
        throw NOT_FOUND();
    }
  };

  return {
    async getWorkspace(
      caller: Caller,
      workspaceId: string,
    ): Promise<WorkspaceEngineSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      await requirePermitted(authorization, caller, "workspace.read", {
        kind: "workspace",
        id: workspaceId,
      });
      const saved = await store.workspace(workspaceId);
      return {
        settings: saved.settings,
        settings_revision: saved.revision,
      };
    },

    async putWorkspace(
      caller: Caller,
      workspaceId: string,
      request: PutEngineSettingsRequest,
    ): Promise<PutEngineSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      await requirePermitted(authorization, caller, "workspace.manage", {
        kind: "workspace",
        id: workspaceId,
      });
      const userId = requireConsoleUser(caller, "The workspace's engine rules");
      const settings = checked(request, "workspace");
      return answer(
        await store.putWorkspace({
          workspaceId,
          expectedRevision: request.expected_revision,
          settings,
          userId,
          principal: caller,
          managerRoles: MANAGEMENT_ROLES["workspace.manage"] ?? [],
        }),
        request.expected_revision,
      );
    },

    async getAgent(
      caller: Caller,
      agentId: string,
    ): Promise<AgentEngineSettingsResponse> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const workspaceId = caller.ownerId;
      const [agent, workspace] = await Promise.all([
        store.agent(workspaceId, agentId),
        store.workspace(workspaceId),
      ]);
      if (agent === null) throw NOT_FOUND();
      return {
        settings: agent.settings,
        settings_revision: agent.revision,
        workspace: {
          settings: workspace.settings,
          settings_revision: workspace.revision,
        },
        reach: reachOf(workspace.settings, agent.settings),
      };
    },

    async putAgent(
      caller: Caller,
      agentId: string,
      request: PutEngineSettingsRequest,
    ): Promise<PutEngineSettingsResponse> {
      await requirePermitted(authorization, caller, "agent.manage", {
        kind: "agent",
        id: agentId,
      });
      const userId = requireConsoleUser(caller, "An agent's engine rules");
      const settings = checked(request, "agent");
      return answer(
        await store.putAgent({
          workspaceId: caller.ownerId,
          agentId,
          expectedRevision: request.expected_revision,
          settings,
          userId,
          principal: caller,
          managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
        }),
        request.expected_revision,
      );
    },
  };
}

export type EngineSettingsService = ReturnType<
  typeof createEngineSettingsService
>;
