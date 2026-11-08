import type { McpStart } from "@werft-ai/contracts";
import type { AgentMcpSettingsView } from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { agentMcpSettings, agentReleases } from "./schema.ts";

/** The settings a new session of the release's agent would start under, or null for none. */
export async function mcpSettingsOfRelease(
  executor: Database,
  releaseId: string,
): Promise<AgentMcpSettingsView | null> {
  const [row] = await executor
    .select({
      server: agentMcpSettings.server,
      allowedTools: agentMcpSettings.allowedTools,
      updatedBy: agentMcpSettings.updatedBy,
    })
    .from(agentReleases)
    .innerJoin(
      agentMcpSettings,
      eq(agentMcpSettings.agentId, agentReleases.agentId),
    )
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  return row ?? null;
}

/**
 * The snapshot a session starts with, read inside the transaction that
 * creates it. The row is locked FOR SHARE, so a save waits for the session to
 * exist instead of landing between the read and the insert. Null when the
 * agent has no row: that session follows its release.
 */
export async function captureMcpStart(
  tx: Database,
  releaseId: string,
): Promise<McpStart | null> {
  const [row] = await tx
    .select({
      server: agentMcpSettings.server,
      allowedTools: agentMcpSettings.allowedTools,
      credentialRefs: agentMcpSettings.credentialRefs,
      revision: agentMcpSettings.revision,
    })
    .from(agentReleases)
    .innerJoin(
      agentMcpSettings,
      eq(agentMcpSettings.agentId, agentReleases.agentId),
    )
    .where(eq(agentReleases.id, releaseId))
    .limit(1)
    .for("share", { of: agentMcpSettings });
  if (row === undefined) return null;
  return {
    server: row.server,
    allowed_tools: row.allowedTools,
    credential_refs: row.credentialRefs,
    revision: row.revision,
  };
}
