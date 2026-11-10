import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDescriptor } from "@werft-ai/contracts";

import { RESTORED_CHECKPOINT_DIRECTORY } from "./checkpoint-restore.ts";
import {
  AttachLimitError,
  COMMITTED_INSTRUCTIONS_MAX_BYTES,
  GitWorkspace,
} from "./workspace.ts";

let scratch: string;
let origin: string;
let root: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function descriptor(url = origin, branch = "main"): WorkspaceDescriptor {
  return { repository: { id: "sample-app", url, branch } };
}

function prepare(workspace: WorkspaceDescriptor, signal?: AbortSignal) {
  return new GitWorkspace(root, ["AGENTS.md", "CLAUDE.md"]).prepare({
    descriptor: workspace,
    restore: null,
    signal: signal ?? new AbortController().signal,
  });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-122-ws-"));
  origin = join(scratch, "origin.git");
  root = join(scratch, "workspace");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], scratch);
  const seed = join(scratch, "seed");
  git(["clone", "--quiet", origin, seed], scratch);
  await writeFile(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:main"], seed);
  await mkdir(root);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

/**
 * Git's dumb HTTP protocol is plain files, so a static server behind Basic
 * auth is enough to make a credential load-bearing.
 */
function serveOrigin(expected: string | null, onRequest?: () => void) {
  git(["update-server-info"], origin);
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      onRequest?.();
      const auth = request.headers.get("authorization");
      seen.push(auth ?? "anonymous");
      if (expected !== null && auth !== expected) {
        return new Response("who?", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        });
      }
      const path = new URL(request.url).pathname.replace(/^\/repo\.git/, "");
      const file = Bun.file(join(origin, path));
      return (await file.exists())
        ? new Response(file)
        : new Response("missing", { status: 404 });
    },
  });
  return { seen, server };
}

