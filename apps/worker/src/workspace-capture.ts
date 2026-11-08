import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECKPOINT_BRANCH_PREFIX,
  CHECKPOINT_HEAD_REF,
  CHECKPOINT_INSTRUCTIONS_REF,
  CHECKPOINT_SOURCE_PREFIX,
  CHECKPOINT_UPSTREAM_PREFIX,
  CHECKPOINT_WORKTREE_REF,
  DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES,
  gitBundleOffersFrom,
  MAX_CHECKPOINT_SOURCES,
  readWorkspaceFile,
} from "@werft-ai/runtime-core";
import type { GitResourceLimits } from "@werft-ai/system";

import {
  check,
  filterOverrides,
  type Git,
  type GitExtras,
  GitOutputLimitError,
  GitResourceLimitError,
  type GitResult,
  LOCAL_DEADLINE_MS,
  runGit,
  runGitBytes,
  workerScratch,
} from "./workspace.ts";

/**
 * What one checkpoint pins of the workspace: a bundle that can recreate the
 * commit on its own, and the untracked files git does not carry.
 */
export type WorkspaceCapture = {
  /** Written where the caller asked (`bundlePath`), and never read into memory. */
  bundle: {
    bytes: number;
    path: string;
    sha256: string;
    /** Every ref's object id, which a later bundle may build on. */
    tips: string[];
    /** Whether it builds on the `base` it was given, or stands alone. */
    incremental: boolean;
  };
  /** The snapshot commit, `refs/checkpoint/worktree` in the bundle. */
  gitCommit: string;
  /**
   * The commit HEAD is on. It is not `gitCommit` exactly when tracked files
   * were left uncommitted and `gitCommit` is the platform's snapshot.
   */
  headCommit: string;
  /** Local branches kept so a push can name them, newest commit first. */
  sources: Array<{ commit: string; name: string }>;
  untracked: Array<{ bytes: Uint8Array; executable: boolean; path: string }>;
};

export type WorkspaceCaptureResult =
  | { capture: WorkspaceCapture; status: "captured" }
  | { reason: string; status: "refused" };

type WorkspaceMarker =
  | { digest: string; status: "marked" }
  | { reason: string; status: "refused" };

export type WorkspaceCaptureLimits = {
  /**
   * At most `DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`: the control plane refuses
   * anything larger. The bundle goes to disk and is streamed from
   * there, so what it costs is workspace quota, not memory.
   */
  maxBundleBytes: number;
  /**
   * Any one tracked file on disk. A restore writes each one back under a file
   * size limit (`checkpointGitLimits`), so a capture refuses what that would
   * refuse rather than pin a checkpoint no worker can resume from.
   */
  maxFileBytes: number;
  /** The workspace index is copied whole before anything reads it. */
  maxIndexBytes: number;
  /**
   * Tracked files that differ from the index, summed before `add -u` writes
   * them into the scratch object store: the bundle limit is only known once
   * that disk is spent.
   */
  maxStagedBytes: number;
  maxUntrackedBytes: number;
  maxUntrackedFiles: number;
};

/**
 * Deliberately minimal: the whole history rides every checkpoint and the
 * untracked files are held in memory to be uploaded. Revisit when sessions
 * approach these (makes bundles incremental). The bundle limit is
 * the control plane's, which it verifies within its time budgets.
 */
export const DEFAULT_WORKSPACE_CAPTURE_LIMITS: WorkspaceCaptureLimits = {
  maxBundleBytes: DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES,
  maxFileBytes: 512 * 1024 * 1024,
  maxIndexBytes: 256 * 1024 * 1024,
  maxStagedBytes: 512 * 1024 * 1024,
  maxUntrackedBytes: 256 * 1024 * 1024,
  maxUntrackedFiles: 10_000,
};

/**
 * The bundles a capture may build on: the chain of the checkpoint
 * before it, as the control plane will check the new one against it.
 */
export type BundleBase = {
  /** Every ref tip the chain's bundles offer; a prerequisite must be one. */
  tips: readonly string[];
  /** What the new bundle may take of the chain's byte limit. */
  maxBytes: number;
};

export {
  CHECKPOINT_HEAD_REF,
  CHECKPOINT_INSTRUCTIONS_REF,
  CHECKPOINT_WORKTREE_REF,
};

/**
 * The instructions commit a capture pins, and where its objects are kept
 * when the workspace may no longer have them (a restore keeps them in a
 * repository of its own, outside the engine's reach).
 */
export type InstructionsPin = { commit: string; objects?: string };

