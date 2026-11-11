import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough,
} from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * 0269 drops the profiles and what was made against them: an installation
 * that ran on profiles keeps its agents, versions, teams and settings, and
 * loses its releases, sessions and the profile tables, as the migration says.
 */
integration("0269 removes the profiles from a database that used them", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const versionId = randomUUID();
  const releaseId = `sha256:${"r".repeat(64)}`;
  const sessionId = randomUUID();
  const attemptId = randomUUID();

  const tableExists = async (name: string) =>
    (
      await pool.query("SELECT to_regclass($1) IS NOT NULL AS found", [
        `public.${name}`,
      ])
    ).rows[0]?.found as boolean;
  const columnsOf = async (table: string) =>
    (
      await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table],
      )
    ).rows.map((row) => row.column_name);
  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "remove_profiles_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough(BEFORE_PROFILE_REMOVAL);
    await migrate(drizzle(pool), { migrationsFolder: before });

    // What an installation on profiles held at 0268.
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO installation_profiles (id, version, origin, definition, permission_mode, fingerprint)
       VALUES ('coding', 1, 'catalog', '{"permission_mode":"default"}', 'default', 'fp')`,
    );
    await pool.query(
      `INSERT INTO catalog_repositories (id, owner, name, url, branch, profiles, source)
       VALUES ('app', 'acme', 'app', 'https://github.com/acme/app.git', 'main', '["coding"]', 'seed')`,
    );
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'bot', 'bot', $3)",
      [agentId, workspaceId, await fixtureTeamSql(pool, workspaceId)],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{"model":"claude-sonnet-5"}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools)
       VALUES ($1, $2, $3, $4, 'coding', 'digest', '{"model":"claude-sonnet-5"}', '{}')`,
      [releaseId, agentId, versionId, "a".repeat(64)],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    await pool.query(
      `INSERT INTO agent_engine_settings (agent_id, workspace_id, permissions, auto_mode, admin_deny, revision)
       VALUES ($1, $2, '{"deny":["Bash"]}', '{}', '[]', 1)`,
      [agentId, workspaceId],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, profile_id, profile_fingerprint, model)
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'app',
         $3, $4, 'coding', 'fp', 'claude-sonnet-5')`,
      [sessionId, workspaceId, workspaceId, releaseId],
    );
    await pool.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch,
         execution_generation, auth_revision, state, lease_expires_at, profile_id)
       VALUES ($1, $2, 'exec', 1, 1, 1, 'running', now(), 'coding')`,
      [attemptId, sessionId],
    );
    await pool.query(
      "INSERT INTO turns (session_id, sequence, message, status) VALUES ($1, 1, 'hello', 'queued')",
      [sessionId],
    );

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
    rmSync(before, { recursive: true, force: true });
  }, 60_000);

  test("the profile tables and the staged-removal gates are dropped", async () => {
    for (const table of [
      "installation_profiles",
      "workspace_profiles",
      "profile_rollouts",
      "profile_rollout_items",
      "profile_fill",
      "engine_settings_gate",
      "session_pin_cutover",
    ]) {
      expect(await tableExists(table), table).toBe(false);
    }
  });

  test("sessions, everything under them, releases and activations are emptied", async () => {
    for (const table of [
      "sessions",
      "attempts",
      "turns",
      "agent_releases",
      "agent_activation_events",
      "session_links",
    ]) {
      expect(await count(table), table).toBe(0);
    }
  });

  test("the agent, its version, its team and its rules stay; it runs nothing until released again", async () => {
    const { rows } = await pool.query(
      "SELECT active_release_id, activation_revision, draft_version_id, draft_connection_id FROM agents WHERE id = $1",
      [agentId],
    );
    expect(rows).toEqual([
      {
        active_release_id: null,
        activation_revision: -1,
        draft_version_id: null,
        draft_connection_id: null,
      },
    ]);
    expect(await count("agent_versions")).toBe(1);
    expect(await count("member_teams")).toBe(1);
    const settings = await pool.query(
      "SELECT permissions, revision FROM agent_engine_settings WHERE agent_id = $1",
      [agentId],
    );
    expect(settings.rows).toEqual([
      { permissions: { deny: ["Bash"] }, revision: 1 },
    ]);
    const repositories = await pool.query(
      "SELECT id, url FROM catalog_repositories",
    );
    expect(repositories.rows).toEqual([
      { id: "app", url: "https://github.com/acme/app.git" },
    ]);
  });

  test("no column names a profile, and a release names its connection and spec", async () => {
    const dropped: Array<[string, string[]]> = [
      [
        "sessions",
        ["profile_id", "profile_fingerprint", "runtime_tools_source"],
      ],
      ["attempts", ["profile_id", "profile_fingerprint"]],
      ["checkpoints", ["profile_id", "profile_fingerprint"]],
      ["session_links", ["profile_id"]],
      ["catalog_repositories", ["profiles"]],
      ["agent_engine_settings", ["admin_deny"]],
      [
        "agents",
        [
          "profile_tracking",
          "model_source",
          "draft_profile_id",
          "draft_model_source",
        ],
      ],
      ["agent_releases", ["runtime_profile_id", "profile_digest"]],
    ];
    for (const [table, columns] of dropped) {
      const present = await columnsOf(table);
      for (const column of columns) {
        expect(present, `${table}.${column}`).not.toContain(column);
      }
    }
    expect(await columnsOf("agents")).toContain("draft_connection_id");
    const { rows } = await pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'agent_releases'
         AND column_name IN ('connection_id', 'spec_source', 'spec_source_digest', 'runtime_spec', 'spec_digest')
       ORDER BY column_name`,
    );
    expect(rows).toEqual(
      [
        "connection_id",
        "runtime_spec",
        "spec_digest",
        "spec_source",
        "spec_source_digest",
      ].map((column_name) => ({ column_name, is_nullable: "NO" })),
    );
  });

  test("a live session of a release must carry its pin; a session without a release need not", async () => {
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch) VALUES ($1, $2, 'https://github.com/acme/app.git', 'main')`,
      [randomUUID(), workspaceId],
    );
    const versionAgain = randomUUID();
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 2, '{}', $3)`,
      [versionAgain, agentId, "b".repeat(64)],
    );
    const spec = { a: 1 };
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256, connection_id,
         runtime_config_snapshot, effective_tools, spec_source, spec_source_digest, runtime_spec, spec_digest)
       VALUES ($1, $2, $3, $4, 'main', '{}', '{}', $5, $6, $5, $6)`,
      [
        `sha256:${"s".repeat(64)}`,
        agentId,
        versionAgain,
        "b".repeat(64),
        JSON.stringify(spec),
        `sha256:${"0".repeat(64)}`,
      ],
    );
    const refused = await pool
      .query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, agent_release_id, model)
         VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', $3, 'claude-sonnet-5')`,
        [randomUUID(), workspaceId, `sha256:${"s".repeat(64)}`],
      )
      .then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(refused).toContain("session_pin_required");
  });
});
