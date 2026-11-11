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
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  type JournalEntry,
  MIGRATIONS_FOLDER,
  migrationFolderProblems,
  readJournal,
} from "./migration-folder.ts";
import * as schema from "./schema.ts";

const copies: string[] = [];

function copyOfMigrations(): string {
  const folder = mkdtempSync(join(tmpdir(), "migrations-"));
  copies.push(folder);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  return folder;
}

function editJson<T>(path: string, edit: (value: T) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as T;
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

type Journal = { entries: JournalEntry[] };

/** The last `count` journal entries of a folder that has at least that many. */
function lastEntries(folder: string, count: number): JournalEntry[] {
  const entries = readJournal(folder).slice(-count);
  expect(entries).toHaveLength(count);
  return entries;
}

const snapshotPath = (folder: string, entry: JournalEntry) =>
  join(folder, `meta/${entry.tag.slice(0, 4)}_snapshot.json`);

afterEach(() => {
  for (const folder of copies.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("migration folder", () => {
  test("the packaged migrations are sound", async () => {
    expect(await migrationFolderProblems(MIGRATIONS_FOLDER, schema)).toEqual(
      [],
    );
  });

  test("a snapshot generated on a base without the previous migration is caught", async () => {
    // What a branch that did not regenerate after rebasing looks like: its
    // snapshot points at the grandparent and lacks the parent's tables.
    const folder = copyOfMigrations();
    const [grandparent, parent, newest] = lastEntries(folder, 3) as [
      JournalEntry,
      JournalEntry,
      JournalEntry,
    ];
    const grandparentId = (
      JSON.parse(readFileSync(snapshotPath(folder, grandparent), "utf8")) as {
        id: string;
      }
    ).id;
    editJson<{ prevId: string }>(snapshotPath(folder, newest), (snapshot) => {
      snapshot.prevId = grandparentId;
    });

    const problems = await migrationFolderProblems(folder, schema);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`is not ${parent.tag}'s id`);
  });

  test("schema.ts ahead of the newest snapshot is caught", async () => {
    const folder = copyOfMigrations();
    // A table the newest snapshot does not hold. Only added, never paired
    // with a drop: a drop beside an add makes the diff ask whether it is a
    // rename, which a test cannot answer.
    const ahead = {
      ...schema,
      migrationFolderProbe: pgTable("migration_folder_probe", {
        id: text().primaryKey(),
      }),
    };

    const problems = await migrationFolderProblems(folder, ahead);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("schema.ts differs from the newest snapshot");
  });

  test("a stale when and a mismatched file prefix are caught", async () => {
    const folder = copyOfMigrations();
    const [previous, newest] = lastEntries(folder, 2) as [
      JournalEntry,
      JournalEntry,
    ];
    editJson<Journal>(join(folder, "meta/_journal.json"), (journal) => {
      journal.entries.splice(-1, 1, {
        ...newest,
        idx: newest.idx + 1,
        when: previous.when - 1,
      });
    });

    const problems = await migrationFolderProblems(folder, schema);
    expect(
      problems.some((problem) => problem.includes("when is not after")),
    ).toBe(true);
    expect(
      problems.some((problem) => problem.includes("does not match idx")),
    ).toBe(true);
  });

  test("files without a journal entry are caught", async () => {
    const folder = copyOfMigrations();
    writeFileSync(join(folder, "9999_orphan.sql"), "SELECT 1;");

    expect(await migrationFolderProblems(folder, schema)).toEqual([
      "9999_orphan.sql has no journal entry",
    ]);
  });
});
