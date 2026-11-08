import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Audit,
  applyExceptions,
  blocking,
  findings,
  type GhsaRange,
  LOCKFILES,
  lockedVersions,
  parseExceptions,
} from "../.github/scripts/npm-audit.ts";

// Only a high or critical vulnerability with
// a fix available blocks; one without a fix is reported.

const root = join(import.meta.dir, "..");

const lockText = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "root" } },
  "packages": {
    "left": ["left@1.0.0", "", {}, "sha512-a"],
    "right": ["right@2.1.0", "", {}, "sha512-b"],
    "a/right": ["right@1.4.0", "", {}, "sha512-c"],
    "@scope/pkg": ["@scope/pkg@3.0.0", "", {}, "sha512-d"],
    "@werft-ai/storage": ["@werft-ai/storage@workspace:packages/storage"],
  },
}`;

const advisory = (id: string, severity: string, range: string) => ({
  url: `https://github.com/advisories/${id}`,
  title: id,
  severity,
  vulnerable_versions: range,
});
const ghsa = (name: string, range: string, fix: string | null): GhsaRange => ({
  package: { ecosystem: "npm", name },
  vulnerable_version_range: range,
  first_patched_version: fix,
});

describe("npm-audit", () => {
  test("audits every tracked bun.lock", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "*bun.lock"], {
      cwd: root,
    });
    if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
    const dirs = listed.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replace(/\/?bun\.lock$/, "") || ".");
    expect([...LOCKFILES].sort()).toEqual(dirs.sort());
  });

  test("reads every locked version, skipping workspaces", () => {
    const locked = lockedVersions(lockText);
    expect(
      Object.fromEntries([...locked].map(([k, v]) => [k, [...v]])),
    ).toEqual({
      left: ["1.0.0"],
      right: ["2.1.0", "1.4.0"],
      "@scope/pkg": ["3.0.0"],
    });
  });

  test("a fix is the patched version of the range holding the locked version", () => {
    const audit: Audit = {
      right: [advisory("GHSA-aaaa-aaaa-aaaa", "high", ">=1.0.0 <2.2.0")],
      left: [advisory("GHSA-bbbb-bbbb-bbbb", "critical", "<=1.0.0")],
      "@scope/pkg": [advisory("GHSA-cccc-cccc-cccc", "moderate", "*")],
    };
    const ranges = new Map([
      [
        "GHSA-aaaa-aaaa-aaaa",
        [
          ghsa("right", ">= 1.0.0, < 1.5.0", "1.5.0"),
          // The 2.x line has no fix yet.
          ghsa("right", ">= 2.0.0, < 2.2.0", null),
        ],
      ],
      ["GHSA-bbbb-bbbb-bbbb", [ghsa("left", "<= 1.0.0", null)]],
    ]);
    const list = findings(audit, lockedVersions(lockText), ranges);
    expect(list.map((f) => [f.package, f.version, f.fix])).toEqual([
      ["right", "2.1.0", null],
      ["right", "1.4.0", "1.5.0"],
      ["left", "1.0.0", null],
    ]);
    expect(blocking(list).map((f) => `${f.package}@${f.version}`)).toEqual([
      "right@1.4.0",
    ]);
  });

  test("a range semver cannot place still counts the package's fix", () => {
    const list = findings(
      { left: [advisory("GHSA-dddd-dddd-dddd", "high", "<2.0.0")] },
      lockedVersions(lockText),
      new Map([
        ["GHSA-dddd-dddd-dddd", [ghsa("left", "not a range", "2.0.0")]],
      ]),
    );
    expect(list.map((f) => f.fix)).toEqual(["2.0.0"]);
  });

  test("an advisory the database does not describe is an error, not a pass", () => {
    expect(() =>
      findings(
        { left: [advisory("GHSA-eeee-eeee-eeee", "high", "*")] },
        lockedVersions(lockText),
        new Map(),
      ),
    ).toThrow("no affected ranges for GHSA-eeee-eeee-eeee");
  });

  test("an exception applies to its id and package until it expires", () => {
    const list = findings(
      {
        left: [advisory("GHSA-ffff-ffff-ffff", "high", "*")],
        right: [advisory("GHSA-ffff-ffff-ffff", "high", "*")],
      },
      lockedVersions(lockText),
      new Map([
        [
          "GHSA-ffff-ffff-ffff",
          [ghsa("left", "< 9", "9.0.0"), ghsa("right", "< 9", "9.0.0")],
        ],
      ]),
    );
    const exceptions = parseExceptions(
      JSON.stringify([
        {
          id: "GHSA-ffff-ffff-ffff",
          package: "left",
          reason: "not reachable",
          expires: "2026-10-01",
        },
      ]),
    );
    const before = applyExceptions(list, exceptions, "2026-10-01");
    expect(blocking(before).map((f) => f.package)).toEqual(["right", "right"]);
    expect(before[0]?.excepted).toBe("not reachable");
    const after = applyExceptions(list, exceptions, "2026-10-02");
    expect(blocking(after).map((f) => f.package)).toEqual([
      "left",
      "right",
      "right",
    ]);
  });

  test("an exception without a reason or a date is refused", () => {
    expect(() =>
      parseExceptions('[{"id":"CVE-1","package":"x","expires":"2026-10-01"}]'),
    ).toThrow("has no reason");
    expect(() =>
      parseExceptions(
        '[{"id":"CVE-1","package":"x","reason":"r","expires":"soon"}]',
      ),
    ).toThrow("not YYYY-MM-DD");
    expect(
      parseExceptions(
        readFileSync(
          join(root, ".github/vulnerability-exceptions.json"),
          "utf8",
        ),
      ),
    ).toBeArray();
  });
});

