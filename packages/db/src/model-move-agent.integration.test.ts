import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agentCardRequestSchema, scopesForRole } from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createModelMoveRunner,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresProfileRolloutStore } from "./profile-rollouts.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  installationProfiles,
  memberships,
  memberTeams,
  receipts,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const BASE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-opus-5-1",
  models: ["claude-opus-5-1", "claude-opus-5-0"],
  model_families: {
    "claude-opus-5-0": { family: "opus", rank: 0 },
    "claude-opus-5-1": { family: "opus", rank: 1 },
  },
  title_model: "claude-haiku-5",
  tools: ["Read"],
  permission_mode: "default",
  repository: "optional",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
// The same profile after the old model left its list.
const CUT: CatalogProfile = { ...BASE, models: ["claude-opus-5-1"] };
const CUT_NO_FAMILY: CatalogProfile = {
  ...CUT,
  model_families: {},
};

const catalogOf = (profile: CatalogProfile): SessionCatalog =>
  withSeededInstallation({
    profiles: { op_ops_v1: profile },
    repositories: {
      app: {
        url: "https://example.invalid/app.git",
        branch: "main",
        profiles: ["op_ops_v1"],
        auth: { kind: "github_app", registered: true },
      },
    },
  });

const quiet = { info: () => {}, warn: () => {} };

function card(model: string) {
  return agentCardRequestSchema.parse({
    rules: [{ id: "r1", text: "analyse", source: "user" }],
    model,
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });
}

const definitionOf = (profile: CatalogProfile) => {
  const { provider, ...rest } = profile;
  return { ...rest, provider: { kind: provider.kind } } as Record<
    string,
    unknown
  >;
};

integration("an agent moves to the next model of its series", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "model_move_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresAgentStore(db);

  function service(profile: CatalogProfile): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: store(),
      catalog: catalogOf(profile),
      credentials: createPostgresCredentialBindingStore(db),
      profileLineage: createPostgresProfileRolloutStore(db),
    });
  }

  async function owner(): Promise<Caller> {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    await db
      .insert(installationProfiles)
      .values({
        id: "op_ops_v1",
        name: "ops",
        version: 1,
        origin: "console",
        definition: definitionOf(BASE),
        permissionMode: "default",
        fingerprint: "fp-1",
        repositoryIds: [],
        createdBy: userId,
      })
      .onConflictDoNothing();
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  /** An agent released on `model`, made while the old model was still listed. */
  async function agentOn(caller: Caller, model = "claude-opus-5-0") {
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: caller.ownerId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    const made = await service(BASE).createAgent(caller, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      managing_team_id: teamId,
      card: card(model),
      runtime_profile_id: "op_ops_v1",
      model_source: "fixed",
    });
    return made.agent.id;
  }

  const agentRow = async (agentId: string) =>
    (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const activeModel = async (agentId: string) => {
    const row = await agentRow(agentId);
    const [release] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, row?.activeReleaseId as string));
    return (release?.runtimeConfigSnapshot as { model?: string }).model;
  };
  const cardModels = async (agentId: string) =>
    (
      await db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId))
    ).map((v) => (v.card as { model: string }).model);

  test("a fixed agent gets a model-only card, one release and a receipt that says it was automatic", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    const before = await agentRow(agentId);

    const step = await service(CUT).migrateModel({
      workspaceId: caller.ownerId,
      agentId,
    });
    expect(step).toEqual({
      status: "applied",
      from: "claude-opus-5-0",
      to: "claude-opus-5-1",
    });

    const after = await agentRow(agentId);
    expect(await activeModel(agentId)).toBe("claude-opus-5-1");
    expect((await cardModels(agentId)).sort()).toEqual([
      "claude-opus-5-0",
      "claude-opus-5-1",
    ]);
    expect(after?.activationRevision).toBe(
      (before?.activationRevision as number) + 1,
    );
    // Not a person's change: behavior, source and draft stay as they were.
    expect(after?.behaviorRevision).toBe(before?.behaviorRevision as number);
    expect(after?.modelSource).toBe("fixed");
    expect(after?.draftVersionId).toBeNull();

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(
        sql`${receipts.operation} = 'activate_agent' AND ${receipts.result} -> 'model_migration' IS NOT NULL`,
      );
    expect(receipt?.result).toMatchObject({
      reason: "model_migration",
      model_migration: {
        from: "claude-opus-5-0",
        to: "claude-opus-5-1",
        automatic: true,
      },
    });
  });

  test("a second move changes nothing: the release now runs a listed model", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    await service(CUT).migrateModel({ workspaceId: caller.ownerId, agentId });
    const releases = (
      await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.agentId, agentId))
    ).length;

    expect(
      await service(CUT).migrateModel({ workspaceId: caller.ownerId, agentId }),
    ).toEqual({ status: "skipped" });
    expect(
      await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.agentId, agentId)),
    ).toHaveLength(releases);
  });

  test("a model with no successor stays blocked: nothing is written", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    const before = await agentRow(agentId);

    expect(
      await service(CUT_NO_FAMILY).migrateModel({
        workspaceId: caller.ownerId,
        agentId,
      }),
    ).toEqual({ status: "skipped" });
    expect(await agentRow(agentId)).toEqual(before);
    expect(await cardModels(agentId)).toEqual(["claude-opus-5-0"]);
  });

  test("an agent that opted out is never a candidate, and a move that raced the switch is superseded", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    await db
      .update(agents)
      .set({ autoModelMigration: false })
      .where(eq(agents.id, agentId));

    expect(
      await store().modelMigrationCandidates({ after: null, limit: 10 }),
    ).toEqual([]);
    expect(
      await service(CUT).migrateModel({ workspaceId: caller.ownerId, agentId }),
    ).toEqual({ status: "superseded" });
    expect(await activeModel(agentId)).toBe("claude-opus-5-0");
  });

  test("when the last approver is no longer an owner or admin the agent stays blocked and the move fails", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.workspaceId, caller.ownerId));

    const step = await service(CUT).migrateModel({
      workspaceId: caller.ownerId,
      agentId,
    });
    expect(step.status).toBe("failed");
    expect(await activeModel(agentId)).toBe("claude-opus-5-0");
  });

  test("the runner moves what can move, leaves the rest, and a failure waits before it is tried again", async () => {
    const caller = await owner();
    const moves = await agentOn(caller);
    const listed = await agentOn(caller, "claude-opus-5-1");
    const failedNotices: string[] = [];
    let clock = 0;
    const runner = createModelMoveRunner({
      store: {
        modelMigrationCandidates: (input) =>
          store().modelMigrationCandidates(input),
        notifyModelMigrationFailed: async (input) => {
          failedNotices.push(input.agentId);
          return 0;
        },
      },
      catalog: catalogOf(CUT),
      agents: service(CUT),
      logger: quiet,
      retryMs: 1_000,
      now: () => clock,
    });

    expect(await runner.runOnce()).toBe(1);
    expect(await activeModel(moves)).toBe("claude-opus-5-1");
    expect(await activeModel(listed)).toBe("claude-opus-5-1");
    expect(await runner.runOnce()).toBe(0);

    // A person who loses their rights blocks the next agent; one failure
    // tells once however many passes find it inside the wait.
    const blocked = await agentOn(caller);
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.workspaceId, caller.ownerId));
    await runner.runOnce();
    await runner.runOnce();
    expect(failedNotices).toEqual([blocked]);
    clock = 2_000;
    await runner.runOnce();
    expect(failedNotices).toEqual([blocked, blocked]);
  });
});
