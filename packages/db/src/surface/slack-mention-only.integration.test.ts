import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";
import * as schema from "../schema.ts";
import { migrationsThrough } from "../testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("agents.slack_mention_only", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "mention_only_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0187_installation_profiles");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test("the agent's default becomes its one setting and every channel in use becomes on", async () => {
    await migrate(db, { migrationsFolder: before });
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const agents = { mention: randomUUID(), ambient: randomUUID() };
    for (const [mode, id] of Object.entries(agents)) {
      await pool.query(
        `INSERT INTO agents (id, workspace_id, slug, name, slack_default_mode)
         VALUES ($1, $2, $3, $3, $4)`,
        [id, workspaceId, mode, mode],
      );
    }
    const binding = (channel: string, mode: string) =>
      pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id,
           external_surface_id, surface_kind, mode, ceiling_actions,
           ceiling_disclosure, status)
         VALUES ($1, $2, $3, $4, 'public_channel', $5, ARRAY[]::text[],
           'full', 'partial')`,
        [randomUUID(), workspaceId, agents.mention, channel, mode],
      );
    await binding("C0MENTION", "mention");
    await binding("C0AMBIENT", "ambient");
    await binding("C0OFF", "off");

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const settings = await pool.query(
      "SELECT slug, slack_mention_only FROM agents ORDER BY slug",
    );
    expect(settings.rows).toEqual([
      { slug: "ambient", slack_mention_only: false },
      { slug: "mention", slack_mention_only: true },
    ]);
    const modes = await pool.query(
      "SELECT external_surface_id, mode FROM surface_bindings ORDER BY external_surface_id",
    );
    expect(modes.rows).toEqual([
      { external_surface_id: "C0AMBIENT", mode: "on" },
      { external_surface_id: "C0MENTION", mode: "on" },
      { external_surface_id: "C0OFF", mode: "off" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'slack_default_mode'",
        )
      ).rows,
    ).toEqual([]);
    await expect(binding("C0OLD", "mention")).rejects.toThrow(
      "surface_bindings_mode_check",
    );
  });
});
