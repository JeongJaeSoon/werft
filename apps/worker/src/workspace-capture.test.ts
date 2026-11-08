import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_SOURCE_PREFIX,
  MAX_CHECKPOINT_SOURCES,
  readGitBundleHeader,
} from "@werft-ai/runtime-core";
import { isolatedGit } from "@werft-ai/testkit/git";
import {
  GitOutputLimitError,
  GitResourceLimitError,
  type GitRunOptions,
  runGitBytes,
} from "./workspace.ts";
import {
  CHECKPOINT_HEAD_REF,
  CHECKPOINT_INSTRUCTIONS_REF,
  CHECKPOINT_WORKTREE_REF,
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type WorkspaceCapture,
} from "./workspace-capture.ts";

const procfs = existsSync("/proc/self/fd");
const linux = process.platform === "linux";

let scratch: string;
let root: string;
const git = isolatedGit(() => scratch);

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-246-capture-"));
  root = join(scratch, "workspace");
  await mkdir(root);
  await git(root, "init", "--quiet", "--initial-branch=main");
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

async function commitFiles(files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "commit");
  return (await git(root, "rev-parse", "HEAD")).trim();
}

/**
 * Puts `script` first on PATH as `git` until the returned function runs.
 * `$REAL_GIT` in it names the git that was there before.
 */
async function fakeGit(script: string): Promise<() => void> {
  const real = Bun.which("git");
  if (real === null) throw new Error("no git on PATH");
  const bin = await mkdtemp(join(scratch, "bin-"));
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nREAL_GIT=${real}\n${script}\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  return () => {
    process.env.PATH = path;
  };
}

/** The real git, except that a command naming `verb` dies as RLIMIT_FSIZE kills. */
function killedOn(verb: string): string {
  return `for arg; do [ "$arg" = ${verb} ] && kill -s XFSZ $$; done\nexec "$REAL_GIT" "$@"`;
}

/**
 * Whether `pid` still runs. A killed helper whose parent died first is
 * reparented to PID 1, and where that is this test runner (bun as a
 * container's PID 1) nobody reaps it: it is dead, just still listed.
 */
async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!linux) return true;
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat !== "" && !/^\d+ \(.*\) Z /.test(stat);
}

async function capture(
  options: { limits?: Partial<typeof DEFAULT_WORKSPACE_CAPTURE_LIMITS> } = {},
) {
  return captureWorkspace({
    root,
    bundlePath: bundlePath(),
    signal: new AbortController().signal,
    limits: { ...DEFAULT_WORKSPACE_CAPTURE_LIMITS, ...options.limits },
  });
}

async function captured(): Promise<WorkspaceCapture> {
  const result = await capture();
  if (result.status !== "captured") throw new Error(result.reason);
  return result.capture;
}

/** Everything a capture must leave exactly as it found it. */
async function fingerprint(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(join(root, ".git", "index")));
  hash.update(await git(root, "rev-parse", "HEAD"));
  hash.update(await git(root, "for-each-ref"));
  hash.update(await git(root, "status", "--porcelain=v2", "--untracked=all"));
  hash.update(await git(root, "count-objects", "-v"));
  return hash.digest("hex");
}

/** Outside the workspace, as the caller's spool is. */
function bundlePath(): string {
  return join(scratch, `capture-${crypto.randomUUID()}.bundle`);
}

function headerOf(capture: WorkspaceCapture) {
  return readGitBundleHeader(readFileSync(capture.bundle.path));
}

/** Fetches the bundle into an empty repository, the way a restore does. */
async function unbundle(capture: WorkspaceCapture): Promise<string> {
  const target = join(scratch, `restored-${crypto.randomUUID()}`);
  await mkdir(target);
  await git(target, "init", "--quiet");
  await git(
    target,
    "fetch",
    "--quiet",
    capture.bundle.path,
    `${CHECKPOINT_WORKTREE_REF}:${CHECKPOINT_WORKTREE_REF}`,
  );
  await git(target, "checkout", "--quiet", "--detach", CHECKPOINT_WORKTREE_REF);
  return target;
}

