import type { AgentMcpSettings, WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

/** The settings row as stored. */
export type AgentMcpRow = {
  server: string | null;
  allowedTools: string[];
  credentialRefs: string[];
  revision: number;
  /** Null only on a row an operator copied from a release. */
  updatedBy: string | null;
};

/** The agent's active release, as far as MCP is concerned. */
export type AgentMcpRelease = {
  id: string;
  card: unknown;
  policyPins: unknown;
};

/**
 * `conflict`: the row's revision is not the one expected, or it is there (or
 * not) against what the caller read.
 */
export type PutAgentMcpSettingsResult =
  | { outcome: "saved"; revision: number; receiptId: string | null }
  | { outcome: "conflict"; revision: number | null }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/** An agent's MCP settings (`agent_mcp_settings`). */
export interface AgentMcpStore {
  /**
   * Null when the workspace has no such agent. The slug is what a catalog
   * server's `workspaces` list names.
   */
  agent(
    workspaceId: string,
    agentId: string,
  ): Promise<{
    workspaceSlug: string;
    activeRelease: AgentMcpRelease | null;
  } | null>;
  row(agentId: string): Promise<AgentMcpRow | null>;
  /** The names among `refs` with a live binding on the agent. */
  boundRefs(
    workspaceId: string,
    agentId: string,
    refs: readonly string[],
  ): Promise<string[]>;
  /**
   * Replaces the agent's settings row in one transaction: the agent row is
   * locked first (as a session start does), then the settings row, whose
   * revision must be `expectedRevision` (null: no row yet). `updated_by` is
   * always `userId`, so a save also marks a copied row a person's. `check`
   * runs on the locked current row and may refuse the write.
   */
  put(input: {
    workspaceId: string;
    agentId: string;
    expectedRevision: number | null;
    settings: AgentMcpSettings;
    userId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
    check: (current: AgentMcpRow | null) => void;
  }): Promise<PutAgentMcpSettingsResult>;
}
