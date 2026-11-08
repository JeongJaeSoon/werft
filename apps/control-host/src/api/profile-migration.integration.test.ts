import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCardRequestSchema,
  GITHUB_CEILING_NONE,
  scopesForRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresWorkspaceProfileStore,
  githubWorkspaceSettings,
  installationProfiles,
  memberships,
  memberTeams,
  receipts,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  type AgentService,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  profileFingerprint,
  type SessionCatalog,
  usesWorkspaceCeiling,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  seedSettings,
  settingsCatalog,
  settingsDocument,
} from "../test-support/settings.ts";
import { runProfileMigration, sha256Of } from "./profile-migration.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const BASE_ID = "coding";
const ENV = {
  INTEGRATION_PROVIDER_KEY: "provider-key-value",
  PRIVATE_A_APP_KEY: "app-key-value",
};
const PROFILES = `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    models: [claude-sonnet-5, claude-haiku-5]
    tools: [Read, Edit, Bash]
    permission_mode: acceptEdits
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: INTEGRATION_PROVIDER_KEY
`;
const CONNECTIONS = `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: INTEGRATION_PROVIDER_KEY
`;
const REPOSITORIES = `repositories:
  private-a:
    url: https://git.example.invalid/acme/private-a.git
    branch: main
    profiles: [coding]
    auth:
      kind: github_app
      app_id: 7
      installation_id: 70
      value_env: PRIVATE_A_APP_KEY
  url-r:
    url: https://github.com/acme/url-r.git
    branch: main
    profiles: [coding]
    auth:
      kind: github_app
`;

function card(instructions: string) {
  return agentCardRequestSchema.parse({
    agent_instructions: instructions,
    model: "claude-sonnet-5",
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });
}

