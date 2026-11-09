import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../.github/scripts/test-files.ts";
import {
  matrix,
  PARTS,
  partOf,
  pick,
  withoutSurface,
} from "../.github/scripts/unit-part.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github", "scripts", "unit-part.ts");

async function part(args: string[]) {
  const process = Bun.spawn(["bun", script, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, lines: stdout.split("\n").filter(Boolean), stderr };
}

describe("unit-part.ts", () => {
  test("separates database fixtures from the other packages, worker/web and the rest", () => {
    expect(partOf("packages/db/src/queries.test.ts")).toBe("packages-db");
    expect(partOf("packages/storage/src/git-runner.test.ts")).toBe("packages");
    expect(partOf("packages/db-extra/a.test.ts")).toBe("packages");
    expect(partOf("apps/worker/src/worker-host.test.ts")).toBe("worker-web");
    expect(partOf("apps/web/src/routes/agents.test.tsx")).toBe("worker-web");
    expect(partOf("apps/workers/a.test.ts")).toBe("rest");
    expect(partOf("apps/control-host/src/api/auth.test.ts")).toBe("rest");
    expect(partOf("tests/architecture.test.ts")).toBe("rest");
    expect(partOf("xapps-e2e/a.test.ts")).toBe("rest");
    expect(partOf("apps/control-host/packages/x.test.ts")).toBe("rest");
  });

  test("refuses an empty part, which bun test would read as the whole suite", () => {
    expect(() => pick(["apps/a.test.ts"], "packages")).toThrow(
      "unit part packages has no files",
    );
  });

  test("the parts of this repo cover its suite exactly once", async () => {
    const outcomes = await Promise.all(PARTS.map((name) => part([name])));
    const all = outcomes.flatMap((outcome) => outcome.lines);
    const suite = discover(repo, ["tests", "packages", "apps", "examples"]).map(
      (path) => `./${path}`,
    );

    for (const outcome of outcomes) expect(outcome.exitCode).toBe(0);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(suite);
    expect(outcomes[PARTS.indexOf("rest")]?.lines).toContain(
      "./tests/unit-part.test.ts",
    );
  });

  test("the CI matrix comes from the same file selection as each shard", async () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
    );
    expect(workflow.jobs["check-part"].strategy.matrix.include).toBe(
      `\${{ fromJSON(needs.changes.outputs.unit_parts) }}`,
    );
    const outcome = await part(["matrix"]);
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(outcome.lines.join(""))).toEqual(
      matrix(discover(repo, ["tests", "packages", "apps", "examples"])),
    );
  });

  test("the workflow plans all manual shards and only complementary web shards", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
    );
    const command = workflow.jobs.changes.steps.find(
      (step: { id?: string }) => step.id === "units",
    ).run;
    const dir = mkdtempSync(join(tmpdir(), "unit-matrix-"));
    try {
      for (const only of ["all", "check"]) {
        const output = join(dir, only);
        const result = Bun.spawnSync(["bash", "-e", "-c", command], {
          cwd: repo,
          env: {
            ...Bun.env,
            ONLY: only,
            DOMAINS: '["surface"]',
            GITHUB_OUTPUT: output,
          },
        });
        expect(result.exitCode).toBe(0);
        const planned = JSON.parse(
          readFileSync(output, "utf8").trim().slice("matrix=".length),
        ) as { unit: string }[];
        expect(planned.map((entry) => entry.unit)).toEqual(
          only === "check"
            ? [...PARTS]
            : matrix(
                withoutSurface(
                  discover(repo, ["tests", "packages", "apps", "examples"]),
                  readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
                ),
              ).map((entry) => entry.unit),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("web shards and surface cover the entire suite exactly once", async () => {
    const { assign, readJobs } = await import(
      "../.github/scripts/integration-jobs.ts"
    );
    const workflow = readFileSync(
      join(repo, ".github/workflows/ci.yml"),
      "utf8",
    );
    const files = discover(repo, ["tests", "packages", "apps", "examples"]);
    const surface = assign(files, readJobs(workflow)).get("surface");
    if (!surface) throw new Error("surface domain is required");
    const plan = await part(["matrix", "--exclude-surface"]);
    expect(plan.exitCode).toBe(0);
    const entries = JSON.parse(plan.lines.join("")) as { unit: string }[];
    expect(entries.map((entry) => entry.unit)).not.toContain("control-slack");
    const outcomes = await Promise.all(
      entries.map((entry) => part([entry.unit, "--exclude-surface"])),
    );
    for (const outcome of outcomes) {
      expect(outcome.exitCode).toBe(0);
      expect(outcome.lines.length).toBeGreaterThan(0);
    }
    const all = [
      ...surface.map((path) => `./${path}`),
      ...outcomes.flatMap((o) => o.lines),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(files.map((path) => `./${path}`));
    const empty = await part(["control-slack", "--exclude-surface"]);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.lines).toEqual([]);
  });

  test("web exclusion rejects an incomplete integration assignment", async () => {
    const { withoutSurface } = await import("../.github/scripts/unit-part.ts");
    const workflow = readFileSync(
      join(repo, ".github/workflows/ci.yml"),
      "utf8",
    );
    const files = discover(repo, ["tests", "packages", "apps", "examples"]);
    expect(() =>
      withoutSurface([...files, "unknown/new.test.ts"], workflow),
    ).toThrow("belongs to no integration job");
  });

  test("rejects anything but a part name", async () => {
    for (const args of [
      [],
      ["apps"],
      ["packages", "rest"],
      ["matrix", "--unknown"],
      ["matrix", "--exclude-surface", "extra"],
    ]) {
      const outcome = await part(args);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain("usage:");
    }
  });
});
