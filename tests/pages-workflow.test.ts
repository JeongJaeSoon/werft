import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const parse = (file: string) =>
  Bun.YAML.parse(readFileSync(join(root, file), "utf8")) as {
    on: Record<string, { branches?: string[]; paths?: string[] } | null>;
    concurrency?: { group: string; "cancel-in-progress": boolean };
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string | string[];
        permissions?: Record<string, string>;
        environment?: { name: string };
        steps?: { run?: string; uses?: string }[];
      }
    >;
  };

const pages = parse(".github/workflows/pages.yml");
const ci = parse(".github/workflows/ci.yml");

describe("pages.yml", () => {
  test("runs on a main push that touches a site input, or by hand, never on a pull request", () => {
    expect(Object.keys(pages.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(pages.on.push?.branches).toEqual(["main"]);
    const paths = pages.on.push?.paths ?? [];
    for (const input of [
      "apps/docs/**",
      "apps/storybook/**",
      "apps/web/**",
      "packages/**",
      "docs/**",
      "bun.lock",
      "bunfig.toml",
      ".gitignore",
      "scripts/pages-site.sh",
      "scripts/storybook-pages.sh",
      ".github/workflows/pages.yml",
    ])
      expect(paths).toContain(input);
    // A change to a service app alone starts nothing.
    expect(paths.some((path) => path.startsWith("apps/control-host"))).toBe(
      false,
    );
    expect(paths.some((path) => path.startsWith("apps/worker"))).toBe(false);
  });

  test("queues deploys instead of cancelling a running one", () => {
    expect(pages.concurrency).toEqual({
      group: "pages",
      "cancel-in-progress": false,
    });
  });

  test("only the deploy job can write to Pages, and only on main with Pages enabled", () => {
    expect(pages.permissions).toEqual({ contents: "read" });
    const writers = Object.entries(pages.jobs)
      .filter(([, job]) => job.permissions?.pages === "write")
      .map(([name]) => name);
    expect(writers).toEqual(["deploy"]);
    const deploy = pages.jobs.deploy;
    expect(deploy?.needs).toEqual(["docs", "storybook"]);
    expect(deploy?.if).toBe(
      "github.ref == 'refs/heads/main' && vars.PAGES_ENABLED == 'true'",
    );
    expect(deploy?.environment?.name).toBe("github-pages");
  });

  test("assembles the site with the script ci.yml uses", () => {
    const runs = (jobs: typeof pages.jobs, name: string) =>
      (jobs[name]?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs(pages.jobs, "deploy")).toContain(
      "scripts/pages-site.sh docs-out storybook-dist _site",
    );
    expect(runs(ci.jobs, "pages")).toContain(
      "scripts/pages-site.sh docs-out storybook-dist _site",
    );
    expect(existsSync(join(root, "scripts/pages-site.sh"))).toBe(true);
  });
});

describe("ci.yml and the Pages deploy", () => {
  test("the deploy and its upload are gone from ci.yml", () => {
    expect(ci.jobs["storybook-pages"]).toBeUndefined();
    const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(text).not.toContain("deploy-pages");
    expect(text).not.toContain("name: pages-site");
    expect(text).not.toContain("PAGES_ENABLED");
  });

  test("a main push builds no site job; a pull request still does", () => {
    for (const name of ["docs", "storybook"])
      expect(ci.jobs[name]?.if).toContain("github.event_name != 'push'");
    // `pages` needs both, so it is skipped with them.
    expect(ci.jobs.pages?.needs).toEqual(["docs", "storybook"]);
  });

  test("no required aggregate waits on a site job", () => {
    for (const name of ["check", "integration", "e2e", "quickstart"]) {
      const needs = [ci.jobs[name]?.needs ?? []].flat();
      for (const site of ["docs", "storybook", "pages"])
        expect(needs).not.toContain(site);
    }
  });
});
