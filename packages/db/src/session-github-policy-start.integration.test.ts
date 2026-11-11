import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import * as schema from "./schema.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough,
} from "./testing/migrations-through.ts";

// Each test applies the migration chain itself, on a fresh database the way
// its hooks prepare one. That is about a second on a quiet runner and went past
// bun's 5s default on a busy one (runs 43076026816 and 43076744519), so the
// tests get the same headroom as their hooks.
const MIGRATION_CHAIN_TIMEOUT = 60_000;

const integration = testDatabaseUrl() ? describe : describe.skip;

// Up to the profile removal: 0270 empties the session tables these rows sit in.
async function migrateBeforeRemoval(db: Parameters<typeof migrate>[0]) {
  const folder = migrationsThrough(BEFORE_PROFILE_REMOVAL);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const BEFORE = "0231_agent_github_settings";

const repositories = (count: number) =>
  JSON.stringify(Array.from({ length: count }, (_, i) => `repo-${i}`));

// The expand step of the repository cap removal: rows from before read the
// same, the old image's writes still land, and only the cap is gone.
integration("sessions.github_policy_start and the repository cap", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "policy_start_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough(BEFORE);
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  async function agentWith(count: number) {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', (SELECT id FROM t))",
      [agentId, workspaceId],
    );
    await insertSettings(workspaceId, agentId, count);
    return { workspaceId, agentId };
  }
  const insertSettings = (
    workspaceId: string,
    agentId: string,
    count: number,
  ) =>
    pool.query(
      `INSERT INTO agent_github_settings
         (agent_id, workspace_id, repositories, push_approval, features, actions_allow)
       VALUES ($1, $2, $3, true, '{}', '[]')`,
      [agentId, workspaceId, repositories(count)],
    );

  test(
    "rows from before read the same; 33 repositories were refused before and are accepted after",
    async () => {
      await migrate(db, { migrationsFolder: before });
      const { agentId } = await agentWith(32);
      const sessionId = randomUUID();
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
        [sessionId],
      );
      const second = await agentWith(2);
      await expect(
        pool.query(
          "UPDATE agent_github_settings SET repositories = $2::jsonb WHERE agent_id = $1",
          [second.agentId, repositories(33)],
        ),
      ).rejects.toThrow("agent_github_settings_repositories_check");

      await migrateBeforeRemoval(db);

      const { rows } = await pool.query<{ n: number; push_approval: boolean }>(
        `SELECT jsonb_array_length(repositories) AS n, push_approval
         FROM agent_github_settings WHERE agent_id = $1`,
        [agentId],
      );
      expect(rows).toEqual([{ n: 32, push_approval: true }]);
      expect(
        (
          await pool.query(
            "SELECT github_policy_start, github_policy_source FROM sessions WHERE id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([
        { github_policy_start: null, github_policy_source: "release" },
      ]);

      await pool.query(
        "UPDATE agent_github_settings SET repositories = $2::jsonb WHERE agent_id = $1",
        [second.agentId, repositories(40)],
      );
      expect(
        (
          await pool.query(
            "SELECT jsonb_array_length(repositories) AS n FROM agent_github_settings WHERE agent_id = $1",
            [second.agentId],
          )
        ).rows,
      ).toEqual([{ n: 40 }]);
      // Only the shape is still checked.
      await expect(
        pool.query(
          "UPDATE agent_github_settings SET repositories = '{}'::jsonb WHERE agent_id = $1",
          [second.agentId],
        ),
      ).rejects.toThrow("agent_github_settings_repositories_check");
    },
    MIGRATION_CHAIN_TIMEOUT,
  );

  test(
    "the image from before still writes sessions, and the migration can run again",
    async () => {
      await migrate(db, { migrationsFolder: before });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      // A session written without the column lands with it null.
      const sessionId = randomUUID();
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
        [sessionId],
      );
      expect(
        (
          await pool.query(
            "SELECT github_policy_start FROM sessions WHERE id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ github_policy_start: null }]);

      // A part-way failure leaves the statements before it committed: the file
      // run a second time changes nothing.
      const sql = await readFile(
        join(MIGRATIONS_FOLDER, "0234_session_github_policy_start.sql"),
        "utf8",
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        await pool.query(statement);
      }
      await agentWith(40);
    },
    MIGRATION_CHAIN_TIMEOUT,
  );
});
