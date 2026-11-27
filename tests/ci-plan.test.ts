import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
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

/** A `gh` that answers every tag lookup the same way. */
function fakeGh(answer: "tagged" | "untagged" | "down") {
  const directory = mkdtempSync(join(root, "gh-"));
  const body = {
    tagged: "exit 0",
    // No tag (a confirmed 404) and no Release.
    untagged:
      'case "$*" in */git/ref/tags/*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;; esac',
    down: "echo 'gh: HTTP 502' >&2; exit 1",
  }[answer];
  writeFileSync(join(directory, "gh"), `#!/usr/bin/env bash\n${body}\n`, {
    mode: 0o755,
  });
  return directory;
}

function plan(
  f: ReturnType<typeof fixture>,
  event = "pull_request",
  base = f.base,
  baseRef = "main",
  gh: Parameters<typeof fakeGh>[0] = "tagged",
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
      GH_REPO: "owner/repo",
      PATH: `${fakeGh(gh)}:${Bun.env.PATH}`,
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
  demo: "true",
  ui_pack: "true",
};

/**
 * The full plan of a pull request that touches nothing k8s-smoke, the docs
 * site, the chart checks, the demo build or the packed UI library build from.
 */
const shared = {
  ...full,
  k8s: "false",
  site: "false",
  helm: "false",
  demo: "false",
  ui_pack: "false",
};
/** A main push of such a path: it keeps every conditional job but the site. */
const pushShared = { ...full, k8s: "false", site: "false" };
/** Paths that keep k8s-smoke on a pull request (ci-plan.sh is_k8s_path). */
const K8S_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/scripts/ci-plan.sh",
  ".github/actions/setup/README.md",
  "bun.lock",
  "deploy/helm/werft/values.yaml",
]);
/** Paths every conditional job builds from (ci-plan.sh is_ci_core_path). */
const CORE_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/scripts/ci-plan.sh",
  ".github/actions/setup/README.md",
  "bun.lock",
  "package.json",
]);
/** The plan of a pull request of one path, for the paths these tests use. */
function prPlan(path: string) {
  const on = (own: boolean) => (CORE_PATHS.has(path) || own ? "true" : "false");
  return {
    ...full,
    k8s: K8S_PATHS.has(path) ? "true" : "false",
    site: on(/^(apps\/docs|packages\/ui)\//.test(path)),
    helm: on(path.startsWith("deploy/helm/")),
    demo: on(
      /^(apps\/web|packages\/(ui|react|core|client|contracts))\//.test(path),
    ),
    ui_pack: on(path.startsWith("packages/ui/")),
  };
}

test("prose-only PRs keep a small explicit plan", () => {
  const result = plan(fixture(undefined, ["docs/settings.md"]));
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
    demo: "false",
    ui_pack: "false",
  });
});

test("the full plan lists exactly the declared integration domains", () => {
  const matrix = readJobs(
    readFileSync(
      join(import.meta.dir, "../.github/integration-domains.yml"),
      "utf8",
    ),
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
    "scripts/verify/github-sandbox/settings.json",
    "scripts/verify/up.sh",
    ".github/workflows/ci.yml",
    ".github/actions/setup/README.md",
    ".github/scripts/ci-plan.sh",
  ]) {
    expect(plan(fixture(undefined, [path])).output).toEqual(prPlan(path));
  }
});

