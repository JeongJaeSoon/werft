import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";
import type {
  AdditionalWorkspaceRepository,
  CheckpointRef,
  WorkspaceDescriptor,
  WorkspaceRepository,
} from "@werft-ai/contracts";
import {
  planWorkspacePreparation,
  type WorkspaceObservation,
  type WorkspacePlan,
} from "@werft-ai/runtime-core";
import {
  type GitResourceLimits,
  gitCommand,
  killProcessGroup,
} from "@werft-ai/system";
import { messageOf } from "./message-of.ts";

/** What the host needs from a workspace before it starts an engine in it. */
export interface WorkspacePreparer {
  /**
   * Leaves the session's repository checked out at the root — a local git
   * with no origin when the session has none — or throws.
   * `restore` wins over the descriptor; restoring is the checkpoint port's
   * job, so that plan comes back untouched.
   */
  prepare(input: {
    descriptor: WorkspaceDescriptor;
    restore: CheckpointRef | null;
    signal: AbortSignal;
  }): Promise<WorkspacePlan["action"]>;
  /**
   * The repository's root CLAUDE.md as committed on the session's branch,
   * read by the last `prepare` from what it had just fetched and before any
   * engine ran; null when there is none. Throws when the committed file is
   * one the worker will not hand over (see `readCommittedInstructions`), or when
   * that `prepare` fetched nothing to read it from (a restore).
   */
  committedInstructions(): string | null;
  /**
   * The commit `committedInstructions` was read from, which checkpoints carry
   * forward (`CHECKPOINT_INSTRUCTIONS_REF`); null when nothing was fetched.
   */
  instructionsCommit(): string | null;
  /**
   * The descriptor's additional repositories as git remotes, once the
   * checkout (or its restore) is in place; absent on a host whose engine
   * never touches a repository.
   */
  attachRepositories?(input: {
    descriptor: WorkspaceDescriptor;
    signal: AbortSignal;
  }): Promise<{ attached: string[]; failed: string[] }>;
  /**
   * One repository the agent attached mid-session, as `attachRepositories`
   * adds each; the commit its branch was fetched at. Throws
   * `AttachLimitError` past the fetch's time or size limit.
   */
  attachRepository?(
    repository: AdditionalWorkspaceRepository,
    signal: AbortSignal,
  ): Promise<string>;
}

/**
 * How long, and how large, one attachment's fetch may get. The size is the
 * scratch mirror's on disk; the checkout then takes its objects from that
 * mirror, so it gains no more than the mirror holds.
 */
export type AttachLimits = { timeoutMs: number; maxBytes: number };
export const DEFAULT_ATTACH_LIMITS: AttachLimits = {
  timeoutMs: 300_000,
  maxBytes: 2 * 1024 ** 3,
};
const ATTACH_SIZE_CHECK_MS = 1_000;

export class AttachLimitError extends Error {
  constructor(readonly failure: "fetch_timeout" | "fetch_too_large") {
    super(
      failure === "fetch_timeout"
        ? "The repository's fetch ran past its time limit"
        : "The repository's fetch grew past its size limit",
    );
  }
}

