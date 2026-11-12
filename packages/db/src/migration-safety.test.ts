import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableName, isTable } from "drizzle-orm";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { GROWING_TABLES, migrationSafetyProblems } from "./migration-safety.ts";
import * as schema from "./schema.ts";

const copies: string[] = [];

afterEach(() => {
  for (const folder of copies.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

// The packaged folder plus one migration after its newest.
function withMigration(sql: string): string {
  const folder = mkdtempSync(join(tmpdir(), "migrations-"));
  copies.push(folder);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  if (!last) throw new Error("empty journal");
  const tag = `${String(last.idx + 1).padStart(4, "0")}_under_test`;
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

// The file's number follows the packaged head, so it is left out.
const problemsOf = (...statements: string[]) =>
  migrationSafetyProblems(
    withMigration(statements.join("--> statement-breakpoint\n")),
  ).map((problem) => problem.replace(/^\d+_under_test/, "under_test"));

describe("migration safety", () => {
  test("the packaged migrations after the baseline follow the rules", () => {
    expect(migrationSafetyProblems(MIGRATIONS_FOLDER)).toEqual([]);
  });

  test("every growing table is a table in the schema", () => {
    const tables = new Set<string>(
      Object.values(schema)
        .filter((value) => isTable(value))
        .map((table) => getTableName(table)),
    );
    expect(GROWING_TABLES.filter((name) => !tables.has(name))).toEqual([]);
  });

  test("an index on a growing table outside a no-transaction migration is caught", () => {
    expect(
      problemsOf(
        `CREATE INDEX "turns_status_idx" ON "turns" USING btree ("status");`,
      ),
    ).toEqual([
      "under_test.sql: index turns_status_idx on turns must be built CONCURRENTLY in a no-transaction migration",
    ]);
  });

  test("a concurrent build without the marker, or without dropping a failed build first, is caught", () => {
    expect(
      problemsOf(
        `CREATE INDEX CONCURRENTLY "turns_status_idx" ON "turns" ("status");`,
      ),
    ).toEqual([
      'under_test.sql: CONCURRENTLY needs the migration\'s first line to be "-- migrate:no-transaction"',
      "under_test.sql: CREATE INDEX CONCURRENTLY turns_status_idx needs DROP INDEX CONCURRENTLY IF EXISTS turns_status_idx before it",
    ]);
  });

  test("a rerunnable concurrent build passes", () => {
    expect(
      problemsOf(
        `-- migrate:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS "turns_status_idx";`,
        `CREATE INDEX CONCURRENTLY "turns_status_idx" ON "turns" ("status") WHERE "turns"."status" IN ('queued', 'running');`,
      ),
    ).toEqual([]);
  });

  test("DDL on a table the same migration creates is not checked", () => {
    expect(
      problemsOf(
        `CREATE TABLE "session_event_archives" ("id" bigserial PRIMARY KEY NOT NULL, "session_id" uuid NOT NULL);`,
        `CREATE INDEX "session_event_archives_session_idx" ON "session_event_archives" ("session_id");`,
      ),
    ).toEqual([]);
  });

  test("rewrites, locked scans and in-transaction backfills of a growing table are caught", () => {
    expect(
      problemsOf(
        `ALTER TABLE "events" ADD COLUMN "token" uuid DEFAULT gen_random_uuid();`,
        `ALTER TABLE "events" ADD COLUMN "kind" text NOT NULL;`,
        `ALTER TABLE "turns" ALTER COLUMN "message" SET DATA TYPE varchar(100);`,
        `ALTER TABLE "turns" ALTER COLUMN "actor_id" SET NOT NULL;`,
        `ALTER TABLE "sessions" ADD CONSTRAINT "sessions_x_check" CHECK ("sessions"."x" >= 0);`,
        `ALTER TABLE "sessions" ADD CONSTRAINT "sessions_x_uniq" UNIQUE("x");`,
        `UPDATE "turns" SET "x" = 1;`,
      ).map((problem) => problem.split(": ")[1]?.split(";")[0]),
    ).toEqual([
      "a volatile DEFAULT on a new column rewrites events",
      "a NOT NULL column without a DEFAULT fails on a non-empty events",
      "changing a column type rewrites turns under an exclusive lock",
      "SET NOT NULL scans turns under an exclusive lock",
      "a new constraint on sessions scans it under a lock that blocks writes",
      "a new UNIQUE or PRIMARY KEY constraint builds its index on sessions under an exclusive lock",
      "UPDATE on turns inside the migration holds its row locks until the whole migration commits",
    ]);
  });

  test("the shorter spellings of the same changes are caught", () => {
    expect(
      problemsOf(
        `ALTER TABLE "events" ADD "token" uuid DEFAULT gen_random_uuid();`,
        `ALTER TABLE "events" ADD COLUMN "n" serial NOT NULL;`,
        `ALTER TABLE "events" ADD COLUMN "n" bigint GENERATED ALWAYS AS IDENTITY;`,
        `ALTER TABLE "events" ADD COLUMN "ref" text UNIQUE;`,
        `ALTER TABLE "events" ADD COLUMN "turn" uuid REFERENCES "turns"("id");`,
        `ALTER TABLE "events" ADD FOREIGN KEY ("turn_id") REFERENCES "turns"("id");`,
        `ALTER TABLE "events" ADD UNIQUE ("ref");`,
        `WITH old AS (SELECT 1) UPDATE "turns" SET "x" = 1;`,
      ).map((problem) => problem.split(": ")[1]?.split(";")[0]),
    ).toEqual([
      "a volatile DEFAULT on a new column rewrites events",
      "a serial, identity or generated column rewrites events",
      "a serial, identity or generated column rewrites events",
      "a UNIQUE, PRIMARY KEY or REFERENCES clause on a new column locks events while it builds or checks",
      "a UNIQUE, PRIMARY KEY or REFERENCES clause on a new column locks events while it builds or checks",
      "a new constraint on events scans it under a lock that blocks writes",
      "a new UNIQUE or PRIMARY KEY constraint builds its index on events under an exclusive lock",
      "UPDATE on turns inside the migration holds its row locks until the whole migration commits",
    ]);
  });

  test("a constraint validated in the migration that adds it is caught", () => {
    expect(
      problemsOf(
        `ALTER TABLE "events" ADD CONSTRAINT "events_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "turns"("id") NOT VALID;`,
        `ALTER TABLE "events" VALIDATE CONSTRAINT "events_turn_fk";`,
      ),
    ).toEqual([
      "under_test.sql: VALIDATE CONSTRAINT events_turn_fk runs under the lock its ADD took; validate it in a later migration",
    ]);
  });

  test("an unnamed concurrent index and statements without a breakpoint between them are caught", () => {
    expect(
      problemsOf(
        `-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY ON "turns" ("status");`,
        `DROP INDEX CONCURRENTLY IF EXISTS "a";\nCREATE INDEX CONCURRENTLY "a" ON "turns" ("status");`,
      ),
    ).toEqual([
      "under_test.sql: CREATE INDEX CONCURRENTLY on turns needs a name, so a failed build can be dropped before the next try",
      'under_test.sql: more than one statement between breakpoints; put "--> statement-breakpoint" after each',
    ]);
  });

  test("the safe forms of the same changes pass", () => {
    expect(
      problemsOf(
        `ALTER TABLE "events" ADD COLUMN "kind" text DEFAULT 'event' NOT NULL;`,
        `ALTER TABLE "events" ADD COLUMN "seen_at" timestamp with time zone DEFAULT now();`,
        `ALTER TABLE "sessions" ADD CONSTRAINT "sessions_x_check" CHECK ("sessions"."x" >= 0) NOT VALID;`,
        `ALTER TABLE "turns" VALIDATE CONSTRAINT "turns_y_check";`,
        `ALTER TABLE "events" ADD COLUMN "unique_ref" text;`,
        `UPDATE "slack_apps" SET "x" = 1;`,
        `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql;`,
        `CREATE FUNCTION g() RETURNS void AS $fn$ BEGIN PERFORM 1; PERFORM 2; END $fn$ LANGUAGE plpgsql;`,
        `ALTER TABLE "events" ADD COLUMN "sep" text DEFAULT ';x'; -- a note`,
        `ALTER TABLE "events" ADD COLUMN "generated" text;`,
        `ALTER TABLE "events" ADD COLUMN "references" text;`,
      ),
    ).toEqual([]);
  });
});
