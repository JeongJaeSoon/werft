import { storedAgentCardSchema } from "@werft-ai/contracts";
import {
  catalogProfile,
  type SessionCatalog,
  workspaceProfileRefusal,
} from "../sessions/catalog.ts";
import { resolveReleaseContent } from "./release-ids.ts";

/** One agent with an active release, as the plan reads it. */
export type ToolUnlockAgentFact = {
  workspace_id: string;
  agent_id: string;
  name: string;
  tracking: "follow" | "pinned";
  activation_revision: number;
  behavior_revision: number;
  active_release_id: string;
  profile_id: string;
  card: unknown;
  /** The active release's `effective_tools.tools`. */
  tools: readonly string[];
};

export type ToolUnlockEntry = {
  workspace_id: string;
  agent_id: string;
  name: string;
  profile_id: string;
  tracking: "follow" | "pinned";
  active_release_id: string;
  activation_revision: number;
  behavior_revision: number;
  /** `same`: the active release already runs what the new calculation gives. */
  decision: "unlock" | "same" | "would_fail";
  tools_before: string[];
  tools_after: string[];
  /** In the new calculation and not in the active release. */
  unlocked: string[];
  /** In the active release and not in the new calculation. */
  removed: string[];
  reason: string | null;
};

export type ToolUnlockPlan = {
  version: 1;
  generated_at: string;
  agents: ToolUnlockEntry[];
  totals: { agents: number; unlock: number; same: number; would_fail: number };
};

export const sameToolSet = (
  a: readonly string[],
  b: readonly string[],
): boolean => {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((tool) => left.has(tool));
};

/**
 * What the new release calculation gives each agent that has an active
 * release, `pinned` ones included, against what it runs now. The same
 * calculation `unlockTools` applies. MCP tools are not part of it: their
 * `ask` and `deny` never reached a run, and the allowed ones come from the
 * card's MCP entries, which this calculation leaves as they are.
 */
export function planToolUnlock(input: {
  facts: readonly ToolUnlockAgentFact[];
  catalog: SessionCatalog;
  now: string;
}): ToolUnlockPlan {
  const agents = input.facts.map((fact): ToolUnlockEntry => {
    const base = {
      workspace_id: fact.workspace_id,
      agent_id: fact.agent_id,
      name: fact.name,
      profile_id: fact.profile_id,
      tracking: fact.tracking,
      active_release_id: fact.active_release_id,
      activation_revision: fact.activation_revision,
      behavior_revision: fact.behavior_revision,
      tools_before: [...fact.tools],
    };
    const fails = (reason: string): ToolUnlockEntry => ({
      ...base,
      decision: "would_fail",
      tools_after: [],
      unlocked: [],
      removed: [],
      reason,
    });
    const refusal = workspaceProfileRefusal(
      input.catalog,
      fact.workspace_id,
      fact.profile_id,
      { retiredAllowed: true },
    );
    if (refusal !== null) return fails(refusal.state);
    const profile = catalogProfile(input.catalog, fact.profile_id);
    if (!profile) return fails("profile_unknown");
    const card = storedAgentCardSchema.safeParse(fact.card);
    if (!card.success) return fails("card_unreadable");
    const resolved = resolveReleaseContent(
      card.data,
      fact.profile_id,
      profile,
      input.catalog.mcp_servers,
    );
    if (!resolved.ok) return fails(resolved.error.field);
    const after = resolved.content.effective_tools.tools;
    return {
      ...base,
      decision: sameToolSet(fact.tools, after) ? "same" : "unlock",
      tools_after: [...after],
      unlocked: after.filter((tool) => !fact.tools.includes(tool)),
      removed: fact.tools.filter((tool) => !after.includes(tool)),
      reason: null,
    };
  });
  const count = (decision: ToolUnlockEntry["decision"]) =>
    agents.filter((entry) => entry.decision === decision).length;
  return {
    version: 1,
    generated_at: input.now,
    agents,
    totals: {
      agents: agents.length,
      unlock: count("unlock"),
      same: count("same"),
      would_fail: count("would_fail"),
    },
  };
}