async function bytesUnder(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(child);
    else if (entry.isFile()) {
      total += (await lstat(child).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** For hosts whose engine never touches a repository, like the fake. */
export const noWorkspace: WorkspacePreparer = {
  async prepare() {
    return "reuse";
  },
  committedInstructions: () => null,
  instructionsCommit: () => null,
};

/**
 * Past this the run is refused rather than handed part of the file: a cut can
 * drop the rule that mattered or end one mid-sentence, and a model cannot
 * tell a truncated policy from a complete one.
 */
export const COMMITTED_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

export type CommittedInstructions =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "refused"; reason: string };

/** The instruction file as read, and the commit it was read from. */
export type PinnedInstructions = {
  file: CommittedInstructions;
  commit: string | null;
};

const NOTHING_PINNED: PinnedInstructions = {
  file: { kind: "absent" },
  commit: null,
};

/** How `committedInstructions` answers for what `pinInstructions` found. */
export function committedInstructionsOf(
  file: CommittedInstructions,
): string | null {
  switch (file.kind) {
    case "text":
      return file.text;
    case "absent":
      return null;
    case "refused":
      throw new Error(`Repository instruction file refused: ${file.reason}`);
  }
}

export type GitResult = { code: number; stdout: string; stderr: string };
export type Git = (
  args: string[],
  options?: { cwd?: string; network?: boolean },
) => Promise<GitResult>;

/**
 * Carries out `planWorkspacePreparation` with the `git` on this image.
 *
 * The repository URL may embed a credential (the descriptor keeps userinfo
 * on purpose). The engine runs in this checkout with tools that can read
 * and write `.git`, and a reused checkout is whatever the last attempt's
 * engine left there, so:
 * - origin is stored without the credential;
 * - the network is only ever reached from a repository this worker has
 *   just created (a clone into the empty root, or a scratch mirror for a
 *   reuse), never through the reused checkout's config, whose
 *   `insteadOf`, `sshCommand` or `askPass` could run the engine's code
 *   with the credential in its environment;
 * - those network calls get the credential from a helper that answers
 *   only the descriptor's protocol and host, may use only that protocol,
 *   and read no global or system config (HOME is the engine's too);
 * - no git command here runs a hook, an fsmonitor, a filter driver the
 *   checkout's config defines, or recurses into a submodule, and each one
 *   is killed past a deadline, so a planted command can neither run nor
 *   wedge the claim while the heartbeat keeps its lease alive.
 * Failures are reported with the URL and the credential replaced.
 *
 * Deliberately minimal: a clone takes whatever history the remote serves,
 * with no depth or size limit beyond the workspace volume's own.
 * Revisit when clone time starts eating the claim's lease budget.
 */
export class GitWorkspace implements WorkspacePreparer {
  private instructions: PinnedInstructions = NOTHING_PINNED;

  constructor(
    private readonly root: string,
    /** The runtime's instruction files in order of preference, as its descriptor names them. */
    private readonly instructionFiles: readonly string[],
    /**
     * The egress proxy's credential routes. A claim that gives the
     * repository a token is fetched through them and nowhere else.
     */
    private readonly egressTransport: string | null = null,
    private readonly attachLimits: AttachLimits = DEFAULT_ATTACH_LIMITS,
  ) {}

  committedInstructions(): string | null {
    return committedInstructionsOf(this.instructions.file);
  }

  instructionsCommit(): string | null {
    return this.instructions.commit;
  }

  async prepare(input: {
    descriptor: WorkspaceDescriptor;
    restore: CheckpointRef | null;
    signal: AbortSignal;
  }): Promise<WorkspacePlan["action"]> {
    if (input.descriptor.repository === null) return this.prepareLocal(input);
    const { access, url } = input.descriptor.repository;
    const remote = routed(splitSecret(url), access, this.egressTransport);
    const redact = redactor(
      url,
      remote.secret,
      remote.route === undefined ? [] : [remote.route.token],
    );
    // Filled in once the checkout's filter drivers are known.
    const neutralized: Array<[string, string]> = [];
    const git: Git = (args, options = {}) =>
      runGit(args, {
        cwd: options.cwd ?? this.root,
        network: options.network === true ? remote : null,
        overrides: neutralized,
        redact,
        signal: input.signal,
      });
    this.instructions = NOTHING_PINNED;
    if (input.restore !== null) {
      // Decided before anything reads the checkout: the restorer replaces it
      // whole, and a half-restored one (a stopped earlier attempt) may have a
      // config `observe` cannot even read. Nothing was fetched, so there is
      // no commit to read instructions from here; the restorer reads them
      // from the one the checkpoint pinned (`RuntimeResumePlan`). Refused
      // rather than absent, so a port that does not would fail the claim
      // instead of resuming without them.
      return this.restored();
    }
    const plan = planWorkspacePreparation({
      workspace: input.descriptor,
      restore: null,
      observed: await this.observe(git, neutralized),
    });
    switch (plan.action) {
      case "restore":
        throw new Error("A workspace with no checkpoint planned a restore");
      case "init":
      case "keep":
        throw new Error(`A workspace with a repository planned ${plan.action}`);
      case "refuse":
        throw new Error(`Workspace ${this.root} refused: ${plan.reason}`);
      case "recreate":
      case "clone":
        await this.clone(git, remote, plan.branch, input.signal);
        // A fresh clone nothing has run in yet.
        this.instructions = await pinInstructions(
          git,
          this.root,
          `refs/remotes/origin/${plan.branch}`,
          this.instructionFiles,
          input.signal,
        );
        return plan.action;
      case "reuse": {
        // Before the first write: a killed worker's scratch may hold the
        // space that write needs, and a `.git` that is not the checkout's
        // own directory is refused before anything changes it.
        await sweepWorkerScratch(this.root);
        // Only a reuse needs a mirror; a clone writes into its own staging.
        const scratch = await workerScratch(this.root, "fetch");
        if (scratch === undefined) {
          throw new Error(
            `Workspace ${this.root} refused: its .git is not a directory`,
          );
        }
        try {
          // Also scrubs a credential an older worker may have stored.
          await check(
            git(["remote", "set-url", "origin", remote.url]),
            "remote set-url",
          );
          await this.fetchThroughMirror(
            git,
            join(scratch, "origin.git"),
            remote.route?.url ?? remote.url,
            plan.branch,
            input.signal,
          );
        } finally {
          await rm(scratch, { force: true, recursive: true });
        }
        await check(git(["checkout", "--quiet", plan.branch]), "checkout");
        return plan.action;
      }
    }
  }

  /**
   * Adds each additional repository as a git remote named by its id, its
   * branch fetched to `refs/remotes/<id>/<branch>` (session-multi-repository.md
   * decision 2). Runs once the checkout is in place, a restored one included.
   * Fetched as `fetchThroughMirror` does: the network is reached only from a
   * scratch mirror this worker just made, never with the checkout's own
   * config, which the engine can write. One that fails is skipped.
   */
  async attachRepositories(input: {
    descriptor: WorkspaceDescriptor;
    signal: AbortSignal;
  }): Promise<{ attached: string[]; failed: string[] }> {
    const attached: string[] = [];
    const failed: string[] = [];
    for (const repository of input.descriptor.additional_repositories ?? []) {
      try {
        await this.attachRepository(repository, input.signal);
        attached.push(repository.id);
      } catch (error) {
        if (input.signal.aborted) throw error;
        failed.push(repository.id);
      }
    }
    return { attached, failed };
  }

  async attachRepository(
    repository: AdditionalWorkspaceRepository,
    outer: AbortSignal,
  ): Promise<string> {
    const { id, access, url, branch } = repository;
    const remote = routed(splitSecret(url), access, this.egressTransport, id);
    const limited = new AbortController();
    let exceeded: AttachLimitError | undefined;
    const stop = (error: AttachLimitError) => {
      exceeded ??= error;
      limited.abort(error);
    };
    const signal = AbortSignal.any([outer, limited.signal]);
    const git: Git = (args, options = {}) =>
      runGit(args, {
        cwd: options.cwd ?? this.root,
        network: options.network === true ? remote : null,
        overrides: [],
        redact: redactor(
          url,
          remote.secret,
          remote.route === undefined ? [] : [remote.route.token],
        ),
        signal,
      });
    const scratch = await workerScratch(this.root, "attach");
    if (scratch === undefined) {
      throw new Error(`Workspace ${this.root} has no .git directory`);
    }
    const mirror = join(scratch, "remote.git");
    const timer = setTimeout(
      () => stop(new AttachLimitError("fetch_timeout")),
      this.attachLimits.timeoutMs,
    );
    let measuring = false;
    const sizer = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void bytesUnder(mirror)
        .then((bytes) => {
          if (bytes > this.attachLimits.maxBytes) {
            stop(new AttachLimitError("fetch_too_large"));
          }
        })
        .finally(() => {
          measuring = false;
        });
    }, ATTACH_SIZE_CHECK_MS);
    try {
      await check(
        git(
          [
            "clone",
            "--quiet",
            "--bare",
            "--single-branch",
            "--branch",
            branch,
            "--",
            remote.route?.url ?? remote.url,
            mirror,
          ],
          { network: true, cwd: "/" },
        ),
        "fetch",
      );
      // A clone quicker than the sampler is measured once more here.
      if ((await bytesUnder(mirror)) > this.attachLimits.maxBytes) {
        throw new AttachLimitError("fetch_too_large");
      }
      await check(
        git([
          "fetch",
          "--quiet",
          "--no-tags",
          mirror,
          `+refs/heads/${branch}:refs/remotes/${id}/${branch}`,
        ]),
        "fetch",
      );
    } catch (error) {
      if (exceeded !== undefined && !outer.aborted) throw exceeded;
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(sizer);
      await rm(scratch, { force: true, recursive: true });
    }
    // The real URL, without a credential, as for origin: the engine sees
    // where the remote is but cannot reach it.
    const added = await git(["remote", "add", id, remote.url]);
    if (added.code !== 0) {
      await check(git(["remote", "set-url", id, remote.url]), "remote set-url");
    }
    const head = await git([
      "rev-parse",
      "--verify",
      `refs/remotes/${id}/${branch}^{commit}`,
    ]);
    await check(Promise.resolve(head), "rev-parse");
    return head.stdout.trim();
  }

  private restored(): "restore" {
    this.instructions = {
      file: {
        kind: "refused",
        reason: "a restored workspace has no freshly fetched commit behind it",
      },
      commit: null,
    };
    return "restore";
  }

  /**
   * A session without a repository works in a local git with no origin,
   * which nothing but this session's own checkpoints can bring back: it is
   * made here once and never recreated. Nothing reaches the network, and no
   * CLAUDE.md is pinned, there being no repository to pin it from.
   */
  private async prepareLocal(input: {
    restore: CheckpointRef | null;
    signal: AbortSignal;
  }): Promise<WorkspacePlan["action"]> {
    this.instructions = NOTHING_PINNED;
    if (input.restore !== null) return this.restored();
    const neutralized: Array<[string, string]> = [];
    const git: Git = (args, options = {}) =>
      runGit(args, {
        cwd: options.cwd ?? this.root,
        network: null,
        overrides: neutralized,
        redact: (text) => text,
        signal: input.signal,
      });
    const plan = planWorkspacePreparation({
      workspace: { repository: null },
      restore: null,
      observed: await this.observe(git, neutralized),
    });
    switch (plan.action) {
      case "refuse":
        throw new Error(`Workspace ${this.root} refused: ${plan.reason}`);
      case "init":
        await this.init(git, input.signal);
        return plan.action;
      case "keep": {
        const found = await lstat(join(this.root, ".git")).catch(() => null);
        if (found?.isDirectory() !== true) {
          throw new Error(
            `Workspace ${this.root} refused: its .git is not a directory`,
          );
        }
        await sweepWorkerScratch(this.root);
        return plan.action;
      }
      default:
        throw new Error(
          `A workspace without a repository planned ${plan.action}`,
        );
    }
  }

  private async init(git: Git, signal: AbortSignal): Promise<void> {
    // From `/`, as for a clone: the root may not exist yet.
    await check(
      git(
        [
          "init",
          "--quiet",
          "--template=",
          "--initial-branch=main",
          "--",
          this.root,
        ],
        { cwd: "/" },
      ),
      "init",
    );
    await writeLocalExcludes(this.root);
    await check(
      runGit(
        ["commit", "--quiet", "--allow-empty", "-m", "Werft: empty workspace"],
        {
          cwd: this.root,
          extra: { env: LOCAL_WORKSPACE_IDENTITY },
          network: null,
          overrides: [],
          redact: (text) => text,
          signal,
        },
      ),
      "commit",
    );
  }

  private async observe(
    git: Git,
    neutralized: Array<[string, string]>,
  ): Promise<WorkspaceObservation> {
    const entries = await readdir(this.root).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    if (entries.length === 0) return { kind: "empty" };
    if (await cloneStaged(this.root)) return { kind: "interrupted" };
    // What a clone stopped between making `.git` and the staging in it
    // leaves: nothing to lose.
    if (
      entries.length === 1 &&
      entries[0] === ".git" &&
      (await lstat(join(this.root, ".git")).catch(() => null))?.isDirectory() &&
      (await readdir(join(this.root, ".git"))).length === 0
    ) {
      return { kind: "empty" };
    }
    // A directory for a clone, a file for a linked worktree.
    if ((await stat(join(this.root, ".git")).catch(() => null)) === null) {
      return { kind: "foreign" };
    }
    // Reading config runs nothing; everything after this may.
    neutralized.push(...(await filterOverrides(git)));
    const remote = await git(["config", "--get", "remote.origin.url"]);
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    const fsck = await git(["fsck", "--connectivity-only", "--no-progress"]);
    const head = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    return {
      kind: "checkout",
      remoteUrl: remote.code === 0 ? remote.stdout.trim() : "",
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      healthy:
        fsck.code === 0 &&
        shallow.code === 0 &&
        shallow.stdout.trim() === "false",
      localWork: await this.holdsLocalWork(git),
      headCommit: head.code === 0,
    };
  }

  /**
   * True unless git can show there is nothing here that `origin` lacks. A
   * probe that fails counts as work: this answer decides whether a
   * checkout may be deleted.
   */
  private async holdsLocalWork(git: Git): Promise<boolean> {
    // Ignored files count: an unsound checkout with none of the other kinds
    // of work is deleted, and an ignored `.env` is still somebody's.
    const probes = await Promise.all([
      git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=all",
      ]),
      git([
        "rev-list",
        "--max-count=1",
        // A detached HEAD's commits are on no branch.
        "HEAD",
        "--branches",
        "--tags",
        "--not",
        "--remotes=origin",
      ]),
      git(["stash", "list"]),
    ]);
    // Submodules are never looked into (their config is the engine's too),
    // so having any is treated as holding work in them.
    const submodules = await stat(join(this.root, ".git", "modules")).catch(
      () => null,
    );
    return (
      submodules !== null ||
      probes.some((probe) => probe.code !== 0 || probe.stdout.trim() !== "")
    );
  }

  /**
   * Clones into `.git/CLONE_STAGING` and only then moves the result up: the
   * tree to the root, the clone's git directory into the root's `.git`, the
   * staging directory last. It is made before anything at the root is
   * deleted, so an attempt stopped at any point leaves `interrupted`.
   */
  private async clone(
    git: Git,
    remote: Remote,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const gitDirectory = join(this.root, ".git");
    const staging = join(gitDirectory, CLONE_STAGING);
    await mkdir(this.root, { recursive: true });
    // As for a reuse: the staging could not go in it, and what it points at
    // is not the root's to empty.
    const found = await lstat(gitDirectory).catch(() => null);
    if (found !== null && !found.isDirectory()) {
      throw new Error(
        `Workspace ${this.root} refused: its .git is not a directory`,
      );
    }
    await mkdir(staging, { recursive: true });
    if (!(await lstat(staging)).isDirectory()) {
      throw new Error(`Workspace ${this.root} refused: ${staging} is a link`);
    }
    // The root is the backend's mount point: empty it, keep it.
    for (const entry of await readdir(this.root)) {
      if (entry === ".git") continue;
      await rm(join(this.root, entry), { force: true, recursive: true });
    }
    for (const entry of await readdir(gitDirectory)) {
      if (entry === CLONE_STAGING) continue;
      await rm(join(gitDirectory, entry), { force: true, recursive: true });
    }
    for (const entry of await readdir(staging)) {
      await rm(join(staging, entry), { force: true, recursive: true });
    }
    await check(
      git(
        [
          "clone",
          "--quiet",
          "--branch",
          branch,
          "--",
          remote.route?.url ?? remote.url,
          staging,
        ],
        // `/`, read-only: the mount above the root is the engine's to write
        // (the Kubernetes backend), so a git looking for a repository from
        // there could find a config the last engine planted.
        { network: true, cwd: "/" },
      ),
      "clone",
    );
    // Cloned through the proxy's route, origin names the route; the
    // repository's own URL is what a reuse compares and what the engine
    // should see.
    if (remote.route !== undefined) {
      await check(
        git(["remote", "set-url", "origin", remote.url], { cwd: staging }),
        "remote set-url",
      );
    }
    const stagedGit = join(staging, ".git");
    for (const entry of await readdir(staging)) {
      if (entry === ".git") continue;
      await rename(join(staging, entry), join(this.root, entry));
    }
    for (const entry of await readdir(stagedGit)) {
      await rename(join(stagedGit, entry), join(gitDirectory, entry));
    }
    await rmdir(stagedGit);
    await rmdir(staging);
  }

  /**
   * Fetches origin into a mirror nobody else has written to, then copies
   * the branches over locally, where nothing carries the credential.
   *
   * Deliberately minimal: the mirror downloads the whole repository again
   * rather than negotiating from the checkout's objects, whose repository
   * config is exactly what this avoids trusting. Revisit when a reuse costs
   * noticeably more than the clone it saves.
   */
  private async fetchThroughMirror(
    git: Git,
    mirror: string,
    url: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    await check(
      git(["clone", "--quiet", "--bare", "--", url, mirror], {
        network: true,
        // Outside the checkout and its mount, as for the clone.
        cwd: "/",
      }),
      "fetch",
    );
    await check(
      git([
        "fetch",
        "--quiet",
        "--no-tags",
        mirror,
        "+refs/heads/*:refs/remotes/origin/*",
      ]),
      "fetch",
    );
    // From the mirror, not the checkout: the last attempt's engine could
    // have edited the working tree, committed on the branch, or planted
    // objects in `.git` that a fetch would not overwrite.
    // The commit is also in the checkout now, under origin's refs.
    this.instructions = await pinInstructions(
      git,
      mirror,
      `refs/heads/${branch}`,
      this.instructionFiles,
      signal,
    );
  }
}