describe("GitWorkspace", () => {
  test("clones the session's branch into an empty mount", async () => {
    expect(await prepare(descriptor())).toBe("clone");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], root)).toBe("main");
    expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
  });

  test("reuses a sound checkout of the same origin and keeps its work", async () => {
    await prepare(descriptor());
    await writeFile(join(root, "notes.txt"), "left by the last attempt\n");

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe(
      "left by the last attempt\n",
    );
  });

  test("starts over from this session's shallow checkout when it holds nothing", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);

    expect(await prepare(descriptor(`file://${origin}`))).toBe("recreate");
    expect(git(["rev-parse", "--is-shallow-repository"], root)).toBe("false");
  });

  test("refuses to delete an unsound checkout that holds work", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    await writeFile(join(root, "draft.txt"), "only here\n");

    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow(
      "holds work that exists nowhere else",
    );
    expect(await Bun.file(join(root, "draft.txt")).text()).toBe("only here\n");
  });

  test("refuses files that are not a checkout, and leaves them alone", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    await expect(prepare(descriptor())).rejects.toThrow("not a git checkout");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("refuses a checkout of another repository", async () => {
    await prepare(descriptor());

    await expect(
      prepare(descriptor("https://git.example.test/other.git")),
    ).rejects.toThrow("another repository");
  });

  test("leaves a committed checkpoint to the restorer", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    expect(
      await new GitWorkspace(root, ["AGENTS.md", "CLAUDE.md"]).prepare({
        descriptor: descriptor(),
        restore: {
          revision: 3,
          manifest_ref: "sessions/x/manifest-3.json",
          manifest_sha256: "a".repeat(64),
        },
        signal: new AbortController().signal,
      }),
    ).toBe("restore");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("clones with the URL's credential but never stores it where the engine can read it", async () => {
    const { seen, server } = serveOrigin(
      `Basic ${btoa("someone:s3cr3t/pass")}`,
    );
    try {
      const url = `http://someone:s3cr3t%2Fpass@127.0.0.1:${server.port}/repo.git`;

      expect(await prepare(descriptor(url))).toBe("clone");
      expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
      const stored = await Bun.file(join(root, ".git", "config")).text();
      expect(stored).not.toContain("s3cr3t");
      expect(stored).not.toContain("someone");
      expect(git(["config", "--get", "remote.origin.url"], root)).toBe(
        `http://127.0.0.1:${server.port}/repo.git`,
      );
      expect(seen).toContain(`Basic ${btoa("someone:s3cr3t/pass")}`);

      // A later attempt reuses it, fetching with the same credential.
      expect(await prepare(descriptor(url))).toBe("reuse");
    } finally {
      server.stop(true);
    }
  });

  test("runs none of the hooks a previous engine planted in a reused checkout", async () => {
    await prepare(descriptor());
    const marker = join(scratch, "hook-ran");
    const hooks = join(scratch, "planted-hooks");
    await mkdir(hooks);
    for (const dir of [hooks, join(root, ".git", "hooks")]) {
      const hook = join(dir, "post-checkout");
      await writeFile(hook, `#!/bin/sh\nenv > "${marker}"\n`);
      await chmod(hook, 0o755);
    }
    git(["config", "core.hooksPath", hooks], root);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("fetches a reuse past whatever the checkout's config rewrites origin to", async () => {
    const real = serveOrigin(`Basic ${btoa("someone:s3cr3t")}`);
    const lure = serveOrigin(null);
    try {
      const url = `http://someone:s3cr3t@127.0.0.1:${real.server.port}/repo.git`;
      await prepare(descriptor(url));
      // What a previous engine could leave behind: every fetch of the real
      // origin quietly goes to another host.
      git(
        [
          "config",
          `url.http://127.0.0.1:${lure.server.port}/.insteadOf`,
          `http://127.0.0.1:${real.server.port}/`,
        ],
        root,
      );

      expect(await prepare(descriptor(url))).toBe("reuse");
      expect(lure.seen).toEqual([]);
    } finally {
      real.server.stop(true);
      lure.server.stop(true);
    }
  });

  test("runs no transport command the checkout's config names", async () => {
    const { server } = serveOrigin(`Basic ${btoa("someone:s3cr3t")}`);
    try {
      const url = `http://someone:s3cr3t@127.0.0.1:${server.port}/repo.git`;
      await prepare(descriptor(url));
      const marker = join(scratch, "transport-ran");
      const command = join(scratch, "steal");
      await writeFile(command, `#!/bin/sh\nenv > "${marker}"\nexit 1\n`);
      await chmod(command, 0o755);
      git(["config", "core.sshCommand", command], root);
      git(["config", "core.askPass", command], root);
      git(
        [
          "config",
          "url.ssh://git@127.0.0.1/repo.git.insteadOf",
          `http://127.0.0.1:${server.port}/repo.git`,
        ],
        root,
      );

      expect(await prepare(descriptor(url))).toBe("reuse");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("runs no filter driver the checkout's config defines", async () => {
    await prepare(descriptor());
    const marker = join(scratch, "filter-ran");
    const filter = join(scratch, "wedge");
    await writeFile(filter, `#!/bin/sh\ntouch "${marker}"\nsleep 30\n`);
    await chmod(filter, 0o755);
    git(["config", "filter.wedge.clean", filter], root);
    git(["config", "filter.wedge.smudge", filter], root);
    git(["config", "filter.wedge.required", "true"], root);
    await writeFile(
      join(root, ".git", "info", "attributes"),
      "* filter=wedge\n",
    );
    // Dirty to git's stat check, so status has to look at the content.
    await writeFile(join(root, "README.md"), "seed\n");
    const touched = new Date(Date.now() + 5_000);
    await utimes(join(root, "README.md"), touched, touched);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 20_000);

  test("keeps an unsound checkout whose only work is an ignored file", async () => {
    await prepare(descriptor());
    await writeFile(join(root, ".gitignore"), ".env\n");
    git(["add", ".gitignore"], root);
    git(["commit", "--quiet", "-m", "ignore"], root);
    git(["push", "--quiet", "origin", "HEAD:main"], root);
    await writeFile(join(root, ".env"), "only copy\n");
    await writeFile(
      join(root, ".git", "shallow"),
      `${git(["rev-parse", "HEAD"], root)}\n`,
    );

    await expect(prepare(descriptor())).rejects.toThrow("refused");
    expect(await Bun.file(join(root, ".env")).text()).toBe("only copy\n");
  });

  test("keeps an unsound checkout whose only work is a detached commit", async () => {
    await prepare(descriptor());
    git(["checkout", "--quiet", "--detach"], root);
    await writeFile(join(root, "WORK.md"), "only here\n");
    git(["add", "WORK.md"], root);
    git(["commit", "--quiet", "-m", "detached"], root);
    await writeFile(
      join(root, ".git", "shallow"),
      `${git(["rev-parse", "HEAD~1"], root)}\n`,
    );

    await expect(prepare(descriptor())).rejects.toThrow("refused");
    expect(await Bun.file(join(root, "WORK.md")).text()).toBe("only here\n");
  });

  test("fetches a reuse through a mirror inside.git that git status never shows and nothing outlives", async () => {
    const gitDirectory = join(root, ".git");
    const worker = (names: string[]) =>
      names.filter((name) => name.startsWith("werft-"));
    let watching = false;
    const during: Array<{ scratch: string[]; status: string }> = [];
    const { server } = serveOrigin(null, () => {
      if (!watching) return;
      during.push({
        scratch: worker(readdirSync(gitDirectory)),
        status: git(["status", "--porcelain", "--untracked-files=all"], root),
      });
    });
    try {
      const url = `http://127.0.0.1:${server.port}/repo.git`;
      await prepare(descriptor(url));
      watching = true;

      expect(await prepare(descriptor(url))).toBe("reuse");
      // Every request is the mirror's clone: a reuse reaches origin only
      // through it.
      expect(during.length).toBeGreaterThan(0);
      for (const seen of during) {
        expect(seen.scratch).toEqual([expect.stringMatching(/^werft-fetch-/)]);
        expect(seen.status).toBe("");
      }
      expect(worker(await readdir(gitDirectory))).toEqual([]);
      expect(
        git(["status", "--porcelain", "--untracked-files=all"], root),
      ).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("a reuse clears the scratch a killed worker left in.git and keeps the restored checkpoint", async () => {
    await prepare(descriptor());
    const gitDirectory = join(root, ".git");
    const mirror = join(gitDirectory, "werft-fetch-Ab3xYz", "o.git");
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, "pack"), "left by a killed worker\n");
    await mkdir(join(gitDirectory, "werft-capture-q1W2e3"));
    await mkdir(join(gitDirectory, RESTORED_CHECKPOINT_DIRECTORY));

    expect(await prepare(descriptor())).toBe("reuse");
    expect(
      (await readdir(gitDirectory)).filter((name) => name.startsWith("werft-")),
    ).toEqual([RESTORED_CHECKPOINT_DIRECTORY]);
  });

  test("a reuse that runs out of space for its mirror fails with the work tree whole, and a pre-rename scratch still in .git", async () => {
    await prepare(descriptor());
    const gitDirectory = join(root, ".git");
    await writeFile(join(root, "README.md"), "edited by the last attempt\n");
    await writeFile(join(root, "notes.txt"), "only here\n");
    // The old name is no longer swept, so it keeps counting against the
    // quota: the cost of renaming the prefix, accepted rather than migrated.
    const legacy = join(gitDirectory, "agent-platform-fetch-Ab3xYz");
    await mkdir(legacy);
    await writeFile(join(legacy, "pack"), "left by an older worker\n");
    await mkdir(join(gitDirectory, "werft-fetch-q1W2e3"));
    const before = git(["status", "--porcelain"], root);

    // A git that cannot write the mirror, as on a full volume.
    const bin = join(scratch, "bin");
    await mkdir(bin);
    const real = Bun.which("git");
    expect(real).not.toBeNull();
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = "--bare" ]; then',
        '    echo "fatal: write error: No space left on device" >&2',
        "    exit 128",
        "  fi",
        "done",
        `exec "${real}" "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(prepare(descriptor())).rejects.toThrow(
        "No space left on device",
      );
    } finally {
      process.env.PATH = path;
    }

    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("only here\n");
    expect(await Bun.file(join(root, "README.md")).text()).toBe(
      "edited by the last attempt\n",
    );
    expect(git(["status", "--porcelain"], root)).toBe(before);
    expect(await readdir(gitDirectory)).toContain(
      "agent-platform-fetch-Ab3xYz",
    );
    expect(await readdir(gitDirectory)).not.toContain("werft-fetch-q1W2e3");
    expect(
      (await readdir(gitDirectory)).filter((name) =>
        name.startsWith("werft-fetch-"),
      ),
    ).toEqual([]);
  });

  test.each(["alternates", "a linked object store"])(
    "keeps worker-named scratch in a checkout that borrows objects through %s, which may be from it",
    async (how) => {
      await prepare(descriptor());
      const gitDirectory = join(root, ".git");
      const lender = join(gitDirectory, "werft-capture-q1W2e3");
      await mkdir(lender);
      if (how === "alternates") {
        await mkdir(join(lender, "objects"));
        await writeFile(
          join(gitDirectory, "objects", "info", "alternates"),
          `${join(lender, "objects")}\n`,
        );
      } else {
        // Every object the checkout has now lives in the scratch.
        await rename(join(gitDirectory, "objects"), join(lender, "objects"));
        await symlink(join(lender, "objects"), join(gitDirectory, "objects"));
      }

      expect(await prepare(descriptor())).toBe("reuse");
      expect(await readdir(lender)).toEqual(["objects"]);
    },
  );

  test("refuses a reuse whose.git is not a directory of its own rather than put the mirror elsewhere", async () => {
    await prepare(descriptor());
    const elsewhere = join(scratch, "elsewhere.git");
    await rename(join(root, ".git"), elsewhere);
    await symlink(elsewhere, join(root, ".git"));
    // Still the same origin to the planner, but not what a reuse writes.
    git(["config", "remote.origin.url", `${origin}/`], root);

    await expect(prepare(descriptor())).rejects.toThrow(
      ".git is not a directory",
    );
    expect(git(["config", "remote.origin.url"], root)).toBe(`${origin}/`);
    expect(
      (await readdir(elsewhere)).filter((name) => name.startsWith("werft-")),
    ).toEqual([]);
  });

  test("attaches another repository's branch as a remote and skips one that cannot be fetched", async () => {
    await prepare(descriptor());
    const docs = join(scratch, "docs.git");
    git(["init", "--quiet", "--bare", "--initial-branch=trunk", docs], scratch);
    const seed = join(scratch, "docs-seed");
    git(["clone", "--quiet", docs, seed], scratch);
    await writeFile(join(seed, "DOCS.md"), "docs\n");
    git(["add", "DOCS.md"], seed);
    git(["commit", "--quiet", "-m", "docs"], seed);
    git(["push", "--quiet", "origin", "HEAD:trunk"], seed);

    const result = await new GitWorkspace(root, [
      "AGENTS.md",
      "CLAUDE.md",
    ]).attachRepositories({
      descriptor: {
        ...descriptor(),
        additional_repositories: [
          { id: "docs", url: docs, branch: "trunk" },
          { id: "gone", url: join(scratch, "missing.git"), branch: "main" },
        ],
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ attached: ["docs"], failed: ["gone"] });
    expect(git(["rev-parse", "refs/remotes/docs/trunk"], root)).toBe(
      git(["rev-parse", "HEAD"], seed),
    );
    expect(git(["remote", "get-url", "docs"], root)).toBe(docs);
    expect(git(["status", "--porcelain"], root)).toBe("");
    expect(await readdir(join(root, ".git"))).not.toContain("attach");
  });

  describe("one repository attached mid-session", () => {
    async function docsRepository(bytes = 4) {
      const docs = join(scratch, "docs.git");
      git(
        ["init", "--quiet", "--bare", "--initial-branch=trunk", docs],
        scratch,
      );
      const seed = join(scratch, "docs-seed");
      git(["clone", "--quiet", docs, seed], scratch);
      await writeFile(join(seed, "DOCS.bin"), randomBytes(bytes));
      git(["add", "DOCS.bin"], seed);
      git(["commit", "--quiet", "-m", "docs"], seed);
      git(["push", "--quiet", "origin", "HEAD:trunk"], seed);
      return { docs, head: git(["rev-parse", "HEAD"], seed) };
    }

    test("answers the commit it fetched", async () => {
      await prepare(descriptor());
      const { docs, head } = await docsRepository();
      const commit = await new GitWorkspace(root, [
        "AGENTS.md",
        "CLAUDE.md",
      ]).attachRepository(
        { id: "docs", url: docs, branch: "trunk" },
        new AbortController().signal,
      );
      expect(commit).toBe(head);
      expect(git(["rev-parse", "refs/remotes/docs/trunk"], root)).toBe(head);
    });

    test("a fetch past the size limit fails as too large and leaves no remote", async () => {
      await prepare(descriptor());
      const { docs } = await docsRepository(256 * 1024);
      const workspace = new GitWorkspace(
        root,
        ["AGENTS.md", "CLAUDE.md"],
        null,
        {
          timeoutMs: 60_000,
          maxBytes: 64 * 1024,
        },
      );
      const failed = await workspace
        .attachRepository(
          { id: "docs", url: docs, branch: "trunk" },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(AttachLimitError);
      expect((failed as AttachLimitError).failure).toBe("fetch_too_large");
      expect(git(["remote"], root)).not.toContain("docs");
      expect(await readdir(join(root, ".git"))).not.toContain("attach");
    });

    test("a fetch past the time limit fails as timed out", async () => {
      await prepare(descriptor());
      const { docs } = await docsRepository();
      const workspace = new GitWorkspace(
        root,
        ["AGENTS.md", "CLAUDE.md"],
        null,
        {
          timeoutMs: 1,
          maxBytes: 1024 ** 3,
        },
      );
      const failed = await workspace
        .attachRepository(
          { id: "docs", url: docs, branch: "trunk" },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      expect((failed as AttachLimitError).failure).toBe("fetch_timeout");
      expect(git(["remote"], root)).not.toContain("docs");
    });
  });

  test("brings the origin's new commits into a reused checkout", async () => {
    await prepare(descriptor());
    const seed = join(scratch, "seed");
    await writeFile(join(seed, "NEXT.md"), "next\n");
    git(["add", "NEXT.md"], seed);
    git(["commit", "--quiet", "-m", "next"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(git(["rev-parse", "origin/main"], root)).toBe(
      git(["rev-parse", "HEAD"], seed),
    );
  });

  test("never puts the repository credential in a failure", async () => {
    // Nothing listens on the discard port, so the clone fails at once.
    const url = "http://someone:hunter2@127.0.0.1:9/private.git";

    const failure = await prepare(descriptor(url)).catch(
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("git clone failed");
    expect((failure as Error).message).not.toContain("hunter2");
  });

  test("stops at once when the worker is told to stop", async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(prepare(descriptor(), stop.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  test("a clone killed halfway is cloned again by the next attempt", async () => {
    const stop = new AbortController();
    const { server } = serveOrigin(null, () => stop.abort());
    try {
      const url = `http://127.0.0.1:${server.port}/repo.git`;
      await expect(prepare(descriptor(url), stop.signal)).rejects.toThrow();
      expect(await readdir(root)).not.toEqual([]);

      expect(await prepare(descriptor(url))).toBe("recreate");
      expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
      expect((await readdir(root)).sort()).toEqual([".git", "README.md"]);
    } finally {
      server.stop(true);
    }
  });

  test("a recreate killed in its clone is recreated by the next attempt", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    const stop = new AbortController();
    const { server } = serveOrigin(null, () => stop.abort());
    try {
      const url = `http://127.0.0.1:${server.port}/repo.git`;
      git(["remote", "set-url", "origin", url], root);
      await expect(prepare(descriptor(url), stop.signal)).rejects.toThrow();

      expect(await prepare(descriptor(url))).toBe("recreate");
      expect(git(["rev-parse", "--is-shallow-repository"], root)).toBe("false");
      expect((await readdir(root)).sort()).toEqual([".git", "README.md"]);
    } finally {
      server.stop(true);
    }
  });

  test("a directory in the tree named like the clone's staging marks nothing", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    for (const name of [".agent-platform-clone", "agent-platform-clone"]) {
      await mkdir(join(root, name));
    }
    await writeFile(join(root, "draft.txt"), "only here\n");

    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow(
      "holds work that exists nowhere else",
    );
    expect(await Bun.file(join(root, "draft.txt")).text()).toBe("only here\n");
  });

  test("clones a repository that tracks paths named like the clone's staging", async () => {
    const seed = join(scratch, "seed");
    for (const name of [".agent-platform-clone", "agent-platform-clone"]) {
      await mkdir(join(seed, name));
      await writeFile(join(seed, name, "file.txt"), `${name}\n`);
    }
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "names"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    expect(await prepare(descriptor())).toBe("clone");
    expect(
      await Bun.file(join(root, "agent-platform-clone", "file.txt")).text(),
    ).toBe("agent-platform-clone\n");
    expect(git(["status", "--porcelain"], root)).toBe("");
  });

  test("refuses a recreate whose .git is a link, and deletes nothing", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    const elsewhere = join(scratch, "elsewhere.git");
    await rename(join(root, ".git"), elsewhere);
    await symlink(elsewhere, join(root, ".git"));
    const before = readdirSync(elsewhere).sort();

    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow(
      "its .git is not a directory",
    );
    expect(readdirSync(elsewhere).sort()).toEqual(before);
    expect((await readdir(root)).sort()).toEqual([".git", "README.md"]);
  });

  test("clones over the empty .git a clone stopped before its staging left", async () => {
    await mkdir(join(root, ".git"));

    expect(await prepare(descriptor())).toBe("clone");
    expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
  });

  test("a recreate that failed while emptying the root is recreated by the next attempt", async () => {
    const seed = join(scratch, "seed");
    await mkdir(join(seed, "locked"));
    await writeFile(join(seed, "locked", "inner.txt"), "x\n");
    git(["add", "locked"], seed);
    git(["commit", "--quiet", "-m", "locked"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    // Unwritable, so emptying the root fails partway through.
    await chmod(join(root, "locked"), 0o500);
    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow();
    await chmod(join(root, "locked"), 0o700);

    expect(await prepare(descriptor(`file://${origin}`))).toBe("recreate");
    expect(git(["rev-parse", "--is-shallow-repository"], root)).toBe("false");
    expect((await readdir(root)).sort()).toEqual([
      ".git",
      "README.md",
      "locked",
    ]);
  });
});

describe("GitWorkspace without a repository", () => {
  const none: WorkspaceDescriptor = { repository: null };

  test("makes a local git with no origin and one empty commit by a fixed identity", async () => {
    await rm(root, { recursive: true });
    const workspace = new GitWorkspace(root, ["AGENTS.md", "CLAUDE.md"]);

    expect(
      await workspace.prepare({
        descriptor: none,
        restore: null,
        signal: new AbortController().signal,
      }),
    ).toBe("init");

    expect(git(["remote"], root)).toBe("");
    expect(git(["symbolic-ref", "--short", "HEAD"], root)).toBe("main");
    expect(git(["log", "--format=%an <%ae>|%cn <%ce>|%s"], root)).toBe(
      "Werft workspace <workspace@werft.invalid>|Werft workspace <workspace@werft.invalid>|Werft: empty workspace",
    );
    expect(git(["ls-tree", "-r", "HEAD"], root)).toBe("");
    expect(await Bun.file(join(root, ".git", "info", "exclude")).text()).toBe(
      "node_modules/\n.venv/\n__pycache__/\n.cache/\n",
    );
    // No template: no sample hooks or description for the engine to find.
    expect((await readdir(join(root, ".git"))).sort()).not.toContain("hooks");
    expect(workspace.committedInstructions()).toBeNull();
    expect(workspace.instructionsCommit()).toBeNull();
  });

  test("attaches a repository's branch as a remote to the local git", async () => {
    await rm(root, { recursive: true });
    await prepare(none);
    const docs = join(scratch, "docs.git");
    git(["init", "--quiet", "--bare", "--initial-branch=trunk", docs], scratch);
    const seed = join(scratch, "docs-seed");
    git(["clone", "--quiet", docs, seed], scratch);
    await writeFile(join(seed, "DOCS.md"), "docs\n");
    git(["add", "DOCS.md"], seed);
    git(["commit", "--quiet", "-m", "docs"], seed);
    git(["push", "--quiet", "origin", "HEAD:trunk"], seed);

    const result = await new GitWorkspace(root, [
      "AGENTS.md",
      "CLAUDE.md",
    ]).attachRepositories({
      descriptor: {
        ...none,
        additional_repositories: [{ id: "docs", url: docs, branch: "trunk" }],
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ attached: ["docs"], failed: [] });
    expect(git(["rev-parse", "refs/remotes/docs/trunk"], root)).toBe(
      git(["rev-parse", "HEAD"], seed),
    );
    expect(git(["remote"], root)).toBe("docs");
    expect(git(["symbolic-ref", "--short", "HEAD"], root)).toBe("main");
  });

  test("keeps the local git a previous attempt left, with its work, and fetches nothing", async () => {
    await prepare(none);
    const head = git(["rev-parse", "HEAD"], root);
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "report.md"), "draft\n");
    // A killed worker's scratch, which counts against the volume.
    await mkdir(join(root, ".git", "werft-capture-AbC123"));

    expect(await prepare(none)).toBe("keep");
    expect(git(["rev-parse", "HEAD"], root)).toBe(head);
    expect(await Bun.file(join(root, "out", "report.md")).text()).toBe(
      "draft\n",
    );
    expect(await readdir(join(root, ".git"))).not.toContain(
      "werft-capture-AbC123",
    );
  });

  test("leaves a committed checkpoint to the restorer, whatever the volume holds", async () => {
    git(["init", "--quiet", root], scratch);
    await writeFile(join(root, "stray.txt"), "?\n");

    expect(
      await new GitWorkspace(root, ["AGENTS.md", "CLAUDE.md"]).prepare({
        descriptor: none,
        restore: {
          revision: 0,
          manifest_ref: "sessions/x/manifest-0.json",
          manifest_sha256: "a".repeat(64),
        },
        signal: new AbortController().signal,
      }),
    ).toBe("restore");
    expect((await readdir(root)).sort()).toEqual([".git", "stray.txt"]);
  });

  test("refuses an init that never made its commit, and leaves it in place", async () => {
    git(["init", "--quiet", root], scratch);
    await writeFile(join(root, "notes.txt"), "only here\n");

    await expect(prepare(none)).rejects.toThrow(
      "local git has no commit: its init never finished",
    );
    expect((await readdir(root)).sort()).toEqual([".git", "notes.txt"]);
  });

  test("refuses a corrupt local git, a .git that is a file, an origin or stray files, and deletes none of them", async () => {
    await prepare(none);
    await writeFile(join(root, "a.txt"), "a\n");
    git(["add", "a.txt"], root);
    git(["commit", "--quiet", "-m", "a"], root);
    const tree = git(["rev-parse", "HEAD^{tree}"], root);
    await rm(join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    await expect(prepare(none)).rejects.toThrow(
      "local git is incomplete or corrupt and exists nowhere else",
    );
    expect(await Bun.file(join(root, "a.txt")).text()).toBe("a\n");

    await rm(root, { recursive: true });
    await prepare(none);
    git(["remote", "add", "origin", origin], root);
    await expect(prepare(none)).rejects.toThrow(
      "checkout has an origin, but the session has no repository",
    );

    await rm(root, { recursive: true });
    await mkdir(root);
    await writeFile(
      join(root, ".git"),
      `gitdir: ${join(scratch, "elsewhere")}\n`,
    );
    await expect(prepare(none)).rejects.toThrow();
    expect(await readdir(root)).toEqual([".git"]);

    await rm(root, { recursive: true });
    await mkdir(root);
    await writeFile(join(root, "stray.txt"), "?\n");
    await expect(prepare(none)).rejects.toThrow("not a git checkout");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });
});

describe("GitWorkspace.committedInstructions", () => {
  /** Commits to origin's main, as the repository's authors would. */
  async function publish(
    files: Record<string, string>,
    links: Record<string, string> = {},
  ): Promise<void> {
    const seed = join(scratch, "seed");
    git(["pull", "--quiet", "origin", "main"], seed);
    // Whatever stood at a path before — a directory, a link — is replaced.
    for (const [path, text] of Object.entries(files)) {
      await rm(join(seed, path), { force: true, recursive: true });
      await mkdir(join(seed, path, ".."), { recursive: true });
      await writeFile(join(seed, path), text);
    }
    for (const [path, target] of Object.entries(links)) {
      await rm(join(seed, path), { force: true, recursive: true });
      await symlink(target, join(seed, path));
    }
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "publish"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
  }

  async function prepared(): Promise<GitWorkspace> {
    const workspace = new GitWorkspace(root, ["AGENTS.md", "CLAUDE.md"]);
    await workspace.prepare({
      descriptor: descriptor(),
      restore: null,
      signal: new AbortController().signal,
    });
    return workspace;
  }

  test("reads the file the branch has committed, and none when it has none", async () => {
    expect((await prepared()).committedInstructions()).toBeNull();
    await rm(root, { force: true, recursive: true });
    await mkdir(root);
    await publish({ "CLAUDE.md": "Run bun test.\n" });

    expect((await prepared()).committedInstructions()).toBe("Run bun test.\n");
  });

  test("a retry reads the branch, not what the last attempt left in the checkout", async () => {
    await publish({ "CLAUDE.md": "committed rules\n" });
    await prepared();
    // What an engine could do before dying: edit the file, commit on the
    // branch, and leave an uncommitted edit on top.
    await writeFile(join(root, "CLAUDE.md"), "agent rules, committed\n");
    git(["commit", "--quiet", "-am", "agent"], root);
    await writeFile(join(root, "CLAUDE.md"), "agent rules, uncommitted\n");

    const retry = await prepared();

    expect(await Bun.file(join(root, "CLAUDE.md")).text()).toBe(
      "agent rules, uncommitted\n",
    );
    expect(retry.committedInstructions()).toBe("committed rules\n");
  });

  test("a retry sees what the branch published since", async () => {
    await publish({ "CLAUDE.md": "first\n" });
    await prepared();
    await publish({ "CLAUDE.md": "second\n" });

    expect((await prepared()).committedInstructions()).toBe("second\n");
  });

  test("follows a committed link that stays in the tree", async () => {
    await publish(
      { "docs/AGENTS.md": "shared rules\n" },
      { "AGENTS.md": "docs/AGENTS.md", "CLAUDE.md": "AGENTS.md" },
    );

    expect((await prepared()).committedInstructions()).toBe("shared rules\n");
  });

  test("reads AGENTS.md before CLAUDE.md, and CLAUDE.md when there is no AGENTS.md", async () => {
    await publish({ "CLAUDE.md": "claude rules\n" });
    expect((await prepared()).committedInstructions()).toBe("claude rules\n");

    await publish({ "AGENTS.md": "agents rules\n" });
    expect((await prepared()).committedInstructions()).toBe("agents rules\n");
  });

  test("a CLAUDE.md that is a link to AGENTS.md, or only imports it, is read once", async () => {
    await publish(
      { "AGENTS.md": "shared rules\n" },
      { "CLAUDE.md": "AGENTS.md" },
    );
    expect((await prepared()).committedInstructions()).toBe("shared rules\n");

    await publish({ "CLAUDE.md": "@AGENTS.md\n" });
    expect((await prepared()).committedInstructions()).toBe("shared rules\n");
  });

  test("an AGENTS.md that only imports CLAUDE.md stands for it, and two imports do not loop", async () => {
    await publish({
      "AGENTS.md": "@CLAUDE.md\n",
      "CLAUDE.md": "claude rules\n",
    });
    expect((await prepared()).committedInstructions()).toBe("claude rules\n");

    await publish({ "AGENTS.md": "@CLAUDE.md\n", "CLAUDE.md": "@AGENTS.md\n" });
    expect((await prepared()).committedInstructions()).toBe("@AGENTS.md\n");
  });

  test("a CLAUDE.md importing an AGENTS.md that is not there is no instructions", async () => {
    await publish({ "CLAUDE.md": "@AGENTS.md\n" });

    expect((await prepared()).committedInstructions()).toBeNull();
  });

  test("an AGENTS.md the worker refuses is not passed over for CLAUDE.md", async () => {
    await publish({
      "AGENTS.md": "a".repeat(COMMITTED_INSTRUCTIONS_MAX_BYTES + 1),
      "CLAUDE.md": "claude rules\n",
    });

    const workspace = await prepared();
    expect(() => workspace.committedInstructions()).toThrow("larger than");
  });

  test("a committed link to nothing is no instructions", async () => {
    await publish({}, { "CLAUDE.md": "missing.md" });

    expect((await prepared()).committedInstructions()).toBeNull();
  });

  test("refuses a committed link that leaves the tree, whatever the checkout holds there", async () => {
    await writeFile(join(scratch, "outside.md"), "WORKER_SECRET=1\n");
    for (const target of ["../outside.md", join(scratch, "outside.md")]) {
      await publish({}, { "CLAUDE.md": target });
      const workspace = await prepared();
      expect(() => workspace.committedInstructions()).toThrow(
        "Repository instruction file refused: it links outside the repository",
      );
    }
  });

  test("refuses a directory, a link loop and a file past the cap — but only when asked", async () => {
    await publish({ "CLAUDE.md/inner.md": "x" });
    const directory = await prepared();
    expect(() => directory.committedInstructions()).toThrow(
      "not a regular file",
    );

    await publish({}, { "CLAUDE.md": "AGENTS.md", "AGENTS.md": "CLAUDE.md" });
    const loop = await prepared();
    expect(() => loop.committedInstructions()).toThrow("too many symlinks");

    await publish({
      "CLAUDE.md": "a".repeat(COMMITTED_INSTRUCTIONS_MAX_BYTES + 1),
    });
    const large = await prepared();
    expect(() => large.committedInstructions()).toThrow(
      `larger than ${COMMITTED_INSTRUCTIONS_MAX_BYTES} bytes`,
    );
  });

  test("sizes a committed link before reading it", async () => {
    await publish({ "CLAUDE.md": "first\n" });
    const workspace = await prepared();
    // A link no checkout could create; a reuse reads the mirror, which has no
    // filesystem to refuse it first.
    const seed = join(scratch, "seed");
    const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: seed,
      stdin: new TextEncoder().encode("a".repeat(1 << 20)),
      stdout: "pipe",
    });
    const object = blob.stdout.toString().trim();
    git(["rm", "--quiet", "CLAUDE.md"], seed);
    git(
      ["update-index", "--add", "--cacheinfo", `120000,${object},CLAUDE.md`],
      seed,
    );
    git(["commit", "--quiet", "-m", "long link"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    await workspace.prepare({
      descriptor: descriptor(),
      restore: null,
      signal: new AbortController().signal,
    });
    expect(() => workspace.committedInstructions()).toThrow(
      "it links to an overlong path",
    );
  });

  test("refuses a committed link to a directory without listing it", async () => {
    await publish({ "docs/a.md": "a", "docs/b.md": "b" });
    for (const target of ["docs/", ".", "./"]) {
      await publish({}, { "CLAUDE.md": target });
      const workspace = await prepared();
      expect(() => workspace.committedInstructions()).toThrow(
        "it is not a regular file",
      );
    }
  });

  test("refuses a committed link whose target holds a NUL, without failing the preparation", async () => {
    await publish({ "CLAUDE.md": "first\n" });
    const workspace = await prepared();
    const seed = join(scratch, "seed");
    const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: seed,
      stdin: new TextEncoder().encode("docs\0AGENTS.md"),
      stdout: "pipe",
    });
    git(["rm", "--quiet", "CLAUDE.md"], seed);
    git(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `120000,${blob.stdout.toString().trim()},CLAUDE.md`,
      ],
      seed,
    );
    git(["commit", "--quiet", "-m", "nul link"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    expect(
      await workspace.prepare({
        descriptor: descriptor(),
        restore: null,
        signal: new AbortController().signal,
      }),
    ).toBe("reuse");
    expect(() => workspace.committedInstructions()).toThrow(
      "it links to a malformed path",
    );
  });

  test("a file exactly at the cap is whole", async () => {
    const whole = "b".repeat(COMMITTED_INSTRUCTIONS_MAX_BYTES);
    await publish({ "CLAUDE.md": whole });

    expect((await prepared()).committedInstructions()).toBe(whole);
  });

  test("a restore fetched nothing, so a run that wants the file is refused", async () => {
    await publish({ "CLAUDE.md": "committed rules\n" });
    const workspace = await prepared();
    expect(workspace.committedInstructions()).toBe("committed rules\n");

    await workspace.prepare({
      descriptor: descriptor(),
      restore: {
        revision: 3,
        manifest_ref: "sessions/x/manifest-3.json",
        manifest_sha256: "a".repeat(64),
      },
      signal: new AbortController().signal,
    });

    expect(() => workspace.committedInstructions()).toThrow(
      "no freshly fetched commit",
    );
  });
});
