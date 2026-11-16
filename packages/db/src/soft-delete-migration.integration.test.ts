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
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const ISSUER = "https://idp.example.test";

integration("0289 on a database that already has the rows it marks", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  let through: string;
  const workspaceId = randomUUID();
  const userId = randomUUID();

  const external = (subject: string) =>
    pool.query(
      "INSERT INTO login_methods (id, user_id, kind, issuer, subject) VALUES ($1, $2, 'oidc', $3, $4) RETURNING id",
      [randomUUID(), userId, ISSUER, subject],
    );
  const token = () =>
    pool.query(
      "INSERT INTO slack_config_tokens (workspace_id, state) VALUES ($1, 'needs_reentry')",
      [workspaceId],
    );

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "soft_delete_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough("0289_soft_delete_user_rows", {
      exclusive: true,
    });
    through = migrationsThrough("0289_soft_delete_user_rows");
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, 'sd@example.test', 'sd')",
      [userId],
    );
    await external("subject-1");
    await token();
    await migrate(drizzle(pool), { migrationsFolder: through });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    for (const folder of [before, through]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  test("existing rows stay live, and the token row gets an id of its own", async () => {
    const { rows } = await pool.query(
      "SELECT id, deleted_at FROM slack_config_tokens WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.deleted_at).toBeNull();
    const methods = await pool.query(
      "SELECT deleted_at, deleted_by FROM login_methods WHERE user_id = $1",
      [userId],
    );
    expect(methods.rows).toEqual([{ deleted_at: null, deleted_by: null }]);
  });

  test("a live row still holds its name; a deleted one gives it back", async () => {
    await expect(token()).rejects.toThrow(/slack_config_tokens_workspace_uniq/);
    await expect(external("subject-1")).rejects.toThrow(
      /login_methods_(external|user_issuer)_uniq/,
    );
    await pool.query(
      "UPDATE slack_config_tokens SET deleted_at = now(), deleted_by = $2 WHERE workspace_id = $1",
      [workspaceId, userId],
    );
    await pool.query(
      "UPDATE login_methods SET deleted_at = now(), deleted_by = $1 WHERE user_id = $1",
      [userId],
    );
    await token();
    await external("subject-1");
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM slack_config_tokens WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([{ n: 2 }]);
  });

  test("a deletion names who made it", async () => {
    await expect(
      pool.query(
        "UPDATE login_methods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL",
        [userId],
      ),
    ).rejects.toThrow(/login_methods_deleted_check/);
  });
});