/**
 * Where `GitWorkspace` clones, inside `.git`, before the result moves up.
 * No tracked path can be there, and `.git/werft-*` is the worker's own, as
 * for `workerScratch`.
 *
 * Keeps its pre-rename name: it is stored on the workspace volume, and a clone
 * stopped under the old name would otherwise read as a finished checkout.
 */
const CLONE_STAGING = "agent-platform-clone";

/** Whether a clone began at `root` and never finished. */
async function cloneStaged(root: string): Promise<boolean> {
  const gitDirectory = join(root, ".git");
  const found = await lstat(gitDirectory).catch(() => null);
  if (found?.isDirectory() !== true) return false;
  const staging = await lstat(join(gitDirectory, CLONE_STAGING)).catch(
    () => null,
  );
  return staging?.isDirectory() === true;
}

/**
 * What a session without a repository keeps out of its checkpoints, having
 * no `.gitignore` of its own: dependencies and caches an engine rebuilds,
 * which would otherwise fill the bundle up to its limit.
 */
const LOCAL_WORKSPACE_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "__pycache__/",
  ".cache/",
] as const;

const LOCAL_WORKSPACE_IDENTITY = {
  GIT_AUTHOR_EMAIL: "workspace@werft.invalid",
  GIT_AUTHOR_NAME: "Werft workspace",
  GIT_COMMITTER_EMAIL: "workspace@werft.invalid",
  GIT_COMMITTER_NAME: "Werft workspace",
};

