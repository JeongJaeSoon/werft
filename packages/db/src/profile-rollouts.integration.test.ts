import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCardRequest,
  agentCardRequestSchema,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createProfileRolloutRunner,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import { createPostgresProfileRolloutStore } from "./profile-rollouts.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  installationProfiles,
  memberships,
  memberTeams,
  profileFill,
  profileRolloutItems,
  profileRollouts,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const V1: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  title_model: "claude-haiku-5",
  tools: ["Read", "Grep", "Edit"],
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
const V2: CatalogProfile = {
  ...V1,
  model: "claude-opus-5",
  models: ["claude-opus-5", "claude-sonnet-5"],
  tools: ["Read", "Grep", "Edit", "Write"],
};
const V3: CatalogProfile = {
  ...V2,
  models: ["claude-sonnet-5", "claude-opus-5"],
};
const V4: CatalogProfile = {
  ...V2,
  model: "claude-opus-5",
  models: ["claude-opus-5"],
  tools: ["Read", "Grep"],
};
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: {
    op_ops_v1: V1,
    op_ops_v2: V2,
    op_ops_v3: V3,
    op_ops_v4: V4,
    op_other_v1: V1,
  },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: [
        "op_ops_v1",
        "op_ops_v2",
        "op_ops_v3",
        "op_ops_v4",
        "op_other_v1",
      ],
      auth: { kind: "github_app", registered: true },
    },
  },
});

const quiet = { info: () => {}, warn: () => {} };

const snapshotModel = (
  release: { runtimeConfigSnapshot: unknown } | undefined,
) => (release?.runtimeConfigSnapshot as { model?: string } | undefined)?.model;

function card(instructions: string, model = "claude-sonnet-5") {
  return agentCardRequestSchema.parse({
    agent_instructions: instructions,
    model,
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });
}

/** The stored form of a catalog profile: the part a rollout compares. */
const definitionOf = (profile: CatalogProfile) => {
  const { provider, ...rest } = profile;
  return { ...rest, provider: { kind: provider.kind } } as Record<
    string,
    unknown
  >;
};

