import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";
import { migrateDatabase, recordAppliedMigrations } from "./migrate.ts";
import { expectedMigrations } from "./migration-head.ts";

/**
 * The 0100 identity migration, run against a database that stands at 0008
 * with data in it. Everything the interface track adds must leave alpha's
 * rows exactly as they were — and must not hand them to a
 * workspace on its own.
 */
const integration = testDatabaseUrl() ? describe : describe.skip;

const migrationsFolder = join(import.meta.dir, "../migrations");
const PRE_IDENTITY = [
  "0000_gifted_morg.sql",
  "0001_giant_sphinx.sql",
  "0002_thin_victor_mancha.sql",
  "0003_lethal_blue_blade.sql",
  "0004_calm_blue_shield.sql",
  "0005_uneven_gargoyle.sql",
  "0006_steady_cobalt_man.sql",
  "0007_typical_butterfly.sql",
  "0008_even_barracuda.sql",
] as const;

// Brings an empty database to exactly 0008: raw SQL plus the journal rows
// Drizzle would have written, so the migrator picks up at 0100.
async function databaseAt0008(): Promise<TempDatabase> {
  const database = await createTempDatabase({
    migrate: false,
    prefix: "identity",
  });
  const pool = new Pool({ connectionString: database.url, max: 1 });
  try {
    for (const file of PRE_IDENTITY) {
      await pool.query(await readFile(join(migrationsFolder, file), "utf8"));
    }
    await recordAppliedMigrations(
      pool,
      expectedMigrations().slice(0, PRE_IDENTITY.length),
    );
  } finally {
    await pool.end();
  }
  return database;
}

async function withPool<T>(
  url: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

// Every pre-existing column of every alpha row the migration touches, so a
// change to any of them — not only a lost row — fails the comparison.
async function legacySnapshot(pool: Pool): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of ["sessions", "turns", "api_keys", "receipts"]) {
    const rows = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY 1`,
    );
    snapshot[table] = rows.rows.map(({ row }) => {
      for (const added of ADDED_COLUMNS[table] ?? []) delete row[added];
      return row;
    });
  }
  return snapshot;
}
// Columns later migrations add on top of 0008; every one of them arrives null.
const ADDED_COLUMNS: Record<string, string[]> = {
  sessions: [
    "workspace_id",
    "created_by_user_id",
    "agent_release_id",
    // 0231; arrives as 'release'
    "github_policy_source",
    // 0234
    "github_policy_start",
    // 0242
    "mcp_start",
    // 0249
    "env_start",
    // 0262
    "engine_settings_start",
    // 0264; arrives as 'profile'
    "runtime_tools_source",
    // 0251
    "extensions",
    // 0255
    "legacy_runtime_configs",
    // 0257
    "runtime_spec",
    "spec_source",
    "spec_source_digest",
    "spec_digest",
    // 0104
    "checkpoint_pending_reason",
    "checkpoint_pending_attempt_id",
    "last_transcript_persisted_at",
    // 0107; arrives as 0, not null
    "cost_usd",
    // 0110
    "workspace_reclaim_id",
    "workspace_reclaim_workspace_id",
    "workspace_reclaim_claimed_at",
    "workspace_reclaimed_at",
    //
    "checkpoint_fallback_revision",
    "checkpoint_restore_attempt_id",
    //
    "context_reset_turn_sequence",
    "context_reset_checkpoint_revision",
    // arrives as false
    "input_announced",
    //
    "execution_revoked_at",
    "execution_revoked_reason",
    // the count arrives as 0
    "restore_attempt_id",
    "restore_failure_count",
    "restore_retry_at",
    "restore_failure_reason",
    //
    "profile_fingerprint",
    // arrives as 'default'
    "partition",
    // arrives as 0
    "provider_tokens",
    // arrives as false
    "unmetered",
    //
    "created_by_api_key_id",
    "takeover_required_at",
    // arrives as 'repository'
    "repository_mode",
    // 0155
    "title",
    // 0158
    "channel",
    // 0159
    "model",
    // 0172
    "pause_reason",
    "permission_wait_override",
    // 0178, arrives as 'user'
    "title_source",
    // 0198
    "first_worker_image",
    "runtime_engine",
    "runtime_sdk_version",
    "runtime_cli_version",
    "runtime_profile_sha256",
    // 0201
    "checkpoint_collection_settled_at",
    // 0207
    "attached_repository_ids",
    // 0229
    "platform_prompt",
  ],
  turns: [
    "actor_id",
    // 0185
    "channel",
    // 0193
    "slack_message",
    // 0263
    "trace_context",
  ],
  // kind arrives as 'service'
  api_keys: [
    "workspace_id",
    "scopes",
    "kind",
    "created_by_user_id",
    "expires_at",
    // 0142
    "agent_id",
    // 0162
    "last_used_at",
    // 0163
    "name",
  ],
  receipts: ["actor", "request_id"],
};

async function seedAlphaRows(pool: Pool): Promise<string[]> {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) {
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, pod_id)
       VALUES ($1, 'legacy-owner', 'https://example.invalid/r.git', $2, $3)`,
      [id, `session/${id}`, `pod-${id}`],
    );
    await pool.query(
      `INSERT INTO turns (session_id, sequence, message, status) VALUES ($1, 1, 'hello', 'completed')`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, owner_id) VALUES ($1, sha256('k'::bytea), 'legacy-owner')`,
    [randomUUID()],
  );
  await pool.query(
    `INSERT INTO receipts (id, owner_id, operation, target_ref)
     VALUES ($1, 'legacy-owner', 'session.create', '{"kind":"session","id":"x"}')`,
    [randomUUID()],
  );
  return ids;
}

async function seedWorkspace(
  pool: Pool,
  slug: string,
): Promise<{ workspaceId: string; userId: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)`,
    [workspaceId, slug],
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, 'argon2id$placeholder', $2)`,
    [userId, `${slug}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [workspaceId, userId],
  );
  return { workspaceId, userId };
}

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