/**
 * Writes `LOCAL_WORKSPACE_EXCLUDES` into the `.git` an init or a restore
 * just made without a template. Neither leaves `info/` behind, so one that
 * exists was not made here and is refused rather than overwritten.
 */
export async function writeLocalExcludes(root: string): Promise<void> {
  const info = join(root, ".git", "info");
  await mkdir(info);
  await writeFile(
    join(info, "exclude"),
    LOCAL_WORKSPACE_EXCLUDES.map((pattern) => `${pattern}\n`).join(""),
    { flag: "wx" },
  );
}

/**
 * A new directory of the worker's own inside the workspace's `.git`: the
 * workspace volume is the only disk a worker has (`/tmp` and HOME are tmpfs,
 * paid for out of the container's memory), and inside `.git` neither git nor
 * a capture takes it for a file of the tree. Undefined when `.git` is not a
 * directory. The engine runs as the worker's user and could reach it anyway,
 * so a link it planted grants nothing; what is read back is checked.
 */
export async function workerScratch(
  root: string,
  purpose: string,
): Promise<string | undefined> {
  const gitDirectory = join(root, ".git");
  const found = await lstat(gitDirectory).catch(() => null);
  if (found?.isDirectory() !== true) return undefined;
  return mkdtemp(join(gitDirectory, `werft-${purpose}-`));
}

