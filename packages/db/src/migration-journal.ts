import { readFileSync } from "node:fs";
import { join } from "node:path";

// migrate.ts and migration-head.ts load this in images installed without
// devDependencies, so it must not import drizzle-kit.

export const MIGRATIONS_FOLDER = join(import.meta.dir, "../migrations");

export interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

export function readJournal(folder: string): JournalEntry[] {
  return (
    JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    }
  ).entries;
}