describe("supply-chain-verdict.sh", () => {
  // A copy under its own .github, so each case brings its exceptions file.
  const verdict = async (
    results: Record<string, string>,
    noVerdict: string,
    exceptions = "[]",
    env: Record<string, string> = {},
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "supply-chain-"));
    const script = join(directory, ".github/scripts/supply-chain-verdict.sh");
    await mkdir(join(directory, ".github/scripts"), { recursive: true });
    await copyFile(
      join(root, ".github/scripts/supply-chain-verdict.sh"),
      script,
    );
    await writeFile(
      join(directory, ".github/vulnerability-exceptions.json"),
      exceptions,
    );
    for (const [scan, result] of Object.entries(results))
      await writeFile(join(directory, `${scan}.txt`), `${result}\n`);
    const run = Bun.spawnSync(["bash", script, directory, noVerdict], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: run.exitCode, out: run.stdout.toString() };
  };
  const all = (result: string) => ({
    "control-host-amd64": result,
    "control-host-arm64": result,
    "worker-amd64": result,
    "worker-arm64": result,
    "egress-proxy-amd64": result,
    "egress-proxy-arm64": result,
    npm: result,
  });

  test("passes when every scan is clean", async () => {
    expect((await verdict(all("clean"), "fail")).code).toBe(0);
  });

  test("fails on a fixable finding, whatever the event", async () => {
    for (const mode of ["warn", "fail"]) {
      const run = await verdict(
        { ...all("clean"), "worker-arm64": "found 2" },
        mode,
      );
      expect(run.code).toBe(1);
      expect(run.out).toContain("::error::worker-arm64: 2 high or critical");
    }
  });

  test("a scan without an answer warns or fails by event", async () => {
    const results = { ...all("clean"), npm: "error" };
    expect((await verdict(results, "warn")).code).toBe(0);
    expect((await verdict(results, "fail")).code).toBe(1);
  });

  test("a missing result fails even where outages only warn", async () => {
    const { "worker-arm64": _, ...rest } = all("clean");
    const run = await verdict(rest, "warn");
    expect(run.code).toBe(1);
    expect(run.out).toContain("::error::worker-arm64: no result");
  });

  test("a result without its arch stands in for neither", async () => {
    const { "worker-amd64": _, "worker-arm64": __, ...rest } = all("clean");
    const run = await verdict({ ...rest, worker: "clean" }, "warn");
    expect(run.code).toBe(1);
    expect(run.out).toContain("::error::worker-amd64: no result");
    expect(run.out).toContain("::error::worker-arm64: no result");
  });

  test("an exception without a reason fails even a clean run", async () => {
    const run = await verdict(
      all("clean"),
      "warn",
      '[{"id":"CVE-1","package":"openssl","reason":"","expires":"2099-01-01"}]',
    );
    expect(run.code).toBe(1);
    expect(run.out).toContain("every entry needs id, package, reason");
    const valid =
      '[{"id":"CVE-1","package":"openssl","reason":"r","expires":"2099-01-01"}]';
    expect((await verdict(all("clean"), "fail", valid)).code).toBe(0);
  });

  test("refuses an unknown mode", async () => {
    expect((await verdict(all("clean"), "maybe")).code).toBe(2);
  });

  describe("image build plan", () => {
    const plan = (images: string, result: string, event = "pull_request") => ({
      IMAGES_PLAN: images,
      IMAGES_BUILD_RESULT: result,
      GITHUB_EVENT_NAME: event,
    });
    const npmOnly = { npm: "clean" };

    test("a planned build passes only as success with every scan", async () => {
      const ok = await verdict(
        all("clean"),
        "warn",
        "[]",
        plan("build", "success"),
      );
      expect(ok.code).toBe(0);
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        const run = await verdict(
          all("clean"),
          "warn",
          "[]",
          plan("build", result),
        );
        expect(run.code).toBe(1);
        expect(run.out).toContain("build was planned");
      }
    });

    test("scan artifacts do not rescue a planned build that failed", async () => {
      const run = await verdict(
        all("clean"),
        "warn",
        "[]",
        plan("build", "failure"),
      );
      expect(run.code).toBe(1);
    });

    test("a planned build with a missing scan still fails", async () => {
      const { "worker-arm64": _, ...rest } = all("clean");
      const run = await verdict(rest, "warn", "[]", plan("build", "success"));
      expect(run.code).toBe(1);
      expect(run.out).toContain("::error::worker-arm64: no result");
    });

    test("an empty, missing or unknown plan fails", async () => {
      for (const images of ["", "none", "BUILD", "[]"]) {
        const run = await verdict(
          all("clean"),
          "warn",
          "[]",
          plan(images, "skipped"),
        );
        expect(run.code).toBe(1);
        expect(run.out).toContain("no valid image build plan");
      }
    });

    test("a skipped build judges only the npm audit", async () => {
      expect(
        (await verdict(npmOnly, "fail", "[]", plan("skip", "skipped"))).code,
      ).toBe(0);
      const found = await verdict(
        { npm: "found 1" },
        "warn",
        "[]",
        plan("skip", "skipped"),
      );
      expect(found.code).toBe(1);
      const missing = await verdict({}, "warn", "[]", plan("skip", "skipped"));
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("::error::npm: no result");
    });

    test("skipping is for pull requests whose build really was skipped", async () => {
      for (const [event, result] of [
        ["push", "skipped"],
        ["schedule", "skipped"],
        ["workflow_dispatch", "skipped"],
        ["pull_request", "success"],
        ["pull_request", "failure"],
        ["pull_request", ""],
      ] as const) {
        const run = await verdict(
          npmOnly,
          "warn",
          "[]",
          plan("skip", result, event),
        );
        expect(run.code).toBe(1);
      }
    });
  });
});

