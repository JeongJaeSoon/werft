import { lstat, opendir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  CHECKPOINT_INSTRUCTIONS_REF,
  type CheckpointBundleRefs,
  checkpointBundleRefs,
  PEELED_REF_FORMAT,
  peeledCommits,
} from "@werft-ai/runtime-core";
import {
  type CommittedInstructions,
  check,
  type Git,
  readCommittedInstructions,
  runGit,
  writeLocalExcludes,
} from "./workspace.ts";
import {
  CHECKPOINT_GIT_CONFIG,
  checkpointGitLimits,
  required,
} from "./workspace-capture.ts";

/**
 * A checkpoint bundle fetched into a repository of the worker's own, outside
 * the workspace's tree, and checked against the manifest before the
 * workspace is touched. The instructions commit is read from it, and a
 * restore that keeps it cuts it down to that commit's objects, which later
 * captures take as an object source so the commit stays bundleable after
 * the engine prunes its own copy.
 */
export type StagedCheckpoint = CheckpointBundleRefs & {
  repository: string;
  /** Every ref tip of the chain's bundles, which the next capture builds on. */
  tips: string[];
};

/**
 * Where, inside the restored workspace's new `.git`, the directory a restore
 * staged into (`restoreCheckpointTree`'s `keep`) ends up.
 */
export const RESTORED_CHECKPOINT_DIRECTORY = "werft-checkpoint";

const STAGED = "refs/bundle/";
const RESTORING = "refs/restore/";
/** Names read from the old root before any of them is removed. */
const CLEAR_BATCH = 1024;

/**
 * A bundle that passed its digest but is not one `captureWorkspace` writes:
 * damage the checkpoint carries, which no retry of the restore mends.
 */
export class CheckpointBundleRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CheckpointBundleRefused";
  }
}

/**
 * Fetches `bundle` into a new bare repository at `repository` and reads its
 * refs back, after the `bases` it builds on, oldest first. Throws
 * `CheckpointBundleRefused` for a bundle that is not the one
 * `captureWorkspace` writes, by the rule
 * finalize applies too (`checkpointBundleRefs`). The fetch checks every
 * object (`fsckObjects`), so what is staged is whole.
 */
export async function stageCheckpointBundle(input: {
  bases?: readonly string[];
  bundle: string;
  gitCommit: string;
  repository: string;
  signal: AbortSignal;
}): Promise<StagedCheckpoint> {
  const { repository, signal } = input;
  const git = localGit(dirname(repository), signal, { GIT_DIR: repository });
  await check(
    git(["init", "--quiet", "--bare", "--template=", repository]),
    "init",
  );
  const fetch = (bundle: string, refspec: string) =>
    check(
      git([
        "-c",
        "fetch.fsckObjects=true",
        "-c",
        "transfer.fsckObjects=true",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        bundle,
        refspec,
      ]),
      "fetch bundle",
    );
  const listed = async (bundle: string) => {
    const heads = await required(
      git(["bundle", "list-heads", bundle]),
      "bundle list-heads",
    );
    const refs = new Map<string, string>();
    for (const line of heads.split("\n")) {
      if (line === "") continue;
      const [oid, name] = line.split(" ");
      if (oid === undefined || name === undefined || refs.has(name)) {
        throw new CheckpointBundleRefused(
          `Checkpoint bundle lists a malformed ref: ${line}`,
        );
      }
      refs.set(name, oid);
    }
    return refs;
  };
  const tips: string[] = [];
  // Each base's refs kept apart, so the next one's prerequisites are here
  // and nothing of the tip's is shadowed.
  for (const [index, base] of (input.bases ?? []).entries()) {
    tips.push(...(await listed(base)).values());
    await fetch(base, `refs/*:refs/base/${index}/*`);
  }
  const refs = await listed(input.bundle);
  tips.push(...refs.values());
  await fetch(input.bundle, `refs/*:${STAGED}*`);
  const staged = peeledCommits(
    await required(
      git(["for-each-ref", `--format=${PEELED_REF_FORMAT}`, STAGED]),
      "for-each-ref",
    ),
  );
  const checked = checkpointBundleRefs(
    [...refs.keys()].map((name) => [
      name,
      name.startsWith("refs/")
        ? (staged.get(`${STAGED}${name.slice("refs/".length)}`) ?? null)
        : null,
    ]),
    input.gitCommit,
  );
  if (checked.status === "invalid") {
    throw new CheckpointBundleRefused(checked.reason);
  }
  return { ...checked.refs, repository, tips };
}

