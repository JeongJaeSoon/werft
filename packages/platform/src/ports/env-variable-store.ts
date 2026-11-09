import type { Principal } from "../musterrolle/policy.ts";

/** A workspace's own variables (`agentId` null) or one agent's. */
export type EnvVariableScope = { workspaceId: string; agentId: string | null };

/** What the stored row says; a secret's `value` is always null. */
export type EnvVariableRecord = {
  id: string;
  name: string;
  kind: "plain" | "secret";
  value: string | null;
  version: number;
  /** Workspace plain variables only. */
  grantAll: boolean;
  grantVersion: number;
  /** Workspace-level variables only; empty for an agent's own. */
  grantedAgents: { id: string; allowAutomation: boolean }[];
  engineDelivery: boolean;
  allowAutomation: boolean;
  updatedBy: string | null;
  updatedAt: Date;
};

export type PutEnvVariableInput = {
  /** The caller, for the receipt and `updated_by`. Authorization is the service's. */
  principal: Principal;
  scope: EnvVariableScope;
  name: string;
  /** Already checked with `envValueProblem`. Plain only until the secret path lands. */
  value: string;
  /** `create` is `If-None-Match: *`; `ifMatch` is the version last read. */
  precondition: { create: true } | { ifMatch: number };
};

export type PutEnvVariableResult =
  | {
      outcome: "saved";
      version: number;
      grantVersion: number;
      created: boolean;
      receiptId: string;
    }
  /** `current` is null when there is no such variable. */
  | { outcome: "version_mismatch"; current: number | null }
  | { outcome: "quota_exceeded" }
  | { outcome: "agent_not_found" };

export type DeleteEnvVariableInput = {
  principal: Principal;
  scope: EnvVariableScope;
  name: string;
  ifMatch: number;
};

export type DeleteEnvVariableResult =
  | {
      outcome: "deleted";
      /** Agents that received the value. */
      affectedAgents: number;
      /** Sessions not closed yet that copied it at accept. */
      openSessions: number;
      receiptId: string;
    }
  | { outcome: "not_found" }
  | { outcome: "version_mismatch"; current: number };

export type SetEnvVariableGrantsInput = {
  principal: Principal;
  workspaceId: string;
  name: string;
  /** The `grant_version` last read. */
  ifMatch: number;
  grantAll: boolean;
  agents: { id: string; allowAutomation: boolean }[];
};

export type SetEnvVariableGrantsResult =
  | { outcome: "saved"; grantVersion: number; receiptId: string }
  | { outcome: "not_found" }
  | { outcome: "version_mismatch"; current: number }
  /** An id that is not an agent of this workspace. */
  | { outcome: "agent_not_found" };

/**
 * Stored user variables. Every write that changes a row also writes its
 * receipt in the same transaction, and the receipt names the variable and its
 * version, never a value. The count limits are judged under an advisory lock
 * so two concurrent first writes cannot both take the last place.
 */
export interface EnvVariableStore {
  /** Whether the agent belongs to the workspace; a read of its variables 404s otherwise. */
  hasAgent(workspaceId: string, agentId: string): Promise<boolean>;
  list(scope: EnvVariableScope): Promise<EnvVariableRecord[]>;
  /**
   * An agent's own variables and the workspace's, with values and grants read
   * from one snapshot, so a value is never paired with a grant that was made
   * for a later value.
   */
  readAgentView(
    workspaceId: string,
    agentId: string,
  ): Promise<{ own: EnvVariableRecord[]; workspace: EnvVariableRecord[] }>;
  put(input: PutEnvVariableInput): Promise<PutEnvVariableResult>;
  delete(input: DeleteEnvVariableInput): Promise<DeleteEnvVariableResult>;
  /** Replaces the whole grant set of a workspace-level variable. */
  setGrants(
    input: SetEnvVariableGrantsInput,
  ): Promise<SetEnvVariableGrantsResult>;
}
