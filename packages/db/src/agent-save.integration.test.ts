import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  cardContentSha256,
  createAgentService,
  createAuthorizationPolicy,
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
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import * as schema from "./schema.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  agentVersions,
  memberships,
  memberTeams,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PROFILE: CatalogProfile = {
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
const CATALOG: SessionCatalog = testSessionCatalog({
  models: ["claude-opus-5", "claude-sonnet-5"],
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

// `tag` only tells two cards apart: it is the text of the card's one rule.
function card(tag: string, model = "claude-sonnet-5") {
  return agentCardRequestSchema.parse({
    rules: [{ id: "r1", text: tag, source: "user" }],
    model,
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });
}

integration("a card save releases (Z1) on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_save_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresAgentStore(db);

  function service(): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: store(),
      catalog: CATALOG,
      credentials: createPostgresCredentialBindingStore(db),
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

  async function newAgent(
    caller: Caller,
    request: {
      card?: AgentCardRequest;
      runtime_profile_id?: string;
      model_source?: "fixed" | "profile";
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
      card: request.card ?? card("v1"),
      ...(request.runtime_profile_id === undefined
        ? {}
        : { runtime_profile_id: request.runtime_profile_id }),
      ...(request.model_source === undefined
        ? {}
        : { model_source: request.model_source }),
    });
  }

  const releaseCount = async (agentId: string) =>
    (
      await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.agentId, agentId))
    ).length;
  const versionCount = async (agentId: string) =>
    (
      await db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId))
    ).length;

  test("a create with a profile makes the first release and activates it, following the profile's model", async () => {
    const caller = await owner();
    const made = await newAgent(caller, {
      card: card("v1", "claude-haiku-5"),
      runtime_profile_id: "coding",
    });
    expect(made.release.status).toBe("applied");
    expect(made.agent.active_release_id).toBe(made.release.release_id);
    expect(made.model_source).toBe("profile");
    expect(made.draft).toBeNull();
    // The card is the model it runs: the profile's, not the one sent.
    expect(made.versions.map((v) => v.card.model)).toEqual(["claude-sonnet-5"]);
    expect(made.active_release?.runtime_config_snapshot.model).toBe(
      "claude-sonnet-5",
    );
    expect(made.effective_behavior.applied).toEqual({
      runtime_profile_id: "coding",
      model: "claude-sonnet-5",
      model_source: "profile",
      title_model: "claude-haiku-5",
    });
    expect(made.effective_behavior.draft).toBeNull();
  });

  test("a create without a profile stays a draft agent", async () => {
    const caller = await owner();
    const made = await newAgent(caller);
    expect(made.release.status).toBe("unchanged");
    expect(made.agent.active_release_id).toBeNull();
    expect(made.draft).toBeNull();
    // A card saved with no profile to release on still names its version.
    expect(made.release.version_id).toBe(made.versions[0]?.id as string);
    const edited = await service().updateAgent(caller, made.agent.id, {
      card: card("v2"),
    });
    expect(edited.release.status).toBe("unchanged");
    expect(edited.release.version_id).toBe(
      edited.versions.at(-1)?.id as string,
    );
  });

  test("the same behavior is unchanged, makes no release, and still takes a revision", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const again = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1"),
    });
    expect(again.release).toEqual({
      status: "unchanged",
      reason: null,
      release_id: null,
      version_id: made.versions[0]?.id as string,
    });
    expect(await releaseCount(made.agent.id)).toBe(1);
    expect(again.behavior_revision).toBe(made.behavior_revision + 1);
    // Role and instructions reach no run: changing only them is unchanged too.
    const legacy = await agentsService.updateAgent(caller, made.agent.id, {
      card: { ...card("v1"), role: "분석가", instructions: "옛 지시" },
    });
    expect(legacy.release.status).toBe("unchanged");
    expect(await releaseCount(made.agent.id)).toBe(1);
    expect(await versionCount(made.agent.id)).toBe(2);
  });

  test("a changed card releases and records why; going back to old content releases the old version", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const second = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v2"),
    });
    expect(second.release.status).toBe("applied");
    expect(second.release.release_id).not.toBe(made.release.release_id);
    expect(await releaseCount(made.agent.id)).toBe(2);
    const back = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1"),
    });
    // The old content has its version and its release already.
    expect(back.release.status).toBe("applied");
    expect(back.release.release_id).toBe(made.release.release_id);
    expect(await versionCount(made.agent.id)).toBe(2);
    expect(await releaseCount(made.agent.id)).toBe(2);
    expect(back.agent.active_release_id).toBe(made.release.release_id);
    const reasons = await pool.query(
      `SELECT result->>'reason' AS reason FROM receipts
       WHERE operation = 'activate_agent' AND target_ref->'resource'->>'id' = $1
       ORDER BY created_at`,
      [made.agent.id],
    );
    expect(reasons.rows.map((r) => r.reason)).toEqual([
      "card_saved",
      "card_saved",
      "card_saved",
    ]);
  });

  test("a profile alone re-saves the card on it; a followed default model moves with the profile", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const moved = await agentsService.updateAgent(caller, made.agent.id, {
      runtime_profile_id: "newer",
    });
    expect(moved.release.status).toBe("applied");
    expect(moved.active_release?.runtime_profile_id).toBe("newer");
    expect(moved.active_release?.runtime_config_snapshot.model).toBe(
      "claude-opus-5",
    );
    expect(moved.model_source).toBe("profile");
    const reasons = await pool.query(
      `SELECT result->>'reason' AS reason FROM receipts
       WHERE operation = 'activate_agent' AND target_ref->'resource'->>'id' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [made.agent.id],
    );
    expect(reasons.rows[0]?.reason).toBe("profile_changed");
  });

  test("a model chosen by hand is fixed; picking the profile's own model by hand is not unchanged-by-source", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "newer" });
    const chosen = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1", "claude-sonnet-5"),
    });
    // The card's model is not the one running, so the source reads as a choice.
    expect(chosen.model_source).toBe("fixed");
    expect(chosen.release.status).toBe("applied");
    expect(chosen.active_release?.runtime_config_snapshot.model).toBe(
      "claude-sonnet-5",
    );
    // Back to following: the profile's model equals the one running only if
    // it does; here it does not, so it releases.
    const follow = await agentsService.updateAgent(caller, made.agent.id, {
      model_source: "profile",
    });
    expect(follow.release.status).toBe("applied");
    expect(follow.active_release?.runtime_config_snapshot.model).toBe(
      "claude-opus-5",
    );
    // Fixed at the model that is running: no release, only the source moves.
    const fixedNow = await agentsService.updateAgent(caller, made.agent.id, {
      model_source: "fixed",
    });
    expect(fixedNow.release.status).toBe("unchanged");
    expect(fixedNow.model_source).toBe("fixed");
    expect(fixedNow.agent.active_release_id).toBe(
      follow.agent.active_release_id,
    );
  });

  test("a refused release keeps the card version and shows as a failed draft until a good save clears it", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const refused = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v2", "gpt-never"),
      model_source: "fixed",
    });
    expect(refused.release).toEqual({
      status: "failed",
      reason: "model_not_in_profile",
      release_id: null,
      version_id: refused.versions.at(-1)?.id as string,
    });
    expect(refused.draft?.failure).toBe("model_not_in_profile");
    expect(refused.agent.active_release_id).toBe(made.release.release_id);
    expect(await versionCount(made.agent.id)).toBe(2);
    expect(refused.effective_behavior.draft?.model).toBe("gpt-never");
    expect(refused.effective_behavior.applied?.model).toBe("claude-sonnet-5");
    // Discarding: the active behavior saved again clears the draft.
    const discarded = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1"),
      runtime_profile_id: "coding",
      model_source: "profile",
    });
    expect(discarded.release.status).toBe("unchanged");
    expect(discarded.draft).toBeNull();
  });

  test("a save a newer intent replaced cannot activate or write its failure (superseded)", async () => {
    const caller = await owner();
    const agentsService = service();
    const agentsStore = store();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const roles = ["owner", "admin"] as const;
    // A: a different card, judged and waiting for its release.
    const a = card("A");
    const judged = await agentsStore.update({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId: made.agent.id,
      card: {
        card: a,
        contentSha256: cardContentSha256(a),
      },
      behavior: { runtimeProfileId: "coding", modelSource: "profile" },
      updatedBy: caller.actor?.userId ?? "",
      managerRoles: roles,
    });
    if (judged.outcome !== "updated" || judged.saved === null) {
      throw new Error("expected a pending save");
    }
    expect(judged.saved.status).toBe("pending");
    expect(judged.detail.draft?.version_id).toBe(judged.saved.versionId);
    const release = await agentsService.createRelease(caller, made.agent.id, {
      version_id: judged.saved.versionId,
      runtime_profile_id: "coding",
    });
    // B: the active behavior again, unchanged. It takes the next revision.
    const b = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1"),
    });
    expect(b.release.status).toBe("unchanged");
    expect(b.draft).toBeNull();
    const activated = await agentsStore.activate({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId: made.agent.id,
      releaseId: release.release.id,
      expectedRevision: b.agent.activation_revision,
      approvedBy: caller.actor?.userId ?? "",
      managerRoles: roles,
      intent: {
        kind: "save",
        behaviorRevision: judged.saved.behaviorRevision,
        draftVersionId: judged.saved.versionId,
        modelSource: "profile",
      },
    });
    expect(activated.outcome).toBe("superseded");
    expect(
      await agentsStore.recordDraftFailure({
        workspaceId: caller.ownerId,
        agentId: made.agent.id,
        behaviorRevision: judged.saved.behaviorRevision,
        draftVersionId: judged.saved.versionId,
        failure: "too_late",
      }),
    ).toBe(false);
    const now = await agentsService.getAgent(caller, made.agent.id);
    expect(now.agent.active_release_id).toBe(made.release.release_id);
    expect(now.draft).toBeNull();
  });

  test("the same content sent twice: the later request wins and the earlier is superseded, though both name the same draft", async () => {
    const caller = await owner();
    const agentsService = service();
    const agentsStore = store();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const roles = ["owner", "admin"] as const;
    const a = card("same");
    const judge = () =>
      agentsStore.update({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId: made.agent.id,
        card: { card: a, contentSha256: cardContentSha256(a) },
        behavior: { runtimeProfileId: "coding", modelSource: "profile" },
        updatedBy: caller.actor?.userId ?? "",
        managerRoles: roles,
      });
    const first = await judge();
    const second = await judge();
    if (
      first.outcome !== "updated" ||
      second.outcome !== "updated" ||
      !first.saved ||
      !second.saved
    ) {
      throw new Error("expected two pending saves");
    }
    expect(second.saved.versionId).toBe(first.saved.versionId);
    expect(second.saved.behaviorRevision).toBe(
      first.saved.behaviorRevision + 1,
    );
    const release = await agentsService.createRelease(caller, made.agent.id, {
      version_id: first.saved.versionId,
      runtime_profile_id: "coding",
    });
    const activate = (behaviorRevision: number) =>
      agentsStore.activate({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId: made.agent.id,
        releaseId: release.release.id,
        expectedRevision: made.agent.activation_revision,
        approvedBy: caller.actor?.userId ?? "",
        managerRoles: roles,
        intent: {
          kind: "save",
          behaviorRevision,
          draftVersionId: first.saved?.versionId ?? "",
          modelSource: "profile",
        },
      });
    expect((await activate(first.saved.behaviorRevision)).outcome).toBe(
      "superseded",
    );
    expect((await activate(second.saved.behaviorRevision)).outcome).toBe(
      "activated",
    );
  });

  test("of two concurrent different saves the revision check lets one finish; the active release is the last one judged", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const results = await Promise.all([
      agentsService.updateAgent(caller, made.agent.id, { card: card("X") }),
      agentsService.updateAgent(caller, made.agent.id, { card: card("Y") }),
    ]);
    const statuses = results.map((r) => r.release.status).sort();
    // Each is applied, or replaced by the other: never both left pending.
    expect(statuses.every((s) => s === "applied" || s === "superseded")).toBe(
      true,
    );
    expect(statuses).toContain("applied");
    const now = await agentsService.getAgent(caller, made.agent.id);
    expect(now.draft).toBeNull();
    const activeCard = now.versions.find(
      (v) => v.id === now.active_release?.version_id,
    )?.card;
    const tagOf = (c: typeof activeCard) => c?.rules[0]?.text ?? "";
    const lastJudged = now.versions
      .filter((v) => ["X", "Y"].includes(tagOf(v.card)))
      .at(-1);
    expect(["X", "Y"]).toContain(tagOf(activeCard));
    if (statuses.includes("superseded")) {
      expect(tagOf(activeCard)).toBe(tagOf(lastJudged?.card));
    }
  });

  test("an agent without a settings row keeps the active release's GitHub pin and repository; one with a row carries neither", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "coding" });
    const github = {
      repositories: ["app"],
      push_approval: true,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
    };
    const pinned = await agentsService.createRelease(caller, made.agent.id, {
      version_id: made.versions[0]?.id ?? "",
      runtime_profile_id: "coding",
      repository_id: "app",
      github,
      note: "pinned",
    });
    await agentsService.activateAgent(caller, made.agent.id, {
      release_id: pinned.release.id,
      expected_revision: made.agent.activation_revision,
    });
    const saved = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v2"),
    });
    expect(saved.release.status).toBe("applied");
    expect(saved.active_release?.id).not.toBe(pinned.release.id);
    expect(saved.active_release?.policy_pins.github).toEqual(github);
    expect(saved.active_release?.repository_id).toBe("app");

    await db.insert(agentGitHubSettings).values({
      agentId: made.agent.id,
      workspaceId: caller.ownerId,
      repositories: ["app"],
      pushApproval: true,
      features: github.features,
      actionsAllow: [],
      updatedBy: caller.actor?.userId ?? null,
    });
    const withRow = await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v3"),
    });
    expect(withRow.release.status).toBe("applied");
    expect(withRow.active_release?.policy_pins.github).toBeUndefined();
    expect(withRow.active_release?.repository_id).toBeNull();
  });

  test("a direct activation (a rollback) takes a revision, leaves the draft, and stops following a profile whose default the release did not run", async () => {
    const caller = await owner();
    const agentsService = service();
    const made = await newAgent(caller, { runtime_profile_id: "newer" });
    // v1 ran claude-opus-5 (the default of newer). Pick sonnet by hand, then
    // follow again: two releases, the second the default.
    await agentsService.updateAgent(caller, made.agent.id, {
      card: card("v1", "claude-sonnet-5"),
    });
    const following = await agentsService.updateAgent(caller, made.agent.id, {
      model_source: "profile",
    });
    expect(following.model_source).toBe("profile");
    const sonnetRelease = (
      await agentsService.getAgent(caller, made.agent.id)
    ).releases.find(
      (r) => r.runtime_config_snapshot.model === "claude-sonnet-5",
    );
    const before = await agentsService.getAgent(caller, made.agent.id);
    await agentsService.activateAgent(caller, made.agent.id, {
      release_id: sonnetRelease?.id ?? "",
      expected_revision: before.agent.activation_revision,
    });
    const after = await agentsService.getAgent(caller, made.agent.id);
    expect(after.behavior_revision).toBe(before.behavior_revision + 1);
    expect(after.model_source).toBe("fixed");
    // Going to the release that ran the default keeps following.
    const defaultRelease = after.releases.find(
      (r) => r.runtime_config_snapshot.model === "claude-opus-5",
    );
    await db
      .update(agents)
      .set({ modelSource: "profile" })
      .where(eq(agents.id, made.agent.id));
    await agentsService.activateAgent(caller, made.agent.id, {
      release_id: defaultRelease?.id ?? "",
      expected_revision: after.agent.activation_revision,
    });
    expect(
      (await agentsService.getAgent(caller, made.agent.id)).model_source,
    ).toBe("profile");
    void receipts;
    void sql;
  });
});
