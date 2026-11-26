import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// .github/scripts/images-reuse.sh against a real git history and a fake `gh`
// whose answers are files, and its place in images.yml: a main push leaves
// test-ops-bundle out only when the PR Images run of its exact tree built and
// ran the bundle.

const root = join(import.meta.dir, "..");
const script = join(root, ".github/scripts/images-reuse.sh");

let dir = "";
let origin = "";
let work = "";
let fake = "";
const sha: Record<string, string> = {};

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

function commitFile(cwd: string, name: string, text: string, message: string) {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const bundleSteps = [
  "Build the bundle twice",
  "Run the bundle's scripts without a checkout",
];
const bundleJob = (conclusion = "success", steps = bundleSteps) => ({
  name: "test-ops-bundle",
  conclusion: "success",
  steps: steps.map((name) => ({ name, conclusion })),
});

type Answers = {
  pulls?: unknown;
  compare?: unknown;
  runs?: unknown;
  jobs?: unknown;
  fail?: boolean;
};
function answer(a: Answers) {
  for (const [key, value] of Object.entries(a)) {
    if (key === "fail") continue;
    writeFileSync(join(fake, `${key}.json`), JSON.stringify(value));
  }
  if (a.fail) writeFileSync(join(fake, "fail"), "");
  else rmSync(join(fake, "fail"), { force: true });
}
const pr = (head = sha.head, mergeSha = sha.merge) => [
  {
    number: 7,
    merge_commit_sha: mergeSha,
    base: { ref: "main" },
    head: { sha: head, ref: "feature" },
  },
];
const runs = (head = sha.head, conclusion = "success") => ({
  workflow_runs: [
    {
      id: 11,
      status: "completed",
      conclusion,
      head_sha: head,
      head_branch: "feature",
      html_url: "https://github.invalid/runs/11",
    },
  ],
});
const hit = (jobs: unknown[] = [bundleJob()]) =>
  answer({
    pulls: pr(),
    compare: { status: "ahead" },
    runs: runs(),
    jobs: { jobs },
  });

function run(at = sha.merge, before = sha.base) {
  git(work, "checkout", "--quiet", "--detach", at ?? "");
  const out = Bun.spawnSync(["bash", script], {
    cwd: work,
    env: {
      PATH: `${fake}/bin:${Bun.env.PATH}`,
      GH_REPO: "o/r",
      FAKE: fake,
      GITHUB_SHA: at ?? "",
      BEFORE_SHA: before ?? "",
    },
  });
  return {
    code: out.exitCode,
    out: out.stdout.toString(),
    why: out.stderr.toString(),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "images-reuse-"));
  origin = join(dir, "origin");
  work = join(dir, "work");
  fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  sha.base = commitFile(origin, "a.sh", "a\n", "base");
  git(origin, "switch", "--quiet", "-c", "feature");
  sha.head = commitFile(origin, "b.sh", "b\n", "feature");
  // Squash merge: one commit on main with the head's tree.
  git(origin, "switch", "--quiet", "main");
  git(origin, "checkout", "--quiet", "feature", "--", ".");
  git(origin, "commit", "--quiet", "-m", "squash (#7)");
  sha.merge = git(origin, "rev-parse", "HEAD");
  // A squash whose tree differs from the head (merged behind main).
  writeFileSync(join(origin, "c.sh"), "c\n");
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", "other");
  sha.other = git(origin, "rev-parse", "HEAD");
  git(origin, "switch", "--quiet", "feature");
  git(dir, "clone", "--quiet", origin, work);
  git(work, "fetch", "--quiet", "origin", "main");

  // gh api [--paginate] PATH [--jq Q]: answers from $FAKE/<kind>.json.
  writeFileSync(
    join(fake, "bin/gh"),
    `#!/usr/bin/env bash
[ -e "$FAKE/fail" ] && exit 1
shift
q=.
while [ $# -gt 0 ]; do
  case "$1" in --paginate) ;; --jq) q=$2; shift ;; *) path=$1 ;; esac
  shift
done
case "$path" in
  */pulls) f=pulls ;;
  */compare/*) f=compare ;;
  */workflows/images.yml/runs*) f=runs ;;
  */jobs*) f=jobs ;;
  *) echo "unexpected $path" >&2; exit 1 ;;
esac
jq -r "$q" "$FAKE/$f.json"
`,
  );
  chmodSync(join(fake, "bin/gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("images-reuse.sh", () => {
  test("a squash with the tested head's tree reuses that run's bundle check", () => {
    hit();
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("reused=https://github.invalid/runs/11\n");
  });

  const refused = (r: ReturnType<typeof run>, why: string) => {
    expect(r.code).toBe(0);
    expect(r.out).toBe("reused=\n");
    expect(r.why).toContain(why);
  };

  test("a PR run whose plan left the bundle out proves nothing", () => {
    hit([{ name: "test-ops-bundle", conclusion: "skipped", steps: [] }]);
    refused(run(), "did not build and run the bundle");
    hit([]);
    refused(run(), "did not build and run the bundle");
  });

  test("every bundle step has to have run and passed", () => {
    hit([bundleJob("skipped")]);
    refused(run(), "did not build and run the bundle");
    hit([bundleJob("success", bundleSteps.slice(0, 1))]);
    refused(run(), "did not build and run the bundle");
  });

  test("only a successful Images run of that head and branch counts", () => {
    answer({
      pulls: pr(),
      compare: { status: "ahead" },
      runs: runs(sha.head, "failure"),
      jobs: { jobs: [bundleJob()] },
    });
    refused(run(), "no successful Images run");
    answer({ runs: runs(sha.base) });
    refused(run(), "no successful Images run");
  });

  test("a tree nobody tested runs the bundle", () => {
    hit();
    answer({ pulls: pr(sha.head, sha.other) });
    refused(run(sha.other, sha.merge), "differs from PR #7");
    hit();
    answer({ compare: { status: "diverged" } });
    refused(run(), "was diverged of main");
  });

  test("a push of more than one commit, or none before it, runs the bundle", () => {
    hit();
    answer({ pulls: pr(sha.head, sha.other) });
    refused(run(sha.other, sha.base), "more than one commit");
    refused(run(sha.merge, "0".repeat(40)), "no previous commit");
    refused(run(sha.merge, ""), "no previous commit");
  });

  test("no pull request, or a lookup that fails, runs the bundle", () => {
    hit();
    answer({ pulls: [] });
    refused(run(), "no pull request merged as this commit");
    hit();
    answer({ fail: true });
    refused(run(), "could not look up the pull request");
    answer({ fail: false });
  });
});

describe("images.yml test-ops-bundle plan", () => {
  type Step = {
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
  };
  type Job = {
    needs?: string | string[];
    if?: string;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps?: Step[];
  };
  const { jobs } = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
  ) as { jobs: Record<string, Job> };

  test("only a main push that builds asks for reuse, with read access alone", () => {
    const plan = jobs.plan;
    expect(plan?.permissions).toEqual({ contents: "read", actions: "read" });
    const step = plan?.steps?.find((s) => s.id === "bundle");
    expect(step?.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.images.outputs.images == 'build'",
    );
    expect(step?.run).toBe(
      'bash .github/scripts/images-reuse.sh >>"$GITHUB_OUTPUT"',
    );
    expect(step?.env?.BEFORE_SHA).toBe("${{ github.event.before }}");
  });

  test("the bundle follows the image plan unless a reuse was proven", () => {
    // build, skip, or reused: without a proof it is the image plan itself,
    // so a PR, tag, scheduled or manual run builds the bundle as before.
    expect(jobs.plan?.outputs?.ops_bundle).toBe(
      "${{ steps.bundle.outputs.reused != '' && 'reused' || steps.images.outputs.images }}",
    );
    expect(jobs["test-ops-bundle"]?.if).toBe(
      "needs.plan.outputs.ops_bundle == 'build'",
    );
    // No required check waits on it, so leaving it out stops nothing.
    for (const job of Object.values(jobs)) {
      expect([job.needs ?? []].flat()).not.toContain("test-ops-bundle");
    }
  });
});