/**
 * Removes what `workerScratch` made and a killed worker never did: on the
 * volume it outlives the container and keeps counting against the quota.
 * Only a reuse can meet one; a clone and a restore start from an empty root.
 */
async function sweepWorkerScratch(root: string): Promise<void> {
  const gitDirectory = join(root, ".git");
  const found = await lstat(gitDirectory).catch(() => null);
  if (found?.isDirectory() !== true) return;
  // The worker never borrows objects; a checkout that does could be
  // borrowing them from one of these, and they are kept rather than lost.
  const objects = await lstat(join(gitDirectory, "objects")).catch(() => null);
  if (objects?.isDirectory() !== true) return;
  for (const borrowed of ["objects/info/alternates", "commondir"]) {
    if (
      (await lstat(join(gitDirectory, borrowed)).catch(() => null)) !== null
    ) {
      return;
    }
  }
  for (const entry of await readdir(gitDirectory)) {
    if (WORKER_SCRATCH_NAME.test(entry)) {
      await rm(join(gitDirectory, entry), { force: true, recursive: true });
    }
  }
}

/** `mkdtemp`'s six characters: the restored checkpoint directory has none. */
const WORKER_SCRATCH_NAME = /^werft-[a-z]+-[A-Za-z0-9]{6}$/;

/** Enough for a CLAUDE.md -> AGENTS.md -> docs/... chain; more is a loop. */
const MAX_LINK_HOPS = 8;
/** Linux's PATH_MAX: no checkout could create a link to anything longer. */
const MAX_LINK_TARGET_BYTES = 4096;

/**
 * The first of the root instruction files `files` (AGENTS.md, else CLAUDE.md
 * for the Claude runtime) that the tree at `rev` has, read from git's object
 * store in `cwd` — never from a working tree, which the engine writes. A file
 * that is only an `@<other file>` line stands for that file, so a CLAUDE.md
 * importing AGENTS.md is read once. A committed symlink is
 * followed only to another path in the same tree (`CLAUDE.md -> AGENTS.md`
 * is ordinary); one that leaves it, loops, or ends at anything but a file is
 * refused, as is a file past the cap or one git cannot read. Refused, not
 * thrown: whether the run wants the file at all is the run config's call, made
 * later, and a session that never asked for it must not fail over it.
 *
 * Left out, against what the engine itself loads: `.claude/CLAUDE.md`,
 * `CLAUDE.local.md`, `.claude/rules/`, nested directories' files and `@`
 * imports — each is another path to resolve the same way, worth adding when
 * a repository the platform serves depends on one.
 */
/**
 * Resolves `rev` to the commit it names now and reads `file` from that
 * commit, so the text and the commit a checkpoint later pins are the same.
 */
