import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER, readJournal } from "../migration-journal.ts";
import { migrationsThrough } from "../testing/migrations-through.ts";

let client: PGlite;
let before: string;

const WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const OTHER = "019a0000-0000-7000-8000-0000000000b2";
const USER = "019a0000-0000-7000-8000-0000000000c1";

beforeEach(async () => {
  client = new PGlite();
  const tag = readJournal(MIGRATIONS_FOLDER).find((entry) =>
    entry.tag.endsWith("_skill_current_version"),
  )?.tag;
  if (!tag) throw new Error("skill_current_version is not in the journal");
  before = migrationsThrough(tag, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  for (const [id, slug] of [
    [WORKSPACE, "acme"],
    [OTHER, "other"],
  ]) {
    await client.query(
      `INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)`,
      [id, slug],
    );
  }
  await client.query(
    `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'u@example.invalid', 'argon2id$placeholder', 'u')`,
    [USER],
  );
});

afterEach(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

async function seed(
  workspaceId: string,
  name: string,
  version: number | null,
  review: "pending" | "approved" | "rejected",
  archived = false,
): Promise<string> {
  const id = crypto.randomUUID();
  const reviewed = review !== "pending";
  await client.query(
    `INSERT INTO extension_bundles (id, workspace_id, name, digest, label, source, size_bytes, manifest, review, registered_by, reviewed_by, reviewed_at, version, archived_by, archived_at)
     VALUES ($1, $2, $3, $4, $3, 'upload', 1, '{}'::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      workspaceId,
      name,
      id.replaceAll("-", "").repeat(2),
      review,
      USER,
      reviewed ? USER : null,
      reviewed ? new Date() : null,
      version,
      archived ? USER : null,
      archived ? new Date() : null,
    ],
  );
  return id;
}

test("each skill's current version starts as its highest approved, not archived one", async () => {
  await seed(WORKSPACE, "research", 1, "approved");
  const research = await seed(WORKSPACE, "research", 2, "approved");
  await seed(WORKSPACE, "research", 3, "pending");
  await seed(WORKSPACE, "research", 4, "rejected");
  const lint = await seed(WORKSPACE, "lint", 1, "approved");
  await seed(WORKSPACE, "lint", 2, "approved", true);
  await seed(WORKSPACE, "draft", 1, "pending");
  await seed(WORKSPACE, "legacy", null, "approved");
  const other = await seed(OTHER, "research", 1, "approved");

  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

  const current = await client.query<{ id: string }>(
    `SELECT id FROM extension_bundles WHERE current ORDER BY id`,
  );
  expect(current.rows.map((row) => row.id)).toEqual(
    [research, lint, other].sort(),
  );
});
