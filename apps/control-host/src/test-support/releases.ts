import { randomUUID } from "node:crypto";
import type { SpecSource } from "@werft-ai/contracts";
import {
  agentReleases,
  agents,
  agentVersions,
  type Database,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  makeFixtureRelease,
  releaseSpecColumns,
} from "@werft-ai/db/testing/spec-pins";

/**
 * A new workspace with an active agent and one release on the test
 * connection: what a test that starts a session needs, since every session
 * runs an agent release of its own workspace.
 */
export async function workspaceRelease(
  db: Database,
  options: { workspaceId?: string; model?: string } = {},
): Promise<{ workspaceId: string; releaseId: string }> {
  const workspaceId = options.workspaceId ?? randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "test" })
    .onConflictDoNothing();
  const releaseId = await makeFixtureRelease(db, {
    workspaceId,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  return { workspaceId, releaseId };
}

/** The owner id tests used to name freely: now a workspace's, so a uuid. */
export const TEST_OWNER = "0a0a0a0a-0000-4000-8000-00000000000a";

/** A release in `workspaceId`'s workspace (TEST_OWNER's by default). */
export async function releaseIn(
  db: Database,
  workspaceId: string = TEST_OWNER,
  model?: string,
): Promise<string> {
  return (
    await workspaceRelease(db, {
      workspaceId,
      ...(model === undefined ? {} : { model }),
    })
  ).releaseId;
}

/**
 * A release in `workspaceId`'s workspace on a connection of the caller's
 * choosing: its spec names that connection.
 */
export async function releaseOnConnection(
  db: Database,
  input: {
    workspaceId?: string;
    connection: SpecSource["connection"];
    model: string;
  },
): Promise<string> {
  const workspaceId = input.workspaceId ?? TEST_OWNER;
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "test" })
    .onConflictDoNothing();
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    slug: `release-${agentId.slice(0, 8)}`,
    name: "release",
    status: "active",
    managingTeamId: await fixtureTeam(db, workspaceId),
  });
  const versionId = randomUUID();
  await db.insert(agentVersions).values({
    id: versionId,
    agentId,
    versionNo: 1,
    card: { model: input.model, capabilities: {}, language: "follow-user", rules: [] },
    contentSha256: "0".repeat(64),
  });
  const releaseId = `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const spec = releaseSpecColumns({
    model: input.model,
    connection: input.connection,
  });
  await db.insert(agentReleases).values({
    id: releaseId,
    agentId,
    versionId,
    cardSha256: "0".repeat(64),
    connectionId: input.connection.id,
    runtimeConfigSnapshot: {
      model: input.model,
      tools: spec.specSource.tools,
      permission_mode: spec.specSource.permission_mode,
      provider: {
        kind: input.connection.kind,
        endpoint: input.connection.endpoint,
      },
      runtime: spec.specSource.runtime,
    },
    effectiveTools: { tools: spec.specSource.tools, mcp: [] },
    ...spec,
  });
  return releaseId;
}
