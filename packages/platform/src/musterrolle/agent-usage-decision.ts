import type { AgentUsageScope } from "@werft-ai/contracts";

// Who may start or feed a session of an agent. Both the policy's
// read and the store's re-decision under lock gather these facts and ask
// decideUsage, so the two cannot drift.

/**
 * Why a requester may use the agent. Checked in this order, so a person who
 * qualifies twice is recorded under the narrower grant:
 * - `public`: the agent is open to the workspace.
 * - `team`: a live member of a team the private agent lists.
 * - `workspace`: a workspace owner or admin.
 * - `agent_admin`: the agent's admin, directly, through a lent team, or as
 *   lead of its managing team.
 * - `manager`: a live member of its managing team.
 * - `agent_key`: a key bound to this very agent.
 */
export const USAGE_BASIS_VALUES = [
  "public",
  "team",
  "workspace",
  "agent_admin",
  "manager",
  "agent_key",
] as const;
export type UsageBasis = (typeof USAGE_BASIS_VALUES)[number];

export type UsageDecision =
  | { allowed: true; basis: UsageBasis; teamId: string | null }
  | { allowed: false };

/** Everything `decideUsage` reads, as of one instant (or one lock). */
export type UsageFacts = {
  scope: AgentUsageScope;
  /** A key bound to this agent: the agent's own. */
  agentKey: boolean;
  /** No person behind the caller (a service key not bound to an agent). */
  personless: boolean;
  workspaceManager: boolean;
  directAdmin: boolean;
  /** Live teams the requester is in that the agent lists as users. */
  usageTeams: readonly string[];
  /** Live teams lent to the agent as admins that the requester is in. */
  adminTeams: readonly string[];
  /** The live managing team, when the requester leads it. */
  managingLead: string | null;
  /** The live managing team, when the requester is in it. */
  managingMember: string | null;
};

const first = (ids: readonly string[]): string | null =>
  [...ids].sort()[0] ?? null;

export function decideUsage(facts: UsageFacts): UsageDecision {
  if (facts.agentKey) {
    return { allowed: true, basis: "agent_key", teamId: null };
  }
  if (facts.scope === "workspace") {
    return { allowed: true, basis: "public", teamId: null };
  }
  // A key with no person, not bound to this agent, is no one's team.
  if (facts.personless) return { allowed: false };
  if (facts.usageTeams.length > 0) {
    return { allowed: true, basis: "team", teamId: first(facts.usageTeams) };
  }
  if (facts.workspaceManager) {
    return { allowed: true, basis: "workspace", teamId: null };
  }
  if (facts.directAdmin) {
    return { allowed: true, basis: "agent_admin", teamId: null };
  }
  if (facts.adminTeams.length > 0) {
    return {
      allowed: true,
      basis: "agent_admin",
      teamId: first(facts.adminTeams),
    };
  }
  if (facts.managingLead !== null) {
    return { allowed: true, basis: "agent_admin", teamId: facts.managingLead };
  }
  if (facts.managingMember !== null) {
    return { allowed: true, basis: "manager", teamId: facts.managingMember };
  }
  return { allowed: false };
}