describe("images.yml supply-chain", () => {
  type Job = {
    needs?: string | string[];
    if?: string;
    steps?: { name?: string; run?: string; env?: Record<string, string> }[];
  };
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const job = workflow.jobs["supply-chain"];

  test("is one job, on pull requests, judging every build", () => {
    // Branch protection requires it by this name.
    expect(Object.keys(workflow.on)).toContain("pull_request");
    expect(job?.needs).toEqual(["plan", "build"]);
    // Skipped would count as passed.
    expect(job?.if).toBe("always()");
    expect(job?.steps?.some((step) => step.run?.includes("npm-audit.ts"))).toBe(
      true,
    );
    expect(existsSync(join(root, ".github/workflows/supply-chain.yml"))).toBe(
      false,
    );
  });

  test("the build runs by the plan and the verdict reads plan and result", () => {
    const plan = workflow.jobs.plan as Job & {
      outputs?: Record<string, string>;
    };
    expect(plan.outputs?.images).toBe("${{ steps.images.outputs.images }}");
    expect(workflow.jobs.build?.needs).toBe("plan");
    expect(workflow.jobs.build?.if).toBe(
      "needs.plan.outputs.images == 'build'",
    );
    const verdict = job?.steps?.find((step) =>
      step.run?.includes("supply-chain-verdict.sh"),
    );
    expect(verdict?.env?.IMAGES_PLAN).toBe("${{ needs.plan.outputs.images }}");
    expect(verdict?.env?.IMAGES_BUILD_RESULT).toBe("${{ needs.build.result }}");
    // The planner decides with the same script CI does.
    expect(JSON.stringify(plan.steps)).toContain("ci-plan.sh");
  });

  test("a publish waits for it and judges its own digest the same way", () => {
    for (const name of ["publish", "publish-main"]) {
      const publish = workflow.jobs[name];
      expect(publish?.needs).toEqual(["build", "supply-chain"]);
      // always() would publish past a failed verdict.
      expect(publish?.if).not.toContain("always()");
      const runs = publish?.steps?.map((step) => step.run ?? "") ?? [];
      const scan = runs.find((run) => run.includes("image-scan.sh"));
      expect(scan).toContain('if [ "$result" != clean ]; then');
      // `supply-chain` only warns on a main push whose scan got no answer.
      const verdict = runs.findIndex((run) =>
        run.includes("supply-chain-verdict.sh supply-chain-results fail"),
      );
      expect(verdict).toBeGreaterThan(-1);
      expect(verdict).toBeLessThan(
        runs.findIndex((run) => run.includes("image-smoke.sh")),
      );
    }
  });
});