integration("0100 identity migration on PostgreSQL", () => {
  test("applies on top of 0008, keeps alpha rows unmapped, and reruns as a no-op", async () => {
    const database = await databaseAt0008();
    try {
      const sessionIds = await withPool(database.url, seedAlphaRows);
      const before = await withPool(database.url, legacySnapshot);

      const sink = new MemoryLogSink();
      const logger = createLogger({ sinks: [sink] });
      const first = await migrateDatabase(database.url, { logger });
      const second = await migrateDatabase(database.url, { logger });
      const total = expectedMigrations().length;
      expect(first).toEqual({
        adopted: 0,
        applied: total - PRE_IDENTITY.length,
        total,
      });
      expect(second).toEqual({ adopted: 0, applied: 0, total });
      expect(sink.records.map(({ message }) => message)).toEqual([
        "db.migrate.applied",
        "db.migrate.noop",
      ]);

      await withPool(database.url, async (pool) => {
        expect(await legacySnapshot(pool)).toEqual(before);
        const sessions = await pool.query<{
          id: string;
          pod_id: string;
          workspace_id: string | null;
          created_by_user_id: string | null;
          agent_release_id: string | null;
        }>(
          `SELECT id, pod_id, workspace_id, created_by_user_id, agent_release_id
             FROM sessions ORDER BY created_at`,
        );
        expect(sessions.rows.map(({ id }) => id).sort()).toEqual(
          [...sessionIds].sort(),
        );
        for (const row of sessions.rows) {
          expect(row.pod_id).toBe(`pod-${row.id}`);
          // No default workspace and no automatic backfill.
          expect(row.workspace_id).toBeNull();
          expect(row.created_by_user_id).toBeNull();
          expect(row.agent_release_id).toBeNull();
        }
        const counts = await pool.query<{
          turns: string;
          keys: string;
          receipts: string;
          workspaces: string;
          mapped: string;
        }>(`
            SELECT
              (SELECT count(*)::text FROM turns) AS turns,
              (SELECT count(*)::text FROM api_keys) AS keys,
              (SELECT count(*)::text FROM receipts) AS receipts,
              (SELECT count(*)::text FROM workspaces) AS workspaces,
              (SELECT count(*)::text FROM owner_workspace_map) AS mapped
          `);
        expect(counts.rows[0]).toEqual({
          turns: "3",
          keys: "1",
          receipts: "1",
          workspaces: "0",
          mapped: "0",
        });
        const key = await pool.query<{
          workspace_id: string | null;
          scopes: string[] | null;
        }>("SELECT workspace_id, scopes FROM api_keys");
        expect(key.rows[0]).toEqual({ workspace_id: null, scopes: null });
        const actor = await pool.query<{
          actor_id: string | null;
          actor: unknown;
        }>(`SELECT t.actor_id, r.actor FROM turns t, receipts r LIMIT 1`);
        expect(actor.rows[0]).toEqual({ actor_id: null, actor: null });
      });
    } finally {
      await database.drop();
    }
  }, 60_000);

  test("the (id, owner_id, workspace_id) key lets a referencing row be pinned to its session's workspace", async () => {
    const database = await createTempDatabase({ prefix: "identity_fk" });
    try {
      await withPool(database.url, async (pool) => {
        const a = await seedWorkspace(pool, "ws-a");
        const b = await seedWorkspace(pool, "ws-b");
        const sessionId = randomUUID();
        await pool.query(
          `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id)
             VALUES ($1, 'svc-a', 'https://example.invalid/r.git', 'main', $2, $3)`,
          [sessionId, a.workspaceId, a.userId],
        );
        // Stands in for the I3 session_links / I2 dispatch tables that will
        // carry this FK; the migration only has to make it possible.
        await pool.query(`
            CREATE TABLE session_scoped_probe (
              session_id uuid NOT NULL,
              owner_id text NOT NULL,
              workspace_id uuid NOT NULL,
              FOREIGN KEY (session_id, owner_id, workspace_id)
                REFERENCES sessions (id, owner_id, workspace_id)
            )
          `);
        await pool.query(
          `INSERT INTO session_scoped_probe VALUES ($1, 'svc-a', $2)`,
          [sessionId, a.workspaceId],
        );
        for (const [owner, workspace] of [
          ["svc-a", b.workspaceId],
          ["svc-b", a.workspaceId],
        ] as const) {
          const violation = await pool
            .query(`INSERT INTO session_scoped_probe VALUES ($1, $2, $3)`, [
              sessionId,
              owner,
              workspace,
            ])
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          expect(sqlState(violation)).toBe("23503");
        }
        // The contract for a referencing table whose workspace_id may be
        // null: MATCH SIMPLE skips the whole check on a null, so it must
        // say MATCH FULL, which then refuses a partly-null reference.
        await pool.query(`
          CREATE TABLE session_scoped_nullable_probe (
            session_id uuid NOT NULL,
            owner_id text NOT NULL,
            workspace_id uuid,
            FOREIGN KEY (session_id, owner_id, workspace_id)
              REFERENCES sessions (id, owner_id, workspace_id) MATCH FULL
          )
        `);
        const partial = await pool
          .query(
            `INSERT INTO session_scoped_nullable_probe VALUES ($1, 'svc-b', NULL)`,
            [sessionId],
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(sqlState(partial)).toBe("23503");
      });
    } finally {
      await database.drop();
    }
  }, 60_000);

  test("identity tables enforce their vocabularies and uniqueness", async () => {
    const database = await createTempDatabase({ prefix: "identity_rules" });
    try {
      await withPool(database.url, async (pool) => {
        const { workspaceId, userId } = await seedWorkspace(pool, "ws");
        const attempts: Array<[string, string, unknown[]]> = [
          [
            "23505",
            `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'ws@example.invalid', 'h', 'dup')`,
            [randomUUID()],
          ],
          [
            "23505",
            `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
            [workspaceId, userId],
          ],
          [
            "23514",
            `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`,
            [workspaceId, randomUUID()],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
               VALUES ($1, $2, 'user', $3, ARRAY['session.read', 'session.delete'], 'session', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
               VALUES ($1, $2, 'user', $3, ARRAY[]::text[], 'session', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id, scopes)
               VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', 'x', 'workspace', $4, ARRAY['sessions:admin'])`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at)
               VALUES ($1, $2, 'x@example.invalid', 'member', sha256('t'::bytea), $3, now(), now(), now())`,
            [randomUUID(), workspaceId, userId],
          ],
          [
            "23503",
            `INSERT INTO owner_workspace_map (owner_id, workspace_id, mapped_by) VALUES ('legacy', $1, $2)`,
            [randomUUID(), userId],
          ],
          [
            "23514",
            `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'Mixed@example.invalid', 'h', 'x')`,
            [randomUUID()],
          ],
          [
            "23514",
            `INSERT INTO api_keys (id, key_hash, owner_id, kind, scopes) VALUES ($1, sha256('k2'::bytea), 'o', 'operator', ARRAY['sessions:admin'])`,
            [randomUUID()],
          ],
          [
            "23514",
            `INSERT INTO api_keys (id, key_hash, owner_id, kind, scopes) VALUES ($1, sha256('k3'::bytea), 'o', 'operator', ARRAY[['sessions:read']])`,
            [randomUUID()],
          ],
          [
            "23514",
            `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'Mixed@example.invalid', 'member', sha256('m'::bytea), $3, now())`,
            [randomUUID(), workspaceId, userId],
          ],
          // grants: unknown resource kind, unknown audience kind, action not
          // admitted by the resource kind, nested array, negative revision,
          // workspace ref naming another workspace.
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['memory.read'], 'team', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', 'x', 'agent', 'y')`,
            [randomUUID(), workspaceId, userId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'workspace', $4, 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY[['session.read']], 'session', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id, revision)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', 'x', 'workspace', $4, -1)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['workspace.read'], 'workspace', $4, 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, randomUUID()],
          ],
          // audience naming another workspace while the resource is fine
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, randomUUID()],
          ],
          // nested scopes array
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id, scopes)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', 'x', 'workspace', $4, ARRAY[['sessions:read']])`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          // empty and oversized ids (opaqueId 1..128, refs 1..512)
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', '', ARRAY['session.read'], 'session', 'x', 'workspace', $3)`,
            [randomUUID(), workspaceId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read'], 'session', repeat('x', 513), 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
          [
            "23514",
            `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, service_principal_id, actions, resource_kind, resource_id, audience_kind, audience_id)
             VALUES ($1, $2, 'user', $3, repeat('s', 129), ARRAY['session.read'], 'session', 'x', 'workspace', $4)`,
            [randomUUID(), workspaceId, userId, workspaceId],
          ],
        ];
        for (const [expected, sql, params] of attempts) {
          const error = await pool.query(sql, params).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(sqlState(error)).toBe(expected);
        }

        const ok = await pool.query<{ id: string }>(
          `INSERT INTO grants (id, workspace_id, actor_kind, actor_id, actions, resource_kind, resource_id, audience_kind, audience_id, scopes)
             VALUES ($1, $2, 'user', $3, ARRAY['session.read', 'session.submit'], 'session', 'x', 'workspace', $4, ARRAY['sessions:read'])
             RETURNING id`,
          [randomUUID(), workspaceId, userId, workspaceId],
        );
        expect(ok.rows).toHaveLength(1);
        // A derived release id is opaque text, and since 0139 it must name
        // a release that exists.
        const unpinned = await pool
          .query(
            `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, agent_release_id)
             VALUES ($1, 'svc', 'https://example.invalid/r.git', 'main', $2, 'sha256:' || encode(sha256('r'::bytea), 'hex'))`,
            [randomUUID(), workspaceId],
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(sqlState(unpinned)).toBe("23503");
        const tokens = await pool
          .query(
            `INSERT INTO web_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, sha256('c'::bytea), now() + interval '1 day'), ($3, $2, sha256('c'::bytea), now() + interval '1 day')`,
            [randomUUID(), userId, randomUUID()],
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(sqlState(tokens)).toBe("23505");

        // A second live invite for the same address is refused until the
        // first is accepted or revoked; a revoked one no longer blocks.
        const invite = async (token: string) =>
          pool
            .query(
              `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at)
               VALUES ($1, $2, 'new@example.invalid', 'member', sha256($3::bytea), $4, now() + interval '1 day')`,
              [randomUUID(), workspaceId, token, userId],
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
        expect(await invite("t1")).toBeUndefined();
        expect(sqlState(await invite("t2"))).toBe("23505");
        await pool.query(
          `UPDATE invites SET revoked_at = now() WHERE email = 'new@example.invalid'`,
        );
        expect(await invite("t3")).toBeUndefined();
      });
    } finally {
      await database.drop();
    }
  }, 60_000);
});
