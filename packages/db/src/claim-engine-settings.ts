import {
  adminDenySchema,
  storedEngineSettingsSchema,
} from "@werft-ai/contracts";
import {
  applicableAdminDeny,
  type ClaimEngineSettings,
  effectiveEngineSettings,
  mergeEngineSettings,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentEngineSettings,
  agentReleases,
  workspaceEngineSettings,
} from "./schema.ts";

export type ClaimEngineSettingsResult =
  | { kind: "ok"; settings: ClaimEngineSettings }
  /** Some source cannot be trusted; the claim is refused, never sent without rules. */
  | { kind: "closed"; reason: string }
  /** The worker lacks a capability the merged rules need. */
  | { kind: "unsupported" };

/**
 * The rules one claim sends, read in the claim's own transaction: the
 * workspace's, the agent's (against what the session started with) and the
 * inherited restrictions that bind the session's release.
 *
 * Rows are parsed structurally. The save path already ran the catalog's
 * parser, and the engine adapter is the last check, so a row that no longer
 * parses closes the claim rather than being read as "no rules".
 */
export async function claimEngineSettingsOf(
  tx: Database,
  session: RuleSession,
  supports: { engineSettings: boolean; permissionRules: boolean },
): Promise<ClaimEngineSettingsResult> {
  const merged = await mergedRulesOf(tx, session);
  if (merged.kind === "closed") return merged;
  if (merged.engine !== undefined && !supports.engineSettings) {
    return { kind: "unsupported" };
  }
  if (merged.disallowedTools.length > 0 && !supports.permissionRules) {
    return { kind: "unsupported" };
  }
  return {
    kind: "ok",
    settings: {
      ...(merged.engine === undefined ? {} : { engine: merged.engine }),
      disallowedTools: merged.disallowedTools,
    },
  };
}

type RuleSession = {
  workspaceId: string | null;
  agentReleaseId: string | null;
  engineSettingsStart: unknown;
};

/**
 * The `mcp__` tool names saved rules deny for the session, or null when the
 * rules cannot be read. Callers treat null as "deny every MCP tool": the
 * platform enforces these at call time because the engine adapter takes no
 * `mcp__` rule in deny or ask.
 */
export async function mcpDeniedBy(
  executor: Database,
  session: RuleSession,
): Promise<string[] | null> {
  const merged = await mergedRulesOf(executor, session);
  return merged.kind === "closed" ? null : merged.mcpDeny;
}

async function mergedRulesOf(
  tx: Database,
  session: RuleSession,
): Promise<ReturnType<typeof mergeEngineSettings>> {
  let workspace = null;
  if (session.workspaceId !== null) {
    const [row] = await tx
      .select()
      .from(workspaceEngineSettings)
      .where(eq(workspaceEngineSettings.workspaceId, session.workspaceId))
      .limit(1);
    if (row !== undefined) {
      const parsed = storedEngineSettingsSchema.safeParse({
        permissions: row.permissions,
        auto_mode: row.autoMode,
      });
      if (!parsed.success) return { kind: "closed", reason: "workspace_rules" };
      workspace = parsed.data;
    }
  }

  let agentRow = null;
  let adminDeny: ReturnType<typeof applicableAdminDeny> = [];
  if (session.agentReleaseId !== null) {
    const [release] = await tx
      .select({ agentId: agentReleases.agentId })
      .from(agentReleases)
      .where(eq(agentReleases.id, session.agentReleaseId))
      .limit(1);
    if (release === undefined) {
      return { kind: "closed", reason: "release_unresolvable" };
    }
    const [row] = await tx
      .select()
      .from(agentEngineSettings)
      .where(eq(agentEngineSettings.agentId, release.agentId))
      .limit(1);
    if (row !== undefined) {
      const parsed = storedEngineSettingsSchema.safeParse({
        permissions: row.permissions,
        auto_mode: row.autoMode,
      });
      const inherited = adminDenySchema.safeParse(row.adminDeny);
      if (!parsed.success) return { kind: "closed", reason: "agent_rules" };
      if (!inherited.success) return { kind: "closed", reason: "admin_deny" };
      agentRow = { ...parsed.data, revision: row.revision };
      adminDeny = applicableAdminDeny(inherited.data, session.agentReleaseId);
    }
  }

  return mergeEngineSettings({
    workspace,
    agent: effectiveEngineSettings({
      start: session.engineSettingsStart,
      row: agentRow,
    }),
    adminDeny,
  });
}
