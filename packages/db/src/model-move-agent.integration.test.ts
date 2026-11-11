import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agentCardRequestSchema, scopesForRole } from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createModelMoveRunner,
  type SessionCatalog,
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
import { createPostgresCredentialBindingStore } from "./musterrolle/credential-bindings.ts";
import { createDatabaseIdentityReader } from "./musterrolle/identity-reader.ts";
import * as schema from "./schema.ts";
import {
  agentActivationEvents,
  agentReleases,
  agents,
  agentVersions,
  memberships,
  memberTeams,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import {
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PROVIDER = {
  kind: "litellm" as const,
  endpoint: "https://litellm.invalid",
  auth: {
    kind: "api_key" as const,
    value: "catalog-provider-key",
    ref: { value_env: "PROVIDER_KEY" },
  },
};
const FAMILIES = {
  "claude-opus-5-0": { family: "opus", rank: 0 },
  "claude-opus-5-1": { family: "opus", rank: 1 },
};
type Offer = {
  models: string[];
  model_families: typeof FAMILIES | Record<string, never>;
};
const BASE: Offer = {
  models: ["claude-opus-5-1", "claude-opus-5-0"],
  model_families: FAMILIES,
};
const CUT: Offer = { models: ["claude-opus-5-1"], model_families: FAMILIES };
const CUT_NO_FAMILY: Offer = {
  models: ["claude-opus-5-1"],
  model_families: {},
};

const catalogOf = (offer: Offer): SessionCatalog =>
  testSessionCatalog({
    provider: PROVIDER,
    models: offer.models,
    model_families: offer.model_families,
    repositories: {
      app: {
        url: "https://example.invalid/app.git",
        branch: "main",
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

  function service(offer: Offer): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: store(),
      catalog: catalogOf(offer),
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
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
      connection_id: TEST_CONNECTION_ID,
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

  test("an agent gets a model-only card, one release and a receipt that says it was automatic", async () => {
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
    expect(after?.behaviorRevision).toBe(before?.behaviorRevision as number);
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

  test("the actor is whoever last activated the release, not whoever approved it first", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    const adminId = randomUUID();
    await db.insert(users).values({
      id: adminId,
      email: `${adminId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "admin",
    });
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.workspaceId, caller.ownerId));
    await db
      .insert(memberships)
      .values({ workspaceId: caller.ownerId, userId: adminId, role: "admin" });
    const [first] = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, agentId));
    await db.insert(agentActivationEvents).values({
      ...(first as typeof agentActivationEvents.$inferSelect),
      id: randomUUID(),
      actorUserId: adminId,
      createdAt: new Date(Date.now() + 1_000),
    });

    expect(
      (
        await service(CUT).migrateModel({
          workspaceId: caller.ownerId,
          agentId,
        })
      ).status,
    ).toBe("applied");
    expect(await activeModel(agentId)).toBe("claude-opus-5-1");
  });

  test("a failure notice for a state the agent has left writes nothing", async () => {
    const caller = await owner();
    const agentId = await agentOn(caller);
    const row = await agentRow(agentId);
    const stale = {
      workspaceId: caller.ownerId,
      agentId,
      from: "claude-opus-5-0",
      to: "claude-opus-5-1",
      reason: "actor_inactive",
      releaseId: row?.activeReleaseId as string,
      revision: (row?.activationRevision as number) + 1,
    };

    expect(await store().notifyModelMigrationFailed(stale)).toBe(0);
    expect(
      await store().notifyModelMigrationFailed({
        ...stale,
        revision: row?.activationRevision as number,
        releaseId: "rel_other",
      }),
    ).toBe(0);
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
