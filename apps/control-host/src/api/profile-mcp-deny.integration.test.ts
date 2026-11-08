import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCardRequest,
  agentCardRequestSchema,
  agentCardSchema,
  type CreateInstallationProfileRequest,
  type CreateWorkspaceProfileRequest,
  scopesForRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentReleases,
  agents,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresInstallationProfileStore,
  createPostgresProfileRolloutStore,
  createPostgresWorkspaceProfileStore,
  installationProfiles,
  memberships,
  memberTeams,
  profileRolloutItems,
  profileRollouts,
  users,
  workspaceProfiles,
  workspaces,
} from "@werft-ai/db";
import {
  type Caller,
  type CatalogMcpServer,
  type CatalogProfile,
  callerFor,
  catalogProfile,
  createAgentService,
  createAuthorizationPolicy,
  createInstallationProfileService,
  createProfileRegistry,
  createProfileRolloutRunner,
  createWorkspaceProfileService,
  effectiveMcp,
  mcpDenyOf,
  ProfileFeatureGate,
  profileCatalog,
  resolveReleaseContent,
  resolveSessionCatalog,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  installedDescriptors,
  installedToolCatalogs,
  toolCatalogFor,
} from "@werft-ai/runtime-codecs";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MAIN = {
  kind: "anthropic" as const,
  endpoint: "https://api.anthropic.invalid",
  auth: { kind: "api_key" as const, value_env: "PROVIDER_KEY" },
};
const DOCS = "mcp__docs__read:all";
const SERVER = {
  url: "https://docs.invalid/mcp",
  credential_ref: "docs-key",
  auth: { kind: "bearer" },
  workspaces: ["acme"],
} as unknown as CatalogMcpServer;
const TOOL_CATALOGS = {
  all: installedToolCatalogs,
  for: (kind: string, version: string) =>
    toolCatalogFor(installedToolCatalogs, kind, version),
};

const { tools: _tools, ...CEILING } = {
  name: "ops",
  connection_id: "main",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: [] as string[],
  permission_mode: "default",
} satisfies CreateInstallationProfileRequest;

