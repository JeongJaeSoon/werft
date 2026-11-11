import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import { Pool, type PoolClient } from "pg";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { createEnforcedPool, type PoolTimeouts } from "./pool.ts";

// Drizzle's migrator applies every pending migration in one transaction, where
// CREATE INDEX CONCURRENTLY is refused. A migration whose first line is this
// marker runs alone, each statement committing on its own, and its journal row
// is written after the last one. A failure part way leaves the earlier
// statements applied and the migration pending, so every statement in such a
// file must be safe to run again (docs/contributing/development.md).
export const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

export function runsOutsideTransaction(statements: readonly string[]): boolean {
  return statements[0]?.trimStart().startsWith(NO_TRANSACTION_MARKER) ?? false;
}
const expectedLegacyTables = [
  "api_keys",
  "events",
  "pull_requests",
  "queue_messages",
  "sessions",
  "turns",
  "unassigned_sessions",
  "workers",
] as const;

export interface MigrationSummary {
  /** Journal rows written for a legacy M0 schema that predates Drizzle. */
  readonly adopted: number;
  /** Migrations newly applied by Drizzle in this run. */
  readonly applied: number;
  /** Journal rows after the run. */
  readonly total: number;
}

// Bounded so a frozen database fails the one-shot migrate instead of holding
// `up` forever, and loose enough for a DDL statement that rewrites a table
// or waits out a lock held by a running API. Raise it, or make it a setting,
// once a migration needs longer.
export const MIGRATION_POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5_000,
  statementMs: 300_000,
  queryMs: 330_000,
};

const MIGRATION_LOCK_KEY = "db:migrate";

export interface MigrateDatabaseOptions {
  readonly logger?: StructuredLogger;
  readonly timeouts?: PoolTimeouts;
  readonly migrationsFolder?: string;
}

export async function migrateDatabase(
  databaseUrl: string,
  options: MigrateDatabaseOptions = {},
): Promise<MigrationSummary> {
  const logger = options.logger ?? createLogger();
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "migrate",
    options.timeouts ?? MIGRATION_POOL_TIMEOUTS,
  );
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  // A second migrate (a manual run beside the Helm hook Job) waits here and
  // then finds nothing pending; unlocked, its DROP INDEX CONCURRENTLY IF
  // EXISTS could remove an index the first one already recorded as built.
  const lock = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  try {
    await takeMigrationLock(lock);
    const adopted = await adoptLegacyM0Schema(pool, migrationsFolder);
    const before = await countJournal(pool);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(
        client,
        readMigrationFiles({ migrationsFolder }),
      );
    } finally {
      client.release();
    }
    const total = await countJournal(pool);
    const summary: MigrationSummary = {
      adopted,
      applied: total - before,
      total,
    };
    const outcome =
      adopted > 0 ? "adopted" : summary.applied > 0 ? "applied" : "noop";
    logger.info(`db.migrate.${outcome}`, { ...summary });
    return summary;
  } finally {
    // Closing the session releases its lock.
    lock.release(true);
    await pool.end();
  }
}

// Polled rather than waited on: a blocking pg_advisory_lock is an open
// transaction, and the holder's CREATE INDEX CONCURRENTLY waits for every
// open transaction to end, so the two would wait on each other. No deadline
// of its own: the holder's session ending frees the lock, and the caller's
// (the Job's activeDeadlineSeconds) bounds the whole run.
async function takeMigrationLock(client: PoolClient): Promise<void> {
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [MIGRATION_LOCK_KEY],
    );
    if (rows[0]?.locked) return;
    await Bun.sleep(1_000);
  }
}

async function countJournal(pool: Pool): Promise<number> {
  const journal = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (!journal.rows[0]?.exists) {
    return 0;
  }
  const count = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
  );
  return Number(count.rows[0]?.count ?? 0);
}

/** One connection: a pg client, or a PGlite database in tests. */
interface SqlConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Drizzle's `migrate` for a test or bench database, with this module's
 * handling of no-transaction migrations, which Drizzle's own migrators run
 * inside one transaction. Takes a drizzle database over a PGlite database or
 * a pg pool, whose `$client` drizzle sets but types only for some callers.
 */
