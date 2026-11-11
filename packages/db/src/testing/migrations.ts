import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";

/** Applies one migration file statement by statement, the way the migrator would. */
export async function applyMigrationFile(
  client: PGlite,
  file: string,
): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_FOLDER, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await client.exec(statement);
  }
}