describe("captureWorkspace", () => {
  test("retries once when the workspace changes during capture", async () => {
    await commitFiles({ "changing.txt": "before\n" });
    const changed = join(scratch, "changed-once");
    const restoreGit = await fakeGit(`
for arg; do
  if [ "$arg" = bundle ] && [ ! -e ${JSON.stringify(changed)} ]; then
    : > ${JSON.stringify(changed)}
    printf 'after\\n' > ${JSON.stringify(join(root, "changing.txt"))}
  fi
done
exec "$REAL_GIT" "$@"`);
    try {
      const restored = await unbundle(await captured());

      expect(await readFile(join(restored, "changing.txt"), "utf8")).toBe(
        "after\n",
      );
    } finally {
      restoreGit();
    }
  });

  test("refuses when the workspace changes during both capture attempts", async () => {
    await commitFiles({ "changing.txt": "before\n" });
    const restoreGit = await fakeGit(`
for arg; do
  if [ "$arg" = bundle ]; then
    printf x >> ${JSON.stringify(join(root, "changing.txt"))}
  fi
done
exec "$REAL_GIT" "$@"`);
    try {
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace changed during both checkpoint capture attempts",
      });
    } finally {
      restoreGit();
    }
  });

  test("does not retry for changes to files the checkpoint ignores", async () => {
    await commitFiles({ ".gitignore": "ignored.log\n", "tracked.txt": "a\n" });
    const ignored = join(root, "ignored.log");
    await writeFile(ignored, "before\n");
    const restoreGit = await fakeGit(`
for arg; do
  if [ "$arg" = bundle ]; then
    printf x >> ${JSON.stringify(ignored)}
  fi
done
exec "$REAL_GIT" "$@"`);
    try {
      expect((await capture()).status).toBe("captured");
    } finally {
      restoreGit();
    }
  });

  test("pins HEAD itself when the working tree matches it, and bundles the branch", async () => {
    const head = await commitFiles({ "a.txt": "a\n", "src/b.txt": "b\n" });
    const before = await fingerprint();

    const result = await captured();

    expect(result.gitCommit).toBe(head);
    expect(result.untracked).toEqual([]);
    const header = headerOf(result);
    expect(header?.prerequisites).toEqual([]);
    expect(header?.refs).toEqual([
      { name: CHECKPOINT_HEAD_REF, oid: head },
      { name: CHECKPOINT_WORKTREE_REF, oid: head },
      { name: "refs/heads/main", oid: head },
    ]);
    expect(await fingerprint()).toBe(before);
  });

  test("commits uncommitted tracked edits on top of HEAD without touching the workspace", async () => {
    const head = await commitFiles({
      "a.txt": "a\n",
      "gone.txt": "g\n",
      "src/b.txt": "b\n",
    });
    await writeFile(join(root, "a.txt"), "a edited\n");
    await rm(join(root, "gone.txt"));
    await writeFile(join(root, "staged.txt"), "staged\n");
    await git(root, "add", "staged.txt");
    const before = await fingerprint();

    const result = await captured();

    expect(result.gitCommit).not.toBe(head);
    expect(result.headCommit).toBe(head);
    expect(await fingerprint()).toBe(before);
    const header = headerOf(result);
    expect(header?.refs).toContainEqual({
      name: CHECKPOINT_HEAD_REF,
      oid: head,
    });
    expect(header?.refs).toContainEqual({
      name: CHECKPOINT_WORKTREE_REF,
      oid: result.gitCommit,
    });

    const restored = await unbundle(result);
    expect(await readFile(join(restored, "a.txt"), "utf8")).toBe("a edited\n");
    expect(await readFile(join(restored, "staged.txt"), "utf8")).toBe(
      "staged\n",
    );
    expect(existsSync(join(restored, "gone.txt"))).toBe(false);
    expect(
      (await git(restored, "rev-parse", `${CHECKPOINT_WORKTREE_REF}^`)).trim(),
    ).toBe(head);
  });

  test("a clean tree is captured at HEAD itself", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    expect(await captured()).toMatchObject({
      gitCommit: head,
      headCommit: head,
    });
  });

  // Reading an untracked file needs procfs, which macOS lacks.
  test.skipIf(!existsSync("/proc/self/fd"))(
    "a tree with only untracked files is captured at HEAD itself",
    async () => {
      const head = await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "scratch.txt"), "untracked\n");
      expect(await captured()).toMatchObject({
        gitCommit: head,
        headCommit: head,
      });
    },
  );

  test("stages a chmod even in a checkout told to ignore modes", async () => {
    await commitFiles({ "run.sh": "#!/bin/sh\n" });
    await git(root, "config", "core.fileMode", "false");
    await chmod(join(root, "run.sh"), 0o755);

    const result = await captured();

    const restored = await unbundle(result);
    expect(await git(restored, "ls-tree", "HEAD", "run.sh")).toStartWith(
      "100755 ",
    );
  });

  test("stages a file that replaced a tracked symlink in a checkout told not to make links", async () => {
    await commitFiles({ "a.txt": "a\n" });
    await symlink("a.txt", join(root, "link"));
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "-m", "link");
    await git(root, "config", "core.symlinks", "false");
    await rm(join(root, "link"));
    await git(root, "checkout", "--", "link");
    expect((await lstat(join(root, "link"))).isFile()).toBe(true);

    const restored = await unbundle(await captured());

    expect((await lstat(join(restored, "link"))).isFile()).toBe(true);
    expect(await readFile(join(restored, "link"), "utf8")).toBe("a.txt");
  });

  test("lists an untracked name that differs from a tracked one only in case", async () => {
    // Needs a filesystem that tells `a` from `A`, which the Linux runs have.
    if (process.platform !== "linux") return;
    await commitFiles({ a: "tracked\n" });
    await git(root, "config", "core.ignoreCase", "true");
    await writeFile(join(root, "A"), "untracked\n");

    expect((await captured()).untracked.map(({ path }) => path)).toEqual(["A"]);
  });

  test("takes the bytes on disk, not what the repository's own attributes would make of them", async () => {
    await commitFiles({ "a.txt": "a\n" });
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(
      join(root, ".git", "info", "attributes"),
      "*.txt text eol=crlf\n",
    );
    await git(
      root,
      "config",
      "core.attributesFile",
      join(scratch, "attributes"),
    );
    await writeFile(join(scratch, "attributes"), "*.md text eol=crlf\n");
    await rm(join(root, "a.txt"));
    await git(root, "checkout", "--", "a.txt");
    await writeFile(join(root, "b.md"), "b\r\n");
    await git(root, "add", "b.md");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\r\n");

    const restored = await unbundle(await captured());

    // A restore has neither file, so the bytes travel as they are.
    expect(await readFile(join(restored, "a.txt"), "utf8")).toBe("a\r\n");
    expect(await readFile(join(restored, "b.md"), "utf8")).toBe("b\r\n");
  });

  test("a HEAD a replace ref stands in for is restored as the files on disk", async () => {
    const head = await commitFiles({ "a.txt": "original\n" });
    const replacement = await commitFiles({ "a.txt": "replacement\n" });
    await git(root, "reset", "--quiet", "--hard", head);
    await git(root, "replace", head, replacement);
    await git(root, "reset", "--quiet", "--hard");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("replacement\n");

    const result = await captured();
    const restored = await unbundle(result);

    expect(result.gitCommit).not.toBe(head);
    expect(await readFile(join(restored, "a.txt"), "utf8")).toBe(
      "replacement\n",
    );
  });

  test("bundles no branch for a detached HEAD, only the branches as sources", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    await git(root, "checkout", "--quiet", "--detach");

    const header = headerOf(await captured());

    expect(header?.refs.map((ref) => ref.name)).toEqual([
      CHECKPOINT_HEAD_REF,
      CHECKPOINT_WORKTREE_REF,
      `${CHECKPOINT_SOURCE_PREFIX}main`,
    ]);
    expect(header?.refs[0]?.oid).toBe(head);
  });

  test("keeps every local branch as a source, each at its own commit", async () => {
    const base = await commitFiles({ "a.txt": "a\n" });
    await git(root, "checkout", "--quiet", "-b", "guard/docs");
    const guard = await commitFiles({ "guard.md": "guard\n" });
    await git(root, "checkout", "--quiet", "-b", "skills-sample", base);
    const skills = await commitFiles({ "skills.md": "skills\n" });

    const result = await captured();

    expect(result.gitCommit).toBe(skills);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        { name: "main", commit: base },
        { name: "guard/docs", commit: guard },
        { name: "skills-sample", commit: skills },
      ]),
    );
    expect(result.sources).toHaveLength(3);
    const refs = headerOf(result)?.refs ?? [];
    expect(refs).toContainEqual({
      name: `${CHECKPOINT_SOURCE_PREFIX}guard/docs`,
      oid: guard,
    });
    expect(refs).toContainEqual({
      name: `${CHECKPOINT_SOURCE_PREFIX}main`,
      oid: base,
    });
    expect(refs.map((ref) => ref.name)).not.toContain(
      `${CHECKPOINT_SOURCE_PREFIX}skills-sample`,
    );
  });

  test("keeps at most MAX_CHECKPOINT_SOURCES branches, the newest first, rather than refusing", async () => {
    await commitFiles({ "a.txt": "a\n" });
    for (let at = 0; at < MAX_CHECKPOINT_SOURCES + 3; at += 1) {
      await git(root, "branch", `extra-${at}`);
    }

    const result = await captured();

    expect(result.sources).toHaveLength(MAX_CHECKPOINT_SOURCES);
  });

  test("pins the caller's instructions commit, from objects kept outside the workspace", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    // A commit the workspace does not have, as after a restore whose engine
    // since pruned it: the restorer keeps it in a repository of its own.
    const kept = join(scratch, "kept");
    await mkdir(kept);
    await git(kept, "init", "--quiet");
    await writeFile(join(kept, "CLAUDE.md"), "rules\n");
    await git(kept, "add", "--all");
    await git(kept, "commit", "--quiet", "-m", "instructions");
    const pinned = (await git(kept, "rev-parse", "HEAD")).trim();
    const signal = new AbortController().signal;

    const result = await captureWorkspace({
      root,
      bundlePath: bundlePath(),
      signal,
      instructions: { commit: pinned, objects: join(kept, ".git", "objects") },
    });

    if (result.status !== "captured") throw new Error(result.reason);
    expect(headerOf(result.capture)?.refs).toEqual([
      { name: CHECKPOINT_HEAD_REF, oid: head },
      { name: CHECKPOINT_WORKTREE_REF, oid: head },
      { name: "refs/heads/main", oid: head },
      { name: CHECKPOINT_INSTRUCTIONS_REF, oid: pinned },
    ]);
    expect(
      await captureWorkspace({
        root,
        bundlePath: bundlePath(),
        signal,
        instructions: { commit: pinned },
      }),
    ).toEqual({
      status: "refused",
      reason: `the instructions commit ${pinned} is no longer in the repository`,
    });
  });

  test("never writes an object into the workspace repository", async () => {
    await commitFiles({ "a.txt": "a\n" });
    await writeFile(join(root, "a.txt"), "only on disk\n");
    const objects = async () =>
      (
        await readdir(join(root, ".git", "objects"), { recursive: true })
      ).sort();
    const before = await objects();

    await captured();

    expect(await objects()).toEqual(before);
  });

  describe("refuses a workspace it cannot represent exactly", () => {
    test("an unborn HEAD", async () => {
      expect(await capture()).toEqual({
        status: "refused",
        reason: "HEAD has no commit yet",
      });
    });

    test("a .git that is not a directory", async () => {
      await rm(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace .git is not a directory",
      });
    });

    test("a shallow clone", async () => {
      await commitFiles({ "a.txt": "1\n" });
      await commitFiles({ "a.txt": "2\n" });
      const shallow = join(scratch, "shallow");
      await git(
        scratch,
        "clone",
        "--quiet",
        "--depth=1",
        `file://${root}`,
        shallow,
      );
      root = shallow;
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace is a shallow clone",
      });
    });

    test("sparse checkout", async () => {
      await commitFiles({ "a.txt": "a\n", "src/b.txt": "b\n" });
      await git(root, "sparse-checkout", "set", "src");
      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/sparse checkout|skip-worktree/),
      });
    });

    test("a split index", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--split-index");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace uses a split index",
      });
    });

    test("an entry marked assume-unchanged", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--assume-unchanged", "a.txt");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt is marked assume-unchanged",
      });
    });

    test("an entry marked skip-worktree", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--skip-worktree", "a.txt");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt is marked skip-worktree",
      });
    });

    test("a tracked submodule", async () => {
      await commitFiles({ "a.txt": "a\n" });
      const head = (await git(root, "rev-parse", "HEAD")).trim();
      await git(
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},vendor/lib`,
      );
      expect(await capture()).toEqual({
        status: "refused",
        reason: "vendor/lib is a submodule",
      });
    });

    test("unresolved merge conflicts", async () => {
      await commitFiles({ "a.txt": "base\n" });
      await git(root, "checkout", "--quiet", "-b", "other");
      await commitFiles({ "a.txt": "other\n" });
      await git(root, "checkout", "--quiet", "main");
      await commitFiles({ "a.txt": "main\n" });
      await git(root, "merge", "--quiet", "other").catch(() => undefined);
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt has unresolved merge conflicts",
      });
    });

    test("an end-of-line conversion that would not come back byte for byte", async () => {
      await commitFiles({ ".gitattributes": "*.txt text eol=crlf\n" });
      await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
      await commitFiles({ "a.txt": "one\r\n" });
      await writeFile(join(root, "a.txt"), "one\r\ntwo\n");
      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/cannot be staged/),
      });
    });

    test("an untracked nested repository", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await mkdir(join(root, "vendor/lib"), { recursive: true });
      await git(join(root, "vendor/lib"), "init", "--quiet");
      await writeFile(join(root, "vendor/lib/x"), "x\n");
      await git(join(root, "vendor/lib"), "add", "x");
      await git(join(root, "vendor/lib"), "commit", "--quiet", "-m", "x");
      expect(await capture()).toEqual({
        status: "refused",
        reason:
          "untracked vendor/lib/ is a nested repository, which a checkpoint cannot carry",
      });
    });

    test("more untracked files than a checkpoint carries", async () => {
      await commitFiles({ "a.txt": "a\n" });
      for (const name of ["x", "y", "z"]) {
        await writeFile(join(root, name), name);
      }
      expect(await capture({ limits: { maxUntrackedFiles: 2 } })).toEqual({
        status: "refused",
        reason: "3 untracked files, over the 2 a checkpoint carries",
      });
    });

    test("a bundle over the control plane's limit", async () => {
      await commitFiles({ "a.txt": "a\n" });
      expect(await capture({ limits: { maxBundleBytes: 10 } })).toMatchObject({
        status: "refused",
        reason:
          "the workspace bundle is over the 10 bytes the control plane verifies",
      });
    });

    // Linux keeps a name's bytes as they are; macOS refuses a name that is
    // not UTF-8 before git ever sees it.
    test.skipIf(process.platform !== "linux")(
      "an untracked name that is not UTF-8, even beside the ignored file a lossy decode would name",
      async () => {
        await commitFiles({ ".gitignore": "bad\ufffd\n", "a.txt": "a\n" });
        const raw = Buffer.concat([
          Buffer.from(join(root, "bad")),
          Buffer.from([0xff]),
        ]);
        await writeFile(raw, "untracked\n");
        await writeFile(join(root, "bad\ufffd"), "ignored secret\n");

        expect(await capture()).toEqual({
          status: "refused",
          reason: "an untracked file's name is not valid UTF-8",
        });
      },
    );

    test("a tracked name that is not UTF-8, before its size is measured", async () => {
      if (process.platform !== "linux") return;
      await commitFiles({ "a.txt": "a\n" });
      const raw = Buffer.concat([
        Buffer.from(join(root, "bad")),
        Buffer.from([0xff]),
      ]);
      await writeFile(raw, "tracked\n");
      await git(root, "add", "--all");
      await git(root, "commit", "--quiet", "-m", "raw name");
      await writeFile(raw, "x".repeat(100));

      expect(await capture()).toEqual({
        status: "refused",
        reason: "a tracked file's name is not valid UTF-8",
      });
    });

    test("line endings the checkout's own config wrote, which a restore would not", async () => {
      await commitFiles({ ".gitattributes": "*.txt text\n", "a.txt": "a\n" });
      await git(root, "config", "core.eol", "crlf");
      await rm(join(root, "a.txt"));
      await git(root, "checkout", "--", "a.txt");
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\r\n");
      // Older than the index, so git trusts its stat data instead of
      // re-reading a file it would call racily clean.
      const past = new Date(Date.now() - 3_600_000);
      await utimes(join(root, "a.txt"), past, past);
      await git(root, "update-index", "--refresh");

      expect(await capture()).toEqual({
        status: "refused",
        reason:
          "a.txt has crlf line endings on disk, and a restore would write lf",
      });
      // A `.gitattributes` edited since the files were written, the other way.
      await git(root, "config", "--unset", "core.eol");
      await rm(join(root, "a.txt"));
      await git(root, "checkout", "--", "a.txt");
      await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
      // Refused by safecrlf while staging or by the check after it, depending
      // on whether git re-reads the file.
      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(
          /(LF would be replaced by CRLF in|has lf line endings on disk).*a\.txt|a\.txt has lf/,
        ),
      });
    });

    test("a missing index, rather than staging into an empty one", async () => {
      await commitFiles({ ".gitignore": "build/\n" });
      await mkdir(join(root, "build"));
      await writeFile(join(root, "build", "tracked.txt"), "tracked\n");
      await git(root, "add", "--force", "build/tracked.txt");
      await git(root, "commit", "--quiet", "-m", "ignored but tracked");
      await rm(join(root, ".git", "index"));

      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace has no index",
      });
    });

    test("a changed file whose $Id$ a restore would rewrite", async () => {
      await commitFiles({ ".gitattributes": "*.txt ident\n" });
      await writeFile(join(root, "a.txt"), "$Id$\nline\n");
      await git(root, "add", "a.txt");
      await git(root, "commit", "--quiet", "-m", "ident");
      await rm(join(root, "a.txt"));
      await git(root, "checkout", "--", "a.txt");
      const expanded = await readFile(join(root, "a.txt"), "utf8");
      expect(expanded).toMatch(/^\$Id: [0-9a-f]{40} \$/);
      await writeFile(join(root, "a.txt"), `${expanded}more\n`);

      expect(await capture()).toEqual({
        status: "refused",
        reason:
          "a.txt has the ident attribute and changed, and a restore would rewrite its $Id$",
      });
    });

    test("an index over the limit, before any git command reads it", async () => {
      await commitFiles({ "a.txt": "a\n" });
      const restoreGit = await fakeGit(`
for arg; do
  if [ "$arg" = rev-parse ]; then
    exec "$REAL_GIT" "$@"
  fi
done
exit 91`);
      try {
        expect(await capture({ limits: { maxIndexBytes: 10 } })).toMatchObject({
          status: "refused",
          reason: expect.stringMatching(
            /^the workspace index is \d+ bytes, over the 10 a checkpoint reads$/,
          ),
        });
      } finally {
        restoreGit();
      }
    });

    test("tracked changes over the staging limit, before they are written as objects", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "a.txt"), "x".repeat(100));

      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
      // An unchanged checkout stages nothing, whatever the limit.
      await writeFile(join(root, "a.txt"), "a\n");
      expect((await capture({ limits: { maxStagedBytes: 0 } })).status).toBe(
        "captured",
      );
      // Measured under the name git listed, BOM and all.
      await commitFiles({ "\ufefflarge.bin": "small\n" });
      await writeFile(join(root, "\ufefflarge.bin"), "x".repeat(100));
      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
    });

    test("unchanged files a changed .gitattributes would renormalize, before they are written", async () => {
      await commitFiles({ "big.txt": "y".repeat(100) });
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "sub", ".gitattributes"), "*.txt text\n");

      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
    });

    test("a file rewritten to its old size and mtime, whatever stat checks the checkout asked for", async () => {
      const past = new Date("2020-01-01T00:00:00Z");
      await writeFile(join(root, "big.txt"), "y".repeat(100));
      await utimes(join(root, "big.txt"), past, past);
      await commitFiles({});
      await git(root, "config", "core.checkStat", "minimal");
      await git(root, "config", "core.trustctime", "false");
      // Past the second the index recorded, which is all the ctime git keeps.
      await Bun.sleep(1_100);
      await writeFile(join(root, "big.txt"), "z".repeat(100));
      await utimes(join(root, "big.txt"), past, past);

      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
    });

    test("a tracked link whose new target is over the limit", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await symlink("a.txt", join(root, "link"));
      await commitFiles({});
      await rm(join(root, "link"));
      await symlink("t".repeat(100), join(root, "link"));

      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
    });

    test("a tracked file over the size a restore writes, changed or not", async () => {
      await commitFiles({ "a.txt": "a\n", "big.bin": "y".repeat(100) });

      expect(await capture({ limits: { maxFileBytes: 50 } })).toEqual({
        status: "refused",
        reason: "big.bin is 100 bytes, over the 50 a checkpoint restores",
      });
      expect((await capture({ limits: { maxFileBytes: 100 } })).status).toBe(
        "captured",
      );
    });

    test("a git that runs out of its resource limits, as a refusal", async () => {
      await commitFiles({ "a.txt": "a\n" });
      let restorePath = await fakeGit(killedOn("write-tree"));
      try {
        expect(await capture()).toEqual({
          status: "refused",
          reason: "git ran out of its resource limits: SIGXFSZ",
        });
      } finally {
        restorePath();
      }
      // The bundle is the only file `bundle create` writes, and its file
      // size limit is the bundle's.
      restorePath = await fakeGit(killedOn("bundle"));
      try {
        expect(await capture()).toEqual({
          status: "refused",
          reason: `the workspace bundle is over the ${DEFAULT_WORKSPACE_CAPTURE_LIMITS.maxBundleBytes} bytes the control plane verifies`,
        });
      } finally {
        restorePath();
      }
      // Every git in the capture goes through the stand-in's shell.
    }, 30_000);

    test("an untracked file it cannot read without following paths", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "notes.md"), "n\n");
      const result = await captureWorkspace({
        root,
        bundlePath: bundlePath(),
        signal: new AbortController().signal,
        fdDirectory: join(scratch, "no-procfs"),
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/cannot be read safely/),
      });
    });
  });

  // Untracked files are read by descriptor, which needs procfs.
  describe.skipIf(!procfs)("untracked files", () => {
    test("captures untracked files but not ignored ones", async () => {
      await commitFiles({ ".gitignore": "build/\n", "a.txt": "a\n" });
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(join(root, "notes/todo.md"), "todo\n");
      await writeFile(join(root, "z.txt"), "z\n");
      await mkdir(join(root, "build"));
      await writeFile(join(root, "build/out.js"), "ignored\n");

      const result = await captured();

      expect(
        result.untracked.map(({ bytes, path }) => [
          path,
          new TextDecoder().decode(bytes),
        ]),
      ).toEqual([
        ["notes/todo.md", "todo\n"],
        ["z.txt", "z\n"],
      ]);
    });

    test("keeps a leading U+FEFF in a name instead of reading the ignored file it would alias", async () => {
      await commitFiles({ ".gitignore": "secrets.txt\n", "a.txt": "a\n" });
      await writeFile(join(root, "secrets.txt"), "ignored secret\n");
      await writeFile(join(root, "\ufeffsecrets.txt"), "untracked\n");

      const result = await captured();

      expect(
        result.untracked.map(({ bytes, path }) => [
          path,
          new TextDecoder().decode(bytes),
        ]),
      ).toEqual([["\ufeffsecrets.txt", "untracked\n"]]);
    });

    test("keeps whether an untracked file is executable", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(root, "data"), "x\n", { mode: 0o644 });

      const result = await captured();

      expect(
        result.untracked.map(({ executable, path }) => [path, executable]),
      ).toEqual([
        ["data", false],
        ["tool", true],
      ]);
    });

    test("refuses an untracked symlink rather than reading what it points at", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(scratch, "worker-secret"), "secret\n");
      await symlink(join(scratch, "worker-secret"), join(root, "planted"));

      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/"planted" is not a regular file/),
      });
    });

    test("refuses untracked files over the byte budget", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "x"), "12345");
      await writeFile(join(root, "y"), "12345");

      expect(await capture({ limits: { maxUntrackedBytes: 8 } })).toEqual({
        status: "refused",
        reason: 'untracked file "y" is 5 bytes, over the 3 left',
      });
    });
  });
});

describe("runGitBytes", () => {
  test("kills git once it writes past the limit instead of buffering it all", async () => {
    await commitFiles({ "big.bin": "x".repeat(4 * 1024 * 1024) });
    const blob = (await git(root, "rev-parse", "HEAD:big.bin")).trim();

    const reading = runGitBytes(["cat-file", "blob", blob], {
      cwd: root,
      maxStdoutBytes: 64 * 1024,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal: new AbortController().signal,
    });

    await expect(reading).rejects.toBeInstanceOf(GitOutputLimitError);
  });

  test("hands back the exact bytes git wrote under the limit", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const blob = (await git(root, "rev-parse", "HEAD:a.txt")).trim();

    const result = await runGitBytes(["cat-file", "blob", blob], {
      cwd: root,
      maxStdoutBytes: 2,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal: new AbortController().signal,
    });

    expect(result.code).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("a\n");
  });

  test("stops reading once git has exited, even with a helper still holding its pipes", async () => {
    // A git that leaves a child behind on its stdout and stderr, the way
    // `bundle create` would leave `pack-objects` if it exited first.
    const pidFile = join(scratch, "helper.pid");
    const restorePath = await fakeGit(
      `sleep 6 &\necho $! > ${pidFile}\nexit 3`,
    );
    try {
      const began = performance.now();
      const result = await runGitBytes(["status"], options());

      expect(result.code).toBe(3);
      expect(performance.now() - began).toBeLessThan(5_000);
      // Not signalled: once git has been reaped its group may be anyone's.
      const helper = Number((await readFile(pidFile, "utf8")).trim());
      expect(await running(helper)).toBe(true);
      process.kill(helper, "SIGKILL");
    } finally {
      restorePath();
    }
  }, 10_000);

  describe("kills git's whole process group, helpers included", () => {
    // A git whose helper would outlive it if only git were killed.
    const pidFile = () => join(scratch, "helper.pid");
    const withHelper = (then: string) =>
      fakeGit(`sleep 30 &\necho $! > ${pidFile()}\n${then}`);
    const helper = async () =>
      Number((await readFile(pidFile(), "utf8")).trim());
    // A fresh script can take a while to start the first time (macOS scans
    // it), so the tests wait for the helper rather than guess.
    const helperStarted = async () => {
      while (!existsSync(pidFile())) await Bun.sleep(20);
    };

    test("past its deadline", async () => {
      const restorePath = await withHelper("wait");
      try {
        const began = performance.now();
        const result = await runGitBytes(
          ["status"],
          options({ deadlineMs: 2_000 }),
        );

        expect(result.code).toBe(137);
        expect(result.stderr).toEndWith("git ran past its 2000ms deadline");
        expect(performance.now() - began).toBeLessThan(6_000);
        await Bun.sleep(100);
        expect(await running(await helper())).toBe(false);
      } finally {
        restorePath();
      }
    }, 10_000);

    test("once the signal aborts", async () => {
      const restorePath = await withHelper("wait");
      try {
        const controller = new AbortController();
        const running_ = runGitBytes(
          ["status"],
          options({ signal: controller.signal }),
        );
        await helperStarted();
        controller.abort();

        await expect(running_).rejects.toThrow();
        await Bun.sleep(100);
        expect(await running(await helper())).toBe(false);
      } finally {
        restorePath();
      }
    }, 10_000);

    test("once stdout runs past the limit", async () => {
      const restorePath = await withHelper("head -c 1048576 /dev/zero\nwait");
      try {
        await expect(
          runGitBytes(["status"], options({ maxStdoutBytes: 1024 })),
        ).rejects.toBeInstanceOf(GitOutputLimitError);
        await Bun.sleep(100);
        expect(await running(await helper())).toBe(false);
      } finally {
        restorePath();
      }
    }, 10_000);
  });

  describe("under resource limits", () => {
    test("a git that says it ran out of memory throws, and only with limits", async () => {
      const restorePath = await fakeGit(
        'echo "fatal: Out of memory, malloc failed (tried to allocate 1 bytes)" >&2\nexit 128',
      );
      try {
        const unlimited = await runGitBytes(["status"], options());
        expect(unlimited.code).toBe(128);
        await expect(
          runGitBytes(["status"], options({ limits: roomy })),
        ).rejects.toThrow(
          new GitResourceLimitError(
            "fatal: Out of memory, malloc failed (tried to allocate 1 bytes)",
          ),
        );
      } finally {
        restorePath();
      }
    });

    test("reads git's verdict from the end of stderr, however much came before it", async () => {
      const restorePath = await fakeGit(
        `head -c ${256 * 1024} /dev/zero | tr '\\0' 'w' | fold -w 99 >&2\necho >&2\necho "error: pack-objects died of signal 9" >&2\nexit 128`,
      );
      try {
        await expect(
          runGitBytes(["status"], options({ limits: roomy })),
        ).rejects.toThrow(
          new GitResourceLimitError("error: pack-objects died of signal 9"),
        );
        // What is kept starts on a whole line.
        const result = await runGitBytes(["status"], options());
        expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
        expect(result.stderr).toMatch(/^w{99}\n/);
      } finally {
        restorePath();
      }
    });

    test("keeps no part of a line that was cut, and every line that was not", async () => {
      // One line longer than what is kept: a cut inside it could land inside
      // a credential, so none of it is kept.
      let restorePath = await fakeGit(
        `printf 'https://user:secret@example.test/' >&2\nhead -c ${96 * 1024} /dev/zero | tr '\\0' 'w' >&2\nexit 1`,
      );
      try {
        expect((await runGitBytes(["status"], options())).stderr).toBe("");
      } finally {
        restorePath();
      }
      // 64-byte lines: the last 64 KiB starts exactly on one, which is kept.
      restorePath = await fakeGit(
        `head -c ${126 * 1024} /dev/zero | tr '\\0' 'w' | fold -w 63 >&2\necho >&2\nexit 1`,
      );
      try {
        const { stderr } = await runGitBytes(["status"], options());
        expect(stderr).toHaveLength(64 * 1024);
        expect(stderr).toMatch(/^w{63}\n/);
      } finally {
        restorePath();
      }
    });

    test("past its deadline, as a limit rather than an exit code", async () => {
      const restorePath = await fakeGit("sleep 30");
      try {
        await expect(
          runGitBytes(
            ["status"],
            options({ deadlineMs: 2_000, limits: roomy }),
          ),
        ).rejects.toThrow(
          new GitResourceLimitError("git ran past its 2000ms deadline"),
        );
      } finally {
        restorePath();
      }
    }, 10_000);

    test("an ordinary failure is still an exit code", async () => {
      const restorePath = await fakeGit(
        'echo "fatal: not a git repository" >&2\nexit 128',
      );
      try {
        const result = await runGitBytes(
          ["status"],
          options({ limits: roomy }),
        );
        expect(result.code).toBe(128);
      } finally {
        restorePath();
      }
    });

    test.skipIf(!linux)("a file past fileSizeBytes throws", async () => {
      const out = join(scratch, "written");
      const restorePath = await fakeGit(
        `exec head -c ${4 * 1024 * 1024} /dev/zero > ${out}`,
      );
      try {
        await expect(
          runGitBytes(
            ["status"],
            options({ limits: { ...roomy, fileSizeBytes: 1024 * 1024 } }),
          ),
        ).rejects.toThrow(new GitResourceLimitError("SIGXFSZ"));
      } finally {
        restorePath();
      }
    });

    test.skipIf(!linux)(
      "a git past cpuSeconds throws",
      async () => {
        const restorePath = await fakeGit("exec sh -c 'while :; do :; done'");
        try {
          await expect(
            runGitBytes(
              ["status"],
              options({ limits: { ...roomy, cpuSeconds: 1 } }),
            ),
          ).rejects.toBeInstanceOf(GitResourceLimitError);
        } finally {
          restorePath();
        }
      },
      30_000,
    );

    test.skipIf(!linux)(
      "a real git past memoryBytes throws",
      async () => {
        await writeFile(
          join(root, "big.bin"),
          new Uint8Array(256 * 1024 * 1024),
        );

        await expect(
          runGitBytes(
            ["hash-object", "big.bin"],
            options({ limits: { ...roomy, memoryBytes: 128 * 1024 * 1024 } }),
          ),
        ).rejects.toBeInstanceOf(GitResourceLimitError);
      },
      30_000,
    );
  });
});

/** Roomy enough that only the one limit a test tightens can bite. */
const roomy = {
  cpuSeconds: 60,
  fileSizeBytes: 64 * 1024 * 1024,
  memoryBytes: 512 * 1024 * 1024,
};

function options(
  overrides: Partial<GitRunOptions & { maxStdoutBytes: number }> = {},
): GitRunOptions & { maxStdoutBytes?: number } {
  return {
    cwd: root,
    network: null,
    overrides: [],
    redact: (text) => text,
    signal: new AbortController().signal,
    ...overrides,
  };
}
