import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { placeInstructionFiles } from "./instruction-files.ts";
import { GitWorkspace } from "./workspace.ts";

let scratch: string;
let root: string;

function git(args: string[], cwd = root): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function place(text = "Platform rules.\n\nAgent rules.") {
  return placeInstructionFiles({
    root,
    text,
    signal: new AbortController().signal,
  });
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(join(root, path)).catch(() => null)) !== null;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-1370-"));
  root = join(scratch, "workspace");
  await mkdir(root);
  git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, "README.md"), "readme\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "seed"]);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("placeInstructionFiles", () => {
  test("puts AGENTS.md at the root with CLAUDE.md linked to it, both out of git's sight", async () => {
    expect(await place()).toBe("placed");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "Platform rules.\n\nAgent rules.\n",
    );
    expect(await readlink(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(
      await readFile(join(root, "AGENTS.md"), "utf8"),
    );
    expect(git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    // Nothing a capture's untracked listing could carry off.
    expect(git(["ls-files", "--others", "--exclude-standard"])).toBe("");
    // No scratch left in .git for the next attempt to sweep.
    expect(
      (await readdir(join(root, ".git"))).filter((name) =>
        name.startsWith("werft-"),
      ),
    ).toEqual([]);
  });

  test("a second attempt refreshes its own files and writes the exclude once", async () => {
    await place("first\n");
    expect(await place("second\n")).toBe("refreshed");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("second\n");
    const excludes = await readFile(
      join(root, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludes.match(/^\/AGENTS\.md$/gm)).toHaveLength(1);
    expect(excludes.match(/^\/CLAUDE\.md$/gm)).toHaveLength(1);
  });

  test("keeps what an exclude already held", async () => {
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "/scratch.txt");

    await place();

    const excludes = await readFile(
      join(root, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludes.startsWith("/scratch.txt\n")).toBe(true);
    expect(excludes).toContain("/AGENTS.md\n");
  });

  test("leaves a repository's AGENTS.md alone, and writes nothing beside it", async () => {
    await writeFile(join(root, "AGENTS.md"), "repo rules\n");
    git(["add", "AGENTS.md"]);
    git(["commit", "--quiet", "-m", "agents"]);

    expect(await place()).toBe("kept");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "repo rules\n",
    );
    expect(await exists("CLAUDE.md")).toBe(false);
    expect(
      await readFile(join(root, ".git", "info", "exclude"), "utf8").catch(
        () => "",
      ),
    ).not.toContain("AGENTS.md");
  });

  test("leaves a repository's CLAUDE.md alone, and writes nothing beside it", async () => {
    await writeFile(join(root, "CLAUDE.md"), "repo rules\n");
    git(["add", "CLAUDE.md"]);
    git(["commit", "--quiet", "-m", "claude"]);

    expect(await place()).toBe("kept");

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(
      "repo rules\n",
    );
    expect(await exists("AGENTS.md")).toBe(false);
  });

  test("leaves a repository's committed CLAUDE.md link to AGENTS.md alone", async () => {
    await writeFile(join(root, "AGENTS.md"), "repo rules\n");
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));
    git(["add", "AGENTS.md", "CLAUDE.md"]);
    git(["commit", "--quiet", "-m", "both"]);

    expect(await place()).toBe("kept");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "repo rules\n",
    );
  });

  test("does not replace a tracked file the engine deleted from the tree", async () => {
    await writeFile(join(root, "AGENTS.md"), "repo rules\n");
    git(["add", "AGENTS.md"]);
    git(["commit", "--quiet", "-m", "agents"]);
    await rm(join(root, "AGENTS.md"));

    expect(await place()).toBe("kept");

    expect(await exists("AGENTS.md")).toBe(false);
    expect(await exists("CLAUDE.md")).toBe(false);
  });

  test("does not take a file of ours the engine added to git for its own", async () => {
    await place("first\n");
    git(["add", "-f", "AGENTS.md", "CLAUDE.md"]);

    expect(await place("second\n")).toBe("kept");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("first\n");
  });

  test("places nothing when the repository's .gitignore re-includes the names", async () => {
    await writeFile(join(root, ".gitignore"), "!AGENTS.md\n!CLAUDE.md\n");
    git(["add", ".gitignore"]);
    git(["commit", "--quiet", "-m", "gitignore"]);

    expect(await place()).toBe("skipped");

    expect(await exists("AGENTS.md")).toBe(false);
    expect(await exists("CLAUDE.md")).toBe(false);

    // Skipped leaves no proof of ownership: a file added later, once the
    // re-inclusion is gone, is not taken for ours.
    await rm(join(root, ".gitignore"));
    git(["rm", "--quiet", "--cached", ".gitignore"]);
    git(["commit", "--quiet", "-m", "drop gitignore"]);
    await writeFile(join(root, "AGENTS.md"), "mine\n");
    expect(await place()).toBe("kept");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  test("stops before writing when the worker is told to stop", async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(
      placeInstructionFiles({ root, text: "x\n", signal: stop.signal }),
    ).rejects.toThrow();
    expect(await exists("AGENTS.md")).toBe(false);
  });

  test("a stop after the exclude was written withdraws it, so a file added later is not taken for ours", async () => {
    const excludePath = join(root, ".git", "info", "exclude");
    const stopsOnceMarked = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
      throwIfAborted() {
        const text = readFileSync(excludePath, "utf8");
        if (text.includes("werft: instruction files")) {
          throw new Error("stopped");
        }
      },
    } as unknown as AbortSignal;
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(excludePath, "");

    await expect(
      placeInstructionFiles({ root, text: "x\n", signal: stopsOnceMarked }),
    ).rejects.toThrow("stopped");

    expect(await readFile(excludePath, "utf8")).toBe("");
    await writeFile(join(root, "AGENTS.md"), "mine\n");
    expect(await place()).toBe("kept");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  test("leaves an untracked file it did not make", async () => {
    await writeFile(join(root, "AGENTS.md"), "engine notes\n");

    expect(await place()).toBe("kept");

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "engine notes\n",
    );
    expect(await exists("CLAUDE.md")).toBe(false);
  });

  test("completes a placement a kill cut between the two files", async () => {
    await place("first\n");
    await rm(join(root, "CLAUDE.md"));

    expect(await place("second\n")).toBe("refreshed");

    expect(await readlink(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("second\n");
  });

  test("without text, the files an earlier attempt placed are removed, and the repository's own are not", async () => {
    expect(await place("old directive text\n")).toBe("placed");

    expect(await place("")).toBe("skipped");
    expect(await exists("AGENTS.md")).toBe(false);
    expect(await exists("CLAUDE.md")).toBe(false);

    await rm(join(root, ".git", "info", "exclude"), { force: true });
    await writeFile(join(root, "AGENTS.md"), "mine\n");
    expect(await place("")).toBe("skipped");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("mine\n");
  });

  test("without text, a file the repository now tracks is kept even though our marker is still in the exclude", async () => {
    expect(await place("old directive text\n")).toBe("placed");
    await rm(join(root, "CLAUDE.md"), { force: true });
    await rm(join(root, "AGENTS.md"), { force: true });
    await writeFile(join(root, "AGENTS.md"), "the repository's own\n");
    git(["add", "-f", "AGENTS.md"]);
    git(["commit", "--quiet", "-m", "repository adds AGENTS.md"]);

    expect(await place("")).toBe("kept");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "the repository's own\n",
    );
  });

  test("writes nothing without text, or where .git is not a directory", async () => {
    expect(await place("  \n")).toBe("skipped");
    expect(await exists("AGENTS.md")).toBe(false);

    await rm(join(root, ".git"), { force: true, recursive: true });
    await writeFile(
      join(root, ".git"),
      `gitdir: ${join(scratch, "elsewhere")}\n`,
    );
    expect(await place()).toBe("skipped");
    expect(await exists("AGENTS.md")).toBe(false);
  });

  test("a session without a repository gets them in its local git", async () => {
    const local = join(scratch, "local");
    await mkdir(local);
    await new GitWorkspace(local, ["AGENTS.md", "CLAUDE.md"]).prepare({
      descriptor: { repository: null },
      restore: null,
      signal: new AbortController().signal,
    });

    expect(
      await placeInstructionFiles({
        root: local,
        text: "No repository here.\n",
        signal: new AbortController().signal,
      }),
    ).toBe("placed");

    expect(await readFile(join(local, "AGENTS.md"), "utf8")).toBe(
      "No repository here.\n",
    );
    expect(await readlink(join(local, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(git(["status", "--porcelain", "--untracked-files=all"], local)).toBe(
      "",
    );
  });
});
