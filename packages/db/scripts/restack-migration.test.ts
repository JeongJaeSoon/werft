import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "../src/migrate.ts";
import {
  migrationFolderProblems,
  readJournal,
} from "../src/migration-folder.ts";

// db:restack runs on git history, so each case builds it in a scratch
// repository holding a copy of this package: `fork` is where the branch left
// main, and a branch is committed as `git rebase` plus
// `git checkout --ours -- packages/db/migrations/meta` leaves it.
const packageDir = join(import.meta.dir, "..");
const repoRoot = join(packageDir, "../..");
const TIMEOUT_MS = 180_000;

let root: string;
let pkg: string;
let migrations: string;
let next: number;

function git(...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=restack-test",
      "-c",
      "user.email=restack-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function bun(...args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: pkg,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function addTable(name: string): void {
  appendFileSync(
    join(pkg, "src/schema.ts"),
    `\nexport const ${name} = pgTable("${name}", { id: text().primaryKey() });\n`,
  );
}

function generate(name: string): string {
  const result = bun("run", "db:generate", "--name", name);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const tag = readJournal(migrations).at(-1)?.tag ?? "";
  expect(tag).toEndWith(`_${name}`);
  return tag;
}

const tag = (index: number, name: string) =>
  `${String(index).padStart(4, "0")}_${name}`;

// schema.ts is edited between calls, so each import is a fresh module.
async function problems(): Promise<string[]> {
  const schema = await import(`${join(pkg, "src/schema.ts")}?${Date.now()}`);
  return migrationFolderProblems(migrations, schema);
}

// An existing database: migrated up to the journal minus its last `landed`
// entries with the real migrate(), then upgraded with the whole folder.
async function upgradeExisting(landed: number): Promise<{
  tables: string[];
  applied: number;
}> {
  const entries = readJournal(migrations);
  const older = mkdtempSync(join(tmpdir(), "restack-older-"));
  const db = new PGlite();
  try {
    cpSync(migrations, older, { recursive: true });
    writeFileSync(
      join(older, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: entries.slice(0, -landed),
      }),
    );
    await migrate(drizzle(db), { migrationsFolder: older });
    await migrate(drizzle(db), { migrationsFolder: migrations });
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'restack_%' ORDER BY 1",
    );
    const applied = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"',
    );
    expect(applied.rows[0]?.n).toBe(entries.length);
    return {
      tables: tables.rows.map((row) => row.table_name),
      applied: entries.length,
    };
  } finally {
    await db.close();
    rmSync(older, { recursive: true, force: true });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "restack-"));
  pkg = join(root, "packages/db");
  migrations = join(pkg, "migrations");
  for (const part of [
    "package.json",
    "drizzle.config.ts",
    "scripts",
    "src",
    "migrations",
  ]) {
    cpSync(join(packageDir, part), join(pkg, part), { recursive: true });
  }
  cpSync(join(repoRoot, "biome.json"), join(root, "biome.json"));
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  // No trailing slash: git sees the symlink as a file, not a directory.
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  next = Number(readJournal(migrations).at(-1)?.tag.slice(0, 4)) + 1;
  git("init", "-q", "-b", "fork");
  git("add", ".");
  git("commit", "-qm", "fork");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("db:restack", () => {
  test(
    "moves a migration whose number main took since the fork to the next number",
    async () => {
      git("switch", "-qc", "collision-branch", "fork");
      addTable("restack_branch");
      const branchTag = generate("restack_branch");
      expect(branchTag).toBe(tag(next, "restack_branch"));
      git("add", ".");
      git("commit", "-qm", "branch");

      git("switch", "-qc", "collision-main", "fork");
      addTable("restack_main");
      expect(generate("restack_main")).toBe(tag(next, "restack_main"));
      git("add", ".");
      git("commit", "-qm", "main");

      git("switch", "-qc", "collision-rebased", "collision-main");
      addTable("restack_branch");
      const sql = git(
        "show",
        `collision-branch:packages/db/migrations/${branchTag}.sql`,
      );
      writeFileSync(join(migrations, `${branchTag}.sql`), `${sql}\n`);
      git("add", ".");
      git("commit", "-qm", "rebased");
      expect(await problems()).toContain(
        `${branchTag}.sql has no journal entry`,
      );

      const due = bun(
        "run",
        "scripts/restack-migration.ts",
        "--check",
        "--base",
        "collision-main",
      );
      expect(due.status, `${due.stdout}${due.stderr}`).toBe(1);
      expect(due.stderr).toContain(
        `should be number ${String(next + 1).padStart(4, "0")}`,
      );

      const result = bun(
        "run",
        "scripts/restack-migration.ts",
        "--base",
        "collision-main",
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const moved = tag(next + 1, "restack_branch");
      expect(result.stdout).toContain(`${branchTag} -> ${moved}`);
      expect(
        readJournal(migrations)
          .slice(-2)
          .map((entry) => entry.tag),
      ).toEqual([tag(next, "restack_main"), moved]);
      expect(existsSync(join(migrations, `${branchTag}.sql`))).toBe(false);
      expect(await problems()).toEqual([]);
      git("add", ".");
      git("commit", "-qm", "restacked");

      // The branch was generated first but lands second. Once restacked it
      // needs no more work, and a database that already ran main's migration
      // (or only the fork) upgrades to have both tables.
      const settled = bun(
        "run",
        "scripts/restack-migration.ts",
        "--check",
        "--base",
        "collision-main",
      );
      expect(settled.status, `${settled.stdout}${settled.stderr}`).toBe(0);
      for (const landed of [1, 2]) {
        expect(await upgradeExisting(landed)).toEqual({
          tables: ["restack_branch", "restack_main"],
          applied: readJournal(migrations).length,
        });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "--check fails a branch that changed the schema without a migration",
    () => {
      git("switch", "-qc", "forgot", "fork");
      const clean = bun(
        "run",
        "scripts/restack-migration.ts",
        "--check",
        "--base",
        "fork",
      );
      expect(clean.status, `${clean.stdout}${clean.stderr}`).toBe(0);

      addTable("restack_forgot");
      git("add", ".");
      git("commit", "-qm", "schema only");
      const forgot = bun(
        "run",
        "scripts/restack-migration.ts",
        "--check",
        "--base",
        "fork",
      );
      expect(forgot.status, `${forgot.stdout}${forgot.stderr}`).toBe(1);
      expect(forgot.stderr).toContain("the folder is not sound");
    },
    TIMEOUT_MS,
  );

  test(
    "renumbers a migration that skips numbers to the next one",
    async () => {
      git("switch", "-qc", "gap", "fork");
      addTable("restack_gap");
      const generated = generate("restack_gap");
      git("checkout", "fork", "--", "packages/db/migrations/meta");
      git("clean", "-fdq", "--", "packages/db/migrations/meta");
      const skipping = tag(next + 3, "restack_gap");
      renameSync(
        join(migrations, `${generated}.sql`),
        join(migrations, `${skipping}.sql`),
      );
      git("add", ".");
      git("commit", "-qm", "gap");
      expect(await problems()).toContain(
        `${skipping}.sql has no journal entry`,
      );

      const result = bun(
        "run",
        "scripts/restack-migration.ts",
        "--base",
        "fork",
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        `${skipping} -> ${tag(next, "restack_gap")}`,
      );
      expect(readJournal(migrations).at(-1)?.tag).toBe(
        tag(next, "restack_gap"),
      );
      expect(existsSync(join(migrations, `${skipping}.sql`))).toBe(false);
      expect(await problems()).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
