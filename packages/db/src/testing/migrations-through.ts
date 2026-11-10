import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_FOLDER } from "../migration-folder.ts";

/**
 * The last migration before the one that dropped the profiles and the rows
 * that named them (0268). A test of an earlier migration's backfill reads
 * the rows it counted here: 0268 empties the session tables after it.
 */
export const BEFORE_PROFILE_REMOVAL = "0267_agent_usage_turn_basis";

/**
 * A copy of the migrations folder whose journal ends at `lastTag` (or just
 * before it, with `exclusive`). The caller removes it.
 */
export function migrationsThrough(
  lastTag: string,
  options: { exclusive?: boolean } = {},
): string {
  const folder = mkdtempSync(join(tmpdir(), "migrations-through-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (at === -1) throw new Error(`no migration ${lastTag}`);
  journal.entries = journal.entries.slice(
    0,
    options.exclusive === true ? at : at + 1,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}
