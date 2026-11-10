import {
  type AdminDenyEntry,
  type ToolCatalogView,
  validateAdminDeny,
  validateEngineSettings,
} from "@werft-ai/contracts";
import type { AgentEngineSettingsView } from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { agentEngineSettings } from "./schema.ts";

export type AgentEngineSettingsRow = AgentEngineSettingsView & {
  /** Restrictions inherited from the profile and installation; see `validateAdminDeny`. */
  readonly adminDeny: AdminDenyEntry[];
};

/**
 * The agent's saved engine settings, or null when it has none, which reads as
 * no rules. Called by no claim or session path yet.
 *
 * A row that is not what a save would have stored throws instead of reading as
 * none: the table's CHECKs keep its structure right, and the rules go through
 * the same parser a save uses, against the catalog the caller runs with. A
 * rule the engine would drop without a word (`Skill(name)`, an unknown tool)
 * is the case a silent "no rules" would get wrong for an agent that has deny
 * rules, so the caller decides what an unreadable row means, not this reader.
 * The same holds for the inherited restrictions in `admin_deny`.
 */
export async function agentEngineSettingsOf(
  executor: Database,
  agentId: string,
  catalog: ToolCatalogView,
): Promise<AgentEngineSettingsRow | null> {
  const [found] = await executor
    .select()
    .from(agentEngineSettings)
    .where(eq(agentEngineSettings.agentId, agentId.toLowerCase()))
    .limit(1);
  if (found === undefined) return null;
  const checked = validateEngineSettings(
    catalog,
    { permissions: found.permissions, auto_mode: found.autoMode },
    "agent",
  );
  if ("refusal" in checked) {
    throw new Error(
      `agent_engine_settings row for agent ${found.agentId} does not parse: ${checked.refusal.reason_code}`,
    );
  }
  const inherited = validateAdminDeny(catalog, found.adminDeny);
  if ("refusal" in inherited) {
    throw new Error(
      `agent_engine_settings.admin_deny for agent ${found.agentId} does not parse: ${inherited.refusal.reason_code}`,
    );
  }
  return {
    ...checked.settings,
    revision: found.revision,
    adminDeny: inherited.entries,
  };
}
