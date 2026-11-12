import { readMigrationFiles } from "drizzle-orm/migrator";
import { MIGRATIONS_FOLDER, readJournal } from "./migration-journal.ts";

export interface MigrationEntry {
  /** Drizzle stores this folder timestamp as created_at in its journal table. */
  readonly when: number;
  /** sha256 of the migration SQL, as Drizzle records it in its journal table. */
  readonly hash: string;
}

export interface MigrationHead extends MigrationEntry {
  readonly tag: string;
}

// Every packaged migration in order, read through Drizzle's own loader so the
// hashes match what its migrator (and adoptLegacyM0Schema) wrote.
export function expectedMigrations(): MigrationEntry[] {
  return readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map(
    (migration) => ({
      when: migration.folderMillis,
      hash: migration.hash,
    }),
  );
}

// The newest packaged migration: the schema version this build expects.
export function expectedMigrationHead(): MigrationHead {
  const last = expectedMigrations().at(-1);
  if (!last) {
    throw new Error("Migration journal is empty");
  }
  const tag = readJournal(MIGRATIONS_FOLDER).find(
    (entry) => entry.when === last.when,
  )?.tag;
  if (!tag) {
    throw new Error(`No journal entry for migration ${last.when}`);
  }
  return { tag, ...last };
}

// Every applied migration in order; raises 42P01 on a database that has no
// journal table at all.
export const APPLIED_MIGRATIONS_SQL =
  'SELECT hash, created_at::text AS "when" FROM "drizzle"."__drizzle_migrations" ORDER BY created_at';
