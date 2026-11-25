import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import {
  ENGINE_SETTINGS_DROP,
  migrationsThrough,
} from "./testing/migrations-through.ts";

const DROPPED = ["agent_engine_settings", "workspace_engine_settings"] as const;

/**
 * The drop of the two run-rule tables v0.4.0 stopped using takes their rows
 * with them and leaves the agent and the workspace they belonged to.
 */
describe("the engine settings tables are dropped", () => {
  let client: PGlite;
  let before: string;
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  const exists = async (table: string) =>
    (
      (
        await client.query("SELECT to_regclass($1) IS NOT NULL AS found", [
          `public.${table}`,
        ])
      ).rows[0] as { found: boolean }
    ).found;
  const count = async (table: string) =>
    Number(
      (
        (await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0] as {
          n: number | string;
        }
      ).n,
    );

  beforeAll(async () => {
    client = new PGlite();
    before = migrationsThrough(ENGINE_SETTINGS_DROP, { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });

    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    await client.query(
      `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, 'team') RETURNING id)
       INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', (SELECT id FROM t))`,
      [agentId, workspaceId],
    );
    await client.query(
      `INSERT INTO agent_engine_settings (agent_id, workspace_id, permissions)
       VALUES ($1, $2, '{"deny": ["Bash"]}')`,
      [agentId, workspaceId],
    );
    await client.query(
      `INSERT INTO workspace_engine_settings (workspace_id, auto_mode)
       VALUES ($1, '{"soft_deny": ["no force push"]}')`,
      [workspaceId],
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("the tables are there before, with rows in them", async () => {
    for (const table of DROPPED) {
      expect(await exists(table)).toBe(true);
      expect(await count(table)).toBe(1);
    }
  });

  test("after it, the tables are gone and the agent and workspace stay", async () => {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

    for (const table of DROPPED) {
      expect(await exists(table)).toBe(false);
    }
    expect(await count("workspaces")).toBe(1);
    expect(await count("agents")).toBe(1);
  });
});
