import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationFile } from "../testing/migrations.ts";

const migrations = join(import.meta.dir, "../../migrations");

let client: PGlite;
let backfill: string;

const apply = (file: string) => applyMigrationFile(client, file);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";

async function seedSession(ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch) VALUES ($1, $2, 'https://example.invalid/r.git', 'main')`,
    [id, ownerId],
  );
  return id;
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) => name.endsWith("_api_key_kind_actor.sql"));
  if (!found) throw new Error("api_key_kind_actor migration not found");
  backfill = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < backfill)) {
    await apply(file);
  }
  await client.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme')`,
    [WORKSPACE],
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'a@example.com', 'x', 'A')`,
    [USER],
  );
});

afterEach(async () => {
  await client.close();
});

describe("api key kind and actor backfill", () => {
  test("every existing key becomes a service key with no issuer and no expiry, scopes untouched", async () => {
    const legacy = crypto.randomUUID();
    const bound = crypto.randomUUID();
    await client.query(
      `INSERT INTO api_keys (id, key_hash, owner_id, scopes) VALUES ($1, '\\x01', 'owner-a', ARRAY['sessions:read'])`,
      [legacy],
    );
    await client.query(
      `INSERT INTO api_keys (id, key_hash, owner_id, workspace_id, scopes, revoked_at) VALUES ($1, '\\x02', $2::text, $2::uuid, NULL, now())`,
      [bound, WORKSPACE],
    );

    await apply(backfill);

    const rows = await client.query<{
      id: string;
      kind: string;
      created_by_user_id: string | null;
      expires_at: Date | null;
      scopes: string[] | null;
      revoked: boolean;
    }>(
      `SELECT id, kind, created_by_user_id, expires_at, scopes, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY key_hash`,
    );
    expect(rows.rows).toEqual([
      {
        id: legacy,
        kind: "service",
        created_by_user_id: null,
        expires_at: null,
        scopes: ["sessions:read"],
        revoked: false,
      },
      {
        id: bound,
        kind: "service",
        created_by_user_id: null,
        expires_at: null,
        scopes: null,
        revoked: true,
      },
    ]);
  });

  test("a session's workspace comes from an owner that is a workspace; nothing names a person", async () => {
    const cookie = await seedSession(WORKSPACE);
    const legacy = await seedSession("owner-a");
    await client.query(
      `INSERT INTO turns (session_id, sequence, message, status) VALUES ($1, 1, 'hi', 'queued')`,
      [cookie],
    );
    await client.query(
      `INSERT INTO receipts (id, owner_id, operation, target_ref) VALUES ($1, $2, 'create_session', '{}'::jsonb)`,
      [crypto.randomUUID(), WORKSPACE],
    );

    await apply(backfill);

    const sessions = await client.query<{
      id: string;
      workspace_id: string | null;
      created_by_user_id: string | null;
      created_by_api_key_id: string | null;
      takeover_required_at: Date | null;
    }>(
      `SELECT id, workspace_id, created_by_user_id, created_by_api_key_id, takeover_required_at FROM sessions`,
    );
    const byId = new Map(sessions.rows.map((row) => [row.id, row]));
    expect(byId.get(cookie)).toMatchObject({
      workspace_id: WORKSPACE,
      created_by_user_id: null,
      created_by_api_key_id: null,
      takeover_required_at: null,
    });
    expect(byId.get(legacy)?.workspace_id).toBeNull();
    const turns = await client.query<{ actor_id: string | null }>(
      `SELECT actor_id FROM turns`,
    );
    expect(turns.rows).toEqual([{ actor_id: null }]);
    const receipts = await client.query<{ actor: unknown }>(
      `SELECT actor FROM receipts`,
    );
    expect(receipts.rows).toEqual([{ actor: null }]);
  });

  test("a personal key needs a creator and a workspace", async () => {
    await apply(backfill);
    const insert = (createdBy: string | null, workspace: string | null) =>
      client.query(
        `INSERT INTO api_keys (id, key_hash, owner_id, workspace_id, scopes, kind, created_by_user_id) VALUES ($1, $2, 'o', $3, ARRAY['sessions:read'], 'personal', $4)`,
        [
          crypto.randomUUID(),
          new TextEncoder().encode(crypto.randomUUID()),
          workspace,
          createdBy,
        ],
      );
    await expect(insert(null, WORKSPACE)).rejects.toThrow(
      /api_keys_personal_check/,
    );
    await expect(insert(USER, null)).rejects.toThrow(/api_keys_personal_check/);
    await insert(USER, WORKSPACE);
    await expect(
      client.query(
        `INSERT INTO api_keys (id, key_hash, owner_id, kind) VALUES ($1, '\\x09', 'o', 'robot')`,
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow(/api_keys_kind_check/);
  });
});