/**
 * The first of the instruction files `files` that is committed at the staged
 * instructions commit.
 * A checkpoint that pins none is refused rather than read as having no file,
 * so a profile that wants the file fails instead of resuming without it.
 */
export async function stagedInstructions(
  staged: StagedCheckpoint,
  files: readonly string[],
  signal: AbortSignal,
): Promise<CommittedInstructions> {
  if (staged.instructions === null) {
    return {
      kind: "refused",
      reason: "the checkpoint pins no commit it can be read at",
    };
  }
  return readCommittedInstructions(
    localGit(staged.repository, signal, { GIT_DIR: staged.repository }),
    staged.repository,
    staged.instructions,
    files,
    signal,
  );
}

/**
 * Replaces everything under `root` with the staged checkout: the branch (or
 * detached HEAD) at HEAD's commit, the working tree as it was on disk, and
 * the index at HEAD, so edits that were uncommitted are uncommitted again.
 * Files the snapshot added are left intent-to-add rather than untracked, so
 * the next capture stages them again even when they are ignored.
 *
 * The root is the mount point and stays; its contents go, so nothing a
 * previous execution wrote after the checkpoint survives — except `keep`,
 * the directory directly under the root this restore downloaded and staged
 * into (the workspace volume being the only disk a worker has), which is
 * moved into the new `.git` as `RESTORED_CHECKPOINT_DIRECTORY`, out of the
 * tree's way. The staged checkpoint comes back with its repository where it
 * now is, when that is inside `keep`, holding only what the instructions
 * commit reaches. The repository is new: the old one's config, hooks and
 * remotes are the last engine's.
 * A null `origin` is a session without a repository: no remote, and the
 * local git's default excludes written again, since the new `.git` has none.
 * Stops between steps once `signal` aborts; a restore stopped half way is
 * redone whole by the next attempt, which never reads what this one left.
 */
export async function restoreCheckpointTree(input: {
  origin: string | null;
  root: string;
  signal: AbortSignal;
  staged: StagedCheckpoint;
  keep?: string;
}): Promise<{ kept?: string; staged: StagedCheckpoint }> {
  const { root, signal } = input;
  let { staged } = input;
  const keep = input.keep === undefined ? undefined : resolve(input.keep);
  if (
    keep !== undefined &&
    (dirname(keep) !== resolve(root) || !(await lstat(keep)).isDirectory())
  ) {
    throw new Error(`${keep} is not a directory directly under ${root}`);
  }
  await clearWorkspace(root, signal, keep);
  const git = localGit(root, signal, {});
  await check(git(["init", "--quiet", "--template="]), "init");
  let kept: string | undefined;
  let slim = false;
  if (keep !== undefined) {
    kept = join(root, ".git", RESTORED_CHECKPOINT_DIRECTORY);
    await rename(keep, kept);
    const inside = relative(keep, resolve(staged.repository));
    if (!inside.startsWith("..")) {
      staged = { ...staged, repository: join(kept, inside) };
      slim = true;
    }
  }
  await check(
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      staged.repository,
      `${STAGED}*:${RESTORING}*`,
    ]),
    "fetch staged checkpoint",
  );
  if (slim) await keepInstructionsOnly(staged, root, signal);
  if (staged.branch === null) {
    await check(
      git(["update-ref", "--no-deref", "HEAD", staged.head]),
      "update-ref",
    );
  } else {
    await check(git(["update-ref", staged.branch, staged.head]), "update-ref");
    await check(git(["symbolic-ref", "HEAD", staged.branch]), "symbolic-ref");
  }
  for (const source of staged.sources) {
    const ref = `refs/heads/${source.name}`;
    if (ref !== staged.branch) {
      await check(git(["update-ref", ref, source.commit]), "update-ref");
    }
  }
  await check(
    git(["read-tree", "--reset", "-u", staged.worktree]),
    "read-tree",
  );
  await check(
    git(["reset", "--quiet", "--mixed", "--intent-to-add", staged.head]),
    "reset",
  );
  const upstream =
    staged.branch === null || staged.upstream === null || input.origin === null
      ? null
      : {
          ...staged.upstream,
          branch: staged.branch.slice("refs/heads/".length),
        };
  if (upstream !== null) {
    await check(
      git([
        "update-ref",
        `refs/remotes/origin/${upstream.merge.slice("refs/heads/".length)}`,
        upstream.commit,
      ]),
      "update-ref",
    );
  }
  const restoring = await required(
    git(["for-each-ref", "--format=%(refname)", RESTORING]),
    "for-each-ref",
  );
  for (const name of restoring.split("\n")) {
    if (name !== "") await check(git(["update-ref", "-d", name]), "update-ref");
  }
  if (input.origin === null) {
    await writeLocalExcludes(root);
  } else {
    await check(git(["remote", "add", "origin", input.origin]), "remote add");
    if (upstream !== null) {
      await check(
        git(["config", `branch.${upstream.branch}.remote`, "origin"]),
        "config",
      );
      await check(
        git(["config", `branch.${upstream.branch}.merge`, upstream.merge]),
        "config",
      );
    }
  }
  return kept === undefined ? { staged } : { kept, staged };
}

