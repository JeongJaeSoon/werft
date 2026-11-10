import type { StoredEngineSettings, WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

/** What a scope has saved; a scope that has saved nothing reads as no rules. */
export type SavedEngineSettings = {
  settings: StoredEngineSettings;
  /** Null while nothing is saved. */
  revision: number | null;
};

export type AgentEngineSettingsRead = SavedEngineSettings & {
  /** What the agent inherited from its profile: counts only, never the rules. */
  inherited: { entries: number; rules: number };
};

/**
 * `writes_closed`: the installation-wide gate is shut; rules already saved
 * still apply. `conflict`: the stored revision is not the one expected.
 */
export type PutEngineSettingsResult =
  | { outcome: "saved"; revision: number; receiptId: string | null }
  | { outcome: "conflict"; revision: number | null }
  | {
      outcome: "writes_closed" | "not_found" | "actor_inactive" | "outranked";
    };

export type PutEngineSettingsInput = {
  workspaceId: string;
  expectedRevision: number | null;
  /** Already checked against the installed catalogs; stored as given. */
  settings: StoredEngineSettings;
  userId: string;
  principal: Principal;
  managerRoles: readonly WorkspaceRole[];
};

export interface EngineSettingsStore {
  writesOpen(): Promise<boolean>;
  workspace(workspaceId: string): Promise<SavedEngineSettings>;
  /** Null when the workspace has no such agent. */
  agent(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentEngineSettingsRead | null>;
  /**
   * One transaction: the gate row is read under a share lock, then the
   * workspace's manager and row are locked in the order the other
   * workspace-setting writers take, then the settings row, whose revision must
   * be `expectedRevision` (null: no row yet). A save that stores what the row
   * already holds changes nothing and writes no receipt.
   */
  putWorkspace(input: PutEngineSettingsInput): Promise<PutEngineSettingsResult>;
  /**
   * The same for an agent, with the agent locked as a session start and the
   * MCP save lock it (account, membership, agent, the right to manage it).
   * Never touches the agent's inherited restrictions.
   */
  putAgent(
    input: PutEngineSettingsInput & { agentId: string },
  ): Promise<PutEngineSettingsResult>;
}