// Neither side of a checkpoint may depend on the repository's own config:
// the restore runs in a fresh repository that has none, on Linux. With
// autocrlf off and eol at lf only `.gitattributes` converts, and it travels
// in the tree; safecrlf refuses a conversion that would not come back byte
// for byte. fileMode on, so a chmod the engine made is staged even in a
// checkout that was told to ignore modes. ignoreCase off, so an untracked `A`
// beside a tracked `a` is listed; symlinks on, so a file that replaced a
// tracked link is staged as the file it is. No attributes file outside the
// tree: the default one lives under the engine's HOME. No replace refs: they
// stay in the workspace, and HEAD read through one names a tree the bundled
// commit does not have. Full stat checks with ctime, so a file rewritten to
// its old size and mtime is still listed as changed when staging is sized;
// only one rewritten within the second its index entry was refreshed slips
// through (git keeps whole-second ctimes unless built with USE_NSEC), and
// what that stages is bounded by the tracked bytes the workspace quota holds.
//
// One pack thread, for `checkpointGitLimits`: each thread takes a malloc
// arena of its own out of the address space, and left alone git starts one
// per host CPU whatever the container's CPU share. `index-pack` reads the
// same setting, so a restore's delta resolution is one thread too.
export const CHECKPOINT_GIT_CONFIG: Array<[string, string]> = [
  ["core.attributesFile", "/dev/null"],
  ["core.autocrlf", "false"],
  ["core.checkStat", "default"],
  ["core.eol", "lf"],
  ["core.fileMode", "true"],
  ["core.ignoreCase", "false"],
  ["core.safecrlf", "true"],
  ["core.symlinks", "true"],
  ["core.trustctime", "true"],
  ["core.useReplaceRefs", "false"],
  ["pack.threads", "1"],
];

/**
 * Address space for each capture or restore git: resolving a delta near
 * `maxFileBytes` holds base and result at once, and staging a file that needs
 * converting has the same shape. This matches the control plane's
 * `DEFAULT_MAX_GIT_MEMORY_BYTES` and is deliberately independent of the
 * container memory setting.
 */
const CHECKPOINT_GIT_MEMORY_BYTES = 1536 * 1024 * 1024;
/** Compression's worst case on top of the largest file: zlib adds ~0.03%. */
const FILE_SIZE_SLACK_BYTES = 16 * 1024 * 1024;

/**
 * What each git in a capture or a restore may use, so that a repository the
 * engine built cannot take the worker's memory, disk or CPU with it. The
 * largest file either writes is a tracked file (as a loose object, or back
 * into the tree) or the index; packs are bounded by the bundle, well below.
 * CPU gets the wall-clock deadline: one thread cannot use more, and a helper
 * left running after git exits gets no more than that either.
 */
export function checkpointGitLimits(
  limits: WorkspaceCaptureLimits = DEFAULT_WORKSPACE_CAPTURE_LIMITS,
): GitResourceLimits {
  return {
    cpuSeconds: Math.ceil(LOCAL_DEADLINE_MS / 1000),
    fileSizeBytes:
      Math.max(limits.maxFileBytes, limits.maxIndexBytes) +
      FILE_SIZE_SLACK_BYTES,
    memoryBytes: CHECKPOINT_GIT_MEMORY_BYTES,
  };
}

/**
 * What any one git call in a capture may print before it is killed: the
 * tracked-file listings grow with the repository, and nothing else bounds
 * them.
 */
const OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
/** The longest path Linux hands back, plus its NUL. */
const PATH_BYTES = 4096 + 1;

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_EMAIL: "checkpoint@werft.invalid",
  GIT_AUTHOR_NAME: "Werft checkpoint",
  GIT_COMMITTER_EMAIL: "checkpoint@werft.invalid",
  GIT_COMMITTER_NAME: "Werft checkpoint",
};

/**
 * Captures the workspace at `root` without changing anything in it.
 *
 * The engine's HEAD, index and object store are left as they are. The
 * working tree is staged into a copy of the index, and every object that
 * produces — blobs, the tree, the snapshot commit — is written to a scratch
 * repository that reads the workspace's objects through an alternate. The
 * bundle is built there too, under refs that exist nowhere else:
 *
 * - `refs/checkpoint/head`: the commit HEAD is on;
 * - `refs/checkpoint/worktree`: the tree as it is on disk, committed on top
 *   of HEAD when it differs and HEAD itself when it does not. This is the
 *   manifest's `gitCommit`.
 * - `refs/heads/<branch>`: HEAD's branch, when HEAD is on one.
 * - `refs/checkpoint/upstream/heads/<name>`: the commit `origin/<name>` is
 *   at, when HEAD's branch tracks it (`originUpstream`).
 * - `refs/checkpoint/instructions`: the `instructions` commit, when given.
 *   It comes from the caller's memory, never from a ref the engine can move.
 *
 * so a restore can put the same branch at the same commit and leave the
 * uncommitted edits uncommitted, rather than handing the engine a history
 * with a commit it never made.
 *
 * Given a `base`, the bundle leaves out what the base's tips reach, and
 * needs only commits the base offers as ref tips. A ref whose commit the
 * base already has is carried by an annotated tag over it, since a bundle
 * cannot name a commit it leaves out. When the result would not be one the
 * control plane accepts on that base — a prerequisite that is no tip (a
 * history rewritten under it), or over what the chain has left of the byte
 * limit — the bundle stands alone instead.
 *
 * A workspace whose state this cannot represent exactly is refused, never
 * approximated: an unborn HEAD, a shallow or partial clone, sparse checkout,
 * a split index, unmerged paths, entries marked assume-unchanged or
 * skip-worktree (their disk content is not what `add -u` stages), tracked
 * submodules, untracked symlinks or special files, and untracked nested
 * repositories. Ignored files are not captured at all — build output and
 * dependencies, but also an ignored `.env`; a resumed session starts without
 * them.
 *
 * Git reads the repository's metadata as the engine left it, links
 * included: `.git/objects` or a ref pointed elsewhere is followed, and what
 * it reaches is bundled into this session's own checkpoint. That grants
 * nothing, because the engine runs as the worker's user and can read, and
 * commit, whatever this can. Running the engine under a user of its own
 * would make it a boundary; capture then has to read metadata the way
 * restore writes files, without following links.
 */
