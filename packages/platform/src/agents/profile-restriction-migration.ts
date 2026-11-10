import {
  type AdminDenyEntry,
  denyOf,
  mcpNamesOf,
  type ToolCatalogView,
  validateAdminDeny,
} from "@werft-ai/contracts";

/** One agent as the copy reads it: names and ids only, no secret. */
export type RestrictionFact = {
  workspace_id: string;
  agent_id: string;
  name: string;
  /** The active release; null before any activation. */
  release: {
    id: string;
    runtime_profile_id: string;
    /** The built-in tools its `runtime_config_snapshot` allows. */
    tools: string[];
  } | null;
  /** Every release id the agent has, read under the agent's lock. */
  release_ids: string[];
  /** The stored `admin_deny`, as it is in the row. */
  existing: unknown;
};

/** What a release's profile blocks today, with the catalog its tools are weighed against. */
export type RestrictionProfile = {
  tools: readonly string[];
  mcp_deny: readonly string[];
  catalog: ToolCatalogView | undefined;
};

export type RestrictionResolver = (
  workspaceId: string,
  runtimeProfileId: string,
) => RestrictionProfile | undefined;

export const RESTRICTION_SKIP_REASONS = [
  "no_release",
  "nothing_to_deny",
  "already_covered",
] as const;
export const RESTRICTION_BLOCK_REASONS = [
  "profile_gone",
  "catalog_missing",
  "stored_admin_deny_invalid",
  "over_budget",
] as const;
export type RestrictionReason =
  | (typeof RESTRICTION_SKIP_REASONS)[number]
  | (typeof RESTRICTION_BLOCK_REASONS)[number];

export type RestrictionEntry = {
  workspace_id: string;
  agent_id: string;
  name: string;
  decision: "write" | "skip" | "blocked";
  reason: RestrictionReason | null;
  /** What the profile blocks that no stored entry covers yet. */
  permissions_deny: string[];
  mcp_deny: string[];
  /** The releases the new entry leaves as they are. */
  exempt_release_count: number;
  /** Refusal text from the storage rules, when blocked by them. */
  detail: string | null;
};

export type RestrictionPlan = {
  version: 1;
  agents: RestrictionEntry[];
  totals: {
    write: number;
    skip: number;
    blocked: number;
    permissions_rules: number;
    mcp_rules: number;
  };
};

const storedEntries = (
  catalog: ToolCatalogView,
  existing: unknown,
): AdminDenyEntry[] | null => {
  const checked = validateAdminDeny(catalog, existing ?? []);
  return "entries" in checked ? checked.entries : null;
};

/** The entry to append for one agent, or why not. The same call the apply re-runs under the agent's lock. */
export function restrictionOf(
  fact: RestrictionFact,
  resolve: RestrictionResolver,
): RestrictionEntry & { entry: AdminDenyEntry | null } {
  const base = {
    workspace_id: fact.workspace_id,
    agent_id: fact.agent_id,
    name: fact.name,
    permissions_deny: [] as string[],
    mcp_deny: [] as string[],
    exempt_release_count: 0,
    detail: null as string | null,
    entry: null as AdminDenyEntry | null,
  };
  const out = (
    decision: RestrictionEntry["decision"],
    reason: RestrictionReason | null,
    extra: Partial<typeof base> = {},
  ) => ({ ...base, ...extra, decision, reason });

  if (fact.release === null) return out("skip", "no_release");
  const profile = resolve(fact.workspace_id, fact.release.runtime_profile_id);
  if (profile === undefined) return out("blocked", "profile_gone");
  if (profile.catalog === undefined) return out("blocked", "catalog_missing");

  // What a claim runs: the profile's tools within the release's, so the
  // denied set is the catalog minus that, the same as `claimToolLists`.
  const chosen = new Set(fact.release.tools);
  const running = profile.tools.filter((tool) => chosen.has(tool));
  const derivedTools = denyOf(profile.catalog, running);
  const derivedMcp = mcpNamesOf(profile.mcp_deny);

  const stored = storedEntries(profile.catalog, fact.existing);
  if (stored === null) return out("blocked", "stored_admin_deny_invalid");
  const have = new Set(
    stored.flatMap((entry) => [...entry.permissions_deny, ...entry.mcp_deny]),
  );
  const permissions_deny = derivedTools.filter((rule) => !have.has(rule));
  const mcp_deny = derivedMcp.filter((rule) => !have.has(rule));
  if (derivedTools.length === 0 && derivedMcp.length === 0) {
    return out("skip", "nothing_to_deny");
  }
  if (permissions_deny.length === 0 && mcp_deny.length === 0) {
    return out("skip", "already_covered");
  }

  const entry: AdminDenyEntry = {
    exempt_release_ids: [...new Set(fact.release_ids)].sort(),
    permissions_deny,
    mcp_deny,
  };
  const checked = validateAdminDeny(profile.catalog, [...stored, entry]);
  if ("refusal" in checked) {
    return out("blocked", "over_budget", {
      permissions_deny,
      mcp_deny,
      detail: `${checked.refusal.reason_code}: ${checked.refusal.message}`,
    });
  }
  return out("write", null, {
    permissions_deny,
    mcp_deny,
    exempt_release_count: entry.exempt_release_ids.length,
    entry,
  });
}

/** What the copy would write, sorted so the report's bytes depend on the data alone. */
export function planProfileRestrictionMigration(input: {
  facts: readonly RestrictionFact[];
  resolve: RestrictionResolver;
}): RestrictionPlan {
  const agents: RestrictionEntry[] = input.facts
    .map((fact) => {
      const { entry: _entry, ...row } = restrictionOf(fact, input.resolve);
      return row;
    })
    .sort((a, b) =>
      a.workspace_id === b.workspace_id
        ? a.agent_id.localeCompare(b.agent_id)
        : a.workspace_id.localeCompare(b.workspace_id),
    );
  const written = agents.filter((entry) => entry.decision === "write");
  return {
    version: 1,
    agents,
    totals: {
      write: written.length,
      skip: agents.filter((entry) => entry.decision === "skip").length,
      blocked: agents.filter((entry) => entry.decision === "blocked").length,
      permissions_rules: written.reduce(
        (sum, entry) => sum + entry.permissions_deny.length,
        0,
      ),
      mcp_rules: written.reduce((sum, entry) => sum + entry.mcp_deny.length, 0),
    },
  };
}
