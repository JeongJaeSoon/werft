import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";
import { migrateDatabase, NO_TRANSACTION_MARKER } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";
import { expectedMigrations } from "./migration-head.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;
const totalMigrations = expectedMigrations().length;

function captureLogger() {
  const sink = new MemoryLogSink();
  return { logger: createLogger({ sinks: [sink] }), sink };
}

integrationTest(
  "adopts a raw M0 database and upgrades it through Drizzle",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "m0_upgrade",
    });
    const testUrl = new URL(database.url);
    const legacy = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      const migration = await readFile(
        join(import.meta.dir, "../migrations/0000_gifted_morg.sql"),
        "utf8",
      );
      await legacy.query(migration);
      const sessionId = randomUUID();
      const turn = await legacy.query<{ id: string }>(
        `
          INSERT INTO sessions (id, owner_id, repo_url, branch, status)
          VALUES ($1, 'owner', 'https://example.invalid/repo.git', 'main', 'stopped')
          RETURNING id
        `,
        [sessionId],
      );
      await legacy.query(
        `
          INSERT INTO turns (session_id, message, status)
          VALUES ($1, 'legacy message', 'done')
        `,
        [turn.rows[0]?.id],
      );
      await legacy.end();

      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({
        adopted: 1,
        applied: totalMigrations - 1,
        total: totalMigrations,
      });
      expect(second).toEqual({
        adopted: 0,
        applied: 0,
        total: totalMigrations,
      });
      expect(
        sink.records.map(({ level, message, fields }) => ({
          level,
          message,
          fields,
        })),
      ).toEqual([
        {
          level: "info",
          message: "db.migrate.adopted",
          fields: {
            adopted: 1,
            applied: totalMigrations - 1,
            total: totalMigrations,
          },
        },
        {
          level: "info",
          message: "db.migrate.noop",
          fields: { adopted: 0, applied: 0, total: totalMigrations },
        },
      ]);

      const verified = new Pool({
        connectionString: testUrl.toString(),
        max: 1,
      });
      try {
        const column = await verified.query<{ claim_token: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'queue_messages'
              AND column_name = 'claim_token'
          ) AS claim_token
        `);
        const session = await verified.query<{ admission_state: string }>(
          "SELECT admission_state FROM sessions WHERE id = $1",
          [sessionId],
        );
        const turnStatus = await verified.query<{
          sequence: number;
          status: string;
        }>("SELECT status, sequence FROM turns WHERE session_id = $1", [
          sessionId,
        ]);
        const tables = await verified.query<{ table_name: string }>(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('receipts', 'pending_requests', 'checkpoints', 'executions')
          ORDER BY table_name
        `);
        const journal = await verified.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        const storage = await verified.query<{ bytes: string }>(
          "SELECT bytes::text FROM storage_usage WHERE scope = 'installation'",
        );
        expect(column.rows[0]?.claim_token).toBe(true);
        // Retained input counts from the first acceptance after the upgrade.
        expect(storage.rows[0]?.bytes).toBe(
          String(Buffer.byteLength("legacy message")),
        );
        // The legacy session went through every migration and then, with
        // everything recorded under sessions, out at 0268 (the profile
        // removal drops the sessions it cannot carry over).
        expect(session.rows).toEqual([]);
        expect(turnStatus.rows).toEqual([]);
        expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
          "checkpoints",
          "executions",
          "pending_requests",
          "receipts",
        ]);
        expect(journal.rows[0]?.count).toBe(String(totalMigrations));
      } finally {
        await verified.end();
      }
    } finally {
      if (!legacy.ended) await legacy.end();
      await database.drop();
    }
  },
  30_000,
);

integrationTest(
  "adopts a database initialized with all raw migrations",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "m0_initdb",
    });
    const testUrl = new URL(database.url);
    const legacy = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      // The compose initdb mounts stop at 0003: adoptLegacyM0Schema only
      // recognises up to 0003, so 0004+ must be applied by the migrator.
      for (const filename of [
        "0000_gifted_morg.sql",
        "0001_giant_sphinx.sql",
        "0002_thin_victor_mancha.sql",
        "0003_lethal_blue_blade.sql",
      ]) {
        await legacy.query(
          await readFile(
            join(import.meta.dir, `../migrations/${filename}`),
            "utf8",
          ),
        );
      }
      await legacy.end();

      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({
        adopted: 4,
        applied: totalMigrations - 4,
        total: totalMigrations,
      });
      expect(second).toEqual({
        adopted: 0,
        applied: 0,
        total: totalMigrations,
      });
      expect(sink.records.map(({ message }) => message)).toEqual([
        "db.migrate.adopted",
        "db.migrate.noop",
      ]);

      const verified = new Pool({
        connectionString: testUrl.toString(),
        max: 1,
      });
      try {
        const journal = await verified.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        expect(journal.rows[0]?.count).toBe(String(totalMigrations));
      } finally {
        await verified.end();
      }
    } finally {
      if (!legacy.ended) await legacy.end();
      await database.drop();
    }
  },
  30_000,
);

