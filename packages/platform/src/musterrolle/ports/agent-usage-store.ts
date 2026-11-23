import type { AgentUsageScope, WorkspaceRole } from "@werft-ai/contracts";
import type { TeamActor } from "./team-store.ts";

/** One agent's usage setting as stored; `teams` is empty for `workspace`. */
export type AgentUsageState = {
  scope: AgentUsageScope;
  teams: { id: string; name: string }[];
  revision: number;
};

/**
 * `unchanged`: the same scope and teams were already stored (no receipt, no
 * revision move). `version_mismatch`: `ifMatch` is not the stored revision;
 * `current` is. `team_not_found`: a listed team is not a live team of the
 * agent's workspace. `team_not_allowed`: an actor outside `managerRoles`
 * listed a team they are not in. `actor_inactive`: the actor no longer
 * manages the agent, read in the write's transaction.
 */
export type PutAgentUsageResult =
  | { outcome: "set" | "unchanged"; usage: AgentUsageState }
  | { outcome: "version_mismatch"; current: number }
  | {
      outcome:
        | "not_found"
        | "actor_inactive"
        | "team_not_found"
        | "team_not_allowed";
    };

export interface AgentUsageStore {
  get(workspaceId: string, agentId: string): Promise<AgentUsageState | null>;
  /**
   * Replaces the whole setting. `managerRoles` hold the right outright;
   * anyone else must administer the agent, and may list only teams they are
   * in.
   */
  put(input: {
    actor: TeamActor;
    receiptId: string;
    agentId: string;
    scope: AgentUsageScope;
    teamIds: readonly string[];
    ifMatch: number;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<PutAgentUsageResult>;
}
