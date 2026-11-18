import {
  AGENT_WORKSPACE_MCP_SERVERS_MAX,
  type AgentWorkspaceMcpServerList,
  type PutAgentWorkspaceMcpServersRequest,
  type PutAgentWorkspaceMcpServersResponse,
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
  AgentWorkspaceMcpServerRow,
  AgentWorkspaceMcpStore,
} from "./ports/agent-workspace-mcp-store.ts";

const refused = (field: string, reason: string) =>
  new SessionServiceError("BAD_REQUEST", `${field}: ${reason}`, undefined, {
    field,
    reason_code: reason,
  });

const listOf = (
  rows: readonly AgentWorkspaceMcpServerRow[],
): AgentWorkspaceMcpServerList => ({
  items: rows.map((row) => ({
    server_id: row.serverId,
    name: row.name,
    on: row.on,
    state: row.state,
    connected_by:
      row.connectedBy === null
        ? null
        : {
            user_id: row.connectedBy.userId,
            display_name: row.connectedBy.displayName,
          },
    tool_count: row.toolCount,
  })),
  limit: AGENT_WORKSPACE_MCP_SERVERS_MAX,
});

/**
 * Which of the workspace's MCP servers an agent's sessions may call. Saved
 * apart from the card, so it makes no release; turning one off reaches
 * running sessions, turning one on only the next session. Whoever manages
 * the agent reads it; it is saved from a signed-in console session.
 */
export function createAgentWorkspaceMcpService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentWorkspaceMcpStore;
}) {
  const { authorization, store } = deps;
  const target = (agentId: string) => ({ kind: "agent", id: agentId }) as const;

  return {
    async list(
      caller: Caller,
      agentId: string,
    ): Promise<AgentWorkspaceMcpServerList> {
      await requirePermitted(
        authorization,
        caller,
        "agent.settings_read",
        target(agentId),
      );
      const rows = await store.list(caller.ownerId, agentId);
      if (rows === null) throw NOT_FOUND();
      return listOf(rows);
    },

    async put(
      caller: Caller,
      agentId: string,
      request: PutAgentWorkspaceMcpServersRequest,
    ): Promise<PutAgentWorkspaceMcpServersResponse> {
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
          "An agent's workspace MCP servers are saved from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const ids = request.server_ids.map((id) => id.toLowerCase());
      const repeated = ids.findIndex((id, at) => ids.indexOf(id) !== at);
      if (repeated >= 0) throw refused(`server_ids.${repeated}`, "duplicate");
      const workspaceId = caller.ownerId;
      const result = await store.put({
        workspaceId,
        agentId,
        serverIds: ids,
        userId,
        principal: caller,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
      });
      switch (result.outcome) {
        case "saved": {
          const rows = await store.list(workspaceId, agentId);
          if (rows === null) throw NOT_FOUND();
          return { servers: listOf(rows), receipt_id: result.receiptId };
        }
        case "server_unknown":
          throw refused(`server_ids.${result.at}`, "server_unknown");
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

export type AgentWorkspaceMcpService = ReturnType<
  typeof createAgentWorkspaceMcpService
>;