integration("profile deny naming mcp__ tools, on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "profile_mcp_deny_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  // The production wiring: Postgres stores behind the registry and the catalog
  // the profile and agent services read.
  function wiring() {
    const installations = createPostgresInstallationProfileStore(db);
    const versions = createPostgresWorkspaceProfileStore(db);
    const catalog = profileCatalog(
      {
        repositories: {},
        mcp_servers: { docs: SERVER },
        tool_catalogs: TOOL_CATALOGS,
      },
      createProfileRegistry({
        workspaces: versions,
        installations,
        sources: {
          connections: { main: MAIN },
          allowUnattended: false,
          runtimeSupported: () => true,
          materialize: (id, definition) => {
            const profile = resolveSessionCatalog(
              { profiles: { [id]: definition }, repositories: {} },
              () => "a-provider-key",
            ).profiles[id];
            if (!profile) throw new Error(`no ${id}`);
            return profile as CatalogProfile;
          },
        },
      }),
    );
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    });
    const agentStore = createPostgresAgentStore(db);
    const agentService = createAgentService({
      authorization,
      store: agentStore,
      catalog: catalog as unknown as SessionCatalog,
      credentials: createPostgresCredentialBindingStore(db),
      profileLineage: createPostgresProfileRolloutStore(db),
    });
    return {
      catalog,
      ceilings: createInstallationProfileService({
        authorization,
        store: installations,
        rollouts: { retryFailed: async () => false },
        catalog,
        connections: () => catalog.workspace_profiles.connections,
        allowUnattended: false,
        runtimes: new ProfileFeatureGate(installedDescriptors),
        newId: randomUUID,
      }),
      workspace: createWorkspaceProfileService({
        authorization,
        store: versions,
        catalog,
        newId: randomUUID,
      }),
      agentService,
      runner: () =>
        createProfileRolloutRunner({
          rollouts: createPostgresProfileRolloutStore(db),
          agentStore,
          agents: agentService,
          logger: { info: () => {}, warn: () => {} },
        }),
    };
  }

  async function owner(): Promise<Caller> {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "acme" })
      .onConflictDoNothing();
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, "acme"));
    const id = workspace?.id ?? workspaceId;
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: id, userId, role: "owner" });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: id,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const card = (): AgentCardRequest =>
    agentCardRequestSchema.parse({
      agent_instructions: "analyse",
      model: "claude-sonnet-5",
      capabilities: { tools: null, mcp: null, forbidden: [] },
    });

  test("a deny written through the API is stored, reaches the release as mcp_deny, and queues the agents that follow the profile", async () => {
    const { catalog, ceilings, agentService, runner } = wiring();
    const caller = await owner();
    const v1 = await ceilings.create(caller, {
      ...CEILING,
      name: `ops-${randomUUID().slice(0, 6)}`,
      deny: ["WebSearch"],
    });
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: caller.ownerId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    const made = await agentService.createAgent(caller, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "follower",
      managing_team_id: teamId,
      card: card(),
      runtime_profile_id: v1.profile.id,
      model_source: "profile",
    });

    const v2 = await ceilings.create(caller, {
      ...CEILING,
      name: v1.profile.installation?.name ?? CEILING.name,
      previous_id: v1.profile.id,
      deny: ["WebSearch", DOCS, "mcp__docs__a"],
    });
    expect(v2.profile.mcp_deny).toEqual(["mcp__docs__a", DOCS].sort());
    expect(v2.profile.deny).toEqual(["WebSearch"]);

    const [row] = await db
      .select()
      .from(installationProfiles)
      .where(eq(installationProfiles.id, v2.profile.id));
    expect(row?.deny).toEqual(["WebSearch", "mcp__docs__a", DOCS].sort());

    // The release a follower is moved to carries the names.
    await catalog.workspace_profiles.refresh();
    const profile = catalogProfile(catalog, v2.profile.id);
    if (!profile) throw new Error("the version did not run");
    const content = resolveReleaseContent(
      agentCardSchema.parse({
        role: "r",
        instructions: "i",
        model: "claude-sonnet-5",
        capabilities: { mcp: null, forbidden: [] },
      }),
      v2.profile.id,
      profile,
    );
    if (!content.ok) throw new Error(content.error.message);
    expect(content.content.runtime_config_snapshot.mcp_deny).toEqual(
      ["mcp__docs__a", DOCS].sort(),
    );

    const [rollout] = await db
      .select()
      .from(profileRollouts)
      .where(eq(profileRollouts.targetProfileId, v2.profile.id));
    expect(rollout).toBeDefined();
    const items = await db
      .select()
      .from(profileRolloutItems)
      .where(eq(profileRolloutItems.rolloutId, rollout?.id as string));
    expect(items.map((item) => item.agentId)).toEqual([made.agent.id]);

    // Applying the rollout gives the follower a release that carries the
    // names, and a session of it no longer runs the tool.
    expect(await runner().runOnce()).toEqual({ claimed: 1, settled: 1 });
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, made.agent.id));
    const [active] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, agent?.activeReleaseId as string));
    expect(active?.runtimeProfileId).toBe(v2.profile.id);
    const deny = mcpDenyOf(active?.runtimeConfigSnapshot);
    expect(deny).toEqual(["mcp__docs__a", DOCS].sort());
    expect(
      effectiveMcp({
        start: null,
        row: null,
        release: { server: "docs", tools: [DOCS], deny },
      }).tools,
    ).toEqual([]);

    // The next version leaves the names out of its request and keeps them.
    const v3 = await ceilings.create(caller, {
      ...CEILING,
      name: v1.profile.installation?.name ?? CEILING.name,
      previous_id: v2.profile.id,
      deny: ["WebSearch", "Bash"],
    });
    expect(v3.profile.mcp_deny).toEqual(["mcp__docs__a", DOCS].sort());
  });

  test("a workspace version stores its base's names only when it names them", async () => {
    const { catalog, ceilings, workspace } = wiring();
    const caller = await owner();
    const base = await ceilings.create(caller, {
      ...CEILING,
      name: `base-${randomUUID().slice(0, 6)}`,
      deny: ["WebSearch", DOCS],
    });
    await catalog.workspace_profiles.refresh();
    const version = {
      name: "strict",
      base_profile_id: base.profile.id,
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      permission_mode: "default",
    } satisfies Omit<CreateWorkspaceProfileRequest, "tools">;
    for (const body of [{}, { deny: ["WebSearch"] }]) {
      await expect(
        workspace.create(caller, { ...version, ...body }),
      ).rejects.toMatchObject({
        details: { reason_code: "base_mcp_deny_dropped" },
      });
    }
    const saved = await workspace.create(caller, {
      ...version,
      deny: ["WebSearch", DOCS, "mcp__docs__more"],
    });
    expect(saved.profile.mcp_deny).toEqual([DOCS, "mcp__docs__more"].sort());
    const [stored] = await db
      .select()
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.id, saved.profile.id));
    expect(stored?.deny).toEqual(["WebSearch", DOCS, "mcp__docs__more"].sort());
  });

  test("unblock_mcp_tools lifts a held name for good, and a refused lift writes no row", async () => {
    const { catalog, ceilings, workspace } = wiring();
    const caller = await owner();
    const name = `lift-${randomUUID().slice(0, 6)}`;
    const v1 = await ceilings.create(caller, {
      ...CEILING,
      name,
      deny: ["WebSearch", DOCS, "mcp__docs__a"],
    });
    // Leaving the names out keeps them; only the lift drops one.
    const kept = await ceilings.create(caller, {
      ...CEILING,
      name,
      previous_id: v1.profile.id,
      deny: ["WebSearch"],
    });
    expect(kept.profile.mcp_deny).toEqual(["mcp__docs__a", DOCS].sort());
    const lifted = await ceilings.create(caller, {
      ...CEILING,
      name,
      previous_id: kept.profile.id,
      deny: ["WebSearch"],
      unblock_mcp_tools: [DOCS],
    });
    expect(lifted.profile.mcp_deny).toEqual(["mcp__docs__a"]);
    const [row] = await db
      .select()
      .from(installationProfiles)
      .where(eq(installationProfiles.id, lifted.profile.id));
    expect(row?.deny).toEqual(["WebSearch", "mcp__docs__a"]);
    // The next version keeps the lift: DOCS stays open.
    const after = await ceilings.create(caller, {
      ...CEILING,
      name,
      previous_id: lifted.profile.id,
      deny: ["WebSearch"],
    });
    expect(after.profile.mcp_deny).toEqual(["mcp__docs__a"]);

    // What the lift refuses writes nothing.
    const before = (await db.select().from(installationProfiles)).length;
    for (const [body, reason] of [
      [{ unblock_mcp_tools: [DOCS] }, "mcp_unblock_unknown"],
      [{ unblock_mcp_tools: ["mcp__docs__a"], deny: [DOCS, "mcp__docs__a"] }, "mcp_unblock_conflict"],
    ] as const) {
      await expect(
        ceilings.create(caller, {
          ...CEILING,
          name,
          previous_id: after.profile.id,
          deny: ["WebSearch"],
          ...body,
        }),
      ).rejects.toMatchObject({ details: { reason_code: reason } });
    }
    expect((await db.select().from(installationProfiles)).length).toBe(before);

    // A workspace version cannot lift the base's name, and lifts its own
    // only from the version it read.
    const base = await ceilings.create(caller, {
      ...CEILING,
      name: `wbase-${randomUUID().slice(0, 6)}`,
      deny: ["WebSearch", DOCS],
    });
    await catalog.workspace_profiles.refresh();
    const version = {
      name: "lifting",
      base_profile_id: base.profile.id,
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      permission_mode: "default",
    } satisfies Omit<CreateWorkspaceProfileRequest, "tools">;
    const first = await workspace.create(caller, {
      ...version,
      deny: ["WebSearch", DOCS, "mcp__docs__own"],
    });
    await expect(
      workspace.create(caller, {
        ...version,
        deny: ["WebSearch", DOCS],
        previous_id: first.profile.id,
        unblock_mcp_tools: [DOCS],
      }),
    ).rejects.toMatchObject({
      details: { reason_code: "base_mcp_deny_dropped" },
    });
    const second = await workspace.create(caller, {
      ...version,
      deny: ["WebSearch", DOCS],
      previous_id: first.profile.id,
      unblock_mcp_tools: ["mcp__docs__own"],
    });
    expect(second.profile.mcp_deny).toEqual([DOCS]);
    const [stored] = await db
      .select()
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.id, second.profile.id));
    expect(stored?.deny).toEqual(["WebSearch", DOCS]);
    // A second editor still holding the first version is told so.
    await expect(
      workspace.create(caller, {
        ...version,
        deny: ["WebSearch", DOCS],
        previous_id: first.profile.id,
        unblock_mcp_tools: ["mcp__docs__own"],
      }),
    ).rejects.toMatchObject({ details: { reason_code: "stale_previous" } });
  });

  test("a refused name writes no row", async () => {
    const { ceilings } = wiring();
    const caller = await owner();
    const name = `refused-${randomUUID().slice(0, 6)}`;
    for (const [bad, reason] of [
      ["mcp__github__get_file", "github_server"],
      ["mcp__nowhere__read", "unknown_mcp_server"],
      ["mcp__docs__read all", "mcp_tool_name"],
    ] as const) {
      await expect(
        ceilings.create(caller, { ...CEILING, name, deny: [bad] }),
      ).rejects.toMatchObject({ details: { reason_code: reason } });
    }
    const rows = await db.select().from(installationProfiles);
    expect(rows.filter((row) => row.name === name)).toEqual([]);
  });
});
