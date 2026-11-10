import type { EngineSettingsStart } from "@werft-ai/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { agentEngineSettings, agentReleases, agents } from "./schema.ts";

/**
 * The agent's engine settings as a new session starts with them, or null when
 * the release has no agent or the agent has no settings row. Null is
 * restrict-only: a row saved later can narrow the session and never grant it.
 *
 * The agent row is locked FOR SHARE, the lock every writer of the agent's
 * settings takes FOR UPDATE, so the content and revision stored are one the
 * agent really had. The content is stored as read; whether it parses is
 * decided at claim time, where an unparseable snapshot closes the claim.
 */
export async function captureEngineSettingsStart(
  tx: Database,
  releaseId: string,
): Promise<EngineSettingsStart | null> {
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agentReleases)
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .where(eq(agentReleases.id, releaseId))
    .limit(1)
    .for("share", { of: agents });
  if (agent === undefined) return null;
  const [row] = await tx
    .select({
      permissions: agentEngineSettings.permissions,
      autoMode: agentEngineSettings.autoMode,
      revision: agentEngineSettings.revision,
    })
    .from(agentEngineSettings)
    .where(eq(agentEngineSettings.agentId, agent.id))
    .limit(1);
  if (row === undefined) return null;
  return {
    permissions: row.permissions as EngineSettingsStart["permissions"],
    auto_mode: row.autoMode as EngineSettingsStart["auto_mode"],
    revision: row.revision,
  };
}
