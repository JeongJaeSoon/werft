import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
const ISSUER = "https://accounts.google.com";

integration("0274 on a database that already has users and sessions", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  // 0275 renames the kind these rows are written with, so this stops at 0274.
  let through: string;
  const userId = randomUUID();
  const sessionId = randomUUID();
  const extraMethodId = randomUUID();

  const external = (id: string, subject: string) =>
    pool.query(
      "INSERT INTO login_methods (id, user_id, kind, issuer, subject) VALUES ($1, $2, 'google', $3, $4)",
      [id, userId, ISSUER, subject],
    );

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "login_method_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough("0274_web_session_login_method", {
      exclusive: true,
    });
    through = migrationsThrough("0274_web_session_login_method");
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, 'ext@example.test', 'ext')",
      [userId],
    );
    await external(randomUUID(), "subject-1");
    await pool.query(
      "INSERT INTO web_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
      [sessionId, userId, createHash("sha256").update(sessionId).digest()],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    for (const folder of [before, through]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  const columnExists = async () =>
    (
      await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'web_sessions' AND column_name = 'login_method_id'",
      )
    ).rowCount === 1;

  test("stops, changing nothing, while a user has two external methods of one issuer", async () => {
    await external(extraMethodId, "subject-2");
    let message = "";
    try {
      await migrate(drizzle(pool), { migrationsFolder: through });
    } catch (error) {
      message = String(
        (error as { cause?: unknown }).cause ?? (error as Error).message,
      );
    }
    expect(message).toContain("two external login methods of one issuer");
    // The column came first in the file and went back with the rest.
    expect(await columnExists()).toBe(false);
  }, 60_000);

  test("runs once the extra row is gone, and leaves existing sessions without a method", async () => {
    await pool.query("DELETE FROM login_methods WHERE id = $1", [
      extraMethodId,
    ]);
    await migrate(drizzle(pool), { migrationsFolder: through });
    expect(await columnExists()).toBe(true);
    const { rows } = await pool.query(
      "SELECT login_method_id FROM web_sessions WHERE id = $1",
      [sessionId],
    );
    expect(rows).toEqual([{ login_method_id: null }]);
  }, 60_000);

  test("afterwards a second subject of the same issuer is refused for the user, another issuer is not", async () => {
    await expect(external(randomUUID(), "subject-3")).rejects.toThrow(
      /login_methods_user_issuer_uniq/,
    );
    await pool.query(
      "INSERT INTO login_methods (id, user_id, kind, issuer, subject) VALUES ($1, $2, 'google', 'https://idp.example', 'subject-1')",
      [randomUUID(), userId],
    );
  });
});