async function pinInstructions(
  git: Git,
  cwd: string,
  rev: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<PinnedInstructions> {
  const resolved = await git(
    ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
    { cwd },
  );
  if (resolved.code !== 0) {
    return {
      file: { kind: "refused", reason: `${rev} names no commit` },
      commit: null,
    };
  }
  const commit = resolved.stdout.trim();
  return {
    file: await readCommittedInstructions(git, cwd, commit, files, signal),
    commit,
  };
}

export async function readCommittedInstructions(
  git: Git,
  cwd: string,
  rev: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<CommittedInstructions> {
  try {
    return await firstCommittedInstructions(git, cwd, rev, files);
  } catch (error) {
    // A stop is the preparation's to report. Anything else that goes wrong
    // with this file is only the business of a run that asks for it.
    if (signal.aborted) throw error;
    return {
      kind: "refused",
      reason: messageOf(error),
    };
  }
}

// A file the tree has wins, even when it is refused: falling through to the
// next name would hand the run rules the repository ranks below the broken one.
async function firstCommittedInstructions(
  git: Git,
  cwd: string,
  rev: string,
  files: readonly string[],
): Promise<CommittedInstructions> {
  for (const file of files) {
    const found = await resolveCommittedInstructions(git, cwd, rev, file);
    if (found.kind === "absent") continue;
    if (found.kind !== "text") return found;
    const imported = /^@(\S+)$/.exec(found.text.trim())?.[1];
    // One hop only, so two files importing each other cannot loop.
    return imported !== undefined &&
      imported !== file &&
      files.includes(imported)
      ? resolveCommittedInstructions(git, cwd, rev, imported)
      : found;
  }
  return { kind: "absent" };
}

async function resolveCommittedInstructions(
  git: Git,
  cwd: string,
  rev: string,
  file: string,
): Promise<CommittedInstructions> {
  let path = file;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const listed = await git(
      ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", rev, "--", path],
      { cwd },
    );
    if (listed.code !== 0) {
      return {
        kind: "refused",
        reason: `git ls-tree failed (exit ${listed.code}): ${listed.stderr.trim()}`,
      };
    }
    // A pathspec naming a directory lists what is in it; only an entry for
    // exactly this path is the file (a link to nothing lists nothing).
    const entry = /^(\d+) (\w+) ([0-9a-f]+)\t([^\0]*)\0/.exec(listed.stdout);
    if (entry === null || entry[4] !== path) return { kind: "absent" };
    const [, mode, type, object] = entry as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (mode === "120000") {
      // Sized before it is read, like the file itself: on a reuse this runs
      // against a mirror before any checkout, where no filesystem limit on
      // link targets stands between a huge blob and this process's memory.
      const size = await git(["cat-file", "-s", object], { cwd });
      if (size.code !== 0) {
        return {
          kind: "refused",
          reason: `git cat-file failed (exit ${size.code}): ${size.stderr.trim()}`,
        };
      }
      if (Number(size.stdout.trim()) > MAX_LINK_TARGET_BYTES) {
        return { kind: "refused", reason: "it links to an overlong path" };
      }
      const target = await git(["cat-file", "blob", object], { cwd });
      if (target.code !== 0) {
        return {
          kind: "refused",
          reason: `git cat-file failed (exit ${target.code}): ${target.stderr.trim()}`,
        };
      }
      // A link is an arbitrary blob; no filesystem path holds a NUL.
      if (target.stdout.includes("\0")) {
        return { kind: "refused", reason: "it links to a malformed path" };
      }
      const next = posix.normalize(
        posix.join(posix.dirname(path), target.stdout),
      );
      if (
        posix.isAbsolute(target.stdout) ||
        next === ".." ||
        next.startsWith("../")
      ) {
        return { kind: "refused", reason: "it links outside the repository" };
      }
      // A pathspec that names a directory this way lists everything in it —
      // unbounded output from a read that runs for every session — and
      // whatever it names is no file anyway.
      if (next === "." || next.endsWith("/")) {
        return { kind: "refused", reason: "it is not a regular file" };
      }
      path = next;
      continue;
    }
    if (type !== "blob") {
      return { kind: "refused", reason: "it is not a regular file" };
    }
    const size = await git(["cat-file", "-s", object], { cwd });
    if (size.code !== 0) {
      return {
        kind: "refused",
        reason: `git cat-file failed (exit ${size.code}): ${size.stderr.trim()}`,
      };
    }
    if (Number(size.stdout.trim()) > COMMITTED_INSTRUCTIONS_MAX_BYTES) {
      return {
        kind: "refused",
        reason: `it is larger than ${COMMITTED_INSTRUCTIONS_MAX_BYTES} bytes`,
      };
    }
    const blob = await git(["cat-file", "blob", object], { cwd });
    if (blob.code !== 0) {
      return {
        kind: "refused",
        reason: `git cat-file failed (exit ${blob.code}): ${blob.stderr.trim()}`,
      };
    }
    return { kind: "text", text: blob.stdout };
  }
  return { kind: "refused", reason: "it links through too many symlinks" };
}

type Secret = {
  host: string;
  password: string;
  username: string;
};

/** The egress proxy's repository route and the token it takes. */
type Route = { token: string; url: string };

type Remote = {
  /**
   * Where the network calls go instead of `url` when the claim gave this
   * attempt a repository token: the proxy puts the repository's
   * own credential on each request, so none reaches this process.
   */
  route?: Route;
  /** What git may store: the URL without userinfo. */
  url: string;
  /** The one transport the network calls may use. */
  protocol: string;
  secret: Secret | null;
};

function routed(
  remote: Remote,
  access: WorkspaceRepository["access"],
  transport: string | null,
  /** Another repository than the session's own: its own route. */
  repositoryId?: string,
): Remote {
  if (access === undefined) return remote;
  if (transport === null) {
    throw new Error(
      "The claim routes the repository through the egress proxy, but WORKER_EGRESS_CREDENTIAL_URL is not set",
    );
  }
  return {
    ...remote,
    route: {
      token: access.token,
      url:
        repositoryId === undefined
          ? `${transport}/repository`
          : `${transport}/repository/${encodeURIComponent(repositoryId)}`,
    },
  };
}

function splitSecret(url: string): Remote {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A plain path, or scp-like syntax (git@host:path), which carries a user
    // name but never a secret.
    return {
      url,
      protocol: url.startsWith("/") ? "file" : "ssh",
      secret: null,
    };
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  if (parsed.username === "" && parsed.password === "") {
    return { url, protocol, secret: null };
  }
  const secret = {
    host: parsed.host,
    password: decodeURIComponent(parsed.password),
    username: decodeURIComponent(parsed.username),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), protocol, secret };
}

/** The repository URL as git may store it: without the credential. */
export function storableRepositoryUrl(url: string): string {
  return splitSecret(url).url;
}

