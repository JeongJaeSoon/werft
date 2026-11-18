import type { WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

/** A workspace server as an agent's tab lists it. */
export type AgentWorkspaceMcpServerRow = {
  serverId: string;
  name: string;
  on: boolean;
  state: "none" | "active" | "needs_reauth";
  connectedBy: { userId: string; displayName: string } | null;
  toolCount: number;
};

export type PutAgentWorkspaceMcpServersResult =
  | { outcome: "saved"; receiptId: string | null }
  | {
      outcome: "server_unknown";
      /** Index into the request's `server_ids`. */
      at: number;
    }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

export interface AgentWorkspaceMcpStore {
  /** Every server of the workspace, by name; null when it has no such agent. */
  list(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentWorkspaceMcpServerRow[] | null>;
  /**
   * Replaces the agent's set in one transaction: the agent row is locked
   * first (as a session start does), then the named servers, so a server
   * deleted meanwhile is `server_unknown` rather than a dangling row.
   */
  put(input: {
    workspaceId: string;
    agentId: string;
    serverIds: readonly string[];
    userId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<PutAgentWorkspaceMcpServersResult>;
}
