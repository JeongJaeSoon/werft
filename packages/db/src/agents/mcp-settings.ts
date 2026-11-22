import type { AgentMcpSettingsView } from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { retiredAgentMcpSettings } from "../schema.ts";

/**
 * The agent's catalog MCP selection as migration 0304 retired it, or null for
 * none: only a restore reads it, to rebuild what a claim gave the session.
 */
export async function retiredMcpSettingsOf(
  executor: Database,
  agentId: string,
): Promise<AgentMcpSettingsView | null> {
  const [row] = await executor
    .select({
      server: retiredAgentMcpSettings.server,
      allowedTools: retiredAgentMcpSettings.allowedTools,
      copied: retiredAgentMcpSettings.copied,
    })
    .from(retiredAgentMcpSettings)
    .where(eq(retiredAgentMcpSettings.agentId, agentId))
    .limit(1);
  return row ?? null;
}
