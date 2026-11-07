// Regenerates this branch's migration on top of the base it was rebased onto.
//
// A migration generated on an older main cannot merge as-is once another
// migration lands first: its snapshot lacks that migration's tables and
// points at the wrong parent, and its `when` may predate it. The SQL itself is
// usually still right, so this regenerates the number, snapshot and journal
// entry on the new base and keeps the SQL when drizzle-kit regenerates exactly
// the same statements. SQL that differs (hand-written backfills, triggers, a
// NOT NULL split across statements) may depend on what the other migration
// changed; it is kept verbatim only with --keep-handwritten, after reading it
// against the new base.
//
// Usage, after squashing to one commit and `git rebase origin/main` (take the
// base side for conflicts under migrations/meta with
// `git checkout --ours -- packages/db/migrations/meta`; never drop your .sql):
//   bun run --cwd packages/db db:restack [--base <ref>] [--keep-handwritten]
//   bun run --cwd packages/db db:restack --check [--base <ref>]
// --check changes nothing: exit 0 when the migration already follows the base's
// head and the folder is sound, exit 1 with the reasons when a restack is due.
//
// Handles one migration per branch; a branch with several is asked to squash
// them. Multi-migration restacking waits for a branch that genuinely needs two.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  MIGRATIONS_FOLDER,
  migrationFolderProblems,
  readJournal,
} from "../src/migration-folder.ts";
import * as schema from "../src/schema.ts";

const BREAKPOINT = "--> statement-breakpoint";
const packageDir = join(import.meta.dir, "..");

function run(args: string[]) {
  return spawnSync("git", args, { cwd: packageDir, encoding: "utf8" });
}

// Set once migrations/ is modified. The run starts from a clean tree, so HEAD
// holds everything it touches; fail() puts migrations/ back from it.
let touched = false;

function fail(message: string): never {
  if (touched) {
    touched = false;
    const restored = [
      run(["checkout", "HEAD", "--", "migrations"]),
      run(["clean", "-fdq", "--", "migrations"]),
    ].every((result) => result.status === 0);
    message += restored
      ? "\n(packages/db/migrations is back as HEAD has it)"
      : "\n(could NOT restore packages/db/migrations; your SQL is still in HEAD:" +
        ' run `cd "$(git rev-parse --show-toplevel)" && git checkout HEAD -- packages/db/migrations && git clean -fd packages/db/migrations`)';
  }
  console.error(`db:restack: ${message}`);
  process.exit(1);
}