integrationTest(
  "applies every migration to a fresh database and reports a no-op on rerun",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "fresh",
    });
    const testUrl = new URL(database.url);
    try {
      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({
        adopted: 0,
        applied: totalMigrations,
        total: totalMigrations,
      });
      expect(second).toEqual({
        adopted: 0,
        applied: 0,
        total: totalMigrations,
      });
      expect(sink.records.map(({ message }) => message)).toEqual([
        "db.migrate.applied",
        "db.migrate.noop",
      ]);
    } finally {
      await database.drop();
    }
  },
  30_000,
);

const CONCURRENT_INDEX_MIGRATION = [
  NO_TRANSACTION_MARKER,
  'DROP INDEX CONCURRENTLY IF EXISTS "turns_status_test_idx";--> statement-breakpoint',
  'CREATE INDEX CONCURRENTLY "turns_status_test_idx" ON "turns" ("status");',
].join("\n");

// The packaged folder plus one migration after its newest.
function folderWithMigration(sql: string): string {
  const folder = mkdtempSync(join(tmpdir(), "migrations-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  if (!last) throw new Error("empty journal");
  const tag = `${String(last.idx + 1).padStart(4, "0")}_concurrent_index`;
  journal.entries.push({
    ...last,
    idx: last.idx + 1,
    when: last.when + 1,
    tag,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

async function indexValidity(url: string): Promise<boolean | undefined> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ indisvalid: boolean }>(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('turns_status_test_idx')`,
    );
    return rows[0]?.indisvalid;
  } finally {
    await pool.end();
  }
}

integrationTest(
  "a no-transaction migration builds its index concurrently after the ones before it commit",
  async () => {
    const folder = folderWithMigration(CONCURRENT_INDEX_MIGRATION);
    const database = await createTempDatabase({
      migrate: false,
      prefix: "concurrent",
    });
    try {
      const options = {
        logger: captureLogger().logger,
        migrationsFolder: folder,
      };
      expect(await migrateDatabase(database.url, options)).toEqual({
        adopted: 0,
        applied: totalMigrations + 1,
        total: totalMigrations + 1,
      });
      expect(await indexValidity(database.url)).toBe(true);
      expect(await migrateDatabase(database.url, options)).toEqual({
        adopted: 0,
        applied: 0,
        total: totalMigrations + 1,
      });
    } finally {
      await database.drop();
      rmSync(folder, { recursive: true, force: true });
    }
  },
  30_000,
);

integrationTest(
  "two migrators started together apply each migration once",
  async () => {
    const folder = folderWithMigration(CONCURRENT_INDEX_MIGRATION);
    const database = await createTempDatabase({
      migrate: false,
      prefix: "concurrent_runners",
    });
    try {
      const options = {
        logger: captureLogger().logger,
        migrationsFolder: folder,
      };
      const runs = await Promise.all([
        migrateDatabase(database.url, options),
        migrateDatabase(database.url, options),
      ]);
      expect(runs.map((run) => run.applied).sort()).toEqual([
        0,
        totalMigrations + 1,
      ]);
      const pool = new Pool({ connectionString: database.url, max: 1 });
      try {
        const { rows } = await pool.query<{ rows: string; hashes: string }>(
          'SELECT count(*)::text AS rows, count(DISTINCT hash)::text AS hashes FROM "drizzle"."__drizzle_migrations"',
        );
        expect(rows[0]).toEqual({
          rows: String(totalMigrations + 1),
          hashes: String(totalMigrations + 1),
        });
      } finally {
        await pool.end();
      }
      expect(await indexValidity(database.url)).toBe(true);
    } finally {
      await database.drop();
      rmSync(folder, { recursive: true, force: true });
    }
  },
  60_000,
);

integrationTest(
  "a no-transaction migration that fails part way stays pending and applies on the next run",
  async () => {
    const failing = folderWithMigration(
      `${CONCURRENT_INDEX_MIGRATION}--> statement-breakpoint\nSELECT 1 / 0;`,
    );
    const fixed = folderWithMigration(CONCURRENT_INDEX_MIGRATION);
    const database = await createTempDatabase({
      migrate: false,
      prefix: "concurrent_retry",
    });
    try {
      const logger = captureLogger().logger;
      await expect(
        migrateDatabase(database.url, { logger, migrationsFolder: failing }),
      ).rejects.toThrow("division by zero");
      // The ordinary migrations before it committed; the index statements
      // that ran stay, without a journal row for their migration.
      const pool = new Pool({ connectionString: database.url, max: 1 });
      try {
        const { rows } = await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        expect(Number(rows[0]?.count)).toBe(totalMigrations);
      } finally {
        await pool.end();
      }
      expect(await indexValidity(database.url)).toBe(true);

      expect(
        await migrateDatabase(database.url, {
          logger,
          migrationsFolder: fixed,
        }),
      ).toEqual({
        adopted: 0,
        applied: 1,
        total: totalMigrations + 1,
      });
      expect(await indexValidity(database.url)).toBe(true);
    } finally {
      await database.drop();
      rmSync(failing, { recursive: true, force: true });
      rmSync(fixed, { recursive: true, force: true });
    }
  },
  30_000,
);
