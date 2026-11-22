import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { reconcileRetiredCatalogDrafts } from "./agents/retired-catalog-drafts.ts";
import { migrate, migrateDatabase } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import * as schema from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const CATALOG_CARD = {
  language: "follow-user",
  model: "claude-sonnet-5",
  rules: [],
  capabilities: {
    mcp: [{ server: "docs" }],
    forbidden: [],
    tool_policy: { per_tool: { mcp__docs__read: "allow" } },
    credential_refs: ["docs-ref", "other-ref"],
  },
};

/**
 * 0303 against an old host's writer that holds its locks: the writer
 * commits, the migration waits for it, and what it wrote is recorded and
 * cleaned. Neither side deadlocks.
 */
integration("0303 beside an old host's writes", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  let workspaceId: string;
  let teamId: string;

  async function preRetire() {
    database = await createTempDatabase({
      migrate: false,
      prefix: "retire_catalog_locks",
    });
    pool = new Pool({ connectionString: database.url, max: 4 });
    before = migrationsThrough("0303_retire_catalog_mcp", { exclusive: true });
    await migrate(drizzle(pool), { migrationsFolder: before });
    workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    teamId = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source, workspaces, origin)
       VALUES ('docs', 'https://docs.example.invalid/mcp', 'docs-ref', $1, 'stored', '["acme"]', 'import')`,
      [JSON.stringify({ kind: "bearer", stored: "mcp:docs" })],
    );
  }

  afterEach(async () => {
    await pool?.end();
    await database?.drop();
    if (before) rmSync(before, { recursive: true, force: true });
  });

  async function insertAgent(on: Pool | PoolClient): Promise<string> {
    const agentId = randomUUID();
    await on.query(
      "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, $4)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, teamId],
    );
    return agentId;
  }

  async function insertCatalogDraft(
    on: Pool | PoolClient,
    agentId: string,
  ): Promise<string> {
    const versionId = randomUUID();
    await on.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, $3, $4)`,
      [versionId, agentId, JSON.stringify(CATALOG_CARD), "1".repeat(64)],
    );
    await on.query(
      "UPDATE agents SET draft_version_id = $1, draft_connection_id = $2 WHERE id = $3",
      [versionId, TEST_CONNECTION_ID, agentId],
    );
    return versionId;
  }

  // Starts the migration and resolves once a backend of this database waits
  // on the writer itself, not on any lock of the instance. Boxed: an async
  // function returning the promise would adopt it.
  async function migrationWaiting(
    writerPid: number,
  ): Promise<{ running: Promise<void> }> {
    const running = migrate(drizzle(pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    running.catch(() => {});
    for (let tries = 0; tries < 200; tries += 1) {
      const { rows } = await pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [writerPid],
      );
      if ((rows[0]?.waiting ?? 0) > 0) return { running };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the migration never waited on the writer");
  }

  async function holding<T>(
    write: (client: PoolClient) => Promise<void>,
    finish: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await client.query("BEGIN");
      await write(client);
      const { running } = await migrationWaiting(rows[0]?.pid ?? 0);
      const result = await finish(client);
      await client.query("COMMIT");
      await running;
      return result;
    } finally {
      client.release();
    }
  }

  test("an import or console write holding the catalog locks commits first, and its server is recorded and removed", async () => {
    await preRetire();
    await holding(
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))",
        );
        await client.query("SELECT 1 FROM settings_generation FOR UPDATE");
        await client.query(
          `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source, workspaces, origin)
           VALUES ('late', 'https://late.example.invalid/mcp', 'late-ref', $1, 'stored', '["acme"]', 'import')`,
          [JSON.stringify({ kind: "bearer", stored: "mcp:late" })],
        );
      },
      async () => {},
    );
    const recorded = await pool.query(
      "SELECT name, credential_ref FROM retired_catalog_mcp ORDER BY name",
    );
    expect(recorded.rows).toEqual([
      { name: "docs", credential_ref: "docs-ref" },
      { name: "late", credential_ref: "late-ref" },
    ]);
    const left = await pool.query("SELECT count(*)::int AS n FROM mcp_servers");
    expect(left.rows).toEqual([{ n: 0 }]);
  }, 60_000);

  test("an agent create paused between its agents and agent_versions inserts finishes, and its draft is reconciled", async () => {
    await preRetire();
    const agentId = await holding(
      (client) => insertAgent(client).then(() => {}),
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM agents WHERE workspace_id = $1",
          [workspaceId],
        );
        const id = rows[0]?.id ?? "";
        await insertCatalogDraft(client, id);
        return id;
      },
    );
    const db = drizzle(pool, { schema });
    expect(await reconcileRetiredCatalogDrafts(db)).toEqual({
      moved: 1,
      unreadable: 0,
    });
    const draft = await pool.query(
      `SELECT v.card -> 'capabilities' -> 'mcp' AS mcp, v.card -> 'capabilities' -> 'credential_refs' AS refs
       FROM agents a JOIN agent_versions v ON v.id = a.draft_version_id WHERE a.id = $1`,
      [agentId],
    );
    expect(draft.rows).toEqual([{ mcp: null, refs: ["other-ref"] }]);
  }, 60_000);

  test("a draft save holding the agent row finishes before the migration", async () => {
    await preRetire();
    const agentId = await insertAgent(pool);
    await holding(
      async (client) => {
        await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [
          agentId,
        ]);
      },
      (client) => insertCatalogDraft(client, agentId),
    );
    const named = await pool.query(
      `SELECT card_names_catalog_mcp(v.card) AS named
       FROM agents a JOIN agent_versions v ON v.id = a.draft_version_id WHERE a.id = $1`,
      [agentId],
    );
    expect(named.rows).toEqual([{ named: true }]);
    // After 0303 the same save is refused.
    const again = randomUUID();
    await expect(
      pool.query(
        `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
         VALUES ($1, $2, 2, $3, $4)`,
        [again, agentId, JSON.stringify(CATALOG_CARD), "2".repeat(64)],
      ),
    ).rejects.toThrow(/installation catalog MCP servers are retired/);
  }, 60_000);

  test("a release create holding the agent row finishes before the migration, and the release stays", async () => {
    await preRetire();
    const agentId = await insertAgent(pool);
    const versionId = await insertCatalogDraft(pool, agentId);
    const releaseId = `sha256:${agentId.replaceAll("-", "")}`;
    await holding(
      async (client) => {
        await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [
          agentId,
        ]);
      },
      async (client) => {
        await client.query(
          `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
             repository_id, runtime_config_snapshot, effective_tools, policy_pins,
             ${RELEASE_SPEC_SQL_COLUMNS})
           VALUES ($1, $2, $3, $4, NULL, '{}', $5, '{}', ${releaseSpecSqlValues()})`,
          [
            releaseId,
            agentId,
            versionId,
            "a".repeat(64),
            JSON.stringify({ tools: [], mcp: ["mcp__docs__read"] }),
          ],
        );
      },
    );
    const release = await pool.query(
      "SELECT version_id FROM agent_releases WHERE id = $1",
      [releaseId],
    );
    expect(release.rows).toEqual([{ version_id: versionId }]);
  }, 60_000);

  test("a session create holding its agent row inserts its session first, and counts as created before the retire", async () => {
    await preRetire();
    const agentId = await insertAgent(pool);
    const sessionId = randomUUID();
    const createdAt = await holding(
      async (client) => {
        // lockedNotRunnable: the agent row, then the session insert.
        await client.query("SELECT id FROM agents WHERE id = $1 FOR SHARE", [
          agentId,
        ]);
      },
      async (client) => {
        const { rows } = await client.query<{ created_at: Date }>(
          `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
           VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')
           RETURNING created_at`,
          [sessionId],
        );
        return rows[0]?.created_at;
      },
    );
    const { rows } = await pool.query<{ retired_at: Date }>(
      "SELECT retired_at FROM retired_catalog_mcp WHERE name = 'docs'",
    );
    const retiredAt = rows[0]?.retired_at;
    if (createdAt === undefined || retiredAt === undefined) {
      throw new Error("no session or no retired row");
    }
    expect(createdAt.getTime()).toBeLessThan(retiredAt.getTime());
  }, 60_000);

  test("the operator log names the retired servers and counts the selections, and holds no URL or credential name", async () => {
    await preRetire();
    const sink = new MemoryLogSink();
    await pool.end();
    await migrateDatabase(database.url, {
      logger: createLogger({ sinks: [sink] }),
    });
    pool = new Pool({ connectionString: database.url, max: 1 });
    const notices = sink.records.filter(
      (record) => record.message === "db.migrate.notice",
    );
    expect(notices.map((record) => record.fields?.notice)).toEqual([
      "0303: 1 catalog MCP servers retired (docs), 0 agent catalog selections retired",
    ]);
    const written = JSON.stringify(sink.records);
    expect(written).not.toContain("docs.example.invalid");
    expect(written).not.toContain("docs-ref");
  }, 60_000);
});