test("a web-only PR drops the domains, chart jobs and guides no changed path reaches", () => {
  for (const path of ["apps/web/src/app.tsx"]) {
    const result = plan(fixture(undefined, [path, "docs/settings.md"]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({
      tests: "true",
      product: "true",
      site: "false",
      quickstart: "false",
      docs_only: "false",
      helm: "false",
      k8s: "false",
      domains: '["surface"]',
      demo: "true",
      ui_pack: "false",
    });
  }
});

test("a web-only PR still drops k8s-smoke for a path its list would match", () => {
  for (const path of ["apps/web/Dockerfile", "apps/web/package.json"]) {
    expect(plan(fixture(undefined, [path])).output.k8s).toBe("false");
  }
});

test("the egress proxy stays on the full plan: service-backed suites import it", () => {
  const result = plan(fixture(undefined, ["apps/egress-proxy/src/a.ts"]));
  expect(result.output).toEqual(shared);
});

test("any shared path next to a web change brings back everything", () => {
  for (const path of [
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
    // apps/web is what the demo builds.
    expect(
      plan(fixture(undefined, ["apps/web/src/a.ts", path])).output,
    ).toEqual({ ...prPlan(path), demo: "true" });
  }
});

test("a pull request runs k8s-smoke only for what the kind install builds or runs", () => {
  for (const path of [
    "deploy/kind/up.sh",
    "deploy/helm/werft/templates/api.yaml",
    "packages/adapters/execution/kubernetes/src/backend.ts",
    "apps/control-host/src/scheduler/launch.ts",
    "packages/platform/src/scheduler/index.ts",
    "packages/testkit/src/local-github-main.ts",
    "packages/testkit/src/fake-messages-main.ts",
    "infra/localstack/init/10-create-resources.sh",
    "apps/worker/Dockerfile",
    "bun.lock",
    ".github/actions/image-cache/action.yml",
  ]) {
    expect({ path, k8s: plan(fixture(undefined, [path])).output.k8s }).toEqual({
      path,
      k8s: "true",
    });
  }
  for (const path of [
    "packages/db/src/a.ts",
    "apps/control-host/src/api/a.ts",
    "apps/worker/src/a.ts",
  ]) {
    expect({ path, plan: plan(fixture(undefined, [path])).output }).toEqual({
      path,
      plan: shared,
    });
  }
});

/** Paths only a main push runs the kind jobs for (ci-plan.sh is_publish_path). */
const PUBLISH_PATHS = [
  ".github/workflows/images.yml",
  ".github/scripts/chart-package.ts",
  ".github/scripts/chart-push.sh",
  ".github/scripts/image-promote.sh",
  ".github/scripts/release-auto.sh",
  "scripts/k8s-api.sh",
  "scripts/lib/seed-credentials.sh",
  "scripts/image-prune.sh",
  "scripts/fetch-pinned.ts",
  "package.json",
  "apps/worker/package.json",
  "bunfig.toml",
  "tsconfig.base.json",
  "packages/adapters/runtimes/registry/src/index.ts",
  "packages/runtime-core/src/image-runtime.ts",
  "apps/worker/src/image-runtime.ts",
  "apps/worker/git-hooks/pre-push",
  "packages/testkit/src/seed-credentials-main.ts",
  "packages/testkit/src/fake-github.ts",
  "packages/testkit/src/git-http.ts",
  "apps/control-host/src/api/settings.ts",
  "apps/web/package.json",
  "THIRD_PARTY_NOTICES.md",
  "scripts/third-party-notices.ts",
  "tests/e2e/owner-cookie.ts",
  "tests/e2e/client.ts",
  "tests/fixtures/settings/fake-model.json",
];

test("a main push runs the kind jobs only for chart, image and deploy paths", () => {
  for (const path of [
    "deploy/helm/werft/values.yaml",
    "deploy/kind/smoke.sh",
    "apps/worker/Dockerfile",
    ".dockerignore",
    "bun.lock",
    ".github/workflows/ci.yml",
    ...PUBLISH_PATHS,
  ]) {
    // Alone: no other path may be what selects it.
    const f = fixture(undefined, [path]);
    expect({ path, k8s: plan(f, "push").output.k8s }).toEqual({
      path,
      k8s: "true",
    });
  }
  const f = fixture(undefined, [
    "packages/db/src/a.ts",
    "apps/control-host/src/api/a.ts",
    // Generated from the API on most changes to it: image content, like source.
    "docs/api/index.html",
    "tests/a.test.ts",
  ]);
  expect(plan(f, "push").output).toEqual({
    ...full,
    site: "false",
    k8s: "false",
  });
});

test("the paths a main push adds leave a pull request's selection alone", () => {
  for (const path of PUBLISH_PATHS) {
    expect({ path, k8s: plan(fixture(undefined, [path])).output.k8s }).toEqual({
      path,
      k8s: "false",
    });
  }
});

describe("a main commit a release needs runs the kind jobs", () => {
  const changelog = (...versions: string[]) =>
    ["# Changelog", ...versions.map((v) => `## ${v}`), ""].join("\n");
  /** A push of `path` onto a main whose CHANGELOG already holds `before`. */
  function push(
    before: string[],
    gh: Parameters<typeof fakeGh>[0],
    path = "packages/db/src/a.ts",
    after = before,
  ) {
    const f = fixture();
    put(f.repo, "CHANGELOG.md", changelog(...before));
    const base = commit(f.repo);
    put(f.repo, "CHANGELOG.md", changelog(...after));
    put(f.repo, path, "after\n");
    commit(f.repo);
    const result = plan(f, "push", base, "main", gh);
    expect(result.exitCode).toBe(0);
    return result.output.k8s;
  }

  test("the push that adds the version heading", () => {
    expect(
      push(["v0.1.0"], "untagged", "docs/a.md", ["v0.2.0", "v0.1.0"]),
    ).toBe("true");
  });

  test("a heading added below the top one", () => {
    expect(
      push(["v0.2.0"], "untagged", "packages/a.ts", ["v0.2.0", "v0.1.1"]),
    ).toBe("true");
  });

  test("a later push while that version has no tag, a docs-only one too", () => {
    for (const path of ["packages/db/src/a.ts", "docs/a.md"]) {
      expect(push(["v0.2.0"], "untagged", path)).toBe("true");
    }
  });

  test("a failed lookup, or a heading that is no version", () => {
    expect(push(["v0.2.0"], "down")).toBe("true");
    expect(push(["vNext"], "tagged")).toBe("true");
  });

  test("not an ordinary push after the release is tagged", () => {
    expect(push(["v0.2.0"], "tagged")).toBe("false");
    expect(push(["v0.2.0"], "tagged", "docs/a.md")).toBe("false");
  });
});

test("both workflows give the plan what the release lookup needs", () => {
  for (const [file, job] of [
    ["ci.yml", "changes"],
    ["images.yml", "plan"],
  ] as const) {
    const workflow = Bun.YAML.parse(
      readFileSync(join(import.meta.dir, "../.github/workflows", file), "utf8"),
    ) as {
      jobs: Record<
        string,
        { steps: { id?: string; env?: Record<string, string> }[] }
      >;
    };
    expect(
      workflow.jobs[job]?.steps.find((step) => step.id === "plan")?.env,
    ).toMatchObject({
      GH_REPO: "$" + "{{ github.repository }}",
      GH_TOKEN: "$" + "{{ github.token }}",
    });
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
    const result = plan(fixture(undefined, ["docs/settings.md", path]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual(prPlan(path));
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
  put(f.repo, "docs/settings.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f);
  expect(plan(f).output).toEqual(shared);
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
  expect(plan(f).output).toEqual(shared);
  const deleted = fixture(["README.md", "docs/settings.md"]);
  git(deleted.repo, "rm", "docs/settings.md");
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

test("a main push whose before cannot be read keeps the full plan", () => {
  const f = fixture(undefined, ["docs/intro.md"]);
  for (const base of ["not-a-sha", "1".repeat(40)]) {
    const result = plan(f, "push", base);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({ ...full, site: "false" });
  }
});

test("main push plans the entire before-to-head range, including multiple commits", () => {
  const docs = fixture(undefined, ["docs/first.md"]);
  put(docs.repo, "docs/second.md", "prose\n");
  commit(docs.repo);
  expect(plan(docs, "push").output.docs_only).toBe("true");
  const mixed = fixture(undefined, ["packages/core/src/a.ts"]);
  put(mixed.repo, "docs/second.md", "prose\n");
  commit(mixed.repo);
  expect(plan(mixed, "push").output).toEqual(pushShared);
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

/** The is_*_path functions of ci-plan.sh, run on each path: the paths it accepts. */
function accepted(fn: string, paths: string[]) {
  const body = readFileSync(script, "utf8");
  const defs = [...body.matchAll(/^is_[a-z_]+\(\) \{\n[\s\S]*?^\}$/gm)]
    .map(([def]) => def)
    .join("\n");
  const out = Bun.spawnSync(
    [
      "bash",
      "-c",
      `${defs}\nwhile IFS= read -r p; do ${fn} "$p" && printf '%s\\n' "$p"; done`,
    ],
    { stdin: new TextEncoder().encode(`${paths.join("\n")}\n`) },
  );
  return new Set(out.stdout.toString().split("\n").filter(Boolean));
}

/**
 * What a job's files reach: relative imports, CSS @import and @source, the
 * workspace packages they import (as each package.json), and relative path
 * strings such as "../../docs/openapi.json". Not followed: paths built from
 * pieces, which a reviewer of the job's own files has to catch.
 */
function reach(entries: string[]) {
  const repo = join(import.meta.dir, "..");
  const isFile = (p: string) =>
    statSync(join(repo, p), { throwIfNoEntry: false })?.isFile() ?? false;
  const workspaces = new Map<string, string>();
  for (const pattern of JSON.parse(
    readFileSync(join(repo, "package.json"), "utf8"),
  ).workspaces as string[]) {
    const parent = pattern.replace(/\/\*$/, "");
    for (const name of readdirSync(join(repo, parent))) {
      const manifest = join(repo, parent, name, "package.json");
      if (existsSync(manifest))
        workspaces.set(
          JSON.parse(readFileSync(manifest, "utf8")).name,
          `${parent}/${name}`,
        );
    }
  }
  const seen = new Set<string>();
  const reached = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    reached.add(file);
    if (!/\.(m?[jt]sx?|css)$/.test(file)) continue;
    const text = readFileSync(join(repo, file), "utf8");
    const resolve = (spec: string) => normalize(join(dirname(file), spec));
    for (const [, spec = ""] of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|@source\s+|@import\s+)["']([^"']+)["']/g,
    )) {
      if (spec.startsWith(".")) {
        const base = resolve(spec);
        const found = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
          base.replace(/\.js$/, ".ts"),
          base.replace(/\.js$/, ".tsx"),
        ].find(isFile);
        if (found) stack.push(found);
        else reached.add(`${base}/`);
      } else {
        const parts = spec.split("/");
        const name = spec.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
        const dir = workspaces.get(name ?? "");
        if (dir) reached.add(`${dir}/package.json`);
      }
    }
    // Such a string may be relative to a root the file names (join(ROOT,
    // "../../LICENSE")), not to the file: every ancestor's reading that exists
    // counts, and with none the file's own reading must match.
    for (const [, spec = ""] of text.matchAll(
      /["'`]((?:\.\.\/)+[^"'`$]+)["'`]/g,
    )) {
      const readings: string[] = [];
      for (let dir = dirname(file); dir !== "."; dir = dirname(dir))
        readings.push(normalize(join(dir, spec)));
      const existing = readings.filter((path) => existsSync(join(repo, path)));
      for (const path of existing.length > 0 ? existing : [resolve(spec)])
        reached.add(isFile(path) ? path : `${path.replace(/\/$/, "")}/`);
    }
  }
  return [...reached].filter((path) => !path.startsWith(".."));
}

function filesUnder(dir: string): string[] {
  const repo = join(import.meta.dir, "..");
  return readdirSync(join(repo, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        ["node_modules", "dist", "out"].includes(entry.name) ||
        entry.name.startsWith(".")
      )
        return [];
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(path) : [path];
    },
  );
}

const source = (dir: string) =>
  filesUnder(dir).filter((file) => !/\.test\.[jt]sx?$/.test(file));

test.each([
  // The job's own files: what its steps build or run (ci.yml).
  [
    "is_site_path",
    () => [...source("apps/docs"), "scripts/check-docs-self-hosting-export.ts"],
  ],
  [
    "is_helm_path",
    () => [...filesUnder("deploy/helm"), "scripts/fetch-pinned.ts"],
  ],
  [
    "is_ui_pack_path",
    () => [...source("packages/ui"), "scripts/ui-pack-smoke.ts"],
  ],
  ["is_demo_path", () => source("apps/web")],
] as const)("%s names every path its job's files reach", (fn, entries) => {
  const reached = reach(entries());
  const ok = accepted(fn, reached);
  expect(reached.filter((path) => !ok.has(path))).toEqual([]);
});

test("a pull request of a path no conditional job builds from leaves them all out", () => {
  const repo = fixture(undefined, ["packages/db/src/a.ts"]);
  expect(plan(repo).output).toMatchObject({
    site: "false",
    helm: "false",
    demo: "false",
    ui_pack: "false",
  });
  // A main push of it keeps them for ci-reuse.sh to take from the PR run.
  expect(plan(repo, "push").output).toMatchObject({
    helm: "true",
    demo: "true",
    ui_pack: "true",
  });
});
