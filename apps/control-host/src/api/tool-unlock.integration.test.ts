import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentCardRequest,
  agentCardRequestSchema,
  scopesForRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentActivationEvents,
  agentReleases,
  agents,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresProfileRolloutStore,
  installationProfiles,
  memberships,
  memberTeams,
  profileRolloutItems,
  profileRollouts,
  ROLLOUT_MAX_CLAIMS,
  receipts,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  type AgentService,
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createProfileRolloutRunner,
  deriveReleaseId,
  resolveReleaseContent,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runToolUnlock } from "./tool-unlock.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep", "Edit", "Write"],
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
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: { op_ops_v1: PROFILE },
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

integration("tool_unlock rollout on PostgreSQL (Z3)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let dir: string;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "tool_unlock_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    dir = await mkdtemp(join(tmpdir(), "tool-unlock-"));
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(dir, { recursive: true, force: true });
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

  const deps = () => ({ db, pool, catalog: CATALOG });
  let reports = 0;
  const reportPath = () => join(dir, `report-${reports++}.json`);

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
        definition: { ...PROFILE, provider: { kind: "litellm" } },
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

  const card = (tools: string[] | null = null): AgentCardRequest =>
    agentCardRequestSchema.parse({
      model: "claude-sonnet-5",
      capabilities: { tools, mcp: null, forbidden: [] },
    });

  /**
   * An agent as the old calculation left it: the card's narrower tools baked
   * into the active release. The release is valid (its id hashes), just old.
   */
  async function legacyAgent(
    caller: Caller,
    options: { tools: string[]; pinned?: boolean },
  ) {
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: caller.ownerId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    const made = await service().createAgent(caller, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      managing_team_id: teamId,
      card: card(options.tools),
      runtime_profile_id: "op_ops_v1",
      model_source: "profile",
    });
    const record = await store().get(caller.ownerId, made.agent.id);
    const version = record?.versions[0];
    if (!record || !version) throw new Error("agent has a version");
    const resolved = resolveReleaseContent(version.card, "op_ops_v1", PROFILE);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const content = resolved.content;
    const identity = {
      agent_id: made.agent.id,
      card_sha256: version.content_sha256,
      repository_id: null,
      ...content,
      runtime_config_snapshot: {
        ...content.runtime_config_snapshot,
        tools: options.tools,
      },
      effective_tools: { tools: options.tools, mcp: [] },
      policy_pins: {
        tools: {
          default: { builtin: "allow" as const, mcp: "ask" as const },
          per_tool: Object.fromEntries(
            options.tools.map((tool) => [tool, "allow" as const]),
          ),
        },
      },
    };
    const releaseId = deriveReleaseId(identity);
    const userId = caller.actor?.userId as string;
    const principal = caller;
    const inserted = await store().insertRelease({
      principal,
      workspaceId: caller.ownerId,
      managerRoles: ["owner", "admin"],
      release: {
        id: releaseId,
        version_id: version.id,
        created_by: userId,
        note: null,
        ...identity,
      },
    });
    // A card that already asks for every tool makes the release the new
    // calculation made at creation: it exists and is already active.
    if (inserted.outcome === "exists") return made.agent.id;
    if (inserted.outcome !== "created") throw new Error(inserted.outcome);
    const activated = await store().activate({
      principal,
      workspaceId: caller.ownerId,
      agentId: made.agent.id,
      releaseId,
      expectedRevision: record.agent.activation_revision,
      approvedBy: userId,
      managerRoles: ["owner", "admin"],
    });
    if (activated.outcome !== "activated") throw new Error(activated.outcome);
    if (options.pinned) {
      await db
        .update(agents)
        .set({ profileTracking: "pinned" })
        .where(eq(agents.id, made.agent.id));
    }
    return made.agent.id;
  }

  const agentRow = async (id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0];
  const releasesOf = (id: string) =>
    db.select().from(agentReleases).where(eq(agentReleases.agentId, id));
  const activeToolsOf = async (id: string) => {
    const row = await agentRow(id);
    const releases = await releasesOf(id);
    return (
      releases.find((r) => r.id === row?.activeReleaseId)?.effectiveTools as {
        tools: string[];
      }
    ).tools;
  };
  const run = async (mode: "--dry-run" | "--apply") => {
    const lines: string[] = [];
    const path = reportPath();
    const code = await runToolUnlock([mode, "--out", path], deps(), (line) =>
      lines.push(line),
    );
    return {
      code,
      path,
      summary: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>,
    };
  };

  test("the dry-run lists agent by unlocked tools and writes nothing", async () => {
    const caller = await owner();
    const narrow = await legacyAgent(caller, { tools: ["Read"] });
    const full = await legacyAgent(caller, {
      tools: ["Read", "Grep", "Edit", "Write"],
    });
    const before = await releasesOf(narrow);

    const { code, path } = await run("--dry-run");
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(path, "utf8"));
    const of = (id: string) =>
      report.agents.find(
        (entry: { agent_id: string }) => entry.agent_id === id,
      );
    expect(of(narrow)).toMatchObject({
      decision: "unlock",
      tools_before: ["Read"],
      unlocked: ["Grep", "Edit", "Write"],
      tracking: "follow",
    });
    expect(of(full)).toMatchObject({ decision: "same", unlocked: [] });
    expect(report.totals).toMatchObject({ unlock: 1, same: 1 });
    expect(await releasesOf(narrow)).toEqual(before);
    expect(await db.select().from(profileRollouts)).toHaveLength(0);
  });

  test("applies to every agent whose tools differ, pinned included, and leaves the rest", async () => {
    const caller = await owner();
    const followed = await legacyAgent(caller, { tools: ["Read"] });
    const pinned = await legacyAgent(caller, {
      tools: ["Read", "Grep"],
      pinned: true,
    });
    const full = await legacyAgent(caller, {
      tools: ["Read", "Grep", "Edit", "Write"],
    });
    const oldRelease = (await agentRow(followed))?.activeReleaseId;
    const fullReleases = await releasesOf(full);

    const first = await run("--apply");
    expect(first.code).toBe(0);
    for (const id of [followed, pinned]) {
      expect(await activeToolsOf(id)).toEqual([
        "Read",
        "Grep",
        "Edit",
        "Write",
      ]);
    }
    // Tracking stays, the old release stays, the full one is not touched.
    expect((await agentRow(pinned))?.profileTracking).toBe("pinned");
    expect((await agentRow(followed))?.profileTracking).toBe("follow");
    expect((await releasesOf(followed)).some((r) => r.id === oldRelease)).toBe(
      true,
    );
    expect(await releasesOf(full)).toEqual(fullReleases);

    const receipt = (await db.select().from(receipts))
      .map((r) => r.result as Record<string, unknown>)
      .find((r) => r?.reason === "tool_unlock" && r?.tool_unlock !== undefined);
    expect(receipt?.tool_unlock).toMatchObject({
      tools_before: expect.any(Array),
      tools_after: ["Read", "Grep", "Edit", "Write"],
    });
    const items = await db.select().from(profileRolloutItems);
    expect(items.map((i) => i.status)).toEqual(["applied", "applied"]);
    const [rollout] = await db.select().from(profileRollouts);
    expect(rollout?.kind).toBe("tool_unlock");

    // A second run changes nothing.
    const second = await run("--apply");
    expect(second.code).toBe(0);
    expect(second.summary).toMatchObject({ unlock: 0 });
    expect(await releasesOf(followed)).toHaveLength(2);
    expect(await releasesOf(pinned)).toHaveLength(2);
    expect(await db.select().from(profileRolloutItems)).toHaveLength(2);
  });

  test("a report path that is already taken does not hold the apply back", async () => {
    const caller = await owner();
    const id = await legacyAgent(caller, { tools: ["Read"] });
    const path = reportPath();
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    expect(await runToolUnlock(["--dry-run", "--out", path], deps(), say)).toBe(
      0,
    );
    const dryReport = await readFile(path, "utf8");

    // Same path as the dry-run: the file stays, the run still unlocks.
    const code = await runToolUnlock(["--apply", "--out", path], deps(), say);
    expect(code).toBe(0);
    const summary = JSON.parse(lines.at(-1) ?? "{}");
    expect(summary).toMatchObject({
      report: null,
      report_sha256: null,
      report_error: expect.stringContaining("EEXIST"),
    });
    expect(await readFile(path, "utf8")).toBe(dryReport);
    expect(await activeToolsOf(id)).toEqual(["Read", "Grep", "Edit", "Write"]);
  });

  test("an agent a person changed after the plan is left as it is", async () => {
    const caller = await owner();
    const id = await legacyAgent(caller, { tools: ["Read"] });
    const record = await store().get(caller.ownerId, id);
    const released = await releasesOf(id);
    const outcome = await service().unlockTools({
      workspaceId: caller.ownerId,
      agentId: id,
      actorUserId: caller.actor?.userId as string,
      rolloutId: null,
      expected: {
        activeReleaseId: record?.active_release?.id as string,
        activationRevision: (record?.agent.activation_revision as number) - 1,
        behaviorRevision: record?.behavior_revision as number,
      },
    });
    expect(outcome).toEqual({ status: "superseded" });
    expect(await releasesOf(id)).toEqual(released);
  });

  test("a change that lands between the plan and the swap is stopped by the database", async () => {
    const caller = await owner();
    const id = await legacyAgent(caller, { tools: ["Read"] });
    const before = await agentRow(id);
    const record = await store().get(caller.ownerId, id);
    const made = await service().createRelease(caller, id, {
      version_id: record?.versions[0]?.id as string,
      runtime_profile_id: "op_ops_v1",
    });
    expect(made.release.id).not.toBe(before?.activeReleaseId);
    const releases = await releasesOf(id);
    const events = await db.select().from(agentActivationEvents);

    const outcome = await store().activate({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId: id,
      releaseId: made.release.id,
      expectedRevision: before?.activationRevision as number,
      approvedBy: caller.actor?.userId as string,
      managerRoles: ["owner", "admin"],
      intent: {
        kind: "tool_unlock",
        rolloutId: null,
        expected: {
          activeReleaseId: before?.activeReleaseId as string,
          activationRevision: before?.activationRevision as number,
          behaviorRevision: (before?.behaviorRevision as number) + 1,
        },
        tools: { before: ["Read"], after: ["Read", "Grep", "Edit", "Write"] },
      },
    });
    expect(outcome).toEqual({ outcome: "superseded" });
    expect(await agentRow(id)).toEqual(before);
    expect(await releasesOf(id)).toEqual(releases);
    expect(await db.select().from(agentActivationEvents)).toEqual(events);
  });

  test("an apply whose report directory is missing still unlocks, and says why", async () => {
    const caller = await owner();
    const id = await legacyAgent(caller, { tools: ["Read"] });
    const path = join(dir, "missing", "report.json");
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);

    const code = await runToolUnlock(["--apply", "--out", path], deps(), say);
    expect(code).toBe(0);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      report: null,
      report_sha256: null,
      report_error: expect.stringContaining("ENOENT"),
    });
    expect(await activeToolsOf(id)).toEqual(["Read", "Grep", "Edit", "Write"]);

    await expect(
      runToolUnlock(["--dry-run", "--out", path], deps(), say),
    ).rejects.toThrow(/ENOENT/);
  });

  test("the rollout runner and its sweep never take a tool_unlock item", async () => {
    const caller = await owner();
    await legacyAgent(caller, { tools: ["Read"] });
    await run("--apply");
    // A pending item (what a crashed run could leave) is the one the claim
    // would take if it did not filter on the rollout's kind.
    const [applied] = await db.select().from(profileRolloutItems);
    await db
      .update(profileRolloutItems)
      .set({ status: "pending" })
      .where(eq(profileRolloutItems.agentId, applied?.agentId as string));
    const rolloutRows = await db.select().from(profileRollouts);
    const itemRows = await db.select().from(profileRolloutItems);

    const runner = createProfileRolloutRunner({
      rollouts: createPostgresProfileRolloutStore(db),
      agentStore: store(),
      agents: service(),
      logger: quiet,
      sweep: true,
    });
    expect(await runner.runOnce()).toEqual({ claimed: 0, settled: 0 });
    expect(await db.select().from(profileRollouts)).toEqual(rolloutRows);
    expect(await db.select().from(profileRolloutItems)).toEqual(itemRows);
  });

  test("an item out of claims is not failed by the profile-update sweep", async () => {
    const caller = await owner();
    await legacyAgent(caller, { tools: ["Read"] });
    await run("--apply");
    await db
      .update(profileRolloutItems)
      .set({ status: "pending", attempts: ROLLOUT_MAX_CLAIMS });
    const itemRows = await db.select().from(profileRolloutItems);
    expect(itemRows[0]?.attempts).toBe(ROLLOUT_MAX_CLAIMS);

    const claimed = await createPostgresProfileRolloutStore(db).claim({
      leaseMs: 60_000,
      limit: 10,
    });
    expect(claimed).toEqual([]);
    expect(await db.select().from(profileRolloutItems)).toEqual(itemRows);
  });
});
