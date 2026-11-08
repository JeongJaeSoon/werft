import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_CEILING_NONE, GITHUB_FEATURES_NONE } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";
import { generateReport } from "../scripts/lib/repository-migration-report.ts";
import {
  applyMigration,
  planMigration,
  revertMigration,
} from "../scripts/lib/repository-migration-write.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PIN = (repositories: unknown, pushApproval = false) => ({
  github: {
    repositories,
    push_approval: pushApproval,
    features: { ...GITHUB_FEATURES_NONE, issues: true },
    actions_allow: [],
  },
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const open: Array<() => Promise<void>> = [];
// Before-image files go under the card's temporary directory.
mkdirSync(join(tmpdir(), "awr-1363w"), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "awr-1363w", "t-"));

async function fixture() {
  const database: TempDatabase = await createTempDatabase({
    prefix: "repo_write_it",
  });
  const pool = new Pool({ connectionString: database.url, max: 6 });
  open.push(async () => {
    await pool.end();
    await database.drop();
  });
  const ids = {
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    user: randomUUID(),
  };
  const agents: Record<string, { agentId: string; releaseId: string }> = {};

  const repository = (id: string, authKind: string) =>
    pool.query(
      `INSERT INTO catalog_repositories (id, owner, name, url, branch, profiles,
         auth_kind, auth, credential_source, source)
       VALUES ($1, 'acme', $1, 'https://example.invalid/' || $1, 'main', NULL,
         $2, $3, $4, 'seed')`,
      [
        id,
        authKind,
        authKind === "github_app" || authKind === "none"
          ? null
          : JSON.stringify({ kind: "basic", username: "u", value: "secret" }),
        authKind === "github_app" || authKind === "none" ? null : "external",
      ],
    );
  const workspace = async (id: string, ceiling: unknown | undefined) => {
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [id, `ws-${id.slice(0, 8)}`],
    );
    if (ceiling !== undefined) {
      await pool.query(
        `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling)
         VALUES ($1, $2, $3)`,
        [
          id,
          JSON.stringify(GITHUB_CEILING_NONE),
          ceiling === null ? null : JSON.stringify(ceiling),
        ],
      );
    }
  };
  const profile = (id: string, scope: string, list: string[]) =>
    pool.query(
      `INSERT INTO installation_profiles (id, name, version, origin, definition,
         permission_mode, fingerprint, repository_ids, repository_scope)
       VALUES ($1, $1, 1, 'console', '{"permission_mode":"default"}', 'default',
         'fp', $2, $3)`,
      [id, JSON.stringify(list), scope],
    );
  const agent = async (
    key: string,
    workspaceId: string,
    options: {
      pins: object;
      profile: string;
      releaseRepository?: string;
      row?: { repositories: string[]; updatedBy: string | null };
    },
  ) => {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, github_enabled) VALUES ($1, $2, $3, $4, true)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, key],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', '{}', $8)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        options.profile,
        options.releaseRepository ?? null,
        `sha256:${"c".repeat(64)}`,
        JSON.stringify(options.pins),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    if (options.row !== undefined) {
      await pool.query(
        `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
           push_approval, features, actions_allow, revision, updated_by)
         VALUES ($1, $2, $3, true, $4, '[]', 3, $5)`,
        [
          agentId,
          workspaceId,
          JSON.stringify(options.row.repositories),
          JSON.stringify(GITHUB_CEILING_NONE),
          options.row.updatedBy,
        ],
      );
    }
    agents[key] = { agentId, releaseId };
  };
  const session = (
    workspaceId: string | null,
    repositoryId: string,
    profileId: string,
    status = "running",
  ) =>
    pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, created_by_user_id, github_policy_source,
         checkpoint_revision, status, profile_id)
       VALUES ($1, $2, 'https://example.invalid/r.git', 'main', $3, $4, $5,
         'release', 1, $6, $7)`,
      [
        randomUUID(),
        workspaceId ?? ids.user,
        repositoryId,
        workspaceId,
        ids.user,
        status,
        profileId,
      ],
    );

  await pool.query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
    [ids.user, `${ids.user}@example.invalid`],
  );
  await repository("app-1", "github_app");
  await repository("pat-url", "basic");
  for (const id of [
    "private-a",
    "shared-x",
    "orphan-x",
    "loose-x",
    "lonely-x",
    "held-x",
  ]) {
    await repository(id, "github_app_explicit");
  }
  // A already holds a URL value and an explicit one; B's ceiling is NULL; C
  // has no settings row at all.
  await workspace(ids.a, {
    repository_ids: ["pat-url", "held-x"],
    github_app_repositories: "listed",
  });
  await workspace(ids.b, null);
  await workspace(ids.c, undefined);
  await profile("p-list", "profile", ["private-a", "orphan-x", "pat-url"]);
  await profile("p-ws", "workspace", []);
  await profile("p-b", "profile", ["shared-x"]);
  await profile("p-lonely", "profile", ["lonely-x"]);

  // A1: a pin with a URL value; release repository inside the pin.
  await agent("a1", ids.a, {
    pins: PIN(["private-a", "pat-url"]),
    profile: "p-list",
    releaseRepository: "private-a",
  });
  // A2: a person already saved a row. Never touched.
  await agent("a2", ids.a, {
    pins: PIN(["orphan-x"]),
    profile: "p-list",
    row: { repositories: ["held-x"], updatedBy: ids.user },
  });
  // A3: pre-settings release judged by the profile list.
  await agent("a3", ids.a, { pins: {}, profile: "p-list" });
  // A4: pre-settings release on a workspace-judged profile.
  await agent("a4", ids.a, { pins: {}, profile: "p-ws" });
  // A5: a pin this image cannot read.
  await agent("a5", ids.a, {
    pins: PIN({ not: "an array" }),
    profile: "p-list",
  });
  await agent("b1", ids.b, {
    pins: PIN(["shared-x"]),
    profile: "p-b",
    releaseRepository: "shared-x",
  });
  // Sessions: B's agentless one makes shared-x B's. loose-x has no workspace.
  await session(ids.b, "shared-x", "p-list");
  await session(null, "loose-x", "p-list");

  const settingsDump = async () =>
    (
      await pool.query(
        `SELECT agent_id, workspace_id, repositories, push_approval, features,
                actions_allow, start_repository_id, revision, updated_by
         FROM agent_github_settings ORDER BY agent_id`,
      )
    ).rows;
  const ceilingDump = async () =>
    (
      await pool.query(
        `SELECT workspace_id, ceiling, repository_ceiling
         FROM github_workspace_settings ORDER BY workspace_id`,
      )
    ).rows;
  /** repository_ceiling per workspace; a missing row reads as NULL. */
  const ceilingOf = async () => {
    const rows = await ceilingDump();
    return Object.fromEntries(
      [ids.a, ids.b, ids.c].map((id) => [
        id,
        rows.find((row) => row.workspace_id === id)?.repository_ceiling ?? null,
      ]),
    );
  };
  const rowOf = async (key: string) =>
    (
      await pool.query(
        "SELECT * FROM agent_github_settings WHERE agent_id = $1",
        [agents[key]?.agentId],
      )
    ).rows[0];
  const file = (name: string) => join(scratch, `${randomUUID()}-${name}.json`);
  return {
    pool,
    ids,
    agents,
    settingsDump,
    ceilingDump,
    ceilingOf,
    rowOf,
    file,
  };
}

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const sortedIds = (list: Array<{ id: string }>) => list.map((e) => e.id).sort();

integration("the repository migration write", () => {
  const T0 = new Date("2026-11-05T01:00:00.000Z");
  const T1 = new Date("2026-11-05T02:00:00.000Z");

  test("plan writes nothing and apply writes what the report promised", async () => {
    const f: Fixture = await fixture();
    const settingsBefore = await f.settingsDump();
    const ceilingBefore = await f.ceilingDump();

    const plan = await planMigration(f.pool, T0);
    expect(await f.settingsDump()).toEqual(settingsBefore);
    expect(await f.ceilingDump()).toEqual(ceilingBefore);
    // a2 has a row, a5's pin is unreadable
    expect(plan.agent_rows_skipped.map((s) => s.reason).sort()).toEqual([
      "has_row",
      "pin_unreadable",
    ]);

    // B's ceiling is NULL and C has no settings row: both are counted
    expect(plan.ceiling_unset).toEqual([f.ids.b, f.ids.c].sort());

    const path = f.file("apply");
    const result = await applyMigration(f.pool, path, T0);
    expect(result.ceiling_unset).toEqual({ before: 2, after: 0 });
    expect(result.changes).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.partial`)).toBe(false);

    // rows: only agents without one, all `updated_by = NULL`, written at T0
    const written = (await f.settingsDump()).filter(
      (row) => row.updated_by === null,
    );
    expect(written.map((r) => r.agent_id).sort()).toEqual(
      [f.agents.a1, f.agents.a3, f.agents.a4, f.agents.b1]
        .map((a) => a?.agentId)
        .sort(),
    );
    const a1 = await f.rowOf("a1");
    // URL value is not copied; the release repository starts the session
    expect(a1.repositories).toEqual(["private-a"]);
    expect(a1.start_repository_id).toBe("private-a");
    expect(a1.features.issues).toBe(true);
    expect(a1.revision).toBe(1);
    expect(new Date(a1.updated_at).toISOString()).toBe(T0.toISOString());
    expect(
      plan.agent_rows.find((r) => r.agent_id === f.agents.a1?.agentId)
        ?.url_not_moved,
    ).toEqual(["pat-url"]);
    // pre-settings release: the profile list without the URL value, a person
    // approves every push, nothing optional
    const a3 = await f.rowOf("a3");
    expect(a3.repositories).toEqual(["orphan-x", "private-a"]);
    expect(a3.push_approval).toBe(true);
    expect(a3.features).toEqual(GITHUB_FEATURES_NONE);
    // workspace-judged profile: the workspace ceiling it had, minus the URL
    const a4 = await f.rowOf("a4");
    expect(a4.repositories).toEqual(["held-x"]);
    expect(a4.push_approval).toBe(true);
    expect(a4.features).toEqual(GITHUB_FEATURES_NONE);
    // the dry-run says which agents these are and that nothing else moved
    expect(plan.pinless).toEqual({
      agents: 2,
      judged_by_profile: 1,
      judged_by_workspace_ceiling: 1,
      same_as_before: 2,
    });
    const pinless = (key: string) =>
      plan.agent_rows.find((r) => r.agent_id === f.agents[key]?.agentId);
    expect(pinless("a3")).toMatchObject({
      judged_by: "profile",
      allowed_before: ["orphan-x", "pat-url", "private-a"],
      allowed_after: ["orphan-x", "private-a"],
      url_not_moved: ["pat-url"],
    });
    expect(pinless("a4")).toMatchObject({
      judged_by: "workspace_ceiling",
      allowed_before: ["held-x", "pat-url"],
      allowed_after: ["held-x"],
    });
    // the person's row and the unreadable pin: untouched, no row
    expect((await f.rowOf("a2")).updated_by).toBe(f.ids.user);
    expect((await f.rowOf("a2")).repositories).toEqual(["held-x"]);
    expect(await f.rowOf("a5")).toBeUndefined();

    // ceilings
    const ceilings = await f.ceilingOf();
    const a = ceilings[f.ids.a] as {
      repository_ids: string[];
      github_app_repositories: string;
    };
    expect(a.github_app_repositories).toBe("installed");
    // what A held stays, URL value included; attributed values are added
    expect(a.repository_ids).toEqual(
      expect.arrayContaining(["pat-url", "held-x", "private-a", "orphan-x"]),
    );
    const b = ceilings[f.ids.b] as { repository_ids: string[] };
    expect(b.repository_ids).toContain("shared-x");
    // B never learns A's private value, nor the URL value
    expect(b.repository_ids).not.toContain("private-a");
    expect(b.repository_ids).not.toContain("pat-url");
    // C: attributed nothing, and still gets the explicit ceiling
    expect(ceilings[f.ids.c]).toEqual({
      repository_ids: [],
      github_app_repositories: "installed",
    });
    // no basis: reported, never written
    for (const id of ["loose-x", "lonely-x"]) {
      for (const ceiling of Object.values(ceilings) as Array<{
        repository_ids: string[];
      }>) {
        expect(ceiling.repository_ids).not.toContain(id);
      }
    }
    expect(plan.report.unattributed.map((u) => u.repository_id).sort()).toEqual(
      ["lonely-x", "loose-x"],
    );

    // the dry-run's allowed sets are the ones now in force
    const after = await generateReport(f.pool, null, T0);
    for (const workspace of plan.report.workspaces) {
      const now = after.workspaces.find(
        (w) => w.workspace_id === workspace.workspace_id,
      );
      expect(sortedIds(now?.ceiling_after_ids ?? [])).toEqual(
        sortedIds(workspace.ceiling_after_ids),
      );
      const reported = result.workspaces.find(
        (w) => w.workspace_id === workspace.workspace_id,
      );
      expect(reported?.allowed_after).toEqual(
        sortedIds(workspace.ceiling_after_ids),
      );
    }
  }, 60_000);

  test("a second run changes nothing", async () => {
    const f = await fixture();
    await applyMigration(f.pool, f.file("one"), T0);
    const settings = await f.settingsDump();
    const ceilings = await f.ceilingDump();
    const second = f.file("two");
    const again = await applyMigration(f.pool, second, T1);
    expect(again.changes).toBe(0);
    expect(again.ceiling_unset).toEqual({ before: 0, after: 0 });
    expect(again.before_image).toBeNull();
    expect(existsSync(second)).toBe(false);
    expect(await f.settingsDump()).toEqual(settings);
    expect(await f.ceilingDump()).toEqual(ceilings);
  }, 60_000);

  test("revert restores what the before-image says and leaves a person's change", async () => {
    const f = await fixture();
    const settingsBefore = await f.settingsDump();
    const ceilingsBefore = await f.ceilingOf();
    const path = f.file("revert");
    await applyMigration(f.pool, path, T0);
    // a person saves a1's settings by PUT after the migration
    await f.pool.query(
      "UPDATE agent_github_settings SET updated_by = $2, revision = 2 WHERE agent_id = $1",
      [f.agents.a1?.agentId, f.ids.user],
    );
    const reverted = await revertMigration(f.pool, path);
    const outcomes = Object.fromEntries(
      reverted.agent_rows.map((r) => [r.agent_id, r.outcome]),
    );
    expect(outcomes[f.agents.a1?.agentId as string]).toBe("changed_since");
    expect(outcomes[f.agents.a3?.agentId as string]).toBe("reverted");
    expect((await f.rowOf("a1")).updated_by).toBe(f.ids.user);
    // everything else is back as it was, the person's other row included
    const expected = settingsBefore;
    const now = (await f.settingsDump()).filter(
      (row) => row.agent_id !== f.agents.a1?.agentId,
    );
    expect(now).toEqual(expected);
    expect(await f.ceilingOf()).toEqual(ceilingsBefore);
    expect(reverted.workspace_ceilings.map((c) => c.outcome)).toEqual(
      expect.arrayContaining(["reverted"]),
    );

    // a second revert finds nothing left to do
    const twice = await revertMigration(f.pool, path);
    expect(
      twice.agent_rows.filter((r) => r.outcome === "reverted"),
    ).toHaveLength(0);
    expect(
      twice.workspace_ceilings.filter((r) => r.outcome === "reverted"),
    ).toHaveLength(0);
  }, 60_000);

  test("a ceiling saved after the migration is not reverted", async () => {
    const f = await fixture();
    const path = f.file("ceiling");
    await applyMigration(f.pool, path, T0);
    // putCeiling raises the shared revision without touching repository_ceiling
    await f.pool.query(
      "UPDATE github_workspace_settings SET revision = revision + 1 WHERE workspace_id = $1",
      [f.ids.b],
    );
    const held = (await f.ceilingOf())[f.ids.b];
    const reverted = await revertMigration(f.pool, path);
    expect(
      reverted.workspace_ceilings.find((c) => c.workspace_id === f.ids.b)
        ?.outcome,
    ).toBe("changed_since");
    expect((await f.ceilingOf())[f.ids.b]).toEqual(held);
    expect((await f.ceilingOf())[f.ids.a]).toEqual({
      repository_ids: ["pat-url", "held-x"],
      github_app_repositories: "listed",
    });
  }, 60_000);

  test("an old before-image does not take back a later run", async () => {
    const f = await fixture();
    const first = f.file("first");
    await applyMigration(f.pool, first, T0);
    await revertMigration(f.pool, first);
    // the same clock reading: only the writing transaction tells the runs apart
    await applyMigration(f.pool, f.file("second"), T0);
    const settings = await f.settingsDump();
    const ceilings = await f.ceilingDump();
    const stale = await revertMigration(f.pool, first);
    expect(
      [...stale.agent_rows, ...stale.workspace_ceilings].every(
        (r) => r.outcome === "changed_since",
      ),
    ).toBe(true);
    expect(await f.settingsDump()).toEqual(settings);
    expect(await f.ceilingDump()).toEqual(ceilings);
  }, 60_000);

  test("an update that keeps every value still stops the revert", async () => {
    const f = await fixture();
    const path = f.file("same-values");
    await applyMigration(f.pool, path, T0);
    // same value, same revision, same timestamp: only the writing transaction differs
    await f.pool.query(
      "UPDATE agent_github_settings SET push_approval = push_approval, updated_at = updated_at WHERE agent_id = $1",
      [f.agents.a1?.agentId],
    );
    await f.pool.query(
      "UPDATE github_workspace_settings SET repository_ceiling = repository_ceiling, updated_at = updated_at WHERE workspace_id = $1",
      [f.ids.b],
    );
    const reverted = await revertMigration(f.pool, path);
    expect(
      reverted.agent_rows.find((r) => r.agent_id === f.agents.a1?.agentId)
        ?.outcome,
    ).toBe("changed_since");
    expect(
      reverted.workspace_ceilings.find((c) => c.workspace_id === f.ids.b)
        ?.outcome,
    ).toBe("changed_since");
    expect(await f.rowOf("a1")).toBeDefined();
    expect((await f.rowOf("a3")) === undefined).toBe(true);
  }, 60_000);

  test("a before-image from another database or too long ago is refused", async () => {
    const f = await fixture();
    const path = f.file("old");
    await applyMigration(f.pool, path, T0);
    const image = JSON.parse(readFileSync(path, "utf8"));
    // A transaction id ahead of this database's. (One 2^31 behind needs a
    // database that old; the same bound refuses it.)
    const tampered = f.file("tampered");
    writeFileSync(tampered, JSON.stringify({ ...image, txid: "999999999999" }));
    const before = await f.settingsDump();
    await expect(revertMigration(f.pool, tampered)).rejects.toThrow(
      /too old or from another database/,
    );
    expect(await f.settingsDump()).toEqual(before);
    // the untouched file still reverts
    const reverted = await revertMigration(f.pool, path);
    expect(reverted.agent_rows.some((r) => r.outcome === "reverted")).toBe(
      true,
    );
  }, 60_000);

  test("a failed before-image write rolls everything back", async () => {
    const f = await fixture();
    const settings = await f.settingsDump();
    const ceilings = await f.ceilingDump();
    await expect(
      applyMigration(f.pool, join(scratch, "missing-dir", "x.json"), T0),
    ).rejects.toThrow();
    expect(await f.settingsDump()).toEqual(settings);
    expect(await f.ceilingDump()).toEqual(ceilings);
    // an existing file is never replaced
    const taken = f.file("taken");
    await applyMigration(f.pool, taken, T0);
    await revertMigration(f.pool, taken);
    const body = readFileSync(taken, "utf8");
    await expect(applyMigration(f.pool, taken, T1)).rejects.toThrow();
    expect(readFileSync(taken, "utf8")).toBe(body);
    expect(await f.settingsDump()).toEqual(settings);
  }, 60_000);

  test("the before-image carries ids and settings, no URL or credential", async () => {
    const f = await fixture();
    const path = f.file("content");
    await applyMigration(f.pool, path, T0);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).version).toBe(1);
  }, 60_000);

  test("takes the agent row before its settings, as a session start does", async () => {
    const f = await fixture();
    // A session start holds the agent row, then wants its settings row.
    const start = await f.pool.connect();
    try {
      await start.query("BEGIN");
      await start.query("SELECT id FROM agents WHERE id = $1 FOR SHARE", [
        f.agents.a1?.agentId,
      ]);
      let done = false;
      const applied = applyMigration(f.pool, f.file("lock"), T0).finally(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // the migration waits on the agent row before it touches any settings
      expect(done).toBe(false);
      await start.query(
        "SELECT agent_id FROM agent_github_settings WHERE agent_id = $1 FOR SHARE",
        [f.agents.a2?.agentId],
      );
      await start.query("COMMIT");
      expect((await applied).changes).toBeGreaterThan(0);
    } finally {
      start.release();
    }
  }, 60_000);
});