export async function migrate(
  database: object,
  config: { readonly migrationsFolder: string },
): Promise<void> {
  const db = database as { readonly $client?: SqlConnection | Pool };
  if (db.$client === undefined) {
    throw new Error("migrate needs a drizzle database with a $client");
  }
  const migrations = readMigrationFiles(config);
  if (!(db.$client instanceof Pool)) {
    // PGlite runs Postgres in single-user mode, where a concurrent index
    // build fails ("tuple concurrently updated"); with one connection there
    // is nothing for it to wait out.
    await applyPendingMigrations(
      db.$client,
      migrations.map((migration) => ({
        ...migration,
        sql: migration.sql.map((statement) =>
          statement.replaceAll(/\bINDEX CONCURRENTLY\b/g, "INDEX"),
        ),
      })),
    );
    return;
  }
  const client = await db.$client.connect();
  try {
    await applyPendingMigrations(client, migrations);
  } finally {
    client.release();
  }
}

// Drizzle's rule for what is pending: everything newer than the newest
// journal row. Runs of ordinary migrations still share one transaction.
async function applyPendingMigrations(
  client: SqlConnection,
  migrations: readonly MigrationMeta[],
): Promise<void> {
  await createJournalTable(client);
  const newest = await client.query(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  const [row] = newest.rows as { created_at: string | number }[];
  const appliedThrough = row
    ? Number(row.created_at)
    : Number.NEGATIVE_INFINITY;
  let batch: MigrationMeta[] = [];
  for (const migration of migrations) {
    if (migration.folderMillis <= appliedThrough) {
      continue;
    }
    if (!runsOutsideTransaction(migration.sql)) {
      batch.push(migration);
      continue;
    }
    await applyInTransaction(client, batch);
    batch = [];
    for (const statement of migration.sql) {
      await client.query(statement);
    }
    await recordAppliedMigrations(client, [
      { hash: migration.hash, when: migration.folderMillis },
    ]);
  }
  await applyInTransaction(client, batch);
}

async function applyInTransaction(
  client: SqlConnection,
  migrations: readonly MigrationMeta[],
): Promise<void> {
  if (migrations.length === 0) {
    return;
  }
  await client.query("BEGIN");
  try {
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        await client.query(statement);
      }
    }
    await recordAppliedMigrations(
      client,
      migrations.map((migration) => ({
        hash: migration.hash,
        when: migration.folderMillis,
      })),
    );
    await client.query("COMMIT");
  } catch (error) {
    // A ROLLBACK on a dead connection fails too; the statement's own error
    // is the one to report.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function adoptLegacyM0Schema(
  pool: Pool,
  migrationsFolder: string,
): Promise<number> {
  const state = await pool.query<{
    claim_token: boolean;
    migration_journal: string | null;
    receipts: string | null;
    sessions: string | null;
    turn_sequence: string | null;
  }>(`
    SELECT
      to_regclass('public.sessions')::text AS sessions,
      to_regclass('public.events_attempt_sequence_uniq')::text AS receipts,
      to_regclass('public.turns_session_sequence_uniq')::text AS turn_sequence,
      to_regclass('drizzle.__drizzle_migrations')::text AS migration_journal,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'queue_messages'
          AND column_name = 'claim_token'
      ) AS claim_token
  `);
  const current = state.rows[0];
  if (!current || current.sessions === null || current.migration_journal) {
    return 0;
  }

  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const present = new Set(tables.rows.map(({ table_name }) => table_name));
  const missing = expectedLegacyTables.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to adopt incomplete legacy M0 schema; missing: ${missing.join(", ")}`,
    );
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  // 0002/0003 are detected by their last statement so a partially applied
  // raw init is not recorded as complete.
  const applied0002 = current.receipts !== null;
  const applied0003 = current.turn_sequence !== null;
  if ((applied0002 && !current.claim_token) || (applied0003 && !applied0002)) {
    throw new Error(
      "Refusing to adopt legacy schema with migrations applied out of order",
    );
  }
  const appliedCount = applied0003
    ? 4
    : applied0002
      ? 3
      : current.claim_token
        ? 2
        : 1;
  if (migrations.length < appliedCount) {
    throw new Error(
      `Legacy schema requires ${appliedCount} migration files, found ${migrations.length}`,
    );
  }
  const applied = migrations.slice(0, appliedCount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordAppliedMigrations(
      client,
      applied.map((migration) => ({
        hash: migration.hash,
        when: migration.folderMillis,
      })),
    );
    await client.query("COMMIT");
    return applied.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Writes journal rows for migrations that were applied by hand, in the shape
 * Drizzle's migrator reads (`hash`, `created_at` = folder millis). Also used
 * by tests that need a database standing at one exact migration.
 */
export async function recordAppliedMigrations(
  client: SqlConnection,
  migrations: readonly { hash: string; when: number }[],
): Promise<void> {
  await createJournalTable(client);
  for (const migration of migrations) {
    await client.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [migration.hash, migration.when],
    );
  }
}

async function createJournalTable(client: SqlConnection): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations");
  }
  await migrateDatabase(databaseUrl);
}
