import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(
  import.meta.dir,
  "..",
  ".github",
  "scripts",
  "forbidden-terms.ts",
);

// Synthetic entries only. They are not real forbidden terms, and the real list never appears here.
const SYNTHETIC = "zz-synthetic-alpha\n^zz-synthetic-beta [0-9]+$\n";
const HIT_TEXT = "contains ZZ-Synthetic-Alpha inside";

let root: string;
let binDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  return out.trim();
}

async function makeRepo(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files))
    await writeFile(join(dir, path), body);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base commit");
  return dir;
}

async function commit(
  dir: string,
  message: string,
  files: Record<string, string> = {},
): Promise<string> {
  for (const [path, body] of Object.entries(files))
    await writeFile(join(dir, path), body);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

// One API object: a PR or issue (with a title) or a comment or review.
function item(
  body: string,
  author_association = "OWNER",
  title?: string,
): Record<string, string> {
  return title === undefined
    ? { body, author_association }
    : { title, body, author_association };
}

const pr = (title: string, body: string, association = "OWNER") =>
  JSON.stringify(item(body, association, title));
const list = (...items: Record<string, string>[]) => JSON.stringify(items);

async function ghCalls(cwd: string): Promise<string[]> {
  const text = await Bun.file(`${cwd}.gh-log`)
    .text()
    .catch(() => "");
  return text.split("\n").filter(Boolean);
}

async function run(cwd: string, env: Record<string, string>) {
  const clean = { ...process.env } as Record<string, string>;
  for (const key of [
    "FORBIDDEN_TERMS",
    "FORBIDDEN_HOST_TERMS",
    "ISSUE_NUMBER",
    "TEXT_ONLY",
    "PR_NUMBER",
    "BASE_SHA",
    "BASE_REF",
    "HEAD_SHA",
    "FORK_PR",
  ])
    delete clean[key];
  const p = Bun.spawn(["bun", script], {
    cwd,
    env: {
      ...clean,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      FAKE_GH_LOG: `${cwd}.gh-log`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: stdout + stderr };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forbidden-terms-"));
  binDir = join(root, "bin");
  await mkdir(binDir);
  // Fake `gh api [--paginate] <path> --jq <filter>`: runs the filter with the real jq over the
  // JSON held for that path, so the author filter is tested too. FAKE_<KIND>_FAIL fails a kind.
  await writeFile(
    join(binDir, "gh"),
    `#!/bin/sh
path=""; filter=""
while [ $# -gt 0 ]; do
  case "$1" in --jq) filter="$2"; shift ;; repos/*) path="$1" ;; esac
  shift
done
echo "$path" >> "$FAKE_GH_LOG"
case "$path" in
  */issues/*/comments) json="\${FAKE_COMMENTS:-[]}"; fail="$FAKE_COMMENTS_FAIL" ;;
  */pulls/*/comments) json="\${FAKE_REVIEW_COMMENTS:-[]}"; fail="$FAKE_COMMENTS_FAIL" ;;
  */pulls/*/reviews) json="\${FAKE_REVIEWS:-[]}"; fail="$FAKE_COMMENTS_FAIL" ;;
  *) json="$FAKE_PR"; fail="$FAKE_PR_FAIL" ;;
esac
[ -n "$fail" ] && exit 4
printf '%s' "$json" | jq -r "$filter"
`,
  );
  await chmod(join(binDir, "gh"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("forbidden-terms", () => {
  test("a clean tree, range and PR text pass with zero counts", async () => {
    const dir = await makeRepo("clean", { "a.txt": "nothing here\n" });
    const base = await git(dir, "rev-parse", "HEAD");
    const head = await commit(dir, "second commit");
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: base,
      HEAD_SHA: head,
      PR_NUMBER: "7",
      FAKE_PR: pr("title", "body"),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("tree: 0");
    expect(r.out).toContain("commit messages: 0");
    expect(r.out).toContain("PR title and body: 0");
    expect(r.out).toContain("PR comments and reviews: 0");
  });

  test("a tree hit fails and the log has counts only", async () => {
    const dir = await makeRepo("tree", {
      "secret-named-file.txt": `${HIT_TEXT}\n`,
    });
    const r = await run(dir, { FORBIDDEN_TERMS: SYNTHETIC });
    expect(r.code).toBe(1);
    expect(r.out).toContain("tree: 1");
    expectNoLeak(r.out);
    expect(r.out).not.toContain("secret-named-file");
  });

  test("a commit message hit in the run range fails; one before the range is ignored", async () => {
    const dir = await makeRepo("msg", { "a.txt": "ok\n" });
    await commit(dir, `old ${HIT_TEXT}`);
    const base = await git(dir, "rev-parse", "HEAD");
    const hitHead = await commit(dir, `new ${HIT_TEXT}`);
    const cleanHead = await commit(dir, "fine");
    const bad = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: base,
      HEAD_SHA: hitHead,
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("commit messages: 1");
    expectNoLeak(bad.out);
    expect(bad.out).not.toContain(hitHead.slice(0, 7));
    const ok = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: cleanHead,
      HEAD_SHA: cleanHead,
    });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("commit messages: 0");
  });

  test("a multi-commit range counts a hit in the middle even when the head is clean", async () => {
    const dir = await makeRepo("multi", { "a.txt": "ok\n" });
    const base = await git(dir, "rev-parse", "HEAD");
    await commit(dir, `middle ${HIT_TEXT}`);
    const head = await commit(dir, "fine");
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: base,
      HEAD_SHA: head,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("commit messages: 1");
  });

  test("a PR that merged newer main is not charged for main's commits when BASE_REF is set", async () => {
    const dir = await makeRepo("merged-main", { "a.txt": "ok\n" });
    const staleBase = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "feature");
    await commit(dir, "feature work");
    await git(dir, "checkout", "-q", "main");
    const mainTip = await commit(dir, `already on main ${HIT_TEXT}`);
    await git(dir, "update-ref", "refs/remotes/origin/main", mainTip);
    await git(dir, "checkout", "-q", "feature");
    await git(dir, "merge", "-q", "--no-edit", "main");
    const head = await git(dir, "rev-parse", "HEAD");
    const without = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: staleBase,
      HEAD_SHA: head,
    });
    expect(without.out).toContain("commit messages: 1");
    const withRef = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: staleBase,
      BASE_REF: "main",
      HEAD_SHA: head,
    });
    expect(withRef.out).toContain("commit messages: 0");
  });

  test("a push without a usable before scans the head commit only", async () => {
    const dir = await makeRepo("zero", { "a.txt": "ok\n" });
    await commit(dir, `old ${HIT_TEXT}`);
    const head = await commit(dir, "fine");
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: "0".repeat(40),
      HEAD_SHA: head,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("commit messages: 0");
  });

  test("a PR title or body hit fails with a count only", async () => {
    const dir = await makeRepo("pr", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR: pr("title", `body ${HIT_TEXT}`),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PR title and body: 1");
    expectNoLeak(r.out);
  });

  test("matching is case-insensitive and honors the ERE anchors", async () => {
    const dir = await makeRepo("ere", { "a.txt": "ZZ-SYNTHETIC-BETA 42\n" });
    expect((await run(dir, { FORBIDDEN_TERMS: SYNTHETIC })).code).toBe(1);
    const miss = await makeRepo("ere2", {
      "a.txt": "x ZZ-SYNTHETIC-BETA 42\n",
    });
    expect(
      (await run(miss, { FORBIDDEN_TERMS: "^zz-synthetic-beta [0-9]+$\n" }))
        .code,
    ).toBe(0);
  });

  test("an empty or missing list fails closed, with a separate message for a fork", async () => {
    const dir = await makeRepo("nolist", { "a.txt": "ok\n" });
    const empty = await run(dir, { FORBIDDEN_TERMS: "\n  \n" });
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("::error::");
    const fork = await run(dir, { FORBIDDEN_TERMS: "", FORK_PR: "true" });
    expect(fork.code).toBe(1);
    expect(fork.out).toContain("fork");
  });

  test("an invalid pattern fails without quoting it", async () => {
    const dir = await makeRepo("bad", { "a.txt": "ok\n" });
    const r = await run(dir, { FORBIDDEN_TERMS: "zz-synthetic-broken(\n" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("zz-synthetic-broken");
  });

  test("an API failure fails with fixed text", async () => {
    const dir = await makeRepo("api", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR_FAIL: "1",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read the PR title and body");
  });

  test("FORBIDDEN_HOST_TERMS joins the scan; without it the log says it was skipped", async () => {
    const dir = await makeRepo("host", { "a.txt": "zz-synthetic-host 1\n" });
    const hit = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      FORBIDDEN_HOST_TERMS: "\nzz-synthetic-host\n",
    });
    expect(hit.code).toBe(1);
    expect(hit.out).toContain("tree: 1");
    expect(hit.out).not.toContain("not set");
    expectNoLeak(hit.out);
    const skipped = await run(dir, { FORBIDDEN_TERMS: SYNTHETIC });
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain(
      "FORBIDDEN_HOST_TERMS is not set; host terms were not scanned",
    );
  });

  test("a hit in a PR comment, review comment or review fails with a count only", async () => {
    const dir = await makeRepo("pr-comments", { "a.txt": "ok\n" });
    const base = { FORBIDDEN_TERMS: SYNTHETIC, PR_NUMBER: "7" };
    const cases: Record<string, string>[] = [
      { FAKE_COMMENTS: list(item("fine"), item(`see ${HIT_TEXT}`, "MEMBER")) },
      { FAKE_REVIEW_COMMENTS: list(item(HIT_TEXT, "COLLABORATOR")) },
      { FAKE_REVIEWS: list(item(HIT_TEXT)) },
    ];
    for (const texts of cases) {
      const r = await run(dir, { ...base, FAKE_PR: pr("t", "b"), ...texts });
      expect(r.code).toBe(1);
      expect(r.out).toContain("PR comments and reviews: 1");
      expectNoLeak(r.out);
    }
  });

  test("a stranger's comment, review or PR body is not scanned", async () => {
    const dir = await makeRepo("stranger", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR: pr("t", HIT_TEXT, "NONE"),
      FAKE_COMMENTS: list(
        item(HIT_TEXT, "NONE"),
        item(HIT_TEXT, "CONTRIBUTOR"),
      ),
      FAKE_REVIEWS: list(item(HIT_TEXT, "FIRST_TIME_CONTRIBUTOR")),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR title and body: 0");
    expect(r.out).toContain("PR comments and reviews: 0");
  });

  test("an issue scans its title, body and comments, and no PR endpoint", async () => {
    const dir = await makeRepo("issue", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      ISSUE_NUMBER: "9",
      FAKE_PR: pr("t", "b"),
      FAKE_COMMENTS: list(item(HIT_TEXT)),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("issue title and body: 0");
    expect(r.out).toContain("issue comments and reviews: 1");
    expect(await ghCalls(dir)).toEqual([
      "repos/o/r/issues/9",
      "repos/o/r/issues/9/comments",
    ]);
  });

  test("TEXT_ONLY skips the tree and commit messages", async () => {
    const dir = await makeRepo("text-only", { "a.txt": `${HIT_TEXT}\n` });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      TEXT_ONLY: "true",
      PR_NUMBER: "7",
      FAKE_PR: pr("t", "b"),
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("tree:");
    expect(r.out).not.toContain("commit messages:");
    expect(r.out).toContain("PR comments and reviews: 0");
  });

  test("a comment API failure fails with fixed text", async () => {
    const dir = await makeRepo("comments-api", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR: pr("t", "b"),
      FAKE_COMMENTS_FAIL: "1",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read the PR comments and reviews");
  });
});

function expectNoLeak(out: string) {
  expect(out.toLowerCase()).not.toContain("synthetic");
  expect(out).not.toContain(HIT_TEXT);
}
