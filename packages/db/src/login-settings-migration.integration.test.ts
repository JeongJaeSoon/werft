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
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("0277 on a database with owners", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  const main = randomUUID();
  const elsewhere = randomUUID();
  const noPassword = randomUUID();
  const split = randomUUID();
  const off = randomUUID();
  const owner = randomUUID();
  const later = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "login_settings_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough("0277_login_settings", { exclusive: true });
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'main', 'Main'), ($2, 'elsewhere', 'Elsewhere')",
      [main, elsewhere],
    );
    const person = (id: string, name: string, hash: string | null) =>
      pool.query(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
        [id, `${name}@example.test`, name, hash],
      );
    const member = (
      workspaceId: string,
      userId: string,
      role: string,
      year: number,
    ) =>
      pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, make_timestamptz($4, 1, 1, 0, 0, 0, 'UTC'))",
        [workspaceId, userId, role, year],
      );
    const hash = "argon2id$placeholder";
    // The oldest owner signs in through a provider only.
    await person(noPassword, "no-password", null);
    await member(main, noPassword, "owner", 2001);
    // An owner of the second workspace whose sign-in lands on an older
    // membership of the first, as a member.
    await person(split, "split", hash);
    await member(main, split, "member", 2002);
    await member(elsewhere, split, "owner", 2003);
    // An owner whose membership is off.
    await person(off, "off", hash);
    await member(main, off, "owner", 2004);
    await pool.query(
      "UPDATE memberships SET disabled_at = now() WHERE user_id = $1",
      [off],
    );
    await person(owner, "owner", hash);
    await member(main, owner, "owner", 2005);
    await person(later, "later", hash);
    await member(main, later, "owner", 2006);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    if (before) rmSync(before, { recursive: true, force: true });
  });

  test("the first emergency admin is the oldest owner whose password sign-in gives an owner's session", async () => {
    const { rows } = await pool.query(
      "SELECT password_login, emergency_admin_user_id FROM login_settings",
    );
    expect(rows).toEqual([
      { password_login: "on", emergency_admin_user_id: owner },
    ]);
  });

  test("a reset link may have no issuer after the upgrade", async () => {
    const { rows } = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'password_resets' AND column_name = 'issued_by'",
    );
    expect(rows).toEqual([{ is_nullable: "YES" }]);
  });
});