type WorkspaceCaptureInput = {
  root: string;
  /** A path in a directory the caller owns and removes. */
  bundlePath: string;
  signal: AbortSignal;
  limits?: WorkspaceCaptureLimits;
  instructions?: InstructionsPin;
  base?: BundleBase;
  /**
   * For a session without a repository: first marks every new file in the
   * workspace's own index intent-to-add, the one change a capture makes, so
   * the files ride the bundle — symlinks included, which the untracked
   * path refuses — rather than travel as untracked files.
   */
  markNewFiles?: boolean;
  /** For tests that need procfs to be missing. */
  fdDirectory?: string;
};

export async function captureWorkspace(
  input: WorkspaceCaptureInput,
): Promise<WorkspaceCaptureResult> {
  const limits = input.limits ?? DEFAULT_WORKSPACE_CAPTURE_LIMITS;
  if (input.markNewFiles === true) {
    const marked = await markNewFiles(input.root, input.signal, limits);
    if (marked !== undefined) return { status: "refused", reason: marked };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await workspaceMarker(input.root, input.signal, limits);
    if (before.status === "refused") return before;
    let result: WorkspaceCaptureResult | undefined;
    let failure: unknown;
    try {
      result = await captureWorkspaceOnce(input);
    } catch (error) {
      if (input.signal.aborted) throw error;
      failure = error;
    }
    const after = await workspaceMarker(input.root, input.signal, limits);
    if (after.status === "refused") {
      await rm(input.bundlePath, { force: true });
      return after;
    }
    if (before.digest === after.digest) {
      if (failure !== undefined) throw failure;
      if (result === undefined)
        throw new Error("workspace capture returned no result");
      return result;
    }
    await rm(input.bundlePath, { force: true });
  }
  return {
    status: "refused",
    reason: "the workspace changed during both checkpoint capture attempts",
  };
}

/**
 * Marks the untracked, unignored paths intent-to-add in the workspace's own
 * index, under the capture's settings and limits, its filter drivers
 * emptied. Only those: `add --all` would also stage tracked paths, turning an
 * unmerged path into a resolved one the capture no longer refuses. A `.git`
 * that is no directory is left for the capture to refuse.
 */
