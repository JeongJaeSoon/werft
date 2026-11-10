import { randomUUID } from "node:crypto";
import { GITHUB_CEILING_NONE, type SpecSource } from "@werft-ai/contracts";
import {
  agentReleases,
  agents,
  agentVersions,
  createPostgresAgentStore,
  type Database,
  githubWorkspaceSettings,
  newSessionGitHubReaders,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  releaseSpecColumns,
  TEST_MODEL,
  testSpecSource,
} from "@werft-ai/db/testing/spec-pins";
import {
  type AuthorizationPolicy,
  agentEnvNames,
  type Caller,
  deriveReleaseId,
  releaseNotRunnableReason,
  resolveAgentRelease,
  type SessionCatalogView,
} from "@werft-ai/platform";

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
  const releaseId = await releaseOnConnection(db, {
    workspaceId,
    model: options.model ?? TEST_MODEL,
    connection: testSpecSource().connection,
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
    /** The rest of the spec, where a test needs other than the default. */
    spec?: Partial<SpecSource>;
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
    card: {
      role: "test agent",
      instructions: "Do what the test asks.",
      language: "follow-user",
      model: input.model,
      capabilities: { mcp: null, forbidden: [] },
      rules: [],
    },
    contentSha256: "0".repeat(64),
  });
  const spec = releaseSpecColumns({
    ...input.spec,
    model: input.model,
    connection: input.connection,
  });
  // Hashed as the agent service hashes it, so a session's start verifies it.
  const identity = {
    agent_id: agentId,
    card_sha256: "0".repeat(64),
    connection_id: input.connection.id,
    repository_id: null,
    runtime_config_snapshot: {
      model: input.model,
      tools: spec.specSource.tools,
      permission_mode: spec.specSource.permission_mode,
      provider: {
        kind: input.connection.kind,
        endpoint: input.connection.endpoint,
      },
      runtime: spec.specSource.runtime,
    },
    effective_tools: { tools: spec.specSource.tools, mcp: [] },
    policy_pins: {},
  };
  const releaseId = deriveReleaseId(identity as never);
  const approver = randomUUID();
  await db.insert(users).values({
    id: approver,
    email: `${approver}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "approver",
  });
  await db.insert(agentReleases).values({
    id: releaseId,
    agentId,
    versionId,
    cardSha256: identity.card_sha256,
    connectionId: identity.connection_id,
    runtimeConfigSnapshot: identity.runtime_config_snapshot,
    effectiveTools: identity.effective_tools,
    policyPins: identity.policy_pins,
    // Approved, as an activated release is: only such a release starts one.
    approvedBy: approver,
    approvedAt: new Date(),
    ...spec,
  });
  return releaseId;
}

/** The workspace's repository ceiling, naming `repositoryIds`. */
export async function allowRepositories(
  db: Database,
  workspaceId: string,
  repositoryIds: readonly string[],
): Promise<void> {
  await db
    .insert(githubWorkspaceSettings)
    .values({
      workspaceId,
      ceiling: GITHUB_CEILING_NONE,
      repositoryCeiling: {
        repository_ids: [...repositoryIds],
        github_app_repositories: "listed",
      },
    })
    .onConflictDoUpdate({
      target: githubWorkspaceSettings.workspaceId,
      set: {
        repositoryCeiling: {
          repository_ids: [...repositoryIds],
          github_app_repositories: "listed",
        },
      },
    });
}

/** The session service's `releases`, read from the database as the API reads them. */
export function sessionReleases(
  db: Database,
  catalog: Pick<SessionCatalogView, "connections">,
) {
  const store = createPostgresAgentStore(db);
  return {
    resolveRelease: (workspaceId: string, releaseId: string) =>
      resolveAgentRelease({ store, catalog }, workspaceId, releaseId),
    envNames: (workspaceId: string, releaseId: string) =>
      agentEnvNames(store, workspaceId, releaseId),
    notRunnableReason: (
      workspaceId: string,
      release: Parameters<typeof releaseNotRunnableReason>[2],
    ) => releaseNotRunnableReason(store, workspaceId, release),
    ...newSessionGitHubReaders(db),
  };
}

/**
 * A session service whose createSession sees the caller as a key of the
 * workspace named by its owner id, as a workspace key is: AUTH_MODE=none
 * names no workspace, and only a workspace's caller names a release. The
 * policy is asked nothing: a key's scopes would come from its stored row.
 */
export function startingInWorkspace<
  S extends { createSession: (caller: Caller, input: never) => unknown },
>(service: S, starter: S): S {
  return {
    ...service,
    createSession: ((caller: Caller, input: never) =>
      starter.createSession(
        asWorkspaceKey(caller),
        input,
      )) as S["createSession"],
  };
}

export function asWorkspaceKey(caller: Caller): Caller {
  const principal = caller.subject.principal;
  return principal
    ? {
        ...caller,
        subject: {
          ...caller.subject,
          principal: { ...principal, workspace_id: caller.ownerId },
        },
      }
    : caller;
}

export const allowingPolicy: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: randomUUID(),
  }),
};
