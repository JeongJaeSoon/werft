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
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const TAG = "0290_agent_archive";

integration("0290 on a database that already has agents", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  let through: string;
  const workspaceId = randomUUID();
  const archivedId = randomUUID();
  let teamId: string;

  const agent = (id: string, slug: string, status = "active") =>
    pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', $5)",
      [id, workspaceId, teamId, slug, status],
    );

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "agent_archive_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough(TAG, { exclusive: true });
    through = migrationsThrough(TAG);
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    teamId = await fixtureTeamSql(pool, workspaceId);
    await agent(randomUUID(), "live");
    // Archived before deletes existed: it keeps its slug and is not deleted.
    await agent(archivedId, "old", "archived");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    for (const folder of [before, through]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  test("leaves every existing agent undeleted and keeps their slugs taken", async () => {
    await migrate(drizzle(pool), { migrationsFolder: through });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM agents WHERE workspace_id = $1 AND deleted_at IS NULL AND deleted_by IS NULL",
      [workspaceId],
    );
    expect(rows).toEqual([{ n: 2 }]);
    await expect(agent(randomUUID(), "live")).rejects.toThrow(
      /agents_workspace_slug_idx/,
    );
    await expect(agent(randomUUID(), "old")).rejects.toThrow(
      /agents_workspace_slug_idx/,
    );
  }, 60_000);

  test("afterwards a deleted agent's slug is free", async () => {
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "UPDATE agents SET deleted_at = now(), deleted_by = $2 WHERE id = $1",
      [archivedId, userId],
    );
    await agent(randomUUID(), "old");
  });
});
