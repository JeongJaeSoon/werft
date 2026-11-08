import type {
  AgentGitHub,
  AgentGitHubSettingsRow,
  PushAttached,
  Receipt,
  RepositoryCeiling,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";
import type { SessionViewer } from "./session-share-store.ts";

/** `outranked`: the right to manage the agent ended before the write. */
export type SetAgentGitHubResult =
  | { outcome: "saved"; receiptId: string | null }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * `conflict`: the row's revision is not the one expected, or it is there (or
 * not) against what the caller read.
 */
export type PutAgentGitHubSettingsResult =
  | { outcome: "saved"; revision: number; receiptId: string | null }
  | { outcome: "conflict"; revision: number | null }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/** An agent's GitHub switch (`agents.github_enabled`) and its activity. */
export interface AgentGitHubStore {
  /** Null when the workspace has no such agent. */
  enabled(workspaceId: string, agentId: string): Promise<boolean | null>;
  /** The agent's own GitHub settings; null without a row. */
  settings(agentId: string): Promise<AgentGitHubSettingsRow | null>;
  /** Null allows none. */
  repositoryCeiling(workspaceId: string): Promise<RepositoryCeiling | null>;
  /** Writes `set_agent_github` only when the value changes. */
  setEnabled(input: {
    workspaceId: string;
    agentId: string;
    enabled: boolean;
    principal: Principal;
    /** Roles holding the right outright; anyone else must administer the agent. */
    managerRoles: readonly WorkspaceRole[];
  }): Promise<SetAgentGitHubResult>;
  /**
   * Replaces the agent's settings row in one transaction: the agent row is
   * locked first (as a session start does), then the settings row, whose
   * revision must be `expectedRevision` (null: no row yet). `updated_by` is
   * always `userId`, so a first save also marks the row a person's.
   * `check` runs on the locked current row and the workspace's repository
   * ceiling as stored in the same transaction (a workspace that had none
   * gets the default one written first), and may refuse the write.
   */
  putSettings(input: {
    workspaceId: string;
    agentId: string;
    expectedRevision: number | null;
    settings: AgentGitHub;
    startRepositoryId: string | null;
    /** Left out: `allow` on a first save, else the row's value as it is. */
    pushAttached?: PushAttached | undefined;
    userId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
    check: (
      current: AgentGitHubSettingsRow | null,
      ceiling: RepositoryCeiling,
    ) => void;
  }): Promise<PutAgentGitHubSettingsResult>;
  /**
   * The latest GitHub receipts for the agent, newest first: those naming it,
   * and those of its sessions that `viewer` sees, filtered before the limit.
   */
  activity(
    workspaceId: string,
    agentId: string,
    viewer: SessionViewer,
    limit: number,
  ): Promise<Receipt[]>;
  /**
   * `owner/repo` per catalog id, rows removed from the catalog included
   * (their ids are never reused). An id no row ever held is left out.
   */
  repositoryNames(ids: readonly string[]): Promise<Map<string, string>>;
}