/**
 * Replaces the staged repository with one holding only what the
 * instructions commit reaches. Captures need nothing else from
 * it; the rest is in the workspace's own `.git`, which just fetched it, and
 * keeping it twice for the whole session would charge the workspace quota
 * for the bundle twice. The staged repository goes first, so the restore
 * never holds it, the workspace's copy, and this one at once; the
 * instructions commit is read back from the workspace, under the ref the
 * fetch left it at.
 */
async function keepInstructionsOnly(
  staged: StagedCheckpoint,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  const { repository } = staged;
  await rm(repository, { force: true, recursive: true });
  const git = localGit(dirname(repository), signal, { GIT_DIR: repository });
  await check(
    git(["init", "--quiet", "--bare", "--template=", repository]),
    "init",
  );
  if (staged.instructions === null) return;
  await check(
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      join(root, ".git"),
      `${RESTORING}${CHECKPOINT_INSTRUCTIONS_REF.slice("refs/".length)}:${CHECKPOINT_INSTRUCTIONS_REF}`,
    ]),
    "fetch instructions",
  );
}

/**
 * Removes everything under `root` but `root` itself and `spare`, a direct
 * child of it. A restore clears the old tree before it downloads anything,
 * so the old tree's disk is free for the checkpoint: the workspace volume's
 * quota holds both only if it holds neither twice.
 */
export async function clearWorkspace(
  root: string,
  signal: AbortSignal,
  spare?: string,
): Promise<void> {
  // Everything below deletes through `root`: a link there would aim it
  // somewhere else.
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`the workspace root ${root} is not a directory`);
  }
  const spared = spare === undefined ? undefined : basename(spare);
  // In batches, so an execution that left millions of names behind is not
  // read into memory at once. Each pass starts over, since what a directory
  // stream returns after its own entries are removed is unspecified.
  for (;;) {
    const batch: string[] = [];
    for await (const entry of await opendir(root)) {
      if (entry.name === spared) continue;
      batch.push(entry.name);
      if (batch.length === CLEAR_BATCH) break;
    }
    if (batch.length === 0) break;
    for (const name of batch) {
      signal.throwIfAborted();
      await rm(join(root, name), { force: true, recursive: true });
    }
  }
}

/**
 * A git that never reaches the network, with the capture's settings and
 * limits: one that runs out throws `GitResourceLimitError`, which fails the
 * restore like any other git failure.
 */
function localGit(
  cwd: string,
  signal: AbortSignal,
  env: Record<string, string>,
): Git {
  return (args, options = {}) =>
    runGit(args, {
      cwd: options.cwd ?? cwd,
      extra: { config: CHECKPOINT_GIT_CONFIG, env },
      limits: checkpointGitLimits(),
      network: null,
      overrides: [],
      redact: (text) => text,
      signal,
    });
}
