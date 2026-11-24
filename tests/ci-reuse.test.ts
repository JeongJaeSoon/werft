import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// .github/scripts/ci-reuse.sh against a real git history and a fake `gh`
// whose answers are files: a main push reuses a PR run only when that run
// tested its exact tree and ran every suite the push would run.

const root = join(import.meta.dir, "..");
const script = join(root, ".github/scripts/ci-reuse.sh");
const domains = [
  "db",
  "sessions",
  "api",
  "surface",
  "storage",
  "docker",
  "egress",
  "worker",
];

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

type Job = {
  name: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
};
const job = (name: string, step?: string, conclusion = "success"): Job => ({
  name,
  conclusion: "success",
  steps: step ? [{ name: step, conclusion }] : [],
});
const fullJobs = (): Job[] => [
  ...domains.map((d) => job(`integration (${d})`, "Tests of this domain")),
  job("e2e", "Alpha path against the compose stack"),
  // No conformance jobs: no pull request runs that suite, and reuse never asks for it.
  job("demo", "Static build"),
  job("ui-pack", "Install, type-check, build and render in an empty app"),
  job("workspace-quota", "Workspace suite against a quota-capable daemon"),
  job("quickstart", "docs/quickstart.md"),
  { ...job("quickstart", "reference/api-guide.mdx"), name: "quickstart-2" },
  job("helm-chart", "kubeconform"),
];
// The quickstart job carries both guide steps.
function withGuides(jobs: Job[]): Job[] {
  const rest = jobs.filter(
    (j) => j.name !== "quickstart" && j.name !== "quickstart-2",
  );
  return [
    ...rest,
    {
      name: "quickstart",
      conclusion: "success",
      steps: [
        { name: "docs/quickstart.md", conclusion: "success" },
        { name: "reference/api-guide.mdx", conclusion: "success" },
      ],
    },
  ];
}

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

function run(env: Record<string, string> = {}, at = sha.merge) {
  git(work, "checkout", "--quiet", "--detach", at ?? "");
  const out = Bun.spawnSync(["bash", script], {
    cwd: work,
    env: {
      PATH: `${fake}/bin:${Bun.env.PATH}`,
      GH_REPO: "o/r",
      FAKE: fake,
      GITHUB_SHA: at ?? "",
      BEFORE_SHA: sha.base ?? "",
      TESTS: "true",
      PRODUCT: "true",
      QUICKSTART: "true",
      HELM: "true",
      K8S: "true",
      SDK_PACK: "false",
      DOCS_ONLY: "false",
      DOMAINS: JSON.stringify(domains),
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    out.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { code: out.exitCode, outputs, why: out.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-reuse-"));
  origin = join(dir, "origin");
  work = join(dir, "work");
  fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  sha.base = commitFile(origin, "a.ts", "a\n", "base");
  git(origin, "switch", "--quiet", "-c", "feature");
  sha.head = commitFile(origin, "b.ts", "b\n", "feature");
  // Squash merge: one commit on main with the head's tree.
  git(origin, "switch", "--quiet", "main");
  git(origin, "checkout", "--quiet", "feature", "--", ".");
  git(origin, "commit", "--quiet", "-m", "squash (#7)");
  sha.merge = git(origin, "rev-parse", "HEAD");
  // A squash whose tree differs from the head (merged behind main).
  writeFileSync(join(origin, "c.ts"), "c\n");
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
  case "$1" in --paginate) ;; --jq) q=$2; shift ;; -H) shift ;; *) path=$1 ;; esac
  shift
done
case "$path" in
  */pulls) f=pulls ;;
  */compare/*) f=compare ;;
  */workflows/ci.yml/runs*) f=runs ;;
  */jobs*) f=jobs ;;
  *) echo "unexpected $path" >&2; exit 1 ;;
esac
jq -r "$q" "$FAKE/$f.json"
`,
  );
  chmodSync(join(fake, "bin/gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ci-reuse.sh", () => {
  const hit = () =>
    answer({
      pulls: pr(),
      compare: { status: "ahead" },
      runs: runs(),
      jobs: { jobs: withGuides(fullJobs()) },
    });

  test("a squash with the tested head's tree reuses that run", () => {
    hit();
    const r = run();
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({
      reused: "https://github.invalid/runs/11",
      helm: "true",
      // The PR plan left k8s-smoke out; the push still runs it.
      k8s: "false",
      sdk_pack: "false",
    });
  });

  test("the PR run's k8s-smoke is reused when it ran", () => {
    answer({
      pulls: pr(),
      compare: { status: "ahead" },
      runs: runs(),
      jobs: {
        jobs: [
          ...withGuides(fullJobs()),
          job("k8s-smoke", "deploy/kind/smoke.sh"),
        ],
      },
    });
    expect(run().outputs.k8s).toBe("true");
  });

  const refused = (r: ReturnType<typeof run>, why: string) => {
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({
      reused: "",
      helm: "false",
      k8s: "false",
      sdk_pack: "false",
    });
    expect(r.why).toContain(why);
  };

  test("a branch merged behind main was never tested as merged", () => {
    hit();
    answer({ compare: { status: "diverged" } });
    refused(run(), "diverged");
  });

  test("a tree that differs from the head is not reused", () => {
    hit();
    answer({ pulls: pr(sha.head, sha.other) });
    refused(run({ BEFORE_SHA: sha.merge ?? "" }, sha.other), "differs");
  });

  test("a push of more than one commit runs everything", () => {
    hit();
    refused(run({ BEFORE_SHA: `${"0".repeat(39)}1` }), "more than one commit");
  });

  test("no PR, no successful run, or a failed lookup falls back", () => {
    hit();
    answer({ pulls: [] });
    refused(run(), "no pull request");
    hit();
    answer({ runs: runs(sha.head, "failure") });
    refused(run(), "no successful CI run");
    hit();
    answer({
      runs: {
        workflow_runs: [{ ...runs().workflow_runs[0], head_branch: "other" }],
      },
    });
    refused(run(), "no successful CI run");
    hit();
    answer({ fail: true });
    refused(run(), "could not look up");
    answer({ fail: false });
  });

  test("a job that passed without running its suite is no evidence", () => {
    const jobs = withGuides(fullJobs()).map((j) =>
      j.name === "e2e"
        ? job("e2e", "Alpha path against the compose stack", "skipped")
        : j,
    );
    answer({
      pulls: pr(),
      compare: { status: "ahead" },
      runs: runs(),
      jobs: { jobs },
    });
    refused(run(), "e2e Alpha path");
    const missing = withGuides(fullJobs()).filter(
      (j) => j.name !== "integration (egress)",
    );
    answer({ jobs: { jobs: missing } });
    refused(run(), "integration (egress)");
  });

  test("a web-only plan also needs the PR's unit shards", () => {
    const surface = JSON.stringify(["surface"]);
    hit();
    refused(run({ DOMAINS: surface }), "check (<part>)");
    answer({
      jobs: {
        jobs: [
          ...withGuides(fullJobs()),
          job("check (static)"),
          job("check (packages)", "Tests of this part"),
        ],
      },
    });
    expect(run({ DOMAINS: surface }).outputs.reused).toBe(
      "https://github.invalid/runs/11",
    );
  });

  test("a documentation-only push has nothing to reuse", () => {
    hit();
    refused(run({ DOCS_ONLY: "true" }), "documentation-only");
  });

  test("a malformed plan is an error, not a fallback", () => {
    expect(run({ TESTS: "yes" }).code).toBe(2);
    expect(run({ DOMAINS: "db" }).code).toBe(2);
  });
});
