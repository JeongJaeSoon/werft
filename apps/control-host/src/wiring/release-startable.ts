import { type AgentRelease, releaseModel } from "@werft-ai/contracts";
import {
  agentGitHubSettingsOf,
  type Database,
  workspaceRepositoryCeiling,
} from "@werft-ai/db";
import { releaseStartable, type SessionCatalogView } from "@werft-ai/platform";

/** Whether a new session could start on `release`, read from the database. */
export async function releaseStartableIn(
  db: Database,
  catalog: SessionCatalogView,
  workspaceId: string,
  release: Pick<
    AgentRelease,
    "agent_id" | "connection_id" | "repository_id" | "policy_pins"
  > &
    Parameters<typeof releaseModel>[0],
): Promise<boolean> {
  return releaseStartable(
    catalog,
    { ...release, model: releaseModel(release) },
    await agentGitHubSettingsOf(db, release.agent_id),
    await workspaceRepositoryCeiling(db, workspaceId),
  );
}
