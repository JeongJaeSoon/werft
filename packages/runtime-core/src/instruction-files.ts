import { posix } from "node:path";

/**
 * Past this the run is refused rather than handed part of the file: a cut can
 * drop the rule that mattered or end one mid-sentence, and a model cannot
 * tell a truncated policy from a complete one.
 */
export const COMMITTED_INSTRUCTIONS_MAX_BYTES = 64 * 1024;
/** Enough for a CLAUDE.md -> AGENTS.md -> docs/... chain; more is a loop. */
const MAX_LINK_HOPS = 8;
/** Linux's PATH_MAX: no checkout could create a link to anything longer. */
const MAX_LINK_TARGET_BYTES = 4096;

export type CommittedInstructions =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "refused"; reason: string };

/**
 * One commit's tree, read from wherever it is stored (a local git's object
 * store, a forge's API). A read that cannot answer throws; the throw is
 * the file's refusal.
 */
export interface CommittedTree {
  /** The entry at exactly `path`, or null when the tree has none there. */
  entry(
    path: string,
  ): Promise<{ mode: string; type: string; object: string } | null>;
  size(object: string): Promise<number>;
  /** The blob as text. */
  read(object: string): Promise<string>;
}

/**
 * The first of the root instruction files `files` (AGENTS.md, else CLAUDE.md
 * for the Claude runtime) that the tree has. A file
 * that is only an `@<other file>` line stands for that file, so a CLAUDE.md
 * importing AGENTS.md is read once. A committed symlink is
 * followed only to another path in the same tree (`CLAUDE.md -> AGENTS.md`
 * is ordinary); one that leaves it, loops, or ends at anything but a file is
 * refused, as is a file past the cap.
 *
 * Left out, against what the engine itself loads: `.claude/CLAUDE.md`,
 * `CLAUDE.local.md`, `.claude/rules/`, nested directories' files and `@`
 * imports — each is another path to resolve the same way, worth adding when
 * a repository the platform serves depends on one.
 *
 * A file the tree has wins, even when it is refused: falling through to the
 * next name would hand the run rules the repository ranks below the broken one.
 */
export async function firstCommittedInstructions(
  tree: CommittedTree,
  files: readonly string[],
): Promise<CommittedInstructions> {
  return (await namedCommittedInstructions(tree, files)).found;
}

/** `firstCommittedInstructions`, with the name it was found under. */
export async function namedCommittedInstructions(
  tree: CommittedTree,
  files: readonly string[],
): Promise<{ file: string | null; found: CommittedInstructions }> {
  for (const file of files) {
    const found = await resolveCommittedInstructions(tree, file);
    if (found.kind === "absent") continue;
    if (found.kind !== "text") return { file, found };
    const imported = /^@(\S+)$/.exec(found.text.trim())?.[1];
    // One hop only, so two files importing each other cannot loop.
    return imported !== undefined &&
      imported !== file &&
      files.includes(imported)
      ? {
          file: imported,
          found: await resolveCommittedInstructions(tree, imported),
        }
      : { file, found };
  }
  return { file: null, found: { kind: "absent" } };
}

async function resolveCommittedInstructions(
  tree: CommittedTree,
  file: string,
): Promise<CommittedInstructions> {
  let path = file;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const entry = await tree.entry(path);
    if (entry === null) return { kind: "absent" };
    if (entry.mode === "120000") {
      // Sized before it is read, like the file itself: no filesystem limit on
      // link targets stands between a huge blob and this process's memory.
      if ((await tree.size(entry.object)) > MAX_LINK_TARGET_BYTES) {
        return { kind: "refused", reason: "it links to an overlong path" };
      }
      const target = await tree.read(entry.object);
      // A link is an arbitrary blob; no filesystem path holds a NUL.
      if (target.includes("\0")) {
        return { kind: "refused", reason: "it links to a malformed path" };
      }
      const next = posix.normalize(posix.join(posix.dirname(path), target));
      if (posix.isAbsolute(target) || next === ".." || next.startsWith("../")) {
        return { kind: "refused", reason: "it links outside the repository" };
      }
      // A path that names a directory this way names no file, and listing
      // what is in it is unbounded work for a read that runs for every session.
      if (next === "." || next.endsWith("/")) {
        return { kind: "refused", reason: "it is not a regular file" };
      }
      path = next;
      continue;
    }
    if (entry.type !== "blob") {
      return { kind: "refused", reason: "it is not a regular file" };
    }
    if ((await tree.size(entry.object)) > COMMITTED_INSTRUCTIONS_MAX_BYTES) {
      return {
        kind: "refused",
        reason: `it is larger than ${COMMITTED_INSTRUCTIONS_MAX_BYTES} bytes`,
      };
    }
    return { kind: "text", text: await tree.read(entry.object) };
  }
  return { kind: "refused", reason: "it links through too many symlinks" };
}