function git(...args: string[]): string {
  const result = run(args);
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

// Statements compared as drizzle-kit writes them; only the edges are trimmed,
// since whitespace inside a statement can be part of a literal.
function statements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex === -1 ? "origin/main" : process.argv[baseIndex + 1];
if (!base) {
  fail("--base needs a ref");
}
const keepHandwritten = process.argv.includes("--keep-handwritten");
if (base === "origin/main") {
  git("fetch", "--quiet", "origin", "main");
}

// git runs in packages/db: pathspecs below are relative to it, while
// `<rev>:<path>` and diff output are relative to the repository root.
const repoRoot = git("rev-parse", "--show-toplevel");
const migrationsPath = `${git("rev-parse", "--show-prefix")}migrations`;
if (git("status", "--porcelain")) {
  fail(
    "the working tree has uncommitted changes; finish the rebase and commit first",
  );
}
if (run(["merge-base", "--is-ancestor", base, "HEAD"]).status !== 0) {
  fail(`HEAD does not contain ${base}; rebase onto it first`);
}

const changed = git(
  "diff",
  "--name-status",
  base,
  "HEAD",
  "--",
  "migrations/*.sql",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t") as [string, string]);
const edited = changed.filter(([status]) => status !== "A");
if (edited.length > 0) {
  fail(
    `this branch changes migrations already on ${base}: ${edited.map(([, path]) => path).join(", ")}`,
  );
}
const added = changed.map(([, path]) => path);
if (added.length === 0) {
  // A branch that edited schema.ts but forgot its migration is not "nothing
  // to do" for --check: the folder check below catches the drift.
  const drift = process.argv.includes("--check")
    ? await migrationFolderProblems(MIGRATIONS_FOLDER, schema)
    : [];
  if (drift.length > 0) {
    console.error(
      `db:restack --check: the folder is not sound:\n${drift.join("\n")}`,
    );
    process.exit(1);
  }
  console.log("db:restack: no migration on this branch; nothing to do");
  process.exit(0);
}
const [ownPath, ...others] = added;
if (!ownPath || others.length > 0) {
  fail(
    `found ${added.length} migrations (${added.join(", ")}); squash them into one first`,
  );
}

const oldTag = basename(ownPath, ".sql");
const name = oldTag.replace(/^\d{4}_/, "");
const keptSql = readFileSync(join(repoRoot, ownPath), "utf8");
const baseMeta = new Set(
  git(
    "ls-tree",
    "--full-tree",
    "--name-only",
    `${base}:${migrationsPath}/meta`,
  ).split("\n"),
);
if (!baseMeta.has("_journal.json")) {
  fail(`could not list ${migrationsPath}/meta on ${base}`);
}

// Read-only: says whether this branch still needs a restack, so a lead can skip
// the squash-and-regenerate round when main took no number since the fork.
if (process.argv.includes("--check")) {
  const baseTag = (
    JSON.parse(git("show", `${base}:${migrationsPath}/meta/_journal.json`)) as {
      entries: { tag: string }[];
    }
  ).entries.at(-1)?.tag;
  if (!baseTag) {
    fail(`${base} has an empty migration journal`);
  }
  const wanted = String(Number(baseTag.slice(0, 4)) + 1).padStart(4, "0");
  const reasons = await migrationFolderProblems(MIGRATIONS_FOLDER, schema);
  if (!oldTag.startsWith(`${wanted}_`)) {
    reasons.unshift(
      `${oldTag} should be number ${wanted}, the one after ${baseTag} on ${base}`,
    );
  }
  if (reasons.length > 0) {
    console.error(`db:restack --check: restack needed:\n${reasons.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `db:restack --check: ${oldTag} follows ${baseTag}; nothing to do`,
  );
  process.exit(0);
}

function generate(custom: boolean): void {
  const args = ["run", "db:generate", "--name", name];
  if (custom) {
    args.push("--custom");
  }
  // stdin is closed so a rename prompt fails fast instead of waiting forever.
  const result = spawnSync(process.execPath, args, {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    fail(
      "drizzle-kit generate failed. If it wanted to ask about a rename, run" +
        ` \`bun run db:generate --name ${name}\` in a terminal instead:\n${result.stdout}${result.stderr}`,
    );
  }
}

// Unexpected errors from here on go through fail() too, so the tree is
// restored whatever breaks.
try {
  touched = true;
  // Rebuild migrations/ as the base has it, then let drizzle-kit add ours on top.
  rmSync(join(repoRoot, ownPath));
  git("checkout", base, "--", "migrations/meta");
  for (const file of readdirSync(join(MIGRATIONS_FOLDER, "meta"))) {
    if (!baseMeta.has(file)) {
      rmSync(join(MIGRATIONS_FOLDER, "meta", file));
    }
  }

  const baseEntries = readJournal(MIGRATIONS_FOLDER).length;
  generate(false);
  const custom = readJournal(MIGRATIONS_FOLDER).length === baseEntries;
  if (custom) {
    if (!keepHandwritten) {
      fail(
        `schema.ts no longer differs from ${base}. Either your migration is now redundant` +
          " (delete it) or it is hand-written SQL only (rerun with --keep-handwritten).",
      );
    }
    generate(true);
  }
  const entries = readJournal(MIGRATIONS_FOLDER);
  const newEntry = entries.at(-1);
  if (!newEntry || entries.length !== baseEntries + 1) {
    fail(
      "drizzle-kit did not add exactly one journal entry (it exits 0 on a snapshot collision)",
    );
  }
  const newTag = newEntry.tag;
  const newPath = join(MIGRATIONS_FOLDER, `${newTag}.sql`);

  if (!custom) {
    const regenerated = statements(readFileSync(newPath, "utf8"));
    const kept = statements(keptSql);
    const same =
      regenerated.length === kept.length &&
      regenerated.every((statement, index) => statement === kept[index]);
    if (!same && !keepHandwritten) {
      fail(
        `your SQL is not what drizzle-kit generates on ${base}. Read it against the new` +
          " base; if it still holds, rerun with --keep-handwritten to keep it verbatim.\n" +
          `Generated on ${base}:\n${regenerated.join("\n")}\n` +
          `Only in your SQL:\n${kept.filter((statement) => !regenerated.includes(statement)).join("\n")}`,
      );
    }
  }
  writeFileSync(newPath, keptSql);

  const problems = await migrationFolderProblems(MIGRATIONS_FOLDER, schema);
  if (problems.length > 0) {
    fail(`the regenerated folder is not sound:\n${problems.join("\n")}`);
  }
  console.log(
    `db:restack: ${oldTag} -> ${newTag}${custom ? " (custom SQL, no schema diff)" : ""}.` +
      ` Commit ${migrationsPath} and push.`,
  );
} catch (error) {
  fail(
    `unexpected failure: ${error instanceof Error ? error.stack : String(error)}`,
  );
}
