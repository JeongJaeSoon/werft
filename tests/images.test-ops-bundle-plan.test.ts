import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// .github/scripts/test-ops-bundle-plan.sh against a real git history: a main
// push leaves test-ops-bundle out only when its one commit onto `before`
// changes none of the bundle's inputs (test-ops-bundle.sh --inputs) or the
// job's own, and builds on any doubt.

const root = join(import.meta.dir, "..");
let repo = "";
let summary = "";

function git(...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: repo,
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
function put(path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
function commit(path: string, text = `${Math.random()}\n`) {
  put(path, text);
  git("add", ".");
  git("commit", "--quiet", "-m", path);
  return git("rev-parse", "HEAD");
}

function plan(before: string, sha = git("rev-parse", "HEAD")) {
  writeFileSync(summary, "");
  const run = Bun.spawnSync(
    ["bash", ".github/scripts/test-ops-bundle-plan.sh"],
    {
      cwd: repo,
      env: {
        PATH: Bun.env.PATH ?? "",
        GITHUB_SHA: sha,
        BEFORE_SHA: before,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    why: run.stderr.toString(),
    summary: readFileSync(summary, "utf8"),
  };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "test-ops-bundle-plan-"));
  summary = join(repo, "..", `${repo.split("/").pop()}-summary.md`);
  git("init", "--quiet", "--initial-branch=main");
  for (const path of [
    ".github/scripts/test-ops-bundle.sh",
    ".github/scripts/test-ops-bundle-plan.sh",
  ]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    cpSync(join(root, path), join(repo, path));
  }
  put(
    "infra/compose.core.yml",
    "services:\n  postgres:\n    volumes:\n      - ../packages/db/migrations/0000_a.sql:/docker-entrypoint-initdb.d/0000_a.sql:ro\n",
  );
  put("packages/db/migrations/0000_a.sql", "select 1;\n");
  put("packages/db/migrations/0001_b.sql", "select 2;\n");
  put("apps/web/a.ts", "a\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(summary, { force: true });
});

describe("test-ops-bundle-plan.sh", () => {
  test("a commit outside the bundle's inputs leaves it out, and says so in the summary", () => {
    const before = git("rev-parse", "HEAD");
    const sha = commit("apps/web/a.ts");
    // A migration compose.core.yml does not mount is not in the bundle.
    const r = plan(before, sha);
    expect(r).toMatchObject({ code: 0, out: "ops_bundle=skip\n" });
    expect(r.summary).toBe(
      `test-ops-bundle left out: no bundle input changed in ${before}..${sha}\n`,
    );
    const next = commit("packages/db/migrations/0001_b.sql");
    expect(plan(sha, next).out).toBe("ops_bundle=skip\n");
  });

  test.each([
    "scripts/test-ops.sh",
    "infra/compose.test-ops.yml",
    "infra/compose.core.yml",
    "packages/db/migrations/0000_a.sql",
    ".github/scripts/test-ops-bundle.sh",
    "tests/fixtures/test-ops-release-manifest.json",
    ".github/workflows/images.yml",
    ".github/scripts/test-ops-bundle-plan.sh",
  ])("a commit that changes %s builds it", (path) => {
    const before = git("rev-parse", "HEAD");
    const keep =
      path === "infra/compose.core.yml" || path.startsWith(".github/scripts/")
        ? `${readFileSync(join(repo, path), "utf8")}# ${Math.random()}\n`
        : undefined;
    const r = plan(before, commit(path, keep));
    expect(r).toMatchObject({
      code: 0,
      out: "ops_bundle=build\n",
      summary: "",
    });
    expect(r.why).toContain(`${path} changed`);
  });

  test("no previous commit, a force push or several commits build it", () => {
    const first = git("rev-parse", "HEAD");
    commit("apps/web/a.ts");
    const sha = commit("apps/web/a.ts");
    for (const [before, why] of [
      ["", "no previous commit"],
      ["0".repeat(40), "no previous commit"],
      ["not-a-sha", "no previous commit"],
      // Two commits, or a before that is not HEAD^ (a force push).
      [first, "HEAD^ is not the push's before"],
    ] as const) {
      const r = plan(before, sha);
      expect(r).toMatchObject({
        code: 0,
        out: "ops_bundle=build\n",
        summary: "",
      });
      expect(r.why).toContain(why);
    }
    expect(plan(git("rev-parse", "HEAD^"), first).why).toContain(
      "not the pushed commit",
    );
  });

  test("a .gitattributes change, anywhere, builds it", () => {
    for (const path of [".gitattributes", "scripts/.gitattributes"]) {
      const before = git("rev-parse", "HEAD");
      const r = plan(
        before,
        commit(path, `*.sh text eol=crlf # ${Math.random()}\n`),
      );
      expect(r).toMatchObject({
        code: 0,
        out: "ops_bundle=build\n",
        summary: "",
      });
      expect(r.why).toContain(`${path} changed`);
    }
  });

  test("a mounted path git would quote is still matched", () => {
    const odd = "packages/db/migrations/0002_ré b.sql";
    put(odd, "select 3;\n");
    put(
      "infra/compose.core.yml",
      `${readFileSync(join(repo, "infra/compose.core.yml"), "utf8")}      - ../${odd}:/docker-entrypoint-initdb.d/0002.sql:ro\n`,
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "odd mount");
    const before = git("rev-parse", "HEAD");
    const r = plan(before, commit(odd, "select 4;\n"));
    expect(r).toMatchObject({ code: 0, out: "ops_bundle=build\n" });
    expect(r.why).toContain("changed");
  });

  test("an input that is a symlink builds it, whatever changed", () => {
    put("scripts/target.sh", "echo t\n");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    rmSync(join(repo, "scripts/test-ops.sh"), { force: true });
    symlinkSync("target.sh", join(repo, "scripts/test-ops.sh"));
    git("add", ".");
    git("commit", "--quiet", "-m", "link");
    const before = git("rev-parse", "HEAD");
    const r = plan(before, commit("scripts/target.sh"));
    expect(r).toMatchObject({ code: 0, out: "ops_bundle=build\n" });
    expect(r.why).toContain("an input is a symlink: scripts/test-ops.sh");
    rmSync(join(repo, "scripts/test-ops.sh"));
    put("scripts/test-ops.sh", "echo real\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "unlink");
  });

  test("a list it cannot read builds it", () => {
    const before = git("rev-parse", "HEAD");
    commit("infra/compose.core.yml", "services: {}\n");
    const sha = commit("apps/web/a.ts");
    const r = plan(git("rev-parse", "HEAD^"), sha);
    expect(r).toMatchObject({ code: 0, out: "ops_bundle=build\n" });
    expect(r.why).toContain("--inputs gave no list");
    expect(before).not.toBe(sha);
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

  test("only a main push that builds images asks, with the workflow's read-only token", () => {
    const plan = jobs.plan;
    expect(plan?.permissions).toBeUndefined();
    const step = plan?.steps?.find((s) => s.id === "bundle");
    expect(step?.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.images.outputs.images == 'build'",
    );
    expect(step?.run).toBe(
      'bash .github/scripts/test-ops-bundle-plan.sh >>"$GITHUB_OUTPUT"',
    );
    expect(step?.env).toEqual({ BEFORE_SHA: "${{ github.event.before }}" });
  });

  test("the bundle follows the image plan unless a main push proved nothing changed", () => {
    // A PR, tag, scheduled or manual run never runs the step, so its plan is
    // the image plan itself, as before.
    expect(jobs.plan?.outputs?.ops_bundle).toBe(
      "${{ steps.bundle.outcome == 'success' && steps.bundle.outputs.ops_bundle == 'skip' && 'skip' || steps.images.outputs.images }}",
    );
    // A planner that breaks builds the bundle rather than failing the plan.
    const step = jobs.plan?.steps?.find((s) => s.id === "bundle") as
      | { "continue-on-error"?: boolean }
      | undefined;
    expect(step?.["continue-on-error"]).toBe(true);
    expect(jobs["test-ops-bundle"]?.if).toBe(
      "needs.plan.outputs.ops_bundle == 'build'",
    );
    // No required check waits on it, so leaving it out stops nothing.
    for (const job of Object.values(jobs)) {
      expect([job.needs ?? []].flat()).not.toContain("test-ops-bundle");
    }
  });
});
