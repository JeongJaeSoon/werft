import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const DROPPED = [
  "catalog_authority",
  "owner_workspace_map",
  "push_continuations",
] as const;

/**
 * 0305 drops three tables no release reads or writes, rows and all, and
 * leaves what their rows pointed at.
 */
describe("0305 drops the unused tables", () => {
  let client: PGlite;
  let before: string;
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();

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
    before = migrationsThrough("0305_drop_unused_tables", { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });

    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'a@example.invalid', 'h', 'a')",
      [userId],
    );
    await client.query(
      "INSERT INTO catalog_authority (id, revision) VALUES (1, 'sha256:old')",
    );
    await client.query(
      "INSERT INTO owner_workspace_map (owner_id, workspace_id, mapped_by) VALUES ('legacy', $1, $2)",
      [workspaceId, userId],
    );
    await client.query(
      "INSERT INTO sessions (id, owner_id, repo_url, branch) VALUES ($1, 'owner', 'https://example.invalid/repo.git', $2)",
      [sessionId, `session/${sessionId}`],
    );
    const turns = await client.query(
      `INSERT INTO turns (session_id, sequence, message, status)
       VALUES ($1, 1, 'push', 'completed'), ($1, 2, 'again', 'queued') RETURNING id`,
      [sessionId],
    );
    const [turn, continuation] = turns.rows as { id: number }[];
    await client.query(
      "INSERT INTO push_continuations (turn_id, continuation_turn_id) VALUES ($1, $2)",
      [turn?.id, continuation?.id],
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("the tables are there before, with rows in them", async () => {
    for (const table of DROPPED) {
      expect(await exists(table)).toBe(true);
    }
    expect(await count("catalog_authority")).toBe(1);
    expect(await count("owner_workspace_map")).toBe(1);
    expect(await count("push_continuations")).toBe(1);
  });

  test("after it, the tables are gone and what they named stays", async () => {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

    for (const table of DROPPED) {
      expect(await exists(table)).toBe(false);
    }
    expect(await count("workspaces")).toBe(1);
    expect(await count("users")).toBe(1);
    expect(await count("turns")).toBe(2);
  });
});