async function markNewFiles(
  root: string,
  signal: AbortSignal,
  limits: WorkspaceCaptureLimits,
): Promise<string | undefined> {
  const gitDirectory = join(root, ".git");
  const found = await lstat(gitDirectory).catch(() => null);
  if (found?.isDirectory() !== true) return undefined;
  const neutralized: Array<[string, string]> = [];
  const options = {
    cwd: root,
    extra: {
      config: CHECKPOINT_GIT_CONFIG,
      env: { GIT_DIR: gitDirectory, GIT_WORK_TREE: root },
    },
    limits: checkpointGitLimits(limits),
    network: null,
    overrides: neutralized,
    redact: (text: string) => text,
    signal,
  };
  neutralized.push(...(await filterOverrides((args) => runGit(args, options))));
  const listed = await runGitBytes(
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { ...options, maxStdoutBytes: OUTPUT_LIMIT_BYTES },
  );
  if (listed.code !== 0) {
    return `new files cannot be listed: ${lastLine({ ...listed, stdout: "" })}`;
  }
  if (listed.stdout.byteLength === 0) return undefined;
  const scratch = await workerScratch(root, "mark");
  if (scratch === undefined) return undefined;
  try {
    const paths = join(scratch, "paths");
    await writeFile(paths, listed.stdout);
    const marked = await runGit(
      [
        "--literal-pathspecs",
        "add",
        "--intent-to-add",
        `--pathspec-from-file=${paths}`,
        "--pathspec-file-nul",
      ],
      options,
    );
    return marked.code === 0
      ? undefined
      : `new files cannot be marked intent-to-add: ${lastLine(marked)}`;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function captureWorkspaceOnce(
  input: WorkspaceCaptureInput,
): Promise<WorkspaceCaptureResult> {
  const { root, signal } = input;
  const limits = input.limits ?? DEFAULT_WORKSPACE_CAPTURE_LIMITS;
  const refused = (reason: string): WorkspaceCaptureResult => ({
    status: "refused",
    reason,
  });
  const gitDirectory = join(root, ".git");
  const scratch = await workerScratch(root, "capture");
  if (scratch === undefined) {
    return refused("the workspace .git is not a directory");
  }
  try {
    const repository = join(scratch, "checkpoint.git");
    const neutralized: Array<[string, string]> = [];
    const gitLimits = checkpointGitLimits(limits);
    const runBytes = (
      args: string[],
      env: Record<string, string>,
      maxStdoutBytes = OUTPUT_LIMIT_BYTES,
    ) =>
      runGitBytes(args, {
        cwd: root,
        extra: { config: CHECKPOINT_GIT_CONFIG, env },
        limits: gitLimits,
        maxStdoutBytes,
        network: null,
        overrides: neutralized,
        redact: (text) => text,
        signal,
      });
    const run = async (
      args: string[],
      env: Record<string, string>,
    ): Promise<GitResult> => {
      const result = await runBytes(args, env);
      return { ...result, stdout: new TextDecoder().decode(result.stdout) };
    };
    const workspace: Git = (args) =>
      run(args, { GIT_DIR: gitDirectory, GIT_WORK_TREE: root });
    neutralized.push(...(await filterOverrides(workspace)));

    const head = await workspace([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    if (head.code !== 0) return refused("HEAD has no commit yet");
    const headCommit = head.stdout.trim();
    // Copied, bounded, before any git command reads it: an index a previous
    // engine grew to gigabytes would otherwise be loaded whole by the checks.
    const index = join(scratch, "index");
    const copied = await copyIndex(gitDirectory, index, limits.maxIndexBytes);
    if (copied !== undefined) return refused(copied);
    const indexed: Git = (args) =>
      run(args, {
        GIT_DIR: gitDirectory,
        GIT_INDEX_FILE: index,
        GIT_WORK_TREE: root,
      });
    const problem = await unrepresentable(indexed, gitDirectory);
    if (problem !== undefined) return refused(problem);
    const staged = await trackedSizes(
      (args) =>
        runBytes(args, {
          GIT_DIR: gitDirectory,
          GIT_INDEX_FILE: index,
          GIT_WORK_TREE: root,
        }),
      root,
      limits,
      signal,
    );
    if (staged !== undefined) return refused(staged);
    await check(
      run(["init", "--quiet", "--bare", repository], {}),
      "init scratch",
    );
    const pin = input.instructions;
    await writeFile(
      join(repository, "objects", "info", "alternates"),
      [join(gitDirectory, "objects"), pin?.objects]
        .filter((directory) => directory !== undefined)
        .map((directory) => `${directory}\n`)
        .join(""),
    );
    // Stages into the copy and writes objects into the scratch repository;
    // the workspace's own index and object store are only read. The scratch
    // repository is the GIT_DIR too, so nothing only the workspace's
    // repository holds — `info/attributes`, its config — shapes what is
    // staged: a restore has neither.
    // `--renormalize` re-reads every tracked file rather than trusting the
    // index's stat data, which an edit that kept size and mtime slips past.
    // Deliberately simple: every capture hashes the whole tree; revisit with
    // if that shows in turn latency.
    const staging: GitExtras["env"] = {
      GIT_DIR: repository,
      GIT_INDEX_FILE: index,
      GIT_WORK_TREE: root,
    };
    const stage = (args: string[], env: Record<string, string> = {}) =>
      run(args, { ...staging, ...env });
    // No `.` pathspec: on an empty index (a local git whose engine wrote
    // nothing) it matches nothing, and git calls that an error.
    let added = await stage(["add", "--update"]);
    if (added.code === 0) {
      added = await stage(["add", "--renormalize", "--", ":/"]);
    }
    if (added.code !== 0) {
      return refused(`the working tree cannot be staged: ${lastLine(added)}`);
    }
    const endings = await lineEndingProblem((args) => runBytes(args, staging));
    if (endings !== undefined) return refused(endings);
    // `ident` collapses `$Id: <blob> $` as it stages, and a checkout expands
    // it to the new blob's id: a changed file would come back with other
    // bytes than it had.
    const expanded = await required(
      stage([
        "diff-index",
        "--cached",
        "--name-only",
        headCommit,
        "--",
        ":(attr:ident)",
      ]),
      "diff-index",
    );
    const identFile = expanded.split("\n").find((path) => path !== "");
    if (identFile !== undefined) {
      return refused(
        `${identFile} has the ident attribute and changed, and a restore would rewrite its $Id$`,
      );
    }
    const tree = (await required(stage(["write-tree"]), "write-tree")).trim();
    const headTree = (
      await required(
        workspace(["rev-parse", `${headCommit}^{tree}`]),
        "rev-parse",
      )
    ).trim();
    const gitCommit =
      tree === headTree
        ? headCommit
        : (
            await required(
              stage(
                [
                  "commit-tree",
                  tree,
                  "-p",
                  headCommit,
                  "-m",
                  "Werft checkpoint: working tree",
                ],
                SNAPSHOT_IDENTITY,
              ),
              "commit-tree",
            )
          ).trim();

    // Bytes, decoded strictly: a lossy decode turns an untracked `a\xff`
    // into `a\ufffd`, which may be another file entirely — an ignored one.
    let listed: Uint8Array;
    try {
      // Against the workspace's repository: a file its own excludes leave
      // out is left out like an ignored one.
      const others = await runBytes(
        ["ls-files", "-z", "--others", "--exclude-standard"],
        { GIT_DIR: gitDirectory, GIT_INDEX_FILE: index, GIT_WORK_TREE: root },
        (limits.maxUntrackedFiles + 1) * PATH_BYTES,
      );
      if (others.code !== 0) {
        throw new Error(
          `git ls-files failed (exit ${others.code}): ${others.stderr.trim()}`,
        );
      }
      listed = others.stdout;
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      return refused(
        `more untracked files than the ${limits.maxUntrackedFiles} a checkpoint carries`,
      );
    }
    const others = namesOf(listed);
    if (others === undefined) {
      return refused("an untracked file's name is not valid UTF-8");
    }
    const paths = others.split("\0").filter((path) => path !== "");
    const nested = paths.find((path) => path.endsWith("/"));
    if (nested !== undefined) {
      return refused(
        `untracked ${nested} is a nested repository, which a checkpoint cannot carry`,
      );
    }
    if (paths.length > limits.maxUntrackedFiles) {
      return refused(
        `${paths.length} untracked files, over the ${limits.maxUntrackedFiles} a checkpoint carries`,
      );
    }

    const branch = await workspace(["symbolic-ref", "--quiet", "HEAD"]);
    const refs: Array<[string, string]> = [
      [CHECKPOINT_HEAD_REF, headCommit],
      [CHECKPOINT_WORKTREE_REF, gitCommit],
    ];
    if (branch.code === 0) {
      const name = branch.stdout.trim();
      const valid = await workspace(["check-ref-format", name]);
      if (!name.startsWith("refs/heads/") || valid.code !== 0) {
        return refused(`HEAD is on a ref git would not restore: ${name}`);
      }
      refs.push([name, headCommit]);
      const upstream = await originUpstream(
        workspace,
        name.slice("refs/heads/".length),
      );
      if (upstream !== undefined) refs.push(upstream);
    }
    const sources = await localSources(workspace);
    const headBranch = branch.code === 0 ? branch.stdout.trim() : null;
    for (const source of sources) {
      if (`refs/heads/${source.name}` === headBranch) continue;
      refs.push([`${CHECKPOINT_SOURCE_PREFIX}${source.name}`, source.commit]);
    }
    const bundling = (args: string[]) => run(args, { GIT_DIR: repository });
    if (pin !== undefined) {
      // Gone once the engine pruned what no ref of its own still reached.
      const present = await bundling([
        "cat-file",
        "-e",
        `${pin.commit}^{commit}`,
      ]);
      if (present.code !== 0) {
        return refused(
          `the instructions commit ${pin.commit} is no longer in the repository`,
        );
      }
      refs.push([CHECKPOINT_INSTRUCTIONS_REF, pin.commit]);
    }
    // Written to disk under a file size limit one byte past the bundle's,
    // so an oversized history costs that much disk and is stopped there
    // (Linux; elsewhere it is measured once written). Undefined when it
    // came out over `maxBytes`.
    const bundleOnto = async (
      names: readonly string[],
      negatives: readonly string[],
      maxBytes: number,
    ) => {
      await rm(input.bundlePath, { force: true });
      try {
        const created = await runGitBytes(
          [
            "bundle",
            "create",
            "--quiet",
            input.bundlePath,
            ...names,
            ...(negatives.length === 0 ? [] : ["--not", ...negatives]),
          ],
          {
            cwd: root,
            extra: {
              config: CHECKPOINT_GIT_CONFIG,
              env: { GIT_DIR: repository },
            },
            limits: { ...gitLimits, fileSizeBytes: maxBytes + 1 },
            maxStdoutBytes: OUTPUT_LIMIT_BYTES,
            network: null,
            overrides: neutralized,
            redact: (text) => text,
            signal,
          },
        );
        if (created.code !== 0) {
          throw new Error(
            `git bundle create failed (exit ${created.code}): ${created.stderr.trim()}`,
          );
        }
      } catch (error) {
        if (
          error instanceof GitResourceLimitError &&
          /SIGXFSZ|signal 25\b|file too large/i.test(error.message)
        ) {
          return undefined;
        }
        throw error;
      }
      const digest = await digestFile(input.bundlePath);
      return digest.bytes > maxBytes ? undefined : digest;
    };
    const direct = async () => {
      for (const [name, oid] of refs) {
        await check(bundling(["update-ref", name, oid]), "update-ref");
      }
    };
    const base = input.base;
    let built:
      | { bytes: number; sha256: string; tips: string[]; incremental: boolean }
      | undefined;
    // A chain written under a larger limit than this one may leave nothing.
    if (base !== undefined && base.tips.length > 0 && base.maxBytes > 0) {
      const negatives: string[] = [];
      for (const tip of new Set(base.tips)) {
        // Snapshot commits and tags of earlier captures lived only in their
        // scratch repositories; only what is still here can be left out.
        const present = await bundling(["cat-file", "-e", tip]);
        if (present.code === 0) negatives.push(tip);
      }
      if (negatives.length > 0) {
        await direct();
        const names: string[] = [];
        for (const [ref, oid] of refs) {
          const reached = await required(
            bundling(["rev-list", "-n", "1", oid, "--not", ...negatives]),
            "rev-list",
          );
          if (reached.trim() !== "") {
            names.push(ref);
            continue;
          }
          const name = ref.startsWith("refs/heads/")
            ? `${CHECKPOINT_BRANCH_PREFIX}${ref.slice("refs/".length)}`
            : ref;
          names.push(name);
          await check(
            run(
              [
                "-c",
                "tag.gpgSign=false",
                "-c",
                "tag.forceSignAnnotated=false",
                "tag",
                "-a",
                "-m",
                `Werft checkpoint: ${name}`,
                `werft/${name}`,
                oid,
              ],
              { GIT_DIR: repository, ...SNAPSHOT_IDENTITY },
            ),
            "tag",
          );
          await check(
            bundling(["update-ref", name, `refs/tags/werft/${name}`]),
            "update-ref",
          );
        }
        const digest = await bundleOnto(names, negatives, base.maxBytes);
        if (digest !== undefined) {
          const offer = await gitBundleOffersFrom(
            createReadStream(input.bundlePath),
            gitCommit,
            new Set(base.tips.map((tip) => tip.toLowerCase())),
          );
          if (offer.status === "offers") {
            built = { ...digest, incremental: true, tips: [...offer.tips] };
          }
        }
      }
    }
    if (built === undefined) {
      await direct();
      const digest = await bundleOnto(
        refs.map(([name]) => name),
        [],
        limits.maxBundleBytes,
      );
      if (digest === undefined) {
        return refused(
          `the workspace bundle is over the ${limits.maxBundleBytes} bytes the control plane verifies`,
        );
      }
      built = {
        ...digest,
        incremental: false,
        tips: refs.map(([, oid]) => oid),
      };
    }

    const untracked: WorkspaceCapture["untracked"] = [];
    let left = limits.maxUntrackedBytes;
    for (const path of paths.sort()) {
      const read = await readWorkspaceFile({
        maxBytes: left,
        path,
        workspaceRoot: root,
        ...(input.fdDirectory === undefined
          ? {}
          : { fdDirectory: input.fdDirectory }),
      });
      if (read.status === "refused") return refused(read.reason);
      left -= read.bytes.byteLength;
      untracked.push({ bytes: read.bytes, executable: read.executable, path });
    }
    return {
      status: "captured",
      capture: {
        bundle: { ...built, path: input.bundlePath },
        gitCommit,
        headCommit,
        sources,
        untracked,
      },
    };
  } catch (error) {
    // Any git in the capture that ran past what it may use or print, where
    // no step above has a more specific reason.
    if (
      error instanceof GitResourceLimitError ||
      error instanceof GitOutputLimitError
    ) {
      return refused(error.message);
    }
    throw error;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function workspaceMarker(
  root: string,
  signal: AbortSignal,
  limits: WorkspaceCaptureLimits,
): Promise<WorkspaceMarker> {
  const hash = createHash("sha256");
  const gitDirectory = join(root, ".git");
  const scratch = await workerScratch(root, "marker");
  if (scratch === undefined) {
    return {
      status: "refused",
      reason: "the workspace .git is not a directory",
    };
  }
  const run = (args: string[], index?: string) =>
    runGitBytes(args, {
      cwd: root,
      extra: {
        config: CHECKPOINT_GIT_CONFIG,
        env: {
          GIT_DIR: gitDirectory,
          ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
          GIT_WORK_TREE: root,
        },
      },
      limits: checkpointGitLimits(limits),
      maxStdoutBytes: OUTPUT_LIMIT_BYTES,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal,
    });
  try {
    const head = await run([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    if (head.code !== 0) {
      return { status: "refused", reason: "HEAD has no commit yet" };
    }
    const index = join(scratch, "index");
    const copied = await copyIndex(gitDirectory, index, limits.maxIndexBytes);
    if (copied !== undefined) return { status: "refused", reason: copied };
    const result = await run(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      index,
    );
    hash.update(result.stdout);
    hash.update(`\0${result.code}\0${result.stderr}\0`);
    const listed = result.stdout;
    hash.update(head.stdout);
    hash.update(`\0${head.code}\0${head.stderr}\0`);
    const decoded = namesOf(listed);
    if (decoded === undefined) {
      return { status: "marked", digest: hash.digest("hex") };
    }
    const paths = decoded
      .split("\0")
      .filter((path) => path !== "")
      .sort();
    const mark = async (relative: string): Promise<void> => {
      signal.throwIfAborted();
      const path = join(root, relative);
      const found = await lstat(path, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        },
      );
      hash.update(`${relative}\0`);
      if (found === null) {
        hash.update("missing\0");
        return;
      }
      hash.update(
        `${found.mode}\0${found.size}\0${found.mtimeNs}\0${found.ctimeNs}\0`,
      );
    };
    for (const path of paths) await mark(path.replace(/\/$/, ""));
    for (const path of [".git/HEAD", ".git/index", ".git/config"]) {
      await mark(path);
    }
    return { status: "marked", digest: hash.digest("hex") };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function localSources(
  workspace: Git,
): Promise<Array<{ commit: string; name: string }>> {
  const listed = await workspace([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%00%(objectname)%00%(objecttype)",
    "refs/heads/",
  ]);
  if (listed.code !== 0) return [];
  const sources: Array<{ commit: string; name: string }> = [];
  for (const line of listed.stdout.split("\n")) {
    const [ref = "", commit = "", type = ""] = line.split("\0");
    const name = ref.slice("refs/heads/".length);
    if (
      type !== "commit" ||
      !/^[0-9a-f]{40}$/.test(commit) ||
      name === "" ||
      name.length > MAX_SOURCE_NAME_LENGTH
    ) {
      continue;
    }
    sources.push({ commit, name });
    if (sources.length === MAX_CHECKPOINT_SOURCES) break;
  }
  return sources;
}

const MAX_SOURCE_NAME_LENGTH = 200;

/**
 * The `CHECKPOINT_UPSTREAM_PREFIX` ref for what `branch` tracks, when that
 * is a branch on origin the checkout has a commit for. Only origin's: it is
 * the one remote a restore adds back. Anything else is left out rather than
 * refused, the checkout restoring without an upstream as before.
 */
async function originUpstream(
  workspace: Git,
  branch: string,
): Promise<[string, string] | undefined> {
  // One read, so the remote, origin's branch and the ref origin's fetch
  // refspec maps it to (not always `refs/remotes/origin/<name>`) come from
  // the same `branch.<name>.merge` entry when the config lists several.
  const upstream = await workspace([
    "for-each-ref",
    "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
    `refs/heads/${branch}`,
  ]);
  const [remote, tracked = "", ref = ""] = upstream.stdout
    .replace(/\n$/, "")
    .split("\0");
  if (
    upstream.code !== 0 ||
    remote !== "origin" ||
    ref === "" ||
    !tracked.startsWith("refs/heads/") ||
    (await workspace(["check-ref-format", tracked])).code !== 0
  ) {
    return undefined;
  }
  const commit = await workspace([
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (commit.code !== 0) return undefined;
  return [
    `${CHECKPOINT_UPSTREAM_PREFIX}${tracked.slice("refs/".length)}`,
    commit.stdout.trim(),
  ];
}

async function digestFile(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Why `add -u` against this repository would not stage what is on disk. */
async function unrepresentable(
  git: Git,
  gitDirectory: string,
): Promise<string | undefined> {
  const shallow = await git(["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0 || shallow.stdout.trim() !== "false") {
    return "the workspace is a shallow clone";
  }
  const flags: Array<[string, string]> = [
    ["core.sparseCheckout", "uses sparse checkout"],
    ["core.splitIndex", "uses a split index"],
  ];
  for (const [key, what] of flags) {
    const value = await git(["config", "--bool", "--get", key]);
    if (value.code === 0 && value.stdout.trim() === "true") {
      return `the workspace ${what}`;
    }
  }
  const partial = await git([
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
  ]);
  if (partial.code === 0 && partial.stdout.trim() !== "") {
    return "the workspace is a partial clone";
  }
  const shared = (await readdir(gitDirectory)).find((name) =>
    name.startsWith("sharedindex."),
  );
  if (shared !== undefined) return "the workspace uses a split index";
  const staged = await required(git(["ls-files", "-z", "--stage"]), "ls-files");
  for (const entry of staged.split("\0")) {
    if (entry === "") continue;
    const [meta = "", path = ""] = entry.split("\t");
    const [mode, , stageNumber] = meta.split(" ");
    if (stageNumber !== "0") return `${path} has unresolved merge conflicts`;
    if (mode === "160000") return `${path} is a submodule`;
  }
  const tagged = await required(git(["ls-files", "-z", "-v"]), "ls-files");
  for (const entry of tagged.split("\0")) {
    if (entry === "") continue;
    const tag = entry.slice(0, 1);
    const path = entry.slice(2);
    if (tag === "S") return `${path} is marked skip-worktree`;
    if (tag !== tag.toUpperCase()) return `${path} is marked assume-unchanged`;
  }
  return undefined;
}

/**
 * Every tracked file on disk against `maxFileBytes`, and what staging would
 * write into the scratch object store against `maxStagedBytes`: the tracked
 * files whose disk content differs from the index, by their size on disk (an
 * upper bound on the loose objects they become). Once a `.gitattributes` has
 * changed, `--renormalize` may rewrite any tracked file, so every one counts.
 */
async function trackedSizes(
  git: (
    args: string[],
  ) => Promise<{ code: number; stderr: string; stdout: Uint8Array }>,
  root: string,
  limits: WorkspaceCaptureLimits,
  signal: AbortSignal,
): Promise<string | undefined> {
  const listing = async (args: string[]) => {
    const listed = await git(["ls-files", "-z", ...args]);
    if (listed.code !== 0) {
      throw new Error(
        `git ls-files failed (exit ${listed.code}): ${listed.stderr.trim()}`,
      );
    }
    return listed.stdout;
  };
  const rules = await listing([
    "--modified",
    "--others",
    "--exclude-standard",
    "--",
    ":(glob)**/.gitattributes",
  ]);
  // Decoded as strictly as the untracked names, or lstat measures a
  // different file than the one `add -u` is about to write.
  const tracked = namesOf(await listing(["--cached"]));
  const modified =
    rules.byteLength > 0 ? tracked : namesOf(await listing(["--modified"]));
  if (tracked === undefined || modified === undefined) {
    return "a tracked file's name is not valid UTF-8";
  }
  const changed = new Set(modified.split("\0"));
  let total = 0;
  for (const path of new Set(tracked.split("\0"))) {
    if (path === "") continue;
    signal.throwIfAborted();
    const found = await lstat(join(root, path)).catch(() => null);
    // A link is staged as a blob of its target, which lstat sizes.
    if (found === null || !(found.isFile() || found.isSymbolicLink())) {
      continue;
    }
    if (found.size > limits.maxFileBytes) {
      return `${path} is ${found.size} bytes, over the ${limits.maxFileBytes} a checkpoint restores`;
    }
    if (!changed.has(path)) continue;
    total += found.size;
    if (total > limits.maxStagedBytes) {
      return `the tracked changes are over the ${limits.maxStagedBytes} bytes a checkpoint stages`;
    }
  }
  return undefined;
}

/**
 * Copies the workspace index without following a symlink planted in its
 * place; the copy is what gets staged into. A missing index is refused, not
 * read as empty: staging into an empty one would drop every tracked file an
 * ignore rule matches, and list the rest as untracked.
 */
async function copyIndex(
  gitDirectory: string,
  destination: string,
  limit: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      join(gitDirectory, "index"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return "the workspace has no index";
    if (code === "ELOOP") return "the workspace index is a symlink";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "the workspace index is not a regular file";
    if (info.size > limit) {
      return `the workspace index is ${info.size} bytes, over the ${limit} a checkpoint reads`;
    }
    // One byte past what fstat said, so an index still growing is noticed.
    const buffer = new Uint8Array(info.size + 1);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.byteLength - filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== info.size)
      return "the workspace index changed while it was read";
    await writeFile(destination, buffer.subarray(0, filled));
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A tracked file whose line endings on disk are not what checking out its
 * staged blob writes under `CHECKPOINT_GIT_CONFIG`, which is how a restore writes
 * it. Staging normalizes a text file's line endings into the blob, so a file
 * the engine's own config wrote with CRLF (`core.eol`, `core.autocrlf`), or
 * one a `.gitattributes` edit since left stale, would come back different
 * without anything failing. `ls-files --eol` reads the working tree itself
 * rather than trusting the index's stat data.
 */
async function lineEndingProblem(
  git: (
    args: string[],
  ) => Promise<{ code: number; stderr: string; stdout: Uint8Array }>,
): Promise<string | undefined> {
  const listed = await git(["ls-files", "--eol", "-z"]);
  if (listed.code !== 0) {
    throw new Error(
      `git ls-files failed (exit ${listed.code}): ${listed.stderr.trim()}`,
    );
  }
  const entries = namesOf(listed.stdout);
  if (entries === undefined) return "a tracked file's name is not valid UTF-8";
  for (const entry of entries.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const info = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/.exec(entry.slice(0, tab));
    if (tab < 0 || info === null) {
      throw new Error(`git ls-files --eol printed ${JSON.stringify(entry)}`);
    }
    const [, staged, disk, attributes] = info as unknown as [
      string,
      string,
      string,
      string,
    ];
    const attribute = attributes.trim().split(/\s+/);
    // `eol` implies `text`; `text=auto` converts only what git calls text.
    const converted =
      !attribute.includes("-text") &&
      (attribute.includes("text") ||
        attribute.some((value) => value.startsWith("eol=")) ||
        (attribute.includes("text=auto") && staged !== "-text"));
    if (!converted) continue;
    const written = attribute.includes("eol=crlf") ? "crlf" : "lf";
    const differs =
      written === "lf"
        ? disk === "crlf" || disk === "mixed"
        : disk === "lf" || disk === "mixed";
    if (differs) {
      return `${entry.slice(tab + 1)} has ${disk} line endings on disk, and a restore would write ${written}`;
    }
  }
  return undefined;
}

/**
 * NUL-separated names as git listed them, or undefined when they are not
 * UTF-8. Strict, because a lossy decode turns `a\xff` into `a\ufffd`, which
 * may be another file entirely; and a leading U+FEFF is part of the name
 * (`\ufeff.env` is not `.env`), not a byte-order mark to drop.
 */
function namesOf(listed: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      listed,
    );
  } catch {
    return undefined;
  }
}

export async function required(
  result: Promise<GitResult>,
  step: string,
): Promise<string> {
  const { code, stderr, stdout } = await result;
  if (code !== 0) {
    throw new Error(`git ${step} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

function lastLine(result: GitResult): string {
  return result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`;
}
