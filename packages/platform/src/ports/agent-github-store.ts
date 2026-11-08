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

/**
 * One repository turned on or off. Everything but `saved` leaves nothing
 * written: the catalog row, the pin and the receipts roll back with it.
 */
export type SetAgentGitHubRepositoryResult =
  | {
      outcome: "saved";
      revision: number;
      /** The settings receipt, else the catalog's when only the row changed. */
      receiptId: string | null;
      repository: { id: string; owner: string; name: string };
      /** A row was added or renamed: the in-memory catalog is behind. */
      catalogChanged: boolean;
    }
  | { outcome: "conflict"; revision: number | null }
  /** Another row holds the name (`resolve`'s `name_held`). */
  | { outcome: "name_held"; id: string }
  /** The catalog id names no active row. */
  | { outcome: "repository_not_found" }
  /** No row to change and no readable active release to start one from. */
  | { outcome: "seed_unavailable" }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/** What the transaction judges about a repository the change turns on. */
export interface RepositoryBeingEnabled {
  id: string;
  authKind: string;
  /** `catalog`: named by a ref; `github`: picked from an installation. */
  via: "catalog" | "github";
}

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
   * Turns one repository on or off in a single transaction: the catalog row
   * (a new pick adds or renames it), the settings row, the `set_agent_github`
   * receipt and the author App pin. The change is applied to the locked row
   * as it stands, so changes of other repositories are kept; the row's
   * revision is compared only when `expectedRevision` is given (null: no row).
   * An agent with no row starts from its active release's GitHub pins.
   * `check` runs in the transaction on a repository the change turns on and
   * throws to refuse; a throw rolls everything back.
   */
  setRepository(input: {
    workspaceId: string;
    agentId: string;
    enabled: boolean;
    expectedRevision: number | null | undefined;
    target:
      | { kind: "catalog"; id: string }
      | {
          kind: "github";
          resolve: {
            base: string;
            githubRepositoryId: number;
            owner: string;
            name: string;
            url: string;
            branch: string;
            receiptId: string;
          };
          /** Null when the API runs without an App store: nothing to pin. */
          pin: {
            connectionId: string;
            appId: number;
            receiptId: string;
          } | null;
        };
    userId: string;
    principal: Principal;
    managerRoles: readonly WorkspaceRole[];
    check: (
      repository: RepositoryBeingEnabled,
      ceiling: RepositoryCeiling,
    ) => void;
  }): Promise<SetAgentGitHubRepositoryResult>;
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
