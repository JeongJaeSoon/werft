import {
  type StoredEngineSettings,
  type ToolCatalogView,
  validateEngineSettings,
} from "@werft-ai/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { workspaceEngineSettings } from "./schema.ts";

export type WorkspaceEngineSettingsView = StoredEngineSettings & {
  readonly revision: number;
};

/**
 * The workspace's saved engine settings, or null when it has none, which
 * reads as no rules. Called by no claim or session path yet.
 *
 * Like the agent's reader, a row that is not what a save would have stored
 * throws: a workspace deny the engine would drop must not read as "no rules".
 */
export async function workspaceEngineSettingsOf(
  executor: Database,
  workspaceId: string,
  catalog: ToolCatalogView,
): Promise<WorkspaceEngineSettingsView | null> {
  const [found] = await executor
    .select()
    .from(workspaceEngineSettings)
    .where(eq(workspaceEngineSettings.workspaceId, workspaceId.toLowerCase()))
    .limit(1);
  if (found === undefined) return null;
  const checked = validateEngineSettings(
    catalog,
    { permissions: found.permissions, auto_mode: found.autoMode },
    "workspace",
  );
  if ("refusal" in checked) {
    throw new Error(
      `workspace_engine_settings row for workspace ${found.workspaceId} does not parse: ${checked.refusal.reason_code}`,
    );
  }
  return { ...checked.settings, revision: found.revision };
}
