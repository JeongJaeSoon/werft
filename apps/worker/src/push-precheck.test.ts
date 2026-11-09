import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPushPrecheck,
  REQUEST_PUSH_TOOL,
  UNRELATED_HISTORY_ADVICE,
} from "./push-precheck.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function commit(cwd: string, file: string, text: string) {
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", file);
  await git(cwd, "commit", "--quiet", "-m", text);
}

let root: string;
/** A clone of `app` with `docs` attached as a remote of its catalog id. */
let workspace: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "push-precheck-"));
  for (const name of ["app", "docs"]) {
    const source = join(root, `${name}-src`);
    await git(root, "init", "--quiet", "--initial-branch=main", source);
    await commit(source, "README.md", `${name}\n`);
  }
  workspace = join(root, "workspace");
  await git(root, "clone", "--quiet", join(root, "app-src"), workspace);
  await git(workspace, "remote", "add", "docs", join(root, "docs-src"));
  await git(
    workspace,
    "fetch",
    "--quiet",
    "docs",
    "+refs/heads/main:refs/remotes/docs/main",
  );
  // Work on the session's own repository.
  await commit(workspace, "a.txt", "on app\n");
  // A branch for the attached repository, built on its history.
  await git(workspace, "checkout", "--quiet", "-b", "docs-work", "docs/main");
  await commit(workspace, "b.txt", "on docs\n");
  // A branch built on nothing the remotes hold.
  await git(workspace, "checkout", "--quiet", "--orphan", "orphan");
  await commit(workspace, "c.txt", "from nothing\n");
  await git(workspace, "checkout", "--quiet", "main");
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("the request_push precheck", () => {
  test("lets a commit built on the session's repository through", async () => {
    const precheck = createPushPrecheck(workspace);
    expect(await precheck(REQUEST_PUSH_TOOL, {})).toBeNull();
    expect(
      await precheck(REQUEST_PUSH_TOOL, { source_ref: "main" }),
    ).toBeNull();
  });

  test("refuses a branch that shares no history with the target, naming the branch to build on", async () => {
    const precheck = createPushPrecheck(workspace);
    expect(await precheck(REQUEST_PUSH_TOOL, { source_ref: "orphan" })).toBe(
      UNRELATED_HISTORY_ADVICE.replaceAll("{base}", "origin/main"),
    );
    expect(
      await precheck(REQUEST_PUSH_TOOL, {
        source_ref: "orphan",
        repository_id: "docs",
      }),
    ).toBe(UNRELATED_HISTORY_ADVICE.replaceAll("{base}", "docs/main"));
  });

  test("judges an attached repository against its own remote", async () => {
    const precheck = createPushPrecheck(workspace);
    expect(
      await precheck(REQUEST_PUSH_TOOL, {
        source_ref: "docs-work",
        repository_id: "docs",
      }),
    ).toBeNull();
    // The app's work pushed to docs is the cross-repository case the push refuses.
    expect(
      await precheck(REQUEST_PUSH_TOOL, {
        source_ref: "main",
        repository_id: "docs",
      }),
    ).toBe(UNRELATED_HISTORY_ADVICE.replaceAll("{base}", "docs/main"));
    // The session's own id is no remote here: origin is judged.
    expect(
      await precheck(REQUEST_PUSH_TOOL, {
        source_ref: "main",
        repository_id: "app",
      }),
    ).toBeNull();
  });

  test("lets through whatever it cannot judge for sure", async () => {
    const precheck = createPushPrecheck(workspace);
    // Not the push tool.
    expect(await precheck("Bash", { source_ref: "orphan" })).toBeNull();
    // No such branch: the platform says source_missing at the turn's end.
    expect(
      await precheck(REQUEST_PUSH_TOOL, { source_ref: "nowhere" }),
    ).toBeNull();
    // Not a plain name.
    expect(
      await precheck(REQUEST_PUSH_TOOL, { source_ref: "--orphan" }),
    ).toBeNull();
    // A workspace with no remote to judge against.
    const local = join(root, "local");
    await git(root, "init", "--quiet", "--initial-branch=main", local);
    await commit(local, "x.txt", "local\n");
    expect(await createPushPrecheck(local)(REQUEST_PUSH_TOOL, {})).toBeNull();
    // A shallow clone, whose missing history would read as unrelated.
    const shallow = join(root, "shallow");
    await git(
      root,
      "clone",
      "--quiet",
      "--depth=1",
      `file://${join(root, "app-src")}`,
      shallow,
    );
    await git(shallow, "checkout", "--quiet", "--orphan", "orphan");
    await commit(shallow, "c.txt", "from nothing\n");
    expect(
      await createPushPrecheck(shallow)(REQUEST_PUSH_TOOL, {
        source_ref: "orphan",
      }),
    ).toBeNull();
  });
});
