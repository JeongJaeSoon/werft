import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const parse = (file: string) =>
  Bun.YAML.parse(readFileSync(join(root, file), "utf8")) as {
    on: Record<
      string,
      { branches?: string[]; tags?: string[]; paths?: string[] } | null
    >;
    concurrency?: { group: string; "cancel-in-progress": boolean };
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string | string[];
        permissions?: Record<string, string>;
        environment?: { name: string };
        outputs?: Record<string, string>;
        steps?: {
          name?: string;
          run?: string;
          uses?: string;
          id?: string;
          if?: string;
          env?: Record<string, string>;
          with?: Record<string, string | number>;
          "continue-on-error"?: boolean;
        }[];
        "timeout-minutes"?: number;
      }
    >;
  };

const pages = parse(".github/workflows/pages.yml");
const ci = parse(".github/workflows/ci.yml");

describe("pages.yml", () => {
  test("runs on a release tag or by hand, never on a main push or a pull request", () => {
    expect(Object.keys(pages.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(pages.on.push).toEqual({ tags: ["v*"] });
    // The release tag images.yml publishes on, not the sdk-v*/ui-v* packages.
    const images = Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
    ) as { on: { push: { tags: string[] } } };
    expect(images.on.push.tags).toEqual(pages.on.push?.tags);
  });

  test("queues deploys instead of cancelling a running one", () => {
    // One group for the runs that can deploy; any other ref gets its own, or
    // it would replace a waiting run that can.
    expect(pages.concurrency).toEqual({
      group:
        "pages-${{ (startsWith(github.ref, 'refs/tags/v') || github.ref == 'refs/heads/main') && 'deploy' || github.run_id }}",
      "cancel-in-progress": false,
    });
  });

  test("picks what the site should be before anything is built", () => {
    const target = pages.jobs.target;
    expect(target?.needs).toBeUndefined();
    // The run list holds the manual runs on main.
    expect(target?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(target?.outputs).toEqual({ sha: "${{ steps.target.outputs.sha }}" });
    const steps = target?.steps ?? [];
    // Ancestry on main needs the whole history and every tag.
    expect(steps[0]?.with).toEqual({ "fetch-depth": 0 });
    const pick = steps.find((s) => s.id === "target");
    expect(pick?.run).toBe(".github/scripts/pages-target.sh");
    expect(Object.keys(pick?.env ?? {}).sort()).toEqual([
      "GH_REPO",
      "GH_TOKEN",
    ]);
    expect(pages.jobs.docs?.needs).toEqual(["target"]);
  });

  test("only the deploy job can write to Pages, and only from a release tag or main with Pages enabled", () => {
    expect(pages.permissions).toEqual({ contents: "read" });
    const writers = Object.entries(pages.jobs)
      .filter(([, job]) => job.permissions?.pages === "write")
      .map(([name]) => name);
    expect(writers).toEqual(["deploy"]);
    const deploy = pages.jobs.deploy;
    expect(deploy?.needs).toEqual(["target", "docs"]);
    expect(deploy?.if).toBe(
      "(startsWith(github.ref, 'refs/tags/v') || github.ref == 'refs/heads/main') && vars.PAGES_ENABLED == 'true'",
    );
    expect(deploy?.environment?.name).toBe("github-pages");
    // A tag can point anywhere; deploy only reviewed commits, before upload.
    const steps = deploy?.steps ?? [];
    const onMain = steps.findIndex((s) => s.name === "Commit must be on main");
    expect(steps[onMain]?.env).toEqual({
      TARGET_SHA: "${{ needs.target.outputs.sha }}",
    });
    expect(steps[onMain]?.run).toContain(
      'git merge-base --is-ancestor "$TARGET_SHA" origin/main',
    );
    const firstUpload = steps.findIndex((s) =>
      s.uses?.startsWith("actions/upload-pages-artifact@"),
    );
    expect(onMain).toBeGreaterThan(-1);
    expect(onMain).toBeLessThan(firstUpload);
  });

  test("a stalled Pages deployment is abandoned early and tried once more inside the job limit", () => {
    const deploy = pages.jobs.deploy;
    const steps = deploy?.steps ?? [];
    const attempts = steps.filter((s) =>
      s.uses?.startsWith("actions/deploy-pages@"),
    );
    expect(attempts.map((s) => s.id)).toEqual(["deploy", "retry"]);
    expect(attempts[0]?.["continue-on-error"]).toBe(true);
    expect(attempts[1]?.if).toBe("steps.deploy.outcome == 'failure'");
    const waitMs = attempts.map((s) => Number(s.with?.timeout));
    // Healthy deploys take under 30s; both attempts plus the ~2 min of
    // assembly before them must fit the job limit.
    // The action replaces a zero or negative value with its 10 minute default.
    for (const ms of waitMs) expect(ms).toBe(180_000);
    // The last attempt must fail the job when it fails.
    expect(attempts[1]?.["continue-on-error"]).toBeUndefined();
    const total = waitMs.reduce((a, b) => a + b, 0) / 60_000 + 3;
    expect(total).toBeLessThan(deploy?.["timeout-minutes"] ?? 0);
  });

  test("assembles the site with the script ci.yml uses", () => {
    const runs = (jobs: typeof pages.jobs, name: string) =>
      (jobs[name]?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs(pages.jobs, "deploy")).toContain(
      "scripts/pages-site.sh docs-out _site",
    );
    expect(runs(ci.jobs, "pages")).toContain(
      "scripts/pages-site.sh docs-out _site",
    );
    expect(existsSync(join(root, "scripts/pages-site.sh"))).toBe(true);
  });
});

describe("ci.yml and the Pages deploy", () => {
  test("the deploy and its upload are gone from ci.yml", () => {
    const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(text).not.toContain("deploy-pages");
    expect(text).not.toContain("name: pages-site");
    expect(text).not.toContain("PAGES_ENABLED");
  });

  test("a main push builds no site job; a pull request still does", () => {
    expect(ci.jobs.docs?.if).toContain("github.event_name != 'push'");
    // `pages` needs it, so it is skipped with it.
    expect(ci.jobs.pages?.needs).toEqual(["docs"]);
  });

  test("the check verdict consumes planned PR site proofs; main builds stay delegated", () => {
    expect(ci.jobs.check?.needs).toEqual(
      expect.arrayContaining(["docs", "pages"]),
    );
    for (const name of ["integration", "e2e", "quickstart"]) {
      const needs = [ci.jobs[name]?.needs ?? []].flat();
      for (const site of ["docs", "pages"]) expect(needs).not.toContain(site);
    }
  });
});

test("only the main Pages build writes the shared Next cache", () => {
  const ciSteps = ci.jobs.docs?.steps ?? [];
  const pageSteps = pages.jobs.docs?.steps ?? [];
  const restore = (steps: typeof ciSteps) =>
    steps.find((s) => s.id === "docs-cache");
  expect(restore(ciSteps)?.with?.path).toBe("apps/docs/.next/cache");
  expect(restore(pageSteps)?.with).toEqual(restore(ciSteps)?.with);
  const saves = (steps: typeof ciSteps) =>
    steps.filter((s) => s.uses?.startsWith("actions/cache/save@"));
  expect(saves(ciSteps)).toEqual([]);
  expect(saves(pageSteps)).toHaveLength(1);
  expect(saves(pageSteps)[0]?.if).toBe(
    "github.ref == 'refs/heads/main' && steps.docs-cache.outputs.cache-hit != 'true'",
  );
  expect(saves(pageSteps)[0]?.with?.path).toBe("apps/docs/.next/cache");
});