/** What git needs from the host: its binary, a HOME, and the egress proxy. */
const GIT_HOST_VARIABLES = [
  "PATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * Answers `get` only for the descriptor's protocol and host; git writes
 * `protocol=` and `host=` lines on stdin. Quoted case patterns match
 * literally.
 */
const SCOPED_HELPER = [
  "!f() {",
  'test "$1" = get || exit 0;',
  "p=; h=;",
  'while IFS= read -r line; do case "$line" in',
  '"protocol=$WORKER_GIT_PROTOCOL") p=1;;',
  '"host=$WORKER_GIT_HOST") h=1;;',
  "esac; done;",
  'test -n "$p" && test -n "$h" || exit 0;',
  'echo "username=$WORKER_GIT_USERNAME";',
  'echo "password=$WORKER_GIT_PASSWORD";',
  "}; f",
].join(" ");

/**
 * Every filter driver the checkout's config defines, emptied: git runs no
 * filter whose command is empty, and `required=false` keeps it from failing
 * the command instead.
 */
export async function filterOverrides(
  git: Git,
): Promise<Array<[string, string]>> {
  const listed = await git([
    "config",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^filter\\.",
  ]);
  // Exit 1 is "no such key"; anything else leaves the drivers unknown.
  if (listed.code === 1) return [];
  if (listed.code !== 0) {
    throw new Error(
      `git config failed (exit ${listed.code}): ${listed.stderr}`,
    );
  }
  const drivers = new Set(
    listed.stdout
      .split("\n")
      .filter((key) => key.startsWith("filter."))
      .map((key) => key.slice("filter.".length, key.lastIndexOf(".")))
      .filter((name) => name !== ""),
  );
  return [...drivers].flatMap(
    (name): Array<[string, string]> => [
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    ],
  );
}

/**
 * What a caller adds to the hardened environment: more configuration (it
 * still outranks the repository's own) and variables such as `GIT_DIR` or
 * `GIT_INDEX_FILE` that point a command at something other than the root.
 */
export type GitExtras = {
  config?: Array<[string, string]>;
  env?: Record<string, string>;
};

/** Long enough for a large clone; a local command gets far less. */
const NETWORK_DEADLINE_MS = 30 * 60_000;
export const LOCAL_DEADLINE_MS = 2 * 60_000;

/** `network` is null for calls that must not leave this machine. */
function gitEnvironment(
  network: Remote | null,
  overrides: Array<[string, string]>,
  extra: GitExtras = {},
): Record<string, string> {
  const env: Record<string, string> = {
    // A credential prompt would hang the claim; fail instead.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: network?.protocol ?? "file",
  };
  for (const name of GIT_HOST_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Config through the environment outranks the repository's own, which
  // the last attempt's engine could write.
  const config: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["submodule.recurse", "false"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ...overrides,
    ...(extra.config ?? []),
  ];
  const route = network?.route;
  if (route !== undefined) {
    // No helper at all: the route takes only the token, in a header git
    // sends to that URL alone, and a redirect elsewhere is not followed.
    config.push(
      ["credential.helper", ""],
      [`http.${route.url}.extraHeader`, `Authorization: Bearer ${route.token}`],
      ["http.followRedirects", "false"],
    );
    const transport = new URL(route.url);
    env.GIT_ALLOW_PROTOCOL = transport.protocol.replace(/:$/, "");
    bypassProxyFor(env, transport.hostname);
  }
  const secret = network?.secret ?? null;
  if (route === undefined && network !== null && secret !== null) {
    // The empty helper first drops every helper configured anywhere else.
    config.push(
      ["credential.helper", ""],
      ["credential.helper", SCOPED_HELPER],
    );
    Object.assign(env, {
      WORKER_GIT_HOST: secret.host,
      WORKER_GIT_PASSWORD: secret.password,
      WORKER_GIT_PROTOCOL: network.protocol,
      WORKER_GIT_USERNAME: secret.username,
    });
  }
  Object.assign(env, extra.env);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * The route is plain http on the worker network and must not go through the
 * forward proxy, which would refuse it: adds its host to whichever of
 * `NO_PROXY`/`no_proxy` is set, or to both when neither is.
 */
function bypassProxyFor(env: Record<string, string>, hostname: string): void {
  const names = (["NO_PROXY", "no_proxy"] as const).filter(
    (name) => env[name] !== undefined,
  );
  for (const name of names.length === 0 ? ["NO_PROXY", "no_proxy"] : names) {
    const current = env[name] ?? "";
    env[name] = current === "" ? hostname : `${current},${hostname}`;
  }
}

export type GitRunOptions = {
  cwd: string;
  /** For tests; otherwise set by whether git may reach the network. */
  deadlineMs?: number;
  extra?: GitExtras;
  /**
   * Caps git and every helper it forks (Linux only, see `gitCommand`); one
   * that runs out is reported as `GitResourceLimitError`. Unset, git shares
   * the worker's memory, disk and CPU.
   */
  limits?: GitResourceLimits;
  network: Remote | null;
  overrides: Array<[string, string]>;
  redact: (text: string) => string;
  signal: AbortSignal;
};

/** Git wrote more to stdout than the caller would hold; the child was killed. */
export class GitOutputLimitError extends Error {
  constructor(readonly limit: number) {
    super(`git wrote more than ${limit} bytes`);
    this.name = "GitOutputLimitError";
  }
}

/**
 * A git run under `GitRunOptions.limits` ran out of memory, file size, CPU
 * or its deadline. Thrown rather than returned as an exit code, so that
 * callers which read a failed probe as an answer do not read this one as one.
 */
export class GitResourceLimitError extends Error {
  constructor(detail: string) {
    super(`git ran out of its resource limits: ${detail}`);
    this.name = "GitResourceLimitError";
  }
}

/**
 * What git says on stderr is kept only up to this, from the end: enough for
 * the last lines a failure is reported and classified with, and not a buffer
 * a hostile repository fills.
 */
const STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * How long the pipes are read once git itself has exited. A helper it forked
 * (`pack-objects`, `index-pack`) shares them, and one that outlives a git
 * that exited on its own would otherwise hold the read open for as long as it
 * runs. Such a helper is not killed (see `runGitBytes`): it runs on until its
 * next write fails, and under `limits` no longer than its own CPU allowance.
 */
const PIPE_GRACE_MS = 2_000;

/**
 * How git reports, in its last lines, a helper or an allocation that a limit
 * stopped. Read only from the end of stderr, where git's own verdict is, and
 * only for a run with limits; a path that happens to say the same can at
 * worst turn a failure into a limit failure, which fails the same way.
 */
const LIMIT_MESSAGES =
  /out of memory|cannot allocate memory|file too large|died of signal (9|24|25)\b/i;
const LIMIT_SIGNALS = new Set(["SIGKILL", "SIGXCPU", "SIGXFSZ"]);

export async function runGit(
  args: string[],
  options: GitRunOptions,
): Promise<GitResult> {
  const result = await runGitBytes(args, options);
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: result.stderr,
  };
}

/**
 * `runGit` with stdout as the bytes git wrote, for output that is not text
 * (a bundle) or whose names must not be decoded lossily. Past `maxStdoutBytes`
 * the child is killed and `GitOutputLimitError` thrown, so a limit is enforced
 * while git runs rather than after it has filled memory.
 *
 * git leads a process group of its own, and a stop — the signal, the
 * deadline, the stdout limit — kills the whole group: the helpers git forks
 * (`pack-objects`, `index-pack`) inherit its pipes and would otherwise run
 * on after it. Only while git itself has not been reaped, though; after that
 * its number may be someone else's group (see `killProcessGroup`).
 */
export async function runGitBytes(
  args: string[],
  options: GitRunOptions & { maxStdoutBytes?: number },
): Promise<{ code: number; stderr: string; stdout: Uint8Array }> {
  const { network, redact, signal } = options;
  signal.throwIfAborted();
  const child = Bun.spawn(gitCommand(args, options.limits), {
    cwd: options.cwd,
    detached: true,
    env: gitEnvironment(network, options.overrides, options.extra),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child.pid);
    }
  };
  const deadlineMs =
    options.deadlineMs ??
    (network === null ? LOCAL_DEADLINE_MS : NETWORK_DEADLINE_MS);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, deadlineMs);
  signal.addEventListener("abort", stop);
  const limit = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
  const abandon = child.exited.then(() => Bun.sleep(PIPE_GRACE_MS));
  let collected: [Collected, string, number];
  try {
    collected = await Promise.all([
      collect(child.stdout, limit, abandon, stop),
      collectTail(child.stderr, STDERR_LIMIT_BYTES, abandon),
      child.exited,
    ]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
  }
  const [stdout, stderr, code] = collected;
  signal.throwIfAborted();
  if (stdout.overflowed) throw new GitOutputLimitError(limit);
  const said = redact(stderr);
  const late = `git ran past its ${deadlineMs}ms deadline`;
  if (options.limits !== undefined) {
    if (timedOut) throw new GitResourceLimitError(late);
    if (!stopped && code !== 0) {
      const killedBy = child.signalCode ?? "";
      if (LIMIT_SIGNALS.has(killedBy)) {
        throw new GitResourceLimitError(killedBy);
      }
      const verdict = said
        .trim()
        .split("\n")
        .slice(-2)
        .find((line) => LIMIT_MESSAGES.test(line));
      if (verdict !== undefined) throw new GitResourceLimitError(verdict);
    }
  }
  return {
    code,
    stdout: stdout.bytes,
    stderr: timedOut ? `${said}\n${late}` : said,
  };
}

/**
 * Reads a pipe up to `limit` bytes. Without `onOverflow` the rest is drained
 * and dropped, so the writer never blocks on a full pipe; with it, reading
 * stops and the writer is expected to be killed. Reading also stops once
 * `abandon` settles, whoever still holds the pipe.
 */
const ABANDONED = Symbol("abandoned");

type Collected = { bytes: Uint8Array; overflowed: boolean };

async function collect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abandon: Promise<void>,
  onOverflow?: () => void,
): Promise<Collected> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  let overflowed = false;
  const reader = stream.getReader();
  const abandoned = abandon.then(() => ABANDONED);
  for (;;) {
    const next = await Promise.race([reader.read(), abandoned]);
    if (typeof next === "symbol") {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = next;
    if (done) break;
    if (overflowed) continue;
    if (held + value.byteLength > limit) {
      overflowed = true;
      const room = limit - held;
      if (room > 0) chunks.push(value.subarray(0, room));
      held = limit;
      if (onOverflow !== undefined) {
        onOverflow();
        await reader.cancel().catch(() => undefined);
        break;
      }
      continue;
    }
    chunks.push(value);
    held += value.byteLength;
  }
  const bytes = new Uint8Array(held);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflowed };
}

