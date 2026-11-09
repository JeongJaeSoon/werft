import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { runGit } from "./workspace.ts";

const CANONICAL = "AGENTS.md";
const LINK = "CLAUDE.md";
// An exclude file carrying the pre-rename marker is not recognised: its
// AGENTS.md is "kept" as foreign, and the exclude lines it came with still
// keep both names out of captures.
const EXCLUDE_MARKER = "# werft: instruction files";

export type InstructionPlacement =
  | "placed"
  | "refreshed"
  // The repository has an instruction file of its own, or the paths hold
  // something this function did not make.
  | "kept"
  | "skipped";

/**
 * Puts the platform's instructions at the workspace root as AGENTS.md, with
 * CLAUDE.md a link to it, for engines and tools that open the file themselves.
 * The Claude engine gets the same text through its system prompt either way.
 *
 * Nothing the repository owns is overwritten: when either name is tracked
 * (in HEAD or the index) or exists untracked without being ours, nothing is
 * written. The names go into `.git/info/exclude` first, so a file that
 * exists is never one a checkpoint capture or a commit would pick up.
 */
export async function placeInstructionFiles(input: {
  root: string;
  text: string;
  signal: AbortSignal;
}): Promise<InstructionPlacement> {
  const { root, signal } = input;
  const gitDir = join(root, ".git");
  if (!(await lstat(gitDir).catch(() => null))?.isDirectory()) return "skipped";
  if (input.text.trim() === "") {
    // A file the repository tracks now is the repository's, marker or not.
    if (await repositoryTracks(root, signal)) return "kept";
    await removePlacedFiles(root, gitDir);
    return "skipped";
  }

  if (await repositoryTracks(root, signal)) return "kept";

  const exclude = join(gitDir, "info", "exclude");
  const excludes = await readFile(exclude, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const marked = excludes.includes(EXCLUDE_MARKER);
  const agents = await lstat(join(root, CANONICAL)).catch(() => null);
  const link = await lstat(join(root, LINK)).catch(() => null);
  // A path that exists is ours only with the marker, and only in the shape
  // this function leaves it in.
  const agentsOurs = agents === null || (marked && agents.isFile());
  const linkOurs =
    link === null ||
    (marked &&
      link.isSymbolicLink() &&
      (await readlink(join(root, LINK))) === CANONICAL);
  if (!agentsOurs || !linkOurs) return "kept";

  signal.throwIfAborted();
  // The marker is the proof a file is ours. Until AGENTS.md is written it
  // must not outlive a call that placed nothing, whether that call skipped
  // or failed, or a file someone adds later would look ours.
  const withdrawMarker = async () => {
    if (!marked) await replaceFile(gitDir, exclude, excludes).catch(() => {});
  };
  try {
    if (!marked) {
      await mkdir(join(gitDir, "info"), { recursive: true });
      await replaceFile(
        gitDir,
        exclude,
        `${excludes}${excludes === "" || excludes.endsWith("\n") ? "" : "\n"}${EXCLUDE_MARKER}\n/${CANONICAL}\n/${LINK}\n`,
      );
    }
    // The repository's own .gitignore can re-include a name (`!AGENTS.md`),
    // and then the exclude would not keep the file out of a commit or capture.
    if (!(await ignored(root, [CANONICAL, LINK], signal))) {
      await withdrawMarker();
      return "skipped";
    }
    signal.throwIfAborted();
    await replaceFile(gitDir, join(root, CANONICAL), ensureNewline(input.text));
  } catch (error) {
    // AGENTS.md may or may not have landed; only an absent one is unplaced.
    if (!(await lstat(join(root, CANONICAL)).catch(() => null))) {
      await withdrawMarker();
    }
    throw error;
  }
  signal.throwIfAborted();
  if (link === null) {
    const staged = scratchPath(gitDir);
    try {
      await symlink(CANONICAL, staged);
      await rename(staged, join(root, LINK));
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }
  return agents === null && link === null ? "placed" : "refreshed";
}

/**
 * A workspace restored from an earlier attempt may hold the files that
 * attempt placed, with text this one no longer sends. Only files carrying
 * the marker, in the shape placeInstructionFiles leaves them, are removed.
 */
async function removePlacedFiles(root: string, gitDir: string): Promise<void> {
  const excludes = await readFile(
    join(gitDir, "info", "exclude"),
    "utf8",
  ).catch(() => "");
  if (!excludes.includes(EXCLUDE_MARKER)) return;
  const link = await lstat(join(root, LINK)).catch(() => null);
  if (
    link?.isSymbolicLink() &&
    (await readlink(join(root, LINK)).catch(() => null)) === CANONICAL
  ) {
    await rm(join(root, LINK), { force: true });
  }
  const agents = await lstat(join(root, CANONICAL)).catch(() => null);
  if (agents?.isFile()) await rm(join(root, CANONICAL), { force: true });
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// Named like the worker's other scratch under `.git`, which a later attempt
// sweeps if a kill leaves it behind.
function scratchPath(gitDir: string): string {
  return join(
    gitDir,
    `werft-place-${randomBytes(4).toString("hex").slice(0, 6)}`,
  );
}

async function replaceFile(
  gitDir: string,
  path: string,
  contents: string,
): Promise<void> {
  const staged = scratchPath(gitDir);
  try {
    await writeFile(staged, contents);
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

async function ignored(
  root: string,
  names: string[],
  signal: AbortSignal,
): Promise<boolean> {
  for (const name of names) {
    const result = await runGit(["check-ignore", "-q", "--", name], {
      cwd: root,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal,
    });
    if (result.code !== 0) return false;
  }
  return true;
}

async function repositoryTracks(
  root: string,
  signal: AbortSignal,
): Promise<boolean> {
  const run = (args: string[]) =>
    runGit(args, {
      cwd: root,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal,
    });
  const names = ["--", CANONICAL, LINK];
  const index = await run(["--literal-pathspecs", "ls-files", "-z", ...names]);
  // Unknown is not "untracked": a file this cannot rule out stays alone.
  if (index.code !== 0) return true;
  if (index.stdout !== "") return true;
  // No HEAD to list (code != 0) means nothing committed there.
  const head = await run([
    "--literal-pathspecs",
    "ls-tree",
    "--name-only",
    "-z",
    "HEAD",
    ...names,
  ]);
  return head.code === 0 && head.stdout !== "";
}
