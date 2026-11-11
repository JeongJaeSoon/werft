import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { readJournal } from "./migration-journal.ts";

// Parallel branches each generate a migration on the main they started from.
// Merging one without regenerating it on top of the other leaves main with a
// snapshot that misses the other's tables: the next `drizzle-kit generate`
// then either aborts on a prevId collision (with exit code 0) or re-emits the
// other branch's DDL. None of that fails a migrate, so it is checked here.

interface Snapshot {
  readonly id: string;
  readonly prevId: string;
}

const snapshotFile = (tag: string) => `${tag.slice(0, 4)}_snapshot.json`;

function readSnapshot(folder: string, tag: string): Snapshot {
  return JSON.parse(
    readFileSync(join(folder, "meta", snapshotFile(tag)), "utf8"),
  ) as Snapshot;
}

/** Every way the folder disagrees with itself or with `schema`; empty when sound. */
export async function migrationFolderProblems(
  folder: string,
  schema: Record<string, unknown>,
): Promise<string[]> {
  const entries = readJournal(folder);
  const problems: string[] = [];

  const tags = entries.map(({ tag }) => tag);
  const sqlFiles = readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length));
  const snapshotFiles = readdirSync(join(folder, "meta")).filter((name) =>
    name.endsWith("_snapshot.json"),
  );
  for (const name of sqlFiles.filter((name) => !tags.includes(name))) {
    problems.push(`${name}.sql has no journal entry`);
  }
  for (const name of snapshotFiles.filter(
    (name) => !tags.some((tag) => snapshotFile(tag) === name),
  )) {
    problems.push(`meta/${name} has no journal entry`);
  }

  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (entry.tag.slice(0, 4) !== String(entry.idx).padStart(4, "0")) {
      problems.push(
        `${entry.tag}: file prefix does not match idx ${entry.idx}`,
      );
    }
    if (previous && entry.idx <= previous.idx) {
      problems.push(`${entry.tag}: idx is not above ${previous.tag}`);
    }
    // Drizzle applies by `when` and skips anything older than the newest
    // applied row, so a stale `when` is silently never applied.
    if (previous && entry.when <= previous.when) {
      problems.push(`${entry.tag}: when is not after ${previous.tag}`);
    }
    if (!sqlFiles.includes(entry.tag)) {
      problems.push(`${entry.tag}: sql file is missing`);
    }
    if (!snapshotFiles.includes(snapshotFile(entry.tag))) {
      problems.push(`${entry.tag}: meta/${snapshotFile(entry.tag)} is missing`);
    }
  });
  if (problems.length > 0) {
    return problems;
  }

  const snapshots = tags.map((tag) => readSnapshot(folder, tag));
  snapshots.forEach((current, index) => {
    const previous = snapshots[index - 1];
    if (previous && current.prevId !== previous.id) {
      problems.push(
        `${tags[index]}: snapshot prevId ${current.prevId} is not ${tags[index - 1]}'s id ${previous.id}` +
          " (generated on a base without that migration)",
      );
    }
  });
  if (new Set(snapshots.map(({ id }) => id)).size !== snapshots.length) {
    problems.push("two snapshots share an id");
  }

  const newest = snapshots.at(-1);
  const newestTag = tags.at(-1);
  if (newest && newestTag) {
    // generateMigration types its inputs as the exported snapshot shape; the
    // file on disk is exactly that shape.
    const pending = await generateMigration(
      newest as Parameters<typeof generateMigration>[0],
      generateDrizzleJson(schema, newest.id),
    );
    if (pending.length > 0) {
      problems.push(
        `schema.ts differs from the newest snapshot ${snapshotFile(newestTag)}; it would generate:\n${pending.join("\n")}`,
      );
    }
  }
  return problems;
}
