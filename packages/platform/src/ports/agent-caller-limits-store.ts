import type {
  AgentCallerLimitRule,
  AgentCallerLimits,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { TeamActor } from "./team-store.ts";

/**
 * A stored rule as the enforcement layer reads it (94S-918): every target
 * kind the table holds, a person's included, though the v1 API takes none.
 * `repositories` and `mcp_servers` list all the caller may use (`null` no
 * limit, `[]` none); a repository id the catalog no longer holds is not an
 * allowance. `tools_deny` and `credentials_deny` list what is refused.
 */
export type CallerLimitRuleFacts = Omit<AgentCallerLimitRule, "target"> & {
  target: AgentCallerLimitRule["target"] | { kind: "user"; id: string };
};

export type CallerLimitsFacts = {
  rules: CallerLimitRuleFacts[];
  /** The agent's `limits_revision` the rules were read at. */
  revision: number;
};

/**
 * `unchanged`: the same rules were already stored (no receipt, no revision
 * move). `version_mismatch`: `ifMatch` is not the stored `limits_revision`;
 * `current` is. `team_not_found`: a rule names a team that is not live in the
 * agent's workspace. `team_not_allowed`: an actor outside `managerRoles`
 * named a team they are not in. `repository_not_in_catalog`: `repositoryIds`
 * are ids this edit adds to a target that the catalog does not hold (an id
 * the target already stored passes, whatever the catalog says now).
 * `actor_inactive`: the actor no longer manages the agent, read in the
 * write's transaction.
 */
export type PutAgentCallerLimitsResult =
  | { outcome: "set" | "unchanged"; limits: AgentCallerLimits }
  | { outcome: "version_mismatch"; current: number }
  | { outcome: "repository_not_in_catalog"; repositoryIds: string[] }
  | {
      outcome:
        | "not_found"
        | "actor_inactive"
        | "team_not_found"
        | "team_not_allowed";
    };

export interface AgentCallerLimitsStore {
  get(workspaceId: string, agentId: string): Promise<AgentCallerLimits | null>;
  /**
   * Replaces the whole set. `managerRoles` hold the right outright; anyone
   * else must administer the agent, and may add a rule only for a team they
   * are in.
   */
  put(input: {
    actor: TeamActor;
    receiptId: string;
    agentId: string;
    rules: readonly AgentCallerLimitRule[];
    ifMatch: number;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<PutAgentCallerLimitsResult>;
}
