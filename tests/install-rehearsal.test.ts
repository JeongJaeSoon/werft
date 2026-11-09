import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const text = readFileSync(
  join(root, ".github/workflows/install-rehearsal.yml"),
  "utf8",
);

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = { needs?: string; steps: Step[] };
const workflow = Bun.YAML.parse(text) as {
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

describe("install rehearsal workflow", () => {
  test("reads with contents: read only and never needs a credential", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/packages:/);
    expect(text).not.toMatch(
      /docker\/login-action|docker login|helm registry login/,
    );
  });

  test("pins every action by a full commit sha", () => {
    const uses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .map((step) => step.uses)
      .filter((use): use is string => use !== undefined)
      .filter((use) => !use.startsWith("./"));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  test("installs only what the release publishes", () => {
    // No image is built and no chart is packaged from this checkout.
    expect(text).not.toMatch(
      /docker (buildx )?build|chart-package|deploy\/helm/,
    );
    expect(text).not.toMatch(/local\.sh/);
    const compose = workflow.jobs.compose;
    const checkout = compose?.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    expect(text).toContain("ref: ${{ needs.release.outputs.commit }}");
    const kind = workflow.jobs.kind?.steps.map((step) => step.run ?? "") ?? [];
    expect(kind.some((run) => run.includes("helm pull"))).toBe(true);
    expect(kind.some((run) => run.includes("CHART_PACKAGE="))).toBe(true);
  });

  test("the pull steps run with a Docker and Helm config that holds no login", () => {
    const runs = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.map((step) => step.run ?? ""),
    );
    const pulls = runs.filter(
      (run) => run.includes("docker pull") || run.includes("helm pull"),
    );
    expect(pulls).toHaveLength(2);
    for (const run of pulls)
      expect(run).toContain('DOCKER_CONFIG="$RUNNER_TEMP/no-login"');
  });

  test("passes the dispatch inputs through env, not into the script text", () => {
    expect(text).not.toMatch(/run:[^\n]*\$\{\{ *github\.event\.inputs/);
    const read = workflow.jobs.release?.steps.find((step) => step.run);
    expect(read?.run).not.toContain("${{");
  });

  test("the compose job's readiness check requires a 200", () => {
    expect(text).toContain("/readyz");
    expect(text).toContain('[ "$code" = 200 ]');
  });
});

describe("rehearsal-release.sh", () => {
  const script = join(root, ".github/scripts/rehearsal-release.sh");
  const run = (...args: string[]) =>
    Bun.spawnSync(["bash", script, ...args], {
      env: { PATH: process.env.PATH ?? "", REHEARSAL_REPOSITORY: "o/r" },
    });

  test("refuses a tag that is not a release tag before any request", () => {
    const result = run("main", "/nonexistent-out");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a release tag");
  });

  test("refuses an override that is not a sha256 digest", () => {
    const result = run("v1.2.3", "/nonexistent-out", "latest");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a digest");
  });
});