integration("profile rollouts on PostgreSQL (U3b reader)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "profile_rollout_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresAgentStore(db);
  const rollouts = () => createPostgresProfileRolloutStore(db);

  function service(): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: store(),
      catalog: CATALOG,
      credentials: createPostgresCredentialBindingStore(db),
      profileLineage: rollouts(),
    });
  }

  function runner(options: { sweep?: boolean; leaseMs?: number } = {}) {
    return createProfileRolloutRunner({
      rollouts: rollouts(),
      agentStore: store(),
      agents: service(),
      logger: quiet,
      ...options,
    });
  }

  const userOf = (caller: Caller) => caller.actor?.userId as string;

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

  async function lineage(
    caller: Caller,
    versions: [number, CatalogProfile][] = [
      [1, V1],
      [2, V2],
    ],
  ) {
    for (const [version, profile] of versions) {
      await db
        .insert(installationProfiles)
        .values({
          id: `op_ops_v${version}`,
          name: "ops",
          version,
          origin: "console",
          definition: definitionOf(profile),
          permissionMode: "default",
          fingerprint: `fp-${version}`,
          repositoryIds: [],
          createdBy: userOf(caller),
        })
        .onConflictDoNothing();
    }
  }

  async function follower(
    caller: Caller,
    options: {
      card?: AgentCardRequest;
      model_source?: "fixed" | "profile";
      profile?: string;
    } = {},
  ) {
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: caller.ownerId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    return service().createAgent(caller, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      managing_team_id: teamId,
      card: options.card ?? card("v1"),
      runtime_profile_id: options.profile ?? "op_ops_v1",
      model_source: options.model_source ?? "profile",
    });
  }

  /** A rollout of op_ops_v2 with one pending item per agent (the writer's job). */
  async function rolloutOf(
    caller: Caller,
    agentIds: string[],
    target = "op_ops_v2",
  ) {
    const rolloutId = randomUUID();
    await db.insert(profileRollouts).values({
      id: rolloutId,
      kind: "profile_update",
      targetProfileId: target,
      createdBy: userOf(caller),
    });
    for (const agentId of agentIds) {
      const [agent] = await db
        .select({ revision: agents.activationRevision })
        .from(agents)
        .where(eq(agents.id, agentId));
      await db.insert(profileRolloutItems).values({
        rolloutId,
        agentId,
        generation: agent?.revision as number,
      });
    }
    return rolloutId;
  }

  const items = (rolloutId: string) =>
    db
      .select()
      .from(profileRolloutItems)
      .where(eq(profileRolloutItems.rolloutId, rolloutId));
  const releasesOf = (agentId: string) =>
    db.select().from(agentReleases).where(eq(agentReleases.agentId, agentId));
  const agentRow = async (agentId: string) =>
    (await db.select().from(agents).where(eq(agents.id, agentId)))[0];

  test("a following agent gets one release on the newest version; a second run changes nothing", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    const rolloutId = await rolloutOf(caller, [made.agent.id]);
    const before = await agentRow(made.agent.id);

    expect(await runner().runOnce()).toEqual({ claimed: 1, settled: 1 });
    const after = await agentRow(made.agent.id);
    const releases = await releasesOf(made.agent.id);
    expect(releases).toHaveLength(2);
    const active = releases.find((r) => r.id === after?.activeReleaseId);
    expect(active?.runtimeProfileId).toBe("op_ops_v2");
    expect(snapshotModel(active)).toBe("claude-opus-5");
    expect(after?.activationRevision).toBe(
      (before?.activationRevision as number) + 1,
    );
    expect(after?.behaviorRevision).toBe(before?.behaviorRevision as number);
    expect(after?.draftVersionId).toBeNull();
    expect((await items(rolloutId))[0]?.status).toBe("applied");

    expect(await runner().runOnce()).toEqual({ claimed: 0, settled: 0 });
    expect(await releasesOf(made.agent.id)).toHaveLength(2);
  });

  test("an agent that follows its profile's model gets a model-only card version; a fixed one keeps its card", async () => {
    const caller = await owner();
    await lineage(caller);
    const following = await follower(caller, { model_source: "profile" });
    const fixed = await follower(caller, {
      card: card("v1", "claude-sonnet-5"),
      model_source: "fixed",
    });
    await rolloutOf(caller, [following.agent.id, fixed.agent.id]);
    await runner().runOnce();

    const cardsOf = async (agentId: string) =>
      (
        await db
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agentId))
      ).map((v) => (v.card as { model: string }).model);
    expect(await cardsOf(following.agent.id)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    expect(await cardsOf(fixed.agent.id)).toEqual(["claude-sonnet-5"]);
    const runs = async (agentId: string) => {
      const row = await agentRow(agentId);
      return (await releasesOf(agentId)).find(
        (r) => r.id === row?.activeReleaseId,
      );
    };
    expect(snapshotModel(await runs(following.agent.id))).toBe("claude-opus-5");
    expect(snapshotModel(await runs(fixed.agent.id))).toBe("claude-sonnet-5");
    expect((await runs(fixed.agent.id))?.runtimeProfileId).toBe("op_ops_v2");
  });

  test("a pinned agent is left alone and its item ends superseded", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    await db
      .update(agents)
      .set({ profileTracking: "pinned" })
      .where(eq(agents.id, made.agent.id));
    const rolloutId = await rolloutOf(caller, [made.agent.id]);
    await runner().runOnce();
    expect(await releasesOf(made.agent.id)).toHaveLength(1);
    expect((await items(rolloutId))[0]?.status).toBe("superseded");
  });

  test("an agent already on the same execution form gets no release", async () => {
    const caller = await owner();
    await lineage(caller, [
      [2, V2],
      [3, V3],
    ]);
    const made = await follower(caller, { profile: "op_ops_v2" });
    const rolloutId = await rolloutOf(caller, [made.agent.id], "op_ops_v3");
    await runner().runOnce();
    expect(await releasesOf(made.agent.id)).toHaveLength(1);
    expect((await items(rolloutId))[0]?.status).toBe("applied");
  });

  test("two replicas at once apply an item once", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await Promise.all(
      Array.from({ length: 6 }, () => follower(caller)),
    );
    const rolloutId = await rolloutOf(
      caller,
      made.map((m) => m.agent.id),
    );
    await Promise.all([
      runner().runOnce(),
      runner().runOnce(),
      runner().runOnce(),
    ]);
    const done = await items(rolloutId);
    expect(done.map((i) => i.status)).toEqual(Array(6).fill("applied"));
    for (const m of made) {
      expect(await releasesOf(m.agent.id)).toHaveLength(2);
    }
  });

  test("a lease the holder lost writes nothing, and another replica takes the item over", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    const rolloutId = await rolloutOf(caller, [made.agent.id]);
    const gone = await rollouts().claim({ leaseMs: 60, limit: 5 });
    expect(gone).toHaveLength(1);
    expect(await rollouts().claim({ leaseMs: 60, limit: 5 })).toHaveLength(0);
    await Bun.sleep(120);
    const [taker] = await rollouts().claim({ leaseMs: 60_000, limit: 5 });
    expect(taker?.claim).not.toBe(gone[0]?.claim);
    expect(
      await rollouts().settle(gone[0] as NonNullable<(typeof gone)[0]>, {
        status: "failed",
        reasonCode: "late",
      }),
    ).toBe(false);
    expect((await items(rolloutId))[0]).toMatchObject({
      status: "pending",
      lockedBy: taker?.claim,
    });
    await rollouts().abandon([taker as NonNullable<typeof taker>]);
    expect(await runner().runOnce()).toEqual({ claimed: 1, settled: 1 });
    expect((await items(rolloutId))[0]?.status).toBe("applied");
    const [stale] = gone;
    expect(
      await rollouts().settle(stale as NonNullable<typeof stale>, {
        status: "failed",
        reasonCode: "late",
      }),
    ).toBe(false);
    expect((await items(rolloutId))[0]?.status).toBe("applied");
    expect(await releasesOf(made.agent.id)).toHaveLength(2);
  });

  test("a stopping replica gives its unfinished items back at once", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await Promise.all([follower(caller), follower(caller)]);
    const rolloutId = await rolloutOf(
      caller,
      made.map((m) => m.agent.id),
    );
    expect(await runner().runOnce(() => true)).toEqual({
      claimed: 2,
      settled: 0,
    });
    const freed = await items(rolloutId);
    expect(
      freed.every((i) => i.lockedBy === null && i.status === "pending"),
    ).toBe(true);
    expect(await runner().runOnce()).toEqual({ claimed: 2, settled: 2 });
  });

  test("giving items back leaves the attempt of an item that was tried", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await Promise.all([follower(caller), follower(caller)]);
    const rolloutId = await rolloutOf(
      caller,
      made.map((m) => m.agent.id),
    );
    const held = await rollouts().claim({ leaseMs: 60_000, limit: 5 });
    expect(held).toHaveLength(2);
    expect(await rollouts().abandon(held.slice(1))).toBe(1);
    const byAgent = new Map(
      (await items(rolloutId)).map((i) => [i.agentId, i]),
    );
    expect(byAgent.get(held[0]?.agentId as string)).toMatchObject({
      attempts: 1,
      lockedBy: held[0]?.claim,
    });
    expect(byAgent.get(held[1]?.agentId as string)).toMatchObject({
      attempts: 0,
      lockedBy: null,
    });
  });

  test("a failed item is not tried again until a person retries it", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    const rolloutId = await rolloutOf(caller, [made.agent.id]);
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(
        and(
          eq(memberships.workspaceId, caller.ownerId),
          eq(memberships.userId, userOf(caller)),
        ),
      );
    await runner().runOnce();
    const [failed] = await items(rolloutId);
    expect(failed).toMatchObject({
      status: "failed",
      reasonCode: "actor_inactive",
    });
    expect(await releasesOf(made.agent.id)).toHaveLength(1);

    expect(await runner({ sweep: false }).runOnce()).toEqual({
      claimed: 0,
      settled: 0,
    });

    await db
      .update(memberships)
      .set({ role: "owner" })
      .where(eq(memberships.userId, userOf(caller)));
    const ref = {
      rolloutId,
      agentId: made.agent.id,
      generation: failed?.generation as number,
    };
    expect(await rollouts().retry(ref)).toBe(true);
    expect(await rollouts().retry(ref)).toBe(false);
    await runner().runOnce();
    expect((await items(rolloutId))[0]?.status).toBe("applied");
    expect(await releasesOf(made.agent.id)).toHaveLength(2);
  });

  test("an item claimed over and over without a result is failed, not retried for ever", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    const rolloutId = await rolloutOf(caller, [made.agent.id]);
    for (let i = 0; i < 5; i++) {
      expect(await rollouts().claim({ leaseMs: 1, limit: 1 })).toHaveLength(1);
      await Bun.sleep(5);
    }
    expect(await rollouts().claim({ leaseMs: 1_000, limit: 1 })).toHaveLength(
      0,
    );
    expect((await items(rolloutId))[0]).toMatchObject({
      status: "failed",
      reasonCode: "retries_exhausted",
    });
  });

  test("a rollout activation is superseded when the agent stopped following", async () => {
    const caller = await owner();
    await lineage(caller);
    const made = await follower(caller);
    await db
      .update(agents)
      .set({ profileTracking: "pinned" })
      .where(eq(agents.id, made.agent.id));
    const outcome = await service().rolloutRelease({
      workspaceId: caller.ownerId,
      agentId: made.agent.id,
      actorUserId: userOf(caller),
      targetProfileId: "op_ops_v2",
    });
    expect(outcome.status).toBe("superseded");
    const row = await agentRow(made.agent.id);
    expect(row?.activeReleaseId).toBe(made.agent.active_release_id);
    expect(row?.activationRevision).toBe(made.agent.activation_revision);
  });

  test("a rollout activation is superseded when the agent moved to another profile", async () => {
    const caller = await owner();
    await lineage(caller);
    await db.insert(installationProfiles).values({
      id: "op_other_v1",
      name: "other",
      version: 1,
      origin: "console",
      definition: definitionOf(V1),
      permissionMode: "default",
      fingerprint: "fp-other",
      repositoryIds: [],
      createdBy: userOf(caller),
    });
    const made = await follower(caller, { profile: "op_other_v1" });
    const outcome = await service().rolloutRelease({
      workspaceId: caller.ownerId,
      agentId: made.agent.id,
      actorUserId: userOf(caller),
      targetProfileId: "op_ops_v2",
    });
    expect(outcome.status).toBe("superseded");
    const row = await agentRow(made.agent.id);
    expect(row?.activeReleaseId).toBe(made.agent.active_release_id);
    expect(row?.activationRevision).toBe(made.agent.activation_revision);
  });

  test("going back to a release on an older form stops following; the same form keeps it", async () => {
    const caller = await owner();
    await lineage(caller, [
      [1, V1],
      [2, V2],
      [3, V3],
    ]);
    const old = await follower(caller);
    const sameForm = await follower(caller, { profile: "op_ops_v2" });
    const oldRelease = old.agent.active_release_id as string;
    const v2Release = sameForm.agent.active_release_id as string;
    for (const made of [old, sameForm]) {
      const moved = await service().updateAgent(caller, made.agent.id, {
        runtime_profile_id: "op_ops_v3",
      });
      expect(moved.release.status).toBe("applied");
    }
    const back = async (agentId: string, releaseId: string) => {
      const row = await agentRow(agentId);
      await service().activateAgent(caller, agentId, {
        release_id: releaseId,
        expected_revision: row?.activationRevision as number,
      });
      return agentRow(agentId);
    };
    expect((await back(old.agent.id, oldRelease))?.profileTracking).toBe(
      "pinned",
    );
    expect((await back(sameForm.agent.id, v2Release))?.profileTracking).toBe(
      "follow",
    );
  });

  describe("the sweep", () => {
    /** A rollout of the first version, no items: the writer has been open before. */
    async function writerOpened(caller: Caller) {
      await db.insert(profileRollouts).values({
        id: randomUUID(),
        kind: "profile_update",
        targetProfileId: "op_ops_v1",
        createdBy: userOf(caller),
      });
    }

    test("holds back, writing nothing, while no rollout was ever written and agents are behind; the fill then runs and the sweep finds nothing", async () => {
      const caller = await owner();
      await lineage(caller);
      const behind = await follower(caller);

      expect(await rollouts().sweep()).toEqual({
        rollouts: 0,
        items: 0,
        held: 1,
      });
      expect(await db.select().from(profileRollouts)).toEqual([]);
      expect(await db.select().from(profileRolloutItems)).toEqual([]);

      const filled = await rollouts().backfill({ dryRun: false });
      expect("refused" in filled).toBe(false);
      expect((await agentRow(behind.agent.id))?.profileTracking).toBe("pinned");
      expect(await rollouts().sweep()).toEqual({ rollouts: 0, items: 0 });
    });

    test("after a real fill, an agent created later on an old version is swept, not held; a dry run does not count as the fill", async () => {
      const caller = await owner();
      await lineage(caller);
      await follower(caller);

      await rollouts().backfill({ dryRun: true });
      expect(await db.select().from(profileFill)).toEqual([]);
      expect(await rollouts().sweep()).toMatchObject({ held: 1 });

      await rollouts().backfill({ dryRun: false });
      expect(await db.select().from(profileFill)).toHaveLength(1);

      const late = await follower(caller);
      const swept = await rollouts().sweep();
      expect(swept).toMatchObject({ rollouts: 1, items: 1 });
      expect("held" in swept).toBe(false);
      expect(
        await db
          .select()
          .from(profileRolloutItems)
          .where(eq(profileRolloutItems.agentId, late.agent.id)),
      ).toHaveLength(1);
      // The fill is one-time: once recorded, a run reports and writes nothing,
      // so an agent that came after it is never pinned by a repeat.
      const another = await follower(caller);
      expect(await rollouts().backfill({ dryRun: false })).toEqual({
        dryRun: false,
        pinned: [],
        modelFollowsProfile: [],
      });
      expect((await agentRow(another.agent.id))?.profileTracking).toBe(
        "follow",
      );
    });

    test("an install filled by the earlier code has no marker: its agents are held until the fill is run once more, which records it and a repeat reports nothing", async () => {
      const caller = await owner();
      await lineage(caller);
      const filledBefore = await follower(caller);
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, filledBefore.agent.id));
      await follower(caller);

      expect(await rollouts().sweep()).toMatchObject({ held: 1 });
      const again = await rollouts().backfill({ dryRun: false });
      if ("refused" in again) throw new Error("refused");
      expect(again.pinned).toHaveLength(1);
      expect(await db.select().from(profileFill)).toHaveLength(1);
      expect(await rollouts().backfill({ dryRun: false })).toMatchObject({
        pinned: [],
      });
    });

    test("a rollout of another lineage does not open this one: its behind agents stay held and the fill can still run", async () => {
      const caller = await owner();
      await lineage(caller);
      const behind = await follower(caller);
      await db.insert(installationProfiles).values({
        id: "op_other_v1",
        name: "other",
        version: 1,
        origin: "console",
        definition: definitionOf(V1),
        permissionMode: "default",
        fingerprint: "fp-other-1",
        repositoryIds: [],
        createdBy: userOf(caller),
      });
      await db.insert(profileRollouts).values({
        id: randomUUID(),
        kind: "profile_update",
        targetProfileId: "op_other_v1",
        createdBy: userOf(caller),
      });

      expect(await rollouts().sweep()).toEqual({
        rollouts: 0,
        items: 0,
        held: 1,
      });
      expect(await db.select().from(profileRolloutItems)).toEqual([]);

      const filled = await rollouts().backfill({ dryRun: false });
      if ("refused" in filled) throw new Error("fill refused");
      expect(filled.pinned).toEqual([behind.agent.id]);
      expect(await db.select().from(profileFill)).toHaveLength(1);
    });

    test("a lineage with a rollout and a failed item does not block the fill of a lineage without one", async () => {
      const caller = await owner();
      await lineage(caller);
      await db.insert(installationProfiles).values(
        [1, 2].map((version) => ({
          id: `op_other_v${version}`,
          name: "other",
          version,
          origin: "console" as const,
          definition: definitionOf(version === 1 ? V1 : V2),
          permissionMode: "default" as const,
          fingerprint: `fp-other-${version}`,
          repositoryIds: [],
          createdBy: userOf(caller),
        })),
      );
      const waiting = await follower(caller, { profile: "op_other_v1" });
      const failed = await follower(caller);
      // Fixed on its profile's own model, so a model fill would take it.
      const fixed = await follower(caller, {
        profile: "op_ops_v2",
        card: card("v1", "claude-opus-5"),
        model_source: "fixed",
      });
      const rolloutId = randomUUID();
      await db.insert(profileRollouts).values({
        id: rolloutId,
        kind: "profile_update",
        targetProfileId: "op_ops_v2",
        createdBy: userOf(caller),
      });
      await db.insert(profileRolloutItems).values({
        rolloutId,
        agentId: failed.agent.id,
        generation: 0,
        status: "failed",
        reasonCode: "release_refused",
      });

      expect(await rollouts().sweep()).toEqual({
        rollouts: 0,
        items: 0,
        held: 1,
      });
      const dry = await rollouts().backfill({ dryRun: true });
      const filled = await rollouts().backfill({ dryRun: false });
      if ("refused" in dry || "refused" in filled)
        throw new Error("fill refused");
      expect(filled.pinned).toEqual([waiting.agent.id]);
      expect(filled).toEqual({ ...dry, dryRun: false });
      expect(filled.modelFollowsProfile).not.toContain(fixed.agent.id);
      expect((await agentRow(fixed.agent.id))?.modelSource).toBe("fixed");
      expect((await agentRow(failed.agent.id))?.profileTracking).toBe("follow");
      expect(await db.select().from(profileFill)).toHaveLength(1);
    });

    test("with nobody behind, an empty outbox is nothing to hold back", async () => {
      const caller = await owner();
      await lineage(caller);
      await follower(caller, { profile: "op_ops_v2" });
      expect(await rollouts().sweep()).toEqual({ rollouts: 0, items: 0 });
    });

    test("puts in the agents the insert-time write missed, once, and a failed item stays failed", async () => {
      const caller = await owner();
      await lineage(caller);
      await writerOpened(caller);
      const behind = await follower(caller);
      const pinned = await follower(caller);
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, pinned.agent.id));
      const current = await follower(caller, { profile: "op_ops_v2" });

      const first = await rollouts().sweep();
      expect(first.items).toBeGreaterThanOrEqual(1);
      const mine = await db
        .select()
        .from(profileRolloutItems)
        .where(eq(profileRolloutItems.agentId, behind.agent.id));
      expect(mine).toHaveLength(1);
      expect(
        await db
          .select()
          .from(profileRolloutItems)
          .where(eq(profileRolloutItems.agentId, pinned.agent.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(profileRolloutItems)
          .where(eq(profileRolloutItems.agentId, current.agent.id)),
      ).toHaveLength(0);
      const [rolloutRow] = await db
        .select()
        .from(profileRollouts)
        .where(eq(profileRollouts.id, mine[0]?.rolloutId as string));
      expect(rolloutRow).toMatchObject({
        kind: "profile_update",
        targetProfileId: "op_ops_v2",
        createdBy: userOf(caller),
      });

      expect(await rollouts().sweep()).toEqual({ rollouts: 0, items: 0 });

      await db
        .update(profileRolloutItems)
        .set({ status: "failed", reasonCode: "release_refused" })
        .where(eq(profileRolloutItems.agentId, behind.agent.id));
      expect(await rollouts().sweep()).toEqual({ rollouts: 0, items: 0 });
    });

    test("a person's change of the active release opens a new generation; a new behavior opens a new rollout", async () => {
      const caller = await owner();
      await lineage(caller, [
        [1, V1],
        [2, V2],
      ]);
      await writerOpened(caller);
      const made = await follower(caller);
      await rollouts().sweep();
      await db
        .update(profileRolloutItems)
        .set({ status: "failed", reasonCode: "release_refused" })
        .where(eq(profileRolloutItems.agentId, made.agent.id));
      await lineage(caller, [
        [3, V3],
        [4, V4],
      ]);
      const swept = await rollouts().sweep();
      expect(swept.rollouts).toBe(1);
      const mine = await db
        .select()
        .from(profileRolloutItems)
        .where(eq(profileRolloutItems.agentId, made.agent.id));
      expect(mine).toHaveLength(2);
      const targets = await db.select().from(profileRollouts);
      expect(
        targets.filter((r) => r.targetProfileId === "op_ops_v4"),
      ).toHaveLength(1);
    });

    test("sweeping writes nothing for a lineage whose agents already run the newest form", async () => {
      const caller = await owner();
      await lineage(caller);
      await follower(caller, { profile: "op_ops_v2" });
      const before = (await db.select().from(profileRollouts)).length;
      await rollouts().sweep();
      expect(
        (await db.select().from(profileRollouts)).length,
      ).toBeGreaterThanOrEqual(before);
    });
  });

  describe("the one-time fill", () => {
    test("reports what it would do, does it, and finds nothing the second time", async () => {
      const caller = await owner();
      await lineage(caller);
      const behind = await follower(caller, { model_source: "fixed" });
      const upToDate = await follower(caller, {
        profile: "op_ops_v2",
        card: card("v1", "claude-opus-5"),
        model_source: "fixed",
      });

      const dry = await rollouts().backfill({ dryRun: true });
      expect(dry).toMatchObject({ dryRun: true });
      if ("refused" in dry) throw new Error("dry run refused");
      expect(dry.pinned).toContain(behind.agent.id);
      expect(dry.pinned).not.toContain(upToDate.agent.id);
      expect(dry.modelFollowsProfile).toContain(behind.agent.id);
      expect(dry.modelFollowsProfile).toContain(upToDate.agent.id);
      expect((await agentRow(behind.agent.id))?.profileTracking).toBe("follow");
      expect((await agentRow(behind.agent.id))?.modelSource).toBe("fixed");

      const real = await rollouts().backfill({ dryRun: false });
      if ("refused" in real) throw new Error("real run refused");
      expect(real.pinned).toEqual(dry.pinned);
      expect((await agentRow(behind.agent.id))?.profileTracking).toBe("pinned");
      expect((await agentRow(behind.agent.id))?.modelSource).toBe("profile");
      expect((await agentRow(upToDate.agent.id))?.profileTracking).toBe(
        "follow",
      );

      const again = await rollouts().backfill({ dryRun: true });
      if ("refused" in again) throw new Error("dry run refused");
      expect(again.pinned).toEqual([]);
      expect(again.modelFollowsProfile).toEqual([]);
    });

    test("a real run is refused when the only agents behind are in a lineage that has a rollout", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      await rolloutOf(caller, [made.agent.id]);
      expect(await rollouts().backfill({ dryRun: false })).toEqual({
        refused: "rollouts_exist",
      });
      expect(await rollouts().backfill({ dryRun: true })).toMatchObject({
        dryRun: true,
      });
    });
  });

  describe("the insert-time write (the writer)", () => {
    /** A console save of `profile` as the next version of `ops`. */
    async function save(
      caller: Caller,
      profile: CatalogProfile,
      previousId: string,
      fingerprint: string,
    ) {
      return createPostgresInstallationProfileStore(db).create({
        actor: {
          principal: caller,
          workspaceId: caller.ownerId,
          userId: userOf(caller),
        },
        receiptId: randomUUID(),
        name: "ops",
        scope: { kind: "installation" },
        previousId,
        definition: definitionOf(profile),
        permission_mode: "default",
        fingerprint,
        deny: null,
        toolCatalogId: null,
        connectionId: "main",
      });
    }
    const rolloutsOf = () => db.select().from(profileRollouts);

    test("a changed form puts in the following agents behind it, not a pinned one, and the consumer applies them", async () => {
      const caller = await owner();
      await lineage(caller, [
        [1, V1],
        [2, V2],
        [3, V3],
      ]);
      const onV1 = await follower(caller);
      const onV2 = await follower(caller, { profile: "op_ops_v2" });
      const onV3 = await follower(caller, { profile: "op_ops_v3" });
      const pinned = await follower(caller, { profile: "op_ops_v2" });
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, pinned.agent.id));

      const made = await save(caller, V4, "op_ops_v3", "fp-4");
      expect(made.outcome).toBe("created");
      const [rollout] = await rolloutsOf();
      expect(rollout).toMatchObject({
        kind: "profile_update",
        targetProfileId: "op_ops_v4",
        createdBy: userOf(caller),
      });
      const queued = await items(rollout?.id as string);
      expect(queued.map((i) => i.agentId).sort()).toEqual(
        [onV1, onV2, onV3].map((m) => m.agent.id).sort(),
      );
      expect(queued.every((i) => i.status === "pending")).toBe(true);
      for (const item of queued) {
        expect(item.generation).toBe(
          (await agentRow(item.agentId))?.activationRevision as number,
        );
      }

      expect(await runner().runOnce()).toEqual({ claimed: 3, settled: 3 });
      expect(
        (await items(rollout?.id as string)).every(
          (i) => i.status === "applied",
        ),
      ).toBe(true);
      expect(await releasesOf(pinned.agent.id)).toHaveLength(1);
      expect((await agentRow(onV1.agent.id))?.activeReleaseId).not.toBe(
        onV1.agent.active_release_id,
      );
    });

    test("the same form writes no row and no rollout", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller, { profile: "op_ops_v2" });
      const same = await save(caller, V3, "op_ops_v2", "fp-3");
      expect(same.outcome).toBe("unchanged");
      expect(await rolloutsOf()).toEqual([]);

      await save(caller, V4, "op_ops_v2", "fp-4");
      const [rollout] = await rolloutsOf();
      // V3 was never written, so the next version took its number.
      expect(rollout?.targetProfileId).toBe("op_ops_v3");
      expect(await items(rollout?.id as string)).toHaveLength(1);
      expect(made.agent.id).toBeTruthy();

      const alone = await owner();
      await lineage(alone, [[1, V1]]);
      await db.delete(profileRolloutItems);
      await db.delete(profileRollouts);
      expect((await rolloutsOf()).length).toBe(0);
    });

    test("a newer rollout closes the waiting items of the older one and takes the agents", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      await save(caller, V4, "op_ops_v2", "fp-3");
      const [first] = await rolloutsOf();
      expect((await items(first?.id as string))[0]?.status).toBe("pending");

      const next: CatalogProfile = { ...V1, tools: ["Read"] };
      await save(caller, next, "op_ops_v3", "fp-4");
      const second = (await rolloutsOf()).find((r) => r.id !== first?.id);
      expect((await items(first?.id as string))[0]?.status).toBe("superseded");
      const queued = await items(second?.id as string);
      expect(queued.map((i) => [i.agentId, i.status])).toEqual([
        [made.agent.id, "pending"],
      ]);
    });
  });

  describe("what the screens read", () => {
    test("counts per version, the failed agents, the agents a default-model change misses, and one agent's open step", async () => {
      const caller = await owner();
      await lineage(caller);
      const applied = await follower(caller);
      const failed = await follower(caller, {
        card: card("v1", "claude-sonnet-5"),
        model_source: "fixed",
      });
      const waiting = await follower(caller);
      const rolloutId = await rolloutOf(caller, [
        applied.agent.id,
        failed.agent.id,
        waiting.agent.id,
      ]);
      await db
        .update(profileRolloutItems)
        .set({ status: "applied" })
        .where(eq(profileRolloutItems.agentId, applied.agent.id));
      await db
        .update(profileRolloutItems)
        .set({ status: "failed", reasonCode: "credential_unbound" })
        .where(eq(profileRolloutItems.agentId, failed.agent.id));

      const summary = (await rollouts().summaries(caller.ownerId)).get(
        "op_ops_v2",
      );
      expect(summary).toEqual({
        total: 3,
        applied: 1,
        pending: 1,
        failed: 1,
        failed_agents: [
          {
            agent_id: failed.agent.id,
            name: "재무 분석가",
            reason: "credential_unbound",
          },
        ],
        fixed_model_agents: 1,
      });
      const other = await owner();
      expect((await rollouts().summaries(other.ownerId)).size).toBe(0);

      const detail = await store().get(caller.ownerId, failed.agent.id);
      expect(detail?.profile_tracking).toBe("follow");
      expect(detail?.profile_rollout).toEqual({
        status: "failed",
        reason: "credential_unbound",
        target_profile_id: "op_ops_v2",
      });
      expect(
        (await store().get(caller.ownerId, applied.agent.id))?.profile_rollout,
      ).toBeNull();

      const ask = (workspaceId: string) => ({
        workspaceId,
        targetProfileId: "op_ops_v2",
        agentId: failed.agent.id,
      });
      expect(await rollouts().retryFailed(ask(other.ownerId))).toBe(false);
      expect(await rollouts().retryFailed(ask(caller.ownerId))).toBe(true);
      expect(await rollouts().retryFailed(ask(caller.ownerId))).toBe(false);
      expect(
        (await items(rolloutId)).find((i) => i.agentId === failed.agent.id),
      ).toMatchObject({ status: "pending", reasonCode: null, attempts: 0 });
    });
  });

  describe("bringing an agent to the newest version by hand", () => {
    test("a pinned agent runs the newest version and follows again", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, made.agent.id));

      const saved = await service().updateAgent(caller, made.agent.id, {
        follow_latest_profile: true,
      });
      expect(saved.release.status).toBe("applied");
      const row = await agentRow(made.agent.id);
      expect(row?.profileTracking).toBe("follow");
      const active = (await releasesOf(made.agent.id)).find(
        (r) => r.id === row?.activeReleaseId,
      );
      expect(active?.runtimeProfileId).toBe("op_ops_v2");
      expect(saved.profile_tracking).toBe("follow");
    });

    test("an agent already on the newest version only starts following again, with no release", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller, { profile: "op_ops_v2" });
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, made.agent.id));
      const saved = await service().updateAgent(caller, made.agent.id, {
        follow_latest_profile: true,
      });
      expect(saved.release.status).toBe("unchanged");
      expect((await agentRow(made.agent.id))?.profileTracking).toBe("follow");
      expect(await releasesOf(made.agent.id)).toHaveLength(1);
    });

    test("a waiting draft, with its profile and failure, is left as it was", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      const kept = await service().updateAgent(caller, made.agent.id, {
        card: card("v2"),
        runtime_profile_id: "op_missing_v1",
      });
      expect(kept.release.status).toBe("failed");
      const before = await agentRow(made.agent.id);
      expect(before?.draftVersionId).not.toBeNull();

      const saved = await service().updateAgent(caller, made.agent.id, {
        follow_latest_profile: true,
      });
      expect(saved.release.status).toBe("applied");
      const after = await agentRow(made.agent.id);
      expect(after).toMatchObject({
        draftVersionId: before?.draftVersionId,
        draftProfileId: "op_missing_v1",
        draftFailure: before?.draftFailure,
        behaviorRevision: before?.behaviorRevision,
        profileTracking: "follow",
      });
    });

    test("a refused rollout item is closed once a person brought the agent to the newest version", async () => {
      const caller = await owner();
      await lineage(caller);
      const behind = await follower(caller);
      const same = await follower(caller, { profile: "op_ops_v2" });
      const rolloutId = await rolloutOf(caller, [
        behind.agent.id,
        same.agent.id,
      ]);
      await db
        .update(profileRolloutItems)
        .set({ status: "failed", reasonCode: "credential_unbound" });
      for (const made of [behind, same]) {
        await service().updateAgent(caller, made.agent.id, {
          follow_latest_profile: true,
        });
      }
      expect(
        (await items(rolloutId)).map((i) => [i.status, i.reasonCode]),
      ).toEqual([
        ["applied", null],
        ["applied", null],
      ]);
      expect(
        (await rollouts().summaries(caller.ownerId)).get("op_ops_v2"),
      ).toMatchObject({ total: 2, applied: 2, failed: 0, failed_agents: [] });
    });

    test("a follow judged on an older revision does not undo a revert made since", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller, { profile: "op_ops_v2" });
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, made.agent.id));
      const row = await agentRow(made.agent.id);
      const followed = await store().followProfile({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId: made.agent.id,
        // The judgment was made one activation ago.
        expectedActivationRevision: (row?.activationRevision as number) - 1,
        managerRoles: ["owner", "admin"],
      });
      expect(followed.outcome).toBe("superseded");
      expect((await agentRow(made.agent.id))?.profileTracking).toBe("pinned");
    });
  });

  describe("claims, leases and the activation's three checks", () => {
    test("a holder whose lease ran out and was not taken over cannot settle, and the item is claimed again", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      const rolloutId = await rolloutOf(caller, [made.agent.id]);
      const [held] = await rollouts().claim({ leaseMs: 1, limit: 1 });
      await Bun.sleep(20);
      expect(
        await rollouts().settle(held as NonNullable<typeof held>, {
          status: "applied",
        }),
      ).toBe(false);
      expect((await items(rolloutId))[0]?.status).toBe("pending");
      expect(await rollouts().claim({ leaseMs: 1_000, limit: 1 })).toHaveLength(
        1,
      );
    });

    test("a retry gives a failed item its five claims again", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      const rolloutId = await rolloutOf(caller, [made.agent.id]);
      for (let i = 0; i < 5; i++) {
        expect(await rollouts().claim({ leaseMs: 1, limit: 1 })).toHaveLength(
          1,
        );
        await Bun.sleep(5);
      }
      expect(await rollouts().claim({ leaseMs: 1_000, limit: 1 })).toEqual([]);
      const [failed] = await items(rolloutId);
      expect(failed).toMatchObject({
        status: "failed",
        reasonCode: "retries_exhausted",
        attempts: 5,
      });
      expect(
        await rollouts().retry({
          rolloutId,
          agentId: made.agent.id,
          generation: failed?.generation as number,
        }),
      ).toBe(true);
      expect((await items(rolloutId))[0]).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(await rollouts().claim({ leaseMs: 1_000, limit: 1 })).toHaveLength(
        1,
      );
      expect((await items(rolloutId))[0]?.attempts).toBe(1);
    });

    test("the lock refuses a rollout for a moved behavior revision and for a version that is not the newest, each on its own", async () => {
      const caller = await owner();
      await lineage(caller);
      const made = await follower(caller);
      const row = await agentRow(made.agent.id);
      const activate = (intent: {
        behaviorRevision: number;
        targetProfileId: string;
      }) =>
        store().activate({
          principal: caller,
          workspaceId: caller.ownerId,
          agentId: made.agent.id,
          releaseId: row?.activeReleaseId as string,
          expectedRevision: row?.activationRevision as number,
          approvedBy: userOf(caller),
          managerRoles: ["owner", "admin"],
          intent: { kind: "rollout", ...intent },
          reason: "profile_rollout",
        });
      const behaviorRevision = row?.behaviorRevision as number;
      expect(
        (await activate({ behaviorRevision, targetProfileId: "op_ops_v2" }))
          .outcome,
      ).toBe("unchanged");
      expect(
        (
          await activate({
            behaviorRevision: behaviorRevision + 1,
            targetProfileId: "op_ops_v2",
          })
        ).outcome,
      ).toBe("superseded");
      expect(
        (await activate({ behaviorRevision, targetProfileId: "op_ops_v1" }))
          .outcome,
      ).toBe("superseded");
    });
  });
});
