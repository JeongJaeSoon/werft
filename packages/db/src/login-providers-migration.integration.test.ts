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
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const ISSUER = "https://accounts.google.com";

integration("0275 and 0276 on a database with Google users", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  const googleUser = randomUUID();
  const passwordUser = randomUUID();
  const googleMethod = randomUUID();
  const passwordMethod = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "login_providers_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough("0275_login_providers", { exclusive: true });
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, 'g@example.test', 'g'), ($2, 'p@example.test', 'p')",
      [googleUser, passwordUser],
    );
    await pool.query(
      "INSERT INTO login_methods (id, user_id, kind, issuer, subject, email_at_link) VALUES ($1, $2, 'google', $3, 'subject-1', 'g@example.test')",
      [googleMethod, googleUser, ISSUER],
    );
    await pool.query(
      "INSERT INTO login_methods (id, user_id, kind) VALUES ($1, $2, 'password')",
      [passwordMethod, passwordUser],
    );
    await pool.query(
      "INSERT INTO web_sessions (id, user_id, token_hash, expires_at, login_method_id) VALUES ($1, $2, $3, now() + interval '1 hour', $4)",
      [
        sessionId,
        googleUser,
        createHash("sha256").update(sessionId).digest(),
        googleMethod,
      ],
    );
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    if (before) rmSync(before, { recursive: true, force: true });
  });

  test("a Google login method becomes an oidc one and keeps its issuer, subject and id", async () => {
    const { rows } = await pool.query(
      "SELECT id, user_id, kind, issuer, subject, email_at_link FROM login_methods ORDER BY kind",
    );
    expect(rows).toEqual([
      {
        id: googleMethod,
        user_id: googleUser,
        kind: "oidc",
        issuer: ISSUER,
        subject: "subject-1",
        email_at_link: "g@example.test",
      },
      {
        id: passwordMethod,
        user_id: passwordUser,
        kind: "password",
        issuer: null,
        subject: null,
        email_at_link: null,
      },
    ]);
  });

  test("the session made with it still names it", async () => {
    const { rows } = await pool.query(
      "SELECT login_method_id FROM web_sessions WHERE id = $1",
      [sessionId],
    );
    expect(rows).toEqual([{ login_method_id: googleMethod }]);
  });

  test("the old kind is refused afterwards", async () => {
    await expect(
      pool.query(
        "INSERT INTO login_methods (id, user_id, kind, issuer, subject) VALUES ($1, $2, 'google', $3, 'subject-2')",
        [randomUUID(), passwordUser, ISSUER],
      ),
    ).rejects.toThrow(/login_methods_kind_check/);
  });

  test("no provider exists until one is made: nothing is carried over from the environment", async () => {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS providers FROM login_providers",
    );
    expect(rows).toEqual([{ providers: 0 }]);
  });

  test("the live-session index by login method is built and valid", async () => {
    const { rows } = await pool.query(
      "SELECT i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'web_sessions_login_method_live_idx'",
    );
    expect(rows).toEqual([{ valid: true, predicate: "(revoked_at IS NULL)" }]);
  });
});