/**
 * The last `limit` bytes of a pipe, as whole lines: once anything has been
 * dropped the first, partial line goes too, so no cut lands inside a URL or
 * credential the redaction would then no longer recognise.
 */
async function collectTail(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abandon: Promise<void>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  // The byte just before what is kept, once anything has been dropped.
  let before: number | undefined;
  const reader = stream.getReader();
  const abandoned = abandon.then(() => ABANDONED);
  for (;;) {
    const next = await Promise.race([reader.read(), abandoned]);
    if (typeof next === "symbol") {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = next;
    if (done) break;
    chunks.push(value);
    held += value.byteLength;
    while (
      chunks.length > 1 &&
      held - (chunks[0] as Uint8Array).byteLength >= limit
    ) {
      const gone = chunks.shift() as Uint8Array;
      held -= gone.byteLength;
      before = gone.at(-1);
    }
  }
  const bytes = new Uint8Array(held);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let kept = bytes;
  if (held > limit) {
    kept = bytes.subarray(held - limit);
    before = bytes[held - limit - 1];
  }
  if (before !== undefined && before !== 0x0a) {
    const newline = kept.indexOf(0x0a);
    kept =
      newline < 0 ? kept.subarray(kept.byteLength) : kept.subarray(newline + 1);
  }
  return new TextDecoder().decode(kept);
}

export async function check(
  result: Promise<GitResult>,
  step: string,
): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) {
    throw new Error(`git ${step} failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Replaces the URL, the credential, and any userinfo git echoes back. */
function redactor(
  url: string,
  secret: Secret | null,
  extra: readonly string[] = [],
): (text: string) => string {
  return (text) => {
    let redacted = text.split(url).join("<repository>");
    if (secret !== null && secret.password !== "") {
      redacted = redacted.split(secret.password).join("<redacted>");
    }
    for (const value of extra) {
      if (value !== "") redacted = redacted.split(value).join("<redacted>");
    }
    return redacted.replace(/(\/\/)[^/@\s]+@/g, "$1<redacted>@");
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
