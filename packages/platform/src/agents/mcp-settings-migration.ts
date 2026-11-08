import { credentialRefSchema, mcpServerIdSchema } from "@werft-ai/contracts";
import {
  type McpReleaseValues,
  mcpValuesOfCard,
} from "./mcp-release-values.ts";

/** One agent as the copy reads it. Only names; no value is read. */
export type McpMigrationFact = {
  workspace_id: string;
  agent_id: string;
  name: string;
  has_row: boolean;
  /** The active release's card and pins; null before any activation. */
  active: { card: unknown; policy_pins: unknown } | null;
  /** The newest version's card, the draft; null when there is none. */
  draft_card: unknown;
};

export const MCP_MIGRATION_SKIP_REASONS = [
  "has_row",
  "nothing_to_move",
  "draft_not_included",
  "invalid_value",
] as const;
export type McpMigrationSkipReason =
  (typeof MCP_MIGRATION_SKIP_REASONS)[number];

export type McpMigrationEntry = {
  workspace_id: string;
  agent_id: string;
  name: string;
  source: "active_release" | "draft_card";
  decision: "copy" | "skip";
  skip_reason: McpMigrationSkipReason | null;
  server: string | null;
  allowed_tools: string[];
  credential_refs: string[];
  /** What a row cannot carry; counted, never named. */
  ask_count: number;
  deny_count: number;
  forbidden_count: number;
};

export type McpMigrationTotals = {
  copy: number;
  has_row: number;
  nothing_to_move: number;
  draft_not_included: number;
  invalid_value: number;
  ask_total: number;
  deny_total: number;
  forbidden_total: number;
};

export type McpMigrationPlan = {
  version: 1;
  include_drafts: boolean;
  agents: McpMigrationEntry[];
  totals: McpMigrationTotals;
};

// The settings table's own limits (`agent_mcp_settings` CHECKs).
const MAX_REFS = 32;
const MAX_TOOL_NAME = 128;

function valid(values: McpReleaseValues): boolean {
  if (
    values.server !== null &&
    !mcpServerIdSchema.safeParse(values.server).success
  ) {
    return false;
  }
  if (values.credentialRefs.length > MAX_REFS) return false;
  if (
    !values.credentialRefs.every(
      (ref) => credentialRefSchema.safeParse(ref).success,
    )
  ) {
    return false;
  }
  return values.allowedTools.every((tool) => tool.length <= MAX_TOOL_NAME);
}

/** A draft card carries its tool policy where a release carries pins. */
function draftValues(card: unknown): McpReleaseValues {
  const capabilities =
    typeof card === "object" && card !== null
      ? (card as { capabilities?: { tool_policy?: { per_tool?: unknown } } })
          .capabilities
      : undefined;
  return mcpValuesOfCard(card, {
    tools: { per_tool: capabilities?.tool_policy?.per_tool ?? {} },
  });
}

/**
 * What the copy would write: for each agent, the values its active release
 * carries (a draft's, only when asked). An agent that has a row is left as
 * it is. Sorted, so the report's bytes depend on the data alone.
 */
export function planMcpSettingsMigration(input: {
  facts: readonly McpMigrationFact[];
  includeDrafts: boolean;
}): McpMigrationPlan {
  const agents = input.facts
    .map((fact): McpMigrationEntry => {
      const source = fact.active === null ? "draft_card" : "active_release";
      const values =
        fact.active !== null
          ? mcpValuesOfCard(fact.active.card, fact.active.policy_pins)
          : draftValues(fact.draft_card);
      const skip = (): McpMigrationSkipReason | null => {
        if (fact.has_row) return "has_row";
        if (values.server === null && values.credentialRefs.length === 0) {
          return "nothing_to_move";
        }
        if (!valid(values)) return "invalid_value";
        if (source === "draft_card" && !input.includeDrafts) {
          return "draft_not_included";
        }
        return null;
      };
      const skip_reason = skip();
      return {
        workspace_id: fact.workspace_id,
        agent_id: fact.agent_id,
        name: fact.name,
        source,
        decision: skip_reason === null ? "copy" : "skip",
        skip_reason,
        server: values.server,
        allowed_tools: values.allowedTools,
        credential_refs: values.credentialRefs,
        ask_count: values.askCount,
        deny_count: values.denyCount,
        forbidden_count: values.forbiddenCount,
      };
    })
    .sort(
      (a, b) =>
        a.workspace_id.localeCompare(b.workspace_id) ||
        a.agent_id.localeCompare(b.agent_id),
    );
  const count = (reason: McpMigrationSkipReason) =>
    agents.filter((entry) => entry.skip_reason === reason).length;
  const sum = (pick: (entry: McpMigrationEntry) => number) =>
    agents.reduce((total, entry) => total + pick(entry), 0);
  return {
    version: 1,
    include_drafts: input.includeDrafts,
    agents,
    totals: {
      copy: agents.filter((entry) => entry.decision === "copy").length,
      has_row: count("has_row"),
      nothing_to_move: count("nothing_to_move"),
      draft_not_included: count("draft_not_included"),
      invalid_value: count("invalid_value"),
      ask_total: sum((entry) => entry.ask_count),
      deny_total: sum((entry) => entry.deny_count),
      forbidden_total: sum((entry) => entry.forbidden_count),
    },
  };
}

/** What `--apply` compares: the values a copy would write. */
export const copyValuesOf = (entry: McpMigrationEntry) =>
  JSON.stringify([entry.server, entry.allowed_tools, entry.credential_refs]);
