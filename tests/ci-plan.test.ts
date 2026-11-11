import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readJobs } from "../.github/scripts/integration-jobs.ts";

const root = mkdtempSync(join(tmpdir(), "ci-plan-"));
const script = join(import.meta.dir, "../.github/scripts/ci-plan.sh");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function put(repo: string, path: string, body: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function commit(repo: string) {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=CI tests",
    "-c",
    "user.email=ci-tests@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return git(repo, "rev-parse", "HEAD");
}

function fixture(before: string[] = ["README.md"], after: string[] = []) {
  const repo = mkdtempSync(join(root, "repo-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  for (const path of before) put(repo, path, "before\n");
  const base = commit(repo);
  git(repo, "remote", "add", "origin", repo);
  for (const path of after) put(repo, path, "after\n");
  if (after.length > 0) commit(repo);
  const temporary = join(root, `temp-${repo.split("/").at(-1)}`);
  mkdirSync(temporary);
  return { repo, base, temporary, output: join(temporary, "output") };
}

function plan(
  f: ReturnType<typeof fixture>,
  event = "pull_request",
  base = f.base,
  baseRef = "main",
) {
  const result = Bun.spawnSync(["bash", script], {
    cwd: f.repo,
    env: {
      ...Bun.env,
      GITHUB_EVENT_NAME: event,
      BASE_SHA: base,
      BASE_REF: baseRef,
      BEFORE_SHA: base,
      GITHUB_REF: "refs/heads/main",
      RUNNER_TEMP: f.temporary,
      GITHUB_OUTPUT: f.output,
    },
  });
  const output = existsSync(f.output) ? readFileSync(f.output, "utf8") : "";
  return {
    exitCode: result.exitCode,
    output: Object.fromEntries(
      output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
    stderr: result.stderr.toString(),
  };
}

function mergePullRequest(f: ReturnType<typeof fixture>, base = f.base) {
  git(f.repo, "branch", "pull-request");
  git(f.repo, "switch", "--detach", base);
  git(
    f.repo,
    "-c",
    "user.name=CI tests",
    "-c",
    "user.email=ci-tests@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "pull-request",
  );
}

const allDomains = [
  "db",
  "sessions",
  "api",
  "surface",
  "storage",
  "docker",
  "egress",
  "worker",
];

const full = {
  tests: "true",
  product: "true",
  site: "true",
  quickstart: "true",
  docs_only: "false",
  helm: "true",
  k8s: "true",
  domains: JSON.stringify(allDomains),
};

test("prose-only PRs keep a small explicit plan", () => {
  const result = plan(fixture(undefined, ["docs/operator/settings.md"]));
  expect(result.exitCode).toBe(0);
  expect(result.output).toEqual({
    tests: "false",
    product: "false",
    site: "false",
    quickstart: "false",
    docs_only: "true",
    helm: "false",
    k8s: "false",
    domains: "[]",
  });
});

test("the full plan lists exactly the domains of the integration matrix", () => {
  const matrix = readJobs(
    readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
  ).map((job) => job.domain);
  expect(JSON.parse(plan(fixture(), "push").output.domains ?? "null")).toEqual(
    matrix,
  );
});

test("repository metadata and agent notes count as prose", () => {
  for (const path of [
    "AGENTS.md",
    "CONTRIBUTING.md",
    ".claude/skills/verify/SKILL.md",
    ".claude/skills/verify/run.sh",
    ".claude/skills/verify/scripts/shot.mjs",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/pull_request_template.md",
  ]) {
    const result = plan(fixture(undefined, [path]));
    expect(result.exitCode).toBe(0);
    expect(result.output.docs_only).toBe("true");
    expect(result.output.domains).toBe("[]");
  }
});

test("generated, executable and workflow files next to prose are not prose", () => {
  for (const path of [
    "THIRD_PARTY_NOTICES.md",
    "CHANGELOG.md",
    ".claude/skills/verify-werft/github-sandbox/settings.json",
    ".github/workflows/ci.yml",
    ".github/actions/setup/README.md",
    ".github/scripts/ci-plan.sh",
  ]) {
    expect(plan(fixture(undefined, [path])).output).toEqual(full);
  }
});

test("a web-only PR drops the domains, chart jobs and guides no changed path reaches", () => {
  for (const path of ["apps/web/src/app.tsx"]) {
    const result = plan(
      fixture(undefined, [path, "docs/operator/settings.md"]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({
      tests: "true",
      product: "true",
      site: "true",
      quickstart: "false",
      docs_only: "false",
      helm: "false",
      k8s: "false",
      domains: '["surface"]',
    });
  }
});

test("the egress proxy stays on the full plan: service-backed suites import it", () => {
  const result = plan(fixture(undefined, ["apps/egress-proxy/src/a.ts"]));
  expect(result.output).toEqual(full);
});

test("any shared path next to a web change brings back everything", () => {
  for (const shared of [
    "packages/core/src/a.ts",
    "apps/control-host/src/a.ts",
    "apps/worker/src/a.ts",
    "bun.lock",
    "package.json",
    "tests/a.test.ts",
    "deploy/helm/werft/values.yaml",
    "compose.yaml",
    "scripts/a.ts",
  ]) {
    expect(
      plan(fixture(undefined, ["apps/web/src/a.ts", shared])).output,
    ).toEqual(full);
  }
});

test("site content keeps the current docs and assembly chain", () => {
  const result = plan(fixture(undefined, ["apps/docs/content/docs/intro.mdx"]));
  expect(result.exitCode).toBe(0);
  expect(result.output.site).toBe("true");
  expect(result.output.product).toBe("false");
});

test("both executable guides keep quickstart even in a docs-only PR", () => {
  for (const path of [
    "docs/quickstart.md",
    "apps/docs/content/docs/reference/api-guide.mdx",
  ]) {
    const result = plan(fixture(undefined, [path]));
    expect(result.exitCode).toBe(0);
    expect(result.output.quickstart).toBe("true");
    expect(result.output.docs_only).toBe("true");
  }
});

test("mixed, unknown, workflow and dependency changes always use the full plan", () => {
  for (const path of [
    "packages/db/src/query.ts",
    ".github/workflows/ci.yml",
    "bun.lock",
    "apps/docs/next.config.ts",
    "new-directory/file.md",
    "packages/x/README.md",
    "docs/page.MD",
    "apps/docs/content/docs/meta.json",
  ]) {
    const result = plan(
      fixture(undefined, ["docs/operator/settings.md", path]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual(full);
  }
});

test("manual and empty PR diffs use the full plan; main delegates the site", () => {
  for (const event of ["push", "workflow_dispatch", "pull_request"]) {
    const result = plan(fixture(), event);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual(
      event === "push" ? { ...full, site: "false" } : full,
    );
  }
});

test("stacked or unknown PR bases keep full validation before retargeting", () => {
  for (const baseRef of ["feature/code", ""]) {
    const f = fixture(undefined, ["docs/prose.md"]);
    expect(plan(f, "pull_request", f.base, baseRef).output).toEqual(full);
  }
});

test("an empty diff with a matching checkout parent keeps full validation", () => {
  const f = fixture(undefined, ["docs/prose.md"]);
  git(f.repo, "revert", "--no-commit", "HEAD");
  commit(f.repo);
  mergePullRequest(f);
  expect(git(f.repo, "diff", "--name-only", f.base, "HEAD")).toBe("");
  expect(plan(f).output).toEqual(full);
});

test("a later prose commit cannot hide code already in the PR", () => {
  const f = fixture(undefined, ["packages/a.ts"]);
  put(f.repo, "docs/operator/settings.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f);
  expect(plan(f).output).toEqual(full);
});

test("a merge checkout keeps multi-commit prose PRs eligible", () => {
  const f = fixture(undefined, ["docs/first.md"]);
  put(f.repo, "docs/second.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f);
  expect(plan(f).output.docs_only).toBe("true");
});

test("an event base that differs from the checkout parent uses full validation", () => {
  const f = fixture(["README.md", "packages/a.ts"], ["packages/a.ts"]);
  const actualBase = git(f.repo, "rev-parse", "HEAD");
  put(f.repo, "packages/a.ts", "before\n");
  put(f.repo, "docs/prose.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f, actualBase);
  expect(plan(f).output).toEqual(full);
});

test("renames and deletions classify the old path as well as the new one", () => {
  const f = fixture(["packages/a.ts"]);
  mkdirSync(join(f.repo, "docs"));
  git(f.repo, "mv", "packages/a.ts", "docs/renamed.md");
  commit(f.repo);
  expect(plan(f).output).toEqual(full);
  const deleted = fixture(["README.md", "docs/operator/settings.md"]);
  git(deleted.repo, "rm", "docs/operator/settings.md");
  commit(deleted.repo);
  expect(plan(deleted).output.docs_only).toBe("true");
});

test("spaces, quotes and newlines in paths stay data", () => {
  const f = fixture(undefined, ["docs/space ' quote\nname.md"]);
  const result = plan(f);
  expect(result.exitCode).toBe(0);
  expect(result.output.docs_only).toBe("true");
});

test("invalid bases and failed fetches fail before publishing any plan", () => {
  const invalid = fixture(undefined, ["docs/intro.md"]);
  const result = plan(invalid, "pull_request", "--upload-pack=unexpected");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toEqual({});
  const missing = fixture(undefined, ["docs/intro.md"]);
  git(missing.repo, "remote", "set-url", "origin", join(root, "missing"));
  const failed = plan(missing);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.output).toEqual({});
});

test("main push plans the entire before-to-head range, including multiple commits", () => {
  const docs = fixture(undefined, ["docs/first.md"]);
  put(docs.repo, "docs/second.md", "prose\n");
  commit(docs.repo);
  expect(plan(docs, "push").output.docs_only).toBe("true");
  const mixed = fixture(undefined, ["packages/core/src/a.ts"]);
  put(mixed.repo, "docs/second.md", "prose\n");
  commit(mixed.repo);
  expect(plan(mixed, "push").output).toEqual({ ...full, site: "false" });
});

test("new main branch and manual runs retain full validation", () => {
  const f = fixture(undefined, ["docs/intro.md"]);
  expect(plan(f, "push", "0".repeat(40)).output).toEqual({
    ...full,
    site: "false",
  });
  expect(plan(f, "workflow_dispatch").output).toEqual(full);
  expect(plan(f, "schedule").output).toEqual(full);
});

test("main site content stays delegated while PR and manual site validation remain planned", () => {
  const paths = ["apps/docs/content/docs/intro.mdx"];
  expect(plan(fixture(undefined, paths), "push").output.site).toBe("false");
  expect(plan(fixture(undefined, paths)).output.site).toBe("true");
  expect(plan(fixture(undefined, paths), "workflow_dispatch").output.site).toBe(
    "true",
  );
});