integration("profile migration on PostgreSQL (U5)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let dir: string;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "profile_migration_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    dir = await mkdtemp(join(tmpdir(), "profile-migration-it-"));
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  const catalogOf = () => settingsCatalog(db, ENV);

  async function seedBase() {
    await seedSettings(
      db,
      settingsDocument(PROFILES, CONNECTIONS, REPOSITORIES),
    );
  }

  async function workspace(options: { ceiling?: boolean } = {}) {
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
    if (options.ceiling !== false) {
      await db.insert(githubWorkspaceSettings).values({
        workspaceId,
        ceiling: GITHUB_CEILING_NONE,
        repositoryCeiling: {
          repository_ids: [],
          github_app_repositories: "installed",
        },
      });
    }
    const caller = callerFor(
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
    return { workspaceId, userId, caller };
  }

  type Ws = Awaited<ReturnType<typeof workspace>>;

  async function wsVersion(
    ws: Ws,
    catalog: SessionCatalog,
    name: string,
    tools = ["Read"],
  ) {
    const base = catalog.profiles[BASE_ID];
    if (!base) throw new Error(`${BASE_ID} is not in the catalog`);
    const made = await createPostgresWorkspaceProfileStore(db).create({
      actor: {
        principal: ws.caller,
        workspaceId: ws.workspaceId,
        userId: ws.userId,
      },
      receiptId: randomUUID(),
      name,
      baseProfileId: BASE_ID,
      base: {
        fingerprint: profileFingerprint(base),
        runtimeVersion: "0.3.270",
        billing: "metered",
        repositoryMode: "required",
      },
      narrowing: {
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools,
        permission_mode: "default",
      },
      deny: null,
      toolCatalogId: null,
    });
    if (made.outcome !== "created") throw new Error(made.outcome);
    return made.record.id;
  }

  async function service(catalog: SessionCatalog): Promise<AgentService> {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
    });
  }

  async function agentOn(
    ws: Ws,
    catalog: SessionCatalog,
    profileId: string,
    options: { settingsRow?: boolean } = {},
  ) {
    const teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: ws.workspaceId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    const agents = await service(catalog);
    const made = await agents.createAgent(ws.caller, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      managing_team_id: teamId,
      card: card("v1"),
    });
    const agentId = made.agent.id;
    // A repository-required profile releases only for an agent with a settings
    // row, so the row exists before the profile is given.
    await db.insert(agentGitHubSettings).values({
      agentId,
      workspaceId: ws.workspaceId,
      repositories: [],
      pushApproval: false,
      features: GITHUB_CEILING_NONE,
      actionsAllow: [],
    });
    const released = await agents.updateAgent(ws.caller, agentId, {
      runtime_profile_id: profileId,
      model_source: "fixed",
    });
    if (released.release.status !== "applied") {
      throw new Error(`fixture release: ${JSON.stringify(released.release)}`);
    }
    if (options.settingsRow === false) {
      await db
        .delete(agentGitHubSettings)
        .where(eq(agentGitHubSettings.agentId, agentId));
    }
    return agentId;
  }

  const agentRow = async (id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0];
  const releaseOf = async (id: string | null | undefined) =>
    (
      await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, id ?? ""))
    )[0];
  const copies = () =>
    db
      .select()
      .from(installationProfiles)
      .where(isNotNull(installationProfiles.migratedFrom));
  const counts = async () => ({
    profiles: (await db.select().from(installationProfiles)).length,
    releases: (await db.select().from(agentReleases)).length,
    receipts: (await db.select().from(receipts)).length,
  });

  async function run(argv: string[], catalog: SessionCatalog) {
    const lines: Array<Record<string, unknown>> = [];
    const code = await runProfileMigration(
      argv,
      { db, pool, catalog },
      (line) => lines.push(JSON.parse(line)),
    );
    return { code, lines, last: lines[lines.length - 1] ?? {} };
  }

  async function dryRun(catalog: SessionCatalog) {
    const out = join(dir, `report-${randomUUID().slice(0, 8)}.json`);
    const result = await run(["--dry-run", "--out", out], catalog);
    const text = await readFile(out, "utf8");
    return { ...result, out, text, sha: sha256Of(text) };
  }

  async function world() {
    await seedBase();
    const ws = await workspace();
    const first = await catalogOf();
    const v1 = await wsVersion(ws, first, "strict");
    const v2 = await wsVersion(ws, first, "strict", ["Read", "Edit"]);
    const old = await wsVersion(ws, first, "old");
    const catalog = await catalogOf();
    const onV1 = await agentOn(ws, catalog, v1);
    const onV2 = await agentOn(ws, catalog, v2);
    const onOld = await agentOn(ws, catalog, old);
    await createPostgresWorkspaceProfileStore(db).retire({
      actor: {
        principal: ws.caller,
        workspaceId: ws.workspaceId,
        userId: ws.userId,
      },
      receiptId: randomUUID(),
      profileId: old,
    });
    return {
      ws,
      v1,
      v2,
      old,
      onV1,
      onV2,
      onOld,
      catalog: await catalogOf(),
    };
  }

  test("the write step refuses without the report's hash and with a wrong one; nothing is written", async () => {
    const { catalog } = await world();
    const report = await dryRun(catalog);
    expect(report.code).toBe(0);
    const before = await counts();
    const missing = await runProfileMigration(
      ["--apply", "--report", report.out],
      { db, pool, catalog },
      () => {},
    ).catch((error: Error) => error.message);
    expect(String(missing)).toContain("--report-sha256 needs a value");
    const wrong = await run(
      ["--apply", "--report", report.out, "--report-sha256", "0".repeat(64)],
      catalog,
    );
    expect(wrong.code).toBe(1);
    expect(String(wrong.last.refused)).toContain("does not match");
    const edited = join(dir, "edited.json");
    await writeFile(edited, report.text.replace("\n", " \n"));
    const tampered = await run(
      ["--apply", "--report", edited, "--report-sha256", report.sha],
      catalog,
    );
    expect(tampered.code).toBe(1);
    expect(await counts()).toEqual(before);
    expect(await copies()).toEqual([]);
  });

  test("the report names what it would do: states, agents, tools before and after, ceiling", async () => {
    const { ws, v1, v2, old, onV1, onOld, catalog } = await world();
    const report = await dryRun(catalog);
    const plan = JSON.parse(report.text);
    expect(plan.preconditions).toMatchObject({
      r2_complete: true,
      null_ceiling_workspaces: [],
    });
    const w = plan.workspaces.find(
      (entry: { workspace_id: string }) =>
        entry.workspace_id === ws.workspaceId,
    );
    expect(
      w.profiles.map(
        (p: { source_id: string; decision: string; state: string }) => [
          p.source_id,
          p.state,
          p.decision,
        ],
      ),
    ).toEqual(
      expect.arrayContaining([
        [v1, "usable", "copy"],
        [v2, "usable", "copy"],
        [old, "retired", "skip"],
      ]),
    );
    const moved = w.agents.find(
      (a: { agent_id: string }) => a.agent_id === onV1,
    );
    expect(moved).toMatchObject({
      decision: "move",
      tracking_after: "pinned",
      tools_before: ["Read"],
      tools_after: ["Read"],
    });
    expect(
      w.agents.find((a: { agent_id: string }) => a.agent_id === onOld),
    ).toMatchObject({ decision: "stay", stay_reason: "retired" });
    expect(
      w.ceiling.additions.map(
        (a: { repository_id: string }) => a.repository_id,
      ),
    ).toEqual(["private-a"]);
    // One line per version that names it, each with its own basis.
    expect(
      w.ceiling.not_added.map(
        (n: {
          repository_id: string;
          reason: string;
          source: { id: string };
        }) => [n.repository_id, n.reason, n.source.id],
      ),
    ).toEqual([
      ["url-r", "app_installed", v1],
      ["url-r", "app_installed", v2],
    ]);
    expect(plan.migration_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.sha).toBe(sha256Of(report.text));
    await expect(
      runProfileMigration(
        ["--dry-run", "--out", report.out],
        { db, pool, catalog },
        () => {},
      ),
    ).rejects.toThrow();
    expect(await copies()).toEqual([]);
  });

  test("copies usable versions only, moves the agents without changing what they run, pins the older version, widens the ceiling", async () => {
    const { ws, v1, v2, old, onV1, onV2, onOld, catalog } = await world();
    const before = {
      onV1: await releaseOf((await agentRow(onV1))?.activeReleaseId),
      onV2: await releaseOf((await agentRow(onV2))?.activeReleaseId),
      onOld: (await agentRow(onOld))?.activeReleaseId,
      behavior: (await agentRow(onV1))?.behaviorRevision,
    };
    const report = await dryRun(catalog);
    const applied = await run(
      ["--apply", "--report", report.out, "--report-sha256", report.sha],
      catalog,
    );
    expect(applied.last).toMatchObject({ dry_run: false, complete: true });

    const rows = (await copies()).sort((a, b) => a.version - b.version);
    expect(rows.map((row) => row.migratedFrom)).toEqual([v1, v2]);
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows[0]?.name).toStartWith("wl_");
    expect(rows[1]?.name).toBe(rows[0]?.name as string);
    expect(rows[1]?.previousId).toBe(rows[0]?.id as string);
    for (const row of rows) {
      expect(row.workspaceId).toBe(ws.workspaceId);
      expect(row.displayName).toBe("strict");
      expect(row.derivedFrom).toBe(BASE_ID);
      expect(row.repositoryIds).toBeNull();
      expect(row.githubAppRepositories).toBeNull();
      expect(row.repositoryScope).toBeNull();
      expect(row.definition).not.toHaveProperty("repository");
      expect(row.retiredAt).toBeNull();
    }
    expect(rows.some((row) => row.migratedFrom === old)).toBe(false);
    expect((await agentRow(onOld))?.activeReleaseId).toBe(before.onOld ?? null);

    const a1 = await agentRow(onV1);
    const a2 = await agentRow(onV2);
    const r1 = await releaseOf(a1?.activeReleaseId);
    const r2 = await releaseOf(a2?.activeReleaseId);
    expect(r1?.runtimeProfileId).toBe(rows[0]?.id as string);
    expect(r2?.runtimeProfileId).toBe(rows[1]?.id as string);
    expect(a1?.profileTracking).toBe("pinned");
    expect(a2?.profileTracking).toBe("follow");
    for (const [after, was] of [
      [r1, before.onV1],
      [r2, before.onV2],
    ] as const) {
      const a = after?.runtimeConfigSnapshot as Record<string, unknown>;
      const b = was?.runtimeConfigSnapshot as Record<string, unknown>;
      expect(a.model).toBe(b.model);
      expect([...(a.tools as string[])].sort()).toEqual(
        [...(b.tools as string[])].sort(),
      );
      expect(a.permission_mode).toBe(b.permission_mode);
      expect(a.provider).toEqual(b.provider);
    }
    expect(a1?.behaviorRevision).toBe(before.behavior);
    expect(r1?.versionId).toBe(before.onV1?.versionId);

    const [ceiling] = await db
      .select()
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, ws.workspaceId));
    expect(ceiling?.repositoryCeiling).toEqual({
      repository_ids: ["private-a"],
      github_app_repositories: "installed",
    });
    const fresh = await catalogOf();
    expect(usesWorkspaceCeiling(fresh, rows[0]?.id as string, "release")).toBe(
      true,
    );
    const stamped = await db.select().from(receipts);
    const migrationId = JSON.parse(report.text).migration_id as string;
    const tagged = stamped.filter((r) => {
      const result = r.result as Record<string, unknown> | null;
      return (
        result?.migration_id === migrationId ||
        (result?.migration as { id?: string } | undefined)?.id === migrationId
      );
    });
    expect(tagged.map((r) => r.operation).sort()).toEqual(
      [
        "activate_agent",
        "activate_agent",
        "create_installation_profile",
        "create_installation_profile",
        "set_github_ceiling",
      ].sort(),
    );
  });

  test("a second run changes nothing: no new row, release, receipt or ceiling value", async () => {
    const { catalog } = await world();
    const first = await dryRun(catalog);
    await run(
      ["--apply", "--report", first.out, "--report-sha256", first.sha],
      catalog,
    );
    const settled = await counts();
    const again = await dryRun(await catalogOf());
    const plan = JSON.parse(again.text);
    expect(
      plan.workspaces[0].profiles.filter(
        (p: { decision: string }) => p.decision === "copy",
      ),
    ).toEqual([]);
    const result = await run(
      ["--apply", "--report", again.out, "--report-sha256", again.sha],
      await catalogOf(),
    );
    expect(result.code).toBe(0);
    expect(await counts()).toEqual(settled);

    const replay = await run(
      ["--apply", "--report", first.out, "--report-sha256", first.sha],
      await catalogOf(),
    );
    expect(replay.code).toBe(0);
    expect(await counts()).toEqual(settled);
  });

  test("it refuses to write while an active release has no settings row, or a workspace has no ceiling", async () => {
    await seedBase();
    const ws = await workspace();
    const first = await catalogOf();
    const v1 = await wsVersion(ws, first, "strict");
    const catalog = await catalogOf();
    await agentOn(ws, catalog, v1, { settingsRow: false });
    const report = await dryRun(await catalogOf());
    expect(JSON.parse(report.text).preconditions.r2_complete).toBe(false);
    const before = await counts();
    const refused = await run(
      ["--apply", "--report", report.out, "--report-sha256", report.sha],
      await catalogOf(),
    );
    expect(refused.code).toBe(1);
    expect(String(refused.last.refused)).toContain("R2 is not complete");
    expect(await counts()).toEqual(before);

    const bare = await workspace({ ceiling: false });
    void bare;
    const second = await dryRun(await catalogOf());
    expect(
      JSON.parse(second.text).preconditions.null_ceiling_workspaces,
    ).toHaveLength(1);
  });

  test("an agent a person changed after the report is left where it is and named", async () => {
    const { onV1, onV2, catalog } = await world();
    const report = await dryRun(catalog);
    await db
      .update(agents)
      .set({ behaviorRevision: 5 })
      .where(eq(agents.id, onV1));
    const applied = await run(
      ["--apply", "--report", report.out, "--report-sha256", report.sha],
      catalog,
    );
    expect(applied.code).toBe(1);
    const left = JSON.stringify(applied.last);
    expect(left).toContain(onV1);
    expect(left).toContain("changed_since_report");
    const a1 = await agentRow(onV1);
    expect(
      (await releaseOf(a1?.activeReleaseId))?.runtimeProfileId,
    ).toStartWith("ws_");
    expect(
      (await releaseOf((await agentRow(onV2))?.activeReleaseId))
        ?.runtimeProfileId,
    ).toStartWith("op_wl_");
  });

  test("revert puts the agents back and retires the copies; it skips an agent changed since, deletes nothing, and keeps the ceiling", async () => {
    const { ws, onV1, onV2, catalog } = await world();
    const startedOn = {
      v1: (await agentRow(onV1))?.activeReleaseId,
      v2: (await agentRow(onV2))?.activeReleaseId,
    };
    const report = await dryRun(catalog);
    await run(
      ["--apply", "--report", report.out, "--report-sha256", report.sha],
      catalog,
    );
    const migrationId = JSON.parse(report.text).migration_id as string;
    const written = await counts();
    await db
      .update(agents)
      .set({ profileTracking: "pinned" })
      .where(eq(agents.id, onV2));

    const reverted = await run(
      ["--revert", "--migration-id", migrationId],
      await catalogOf(),
    );
    expect(reverted.code).toBe(0);
    const a1 = await agentRow(onV1);
    expect(a1?.activeReleaseId).toBe(startedOn.v1 as string);
    expect(a1?.profileTracking).toBe("follow");
    const a2 = await agentRow(onV2);
    expect(a2?.activeReleaseId).not.toBe(startedOn.v2 as string);
    expect(JSON.stringify(reverted.last)).toContain("changed_since_migration");

    const rows = await copies();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.retiredAt !== null)).toBe(true);
    const after = await counts();
    expect(after.profiles).toBe(written.profiles);
    expect(after.releases).toBe(written.releases);
    const [ceiling] = await db
      .select()
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, ws.workspaceId));
    expect(
      (ceiling?.repositoryCeiling as { repository_ids: string[] })
        .repository_ids,
    ).toEqual(["private-a"]);
    expect(
      await db
        .select()
        .from(installationProfiles)
        .where(
          inArray(
            installationProfiles.id,
            rows.map((row) => row.id),
          ),
        ),
    ).toHaveLength(2);

    // Running the revert again undoes nothing, with nobody having touched
    // the agent, and overwrites nothing a person changed since.
    await run(["--revert", "--migration-id", migrationId], await catalogOf());
    expect((await agentRow(onV1))?.activeReleaseId).toBe(
      startedOn.v1 as string,
    );
    await db
      .update(agents)
      .set({ profileTracking: "pinned" })
      .where(eq(agents.id, onV1));
    await run(["--revert", "--migration-id", migrationId], await catalogOf());
    const again = await agentRow(onV1);
    expect(again?.activeReleaseId).toBe(startedOn.v1 as string);
    expect(again?.profileTracking).toBe("pinned");
  });

  test("a newer version of the name made after the report stops the move that would have followed it", async () => {
    const { ws, onV2, catalog } = await world();
    const report = await dryRun(catalog);
    expect(
      JSON.parse(report.text).workspaces[0].agents.find(
        (a: { agent_id: string }) => a.agent_id === onV2,
      ).tracking_after,
    ).toBe("follow");
    await wsVersion(ws, await catalogOf(), "strict", ["Read", "Bash"]);
    const applied = await run(
      ["--apply", "--report", report.out, "--report-sha256", report.sha],
      await catalogOf(),
    );
    expect(applied.code).toBe(1);
    expect(JSON.stringify(applied.last)).toContain("plan_changed");
    expect(
      (await releaseOf((await agentRow(onV2))?.activeReleaseId))
        ?.runtimeProfileId,
    ).toStartWith("ws_");
    // The pinned agent did move onto the first copy; the newer version can
    // still be copied behind it by the next report.
    const next = await dryRun(await catalogOf());
    const finished = await run(
      ["--apply", "--report", next.out, "--report-sha256", next.sha],
      await catalogOf(),
    );
    expect(finished.code).toBe(0);
    expect(await copies()).toHaveLength(3);
  });

  test("a revert of a migration that wrote nothing refuses", async () => {
    await seedBase();
    const result = await run(
      ["--revert", "--migration-id", randomUUID()],
      await catalogOf(),
    );
    expect(result.code).toBe(1);
  });
});
