import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collect,
  FRAGMENT_DIR,
  fragmentNames,
  parseSections,
} from "../.github/scripts/changelog-release.ts";
import {
  chartVersion,
  effectiveRef,
} from "../.github/scripts/chart-package.ts";

// A merge that turns CHANGELOG.md's `## 미출시` into `## vX.Y.Z` releases that
// version from the same main push, with one approval and no tag before it.
// These tests hold the job graph (order, one approval, no write before it,
// separate artifacts) and the scripts (detect, ci, tag, stage) against a fake
// `gh` and a real git repository. The first real release is the owner's.

const root = join(import.meta.dir, "..");
const sha = "0123456789abcdef0123456789abcdef01234567";
const script = (name: string) => join(root, ".github", "scripts", name);

type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string;
  env?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  permissions?: Record<string, string>;
  steps: {
    name?: string;
    run?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
  }[];
};

const workflow = Bun.YAML.parse(
  readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const { jobs } = workflow;

const needsOf = (name: string): string[] => {
  const needs = jobs[name]?.needs;
  return needs === undefined ? [] : [needs].flat();
};
const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
  for (const next of needsOf(name)) {
    if (!seen.has(next)) {
      seen.add(next);
      ancestors(next, seen);
    }
  }
  return seen;
};
const hasTag = "needs.release-detect.outputs.tag != ''";
const releaseJobs = [
  "sources-release",
  "release-gate",
  "release-approve",
  "promote-release",
  "chart-release",
  "chart-publish-release",
  "release-tag",
  "release-publish",
  "latest-release",
  "pages-release",
];

describe("the release jobs of a main run", () => {
  test("nothing but release-detect runs for a main run without a version to release", () => {
    expect(jobs["release-detect"]?.if).toBe(
      "contains(fromJSON('[\"push\",\"workflow_dispatch\"]'), github.event_name) && github.ref == 'refs/heads/main'",
    );
    expect(jobs["release-detect"]?.steps.at(-1)?.env?.EVENT).toBe(
      "$" + "{{ github.event_name }}",
    );
    for (const name of releaseJobs) {
      expect(jobs[name]?.if).toBe(hasTag);
      expect(needsOf(name)).toContain("release-detect");
    }
  });

  test("a retry stages its own images up to index-main and promotes no main-<12>", () => {
    const pushOrRetry =
      "contains(fromJSON('[\"push\",\"workflow_dispatch\"]'), github.event_name) && github.ref == 'refs/heads/main'";
    for (const name of ["publish-main", "sources-main", "index-main"]) {
      expect(jobs[name]?.if).toBe(pushOrRetry);
    }
    const push =
      "github.event_name == 'push' && github.ref == 'refs/heads/main'";
    for (const name of ["promote-main", "chart-publish-main"]) {
      expect(jobs[name]?.if).toBe(push);
    }
    expect(jobs["chart-main"]?.if).toBe(
      `needs.plan.outputs.chart != 'false' && ${push}`,
    );
    // What a retry promotes and approves still comes from index-main.
    for (const name of ["worker-compat-release", "promote-release"]) {
      expect(needsOf(name)).toContain("index-main");
    }
    expect(needsOf("sources-release")).toContain("publish-main");
  });

  test("no release job and no main job waits on a job a retry or a push may skip", () => {
    // A skipped or failed ancestor skips every job after it that has no
    // status check of its own (actions/runner#491): one push-only job behind
    // a release job would stop a retry at release-approve, and release-detect
    // behind the main chain would stop a push's chain when it fails.
    const pushOnly = ["promote-main", "chart-main", "chart-publish-main"];
    for (const name of releaseJobs) {
      for (const ancestor of ancestors(name)) {
        expect(pushOnly).not.toContain(ancestor);
      }
    }
    for (const name of [
      ...pushOnly,
      "publish-main",
      "sources-main",
      "index-main",
    ]) {
      expect(ancestors(name).has("release-detect")).toBe(false);
    }
  });

  test("one approval, in front of every write the release makes", () => {
    const environments = Object.entries(jobs)
      .filter(([, job]) => job.environment !== undefined)
      .map(([name, job]) => [name, job.environment]);
    // `publish` is the pushed-tag chain's, `release-approve` this one's: two
    // events, one environment, one approval each.
    expect(environments).toEqual([
      ["publish", "release"],
      ["release-approve", "release"],
    ]);
    const before = ancestors("release-approve");
    for (const name of before) {
      const permissions = jobs[name]?.permissions ?? {};
      if (!name.endsWith("-main") && name !== "release-detect") {
        expect(permissions.contents).not.toBe("write");
      }
    }
    // Everything that writes a version tag, the chart or the Release comes after it.
    for (const name of [
      "promote-release",
      "chart-publish-release",
      "release-tag",
      "release-publish",
      "latest-release",
    ]) {
      expect(ancestors(name).has("release-approve")).toBe(true);
    }
    expect(before.has("promote-release")).toBe(false);
  });

  test("the tag is made after the approval and after everything it names is published", () => {
    for (const name of [
      "release-approve",
      "promote-release",
      "chart-publish-release",
    ]) {
      expect(ancestors("release-tag").has(name)).toBe(true);
    }
    expect(needsOf("release-publish")).toContain("release-tag");
    expect(jobs["release-tag"]?.permissions).toEqual({ contents: "write" });
    expect(jobs["release-publish"]?.permissions).toEqual({ contents: "write" });
    for (const name of ["promote-release", "chart-publish-release"]) {
      expect(jobs[name]?.permissions?.contents).toBe("read");
    }
  });

  test("the published release dispatches the docs site at its tag, since its GITHUB_TOKEN tag starts no pages.yml run", () => {
    const job = jobs["pages-release"];
    expect(needsOf("pages-release")).toContain("release-publish");
    expect(job?.permissions).toEqual({ actions: "write" });
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.run)).toEqual([
      'gh workflow run pages.yml --ref "$TAG"',
    ]);
    expect(steps[0]?.env?.TAG).toBe(
      "$" + "{{ needs.release-detect.outputs.tag }}",
    );
    // pages.yml deploys a dispatch only from a v* tag or main.
    const pages = Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/pages.yml"), "utf8"),
    ) as { on: Record<string, unknown>; jobs: Record<string, { if?: string }> };
    expect(Object.keys(pages.on)).toContain("workflow_dispatch");
    expect(pages.jobs.deploy?.if).toContain(
      "startsWith(github.ref, 'refs/tags/v')",
    );
  });

  test("it waits for main's whole chain and for ci.yml before asking anyone", () => {
    // chart-publish-main by reading the run (main-chain), not by needs.
    expect(needsOf("release-gate")).toEqual(["release-detect", "index-main"]);
    expect(needsOf("release-approve")).toEqual(
      expect.arrayContaining([
        "release-gate",
        "sources-release",
        "worker-compat-release",
      ]),
    );
    expect(needsOf("worker-compat-release")).toEqual(
      expect.arrayContaining(["release-detect", "index-main"]),
    );
    expect(jobs["release-gate"]?.steps.map((step) => step.run)).toEqual([
      undefined,
      ".github/scripts/release-auto.sh ci",
      ".github/scripts/release-auto.sh main-chain",
      ".github/scripts/release-auto.sh conformance",
      ".github/scripts/release-auto.sh k8s-smoke",
      ".github/scripts/release-auto.sh free",
    ]);
    expect(
      (jobs["release-gate"]?.steps[2] as { if?: string } | undefined)?.if,
    ).toBeUndefined();
    expect(jobs["release-gate"]?.steps[2]?.env?.EVENT).toBe(
      "$" + "{{ github.event_name }}",
    );
    expect(jobs["release-gate"]?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    // It starts before chart-publish-main on a push, so its timeout holds
    // the default waits of ci and main-chain one after the other.
    const script = readFileSync(
      join(root, ".github/scripts/release-auto.sh"),
      "utf8",
    );
    const wait = (name: string) =>
      Number(new RegExp(`\\$\\{${name}:-(\\d+)\\}`).exec(script)?.[1]);
    expect(wait("CI_WAIT_SECONDS")).toBe(5400);
    expect(wait("MAIN_CHAIN_WAIT_SECONDS")).toBe(3600);
    const timeout = (jobs["release-gate"] as { "timeout-minutes"?: number })[
      "timeout-minutes"
    ];
    expect((timeout ?? 0) * 60).toBeGreaterThan(
      wait("CI_WAIT_SECONDS") + wait("MAIN_CHAIN_WAIT_SECONDS"),
    );
    // Every Debian source is verified, not only warned about, before the approval.
    expect(jobs["sources-release"]?.env?.RELEASE_REF).toBe(
      "refs/tags/${{ needs.release-detect.outputs.tag }}",
    );
  });

  test("it promotes main's staged digests under the same lock as a pushed tag", () => {
    expect(jobs["promote-release"]?.concurrency).toEqual(
      jobs.promote?.concurrency ?? {},
    );
    // The Release is its tag's alone: the same group name in both chains,
    // each with the tag it releases.
    expect(jobs.release?.concurrency).toEqual({
      group: "images-release-${{ github.ref_name }}",
      "cancel-in-progress": false,
    });
    expect(jobs["release-publish"]?.concurrency).toEqual({
      group: "images-release-${{ needs.release-detect.outputs.tag }}",
      "cancel-in-progress": false,
    });
    expect(needsOf("latest-release")).toContain("release-publish");
    expect(jobs["latest-release"]?.steps).toEqual(jobs.latest?.steps ?? []);
    const promote = jobs["promote-release"]?.steps ?? [];
    expect(promote.flatMap((step) => step.with?.name ?? [])).toEqual([
      "staged-digests",
      "unverified-sources-release",
      "image-digests-published-release",
    ]);
    const runs = promote.map((step) => step.run ?? "").join("\n");
    expect(runs.indexOf("release-stage.sh")).toBeLessThan(
      runs.indexOf("image-promote.sh"),
    );
    // A tag made by someone else while the approval waited must stop the run
    // before any vX image exists.
    expect(runs.indexOf("release-auto.sh free")).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf("release-auto.sh free")).toBeLessThan(
      runs.indexOf("image-promote.sh"),
    );
    expect(runs).not.toContain("docker/build-push-action");
  });

  test("RELEASE_REF reaches every job whose scripts read the ref", () => {
    const ref = "refs/tags/${{ needs.release-detect.outputs.tag }}";
    for (const name of [
      "sources-release",
      "promote-release",
      "chart-release",
      "release-publish",
    ]) {
      expect(jobs[name]?.env?.RELEASE_REF).toBe(ref);
    }
  });

  test("artifacts of the two chains never share a name", () => {
    const suffix = (name: string) => jobs[name]?.env?.ARTIFACT_SUFFIX ?? "";
    const names = new Map<string, string>();
    const chain = [
      "build",
      "supply-chain",
      "publish-main",
      "sources-main",
      "index-main",
      "promote-main",
      "chart-main",
      "sources-release",
      "promote-release",
      "chart-release",
    ];
    for (const name of chain) {
      for (const step of jobs[name]?.steps ?? []) {
        const uploaded = step.with?.name;
        if (uploaded === undefined || !step.with?.path) continue;
        if (!(step as { uses?: string }).uses?.includes("upload-artifact")) {
          continue;
        }
        const resolved = uploaded
          .replace("${{ env.ARTIFACT_SUFFIX }}", suffix(name))
          .replace("${{ github.job }}", name);
        expect(names.get(resolved)).toBeUndefined();
        names.set(resolved, name);
      }
    }
    expect(names.get("unverified-sources")).toBe("sources-main");
    expect(names.get("unverified-sources-release")).toBe("sources-release");
    expect(names.get("chart")).toBe("chart-main");
    expect(names.get("chart-release")).toBe("chart-release");
    // A download of the release jobs that is a pattern would match both chains.
    for (const name of [
      "chart-release",
      "chart-publish-release",
      "release-publish",
    ]) {
      for (const step of jobs[name]?.steps ?? []) {
        expect(step.with?.pattern).toBeUndefined();
      }
    }
  });
});

describe("release-auto.sh", () => {
  type Reply = { match: string; out?: string; code?: number };

  /** A fake `gh`: the first reply whose `match` is in the argv wins; an array answers one call at a time. */
  const fakeGh = (
    directory: string,
    replies: (Reply & { seq?: [string, number][] })[],
  ) => {
    const log = join(directory, "calls.log");
    const cases = replies
      .map(({ match, out = "", code = 0, seq }, index) => {
        const answers = seq ?? [[out, code]];
        const lines = answers
          .map(
            ([text, status], at) =>
              `    ${at}) printf '%s' ${JSON.stringify(text)}; [ ${status} = 0 ] || echo "gh: ${text.replaceAll('"', "")}" >&2; exit ${status} ;;`,
          )
          .join("\n");
        return `  *${JSON.stringify(match)}*)
    n=$(cat "${directory}/count.${index}" 2>/dev/null || echo 0)
    echo $((n + 1)) >"${directory}/count.${index}"
    [ "$n" -lt ${answers.length} ] || n=${answers.length - 1}
    case "$n" in
${lines}
    esac ;;`;
      })
      .join("\n");
    mkdirSync(join(directory, "bin"), { recursive: true });
    writeFileSync(
      join(directory, "bin", "gh"),
      `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >>"${log}"
case "$*" in
${cases}
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    return () =>
      existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean)
        : [];
  };

  const sh = (
    directory: string,
    args: string[],
    env: Record<string, string>,
    cwd?: string,
  ) => {
    const run = Bun.spawnSync(["bash", ...args], {
      cwd,
      env: {
        PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
        HOME: directory,
        GH_REPO: "owner/repo",
        GH_TOKEN: "fake",
        ...env,
      },
    });
    return {
      code: run.exitCode,
      out: run.stdout.toString(),
      err: run.stderr.toString(),
    };
  };

  const sandbox = <T>(use: (directory: string) => T): T => {
    const directory = mkdtempSync(join(tmpdir(), "release-auto-"));
    try {
      return use(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const absent = {
    match: "git/ref/tags/",
    code: 1,
    out: "Not Found (HTTP 404)",
  };
  const noRelease = { match: "releases?per_page", out: "" };

  describe("detect", () => {
    const git = (cwd: string, ...args: string[]) => {
      const run = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd } },
      );
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString().trim();
    };
    const changelog = (...headings: string[]) =>
      `# 변경 기록\n\n## 미출시\n\n${headings.map((h) => `## ${h}\n\ntext\n`).join("\n")}`;

    /** Commits `before` then `after` (CHANGELOG bodies) and runs detect on the pair. */
    const detect = (
      before: string | null,
      after: string,
      replies: Reply[] = [absent, noRelease],
      options: {
        zeroBefore?: boolean;
        unrelated?: boolean;
        /** Other files the after commit adds, by path. */
        files?: Record<string, string>;
      } = {},
    ) =>
      sandbox((directory) => {
        const repo = join(directory, "repo");
        mkdirSync(repo);
        git(repo, "init", "-q", "-b", "main");
        writeFileSync(join(repo, "README.md"), "x");
        if (before !== null) writeFileSync(join(repo, "CHANGELOG.md"), before);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "before");
        const first = git(repo, "rev-parse", "HEAD");
        writeFileSync(join(repo, "CHANGELOG.md"), after);
        for (const [path, body] of Object.entries(options.files ?? {})) {
          mkdirSync(join(repo, path, ".."), { recursive: true });
          writeFileSync(join(repo, path), body);
        }
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "after");
        const second = git(repo, "rev-parse", "HEAD");
        let beforeSha = first;
        if (options.unrelated) {
          git(repo, "checkout", "-q", "--orphan", "other");
          writeFileSync(join(repo, "o.txt"), "o");
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", "other");
          beforeSha = git(repo, "rev-parse", "HEAD");
          git(repo, "checkout", "-q", "main");
        }
        if (options.zeroBefore) beforeSha = "0".repeat(40);
        const calls = fakeGh(directory, replies);
        const output = join(directory, "github-output");
        const run = sh(
          directory,
          [script("release-auto.sh"), "detect"],
          {
            EVENT: "push",
            BEFORE: beforeSha,
            AFTER: second,
            GITHUB_OUTPUT: output,
          },
          repo,
        );
        return {
          ...run,
          calls: calls(),
          output: existsSync(output) ? readFileSync(output, "utf8") : "",
        };
      });

    const base = changelog("v0.1.1", "v0.1.0");

    test("an ordinary merge releases nothing and asks GitHub nothing", () => {
      const run = detect(base, `${base}\n- an edit\n`);
      expect(run.code).toBe(0);
      expect(run.output).toBe("tag=\n");
      expect(run.calls).toEqual([]);
    });

    test("a new version heading is the release, once its tag and Release are free", () => {
      const run = detect(base, changelog("v0.1.2", "v0.1.1", "v0.1.0"));
      expect(run.code).toBe(0);
      expect(run.output).toBe("tag=v0.1.2\n");
      expect(run.calls.length).toBe(2);
    });

    test("a prerelease heading is a release too", () => {
      const run = detect(base, changelog("v0.2.0-rc.1", "v0.1.1", "v0.1.0"));
      expect(run.output).toBe("tag=v0.2.0-rc.1\n");
    });

    test("moving a heading, or editing under one, is not a release", () => {
      const run = detect(base, changelog("v0.1.0", "v0.1.1"));
      expect(run.code).toBe(0);
      expect(run.output).toBe("tag=\n");
    });

    test.each([
      [
        "two new headings",
        changelog("v0.1.3", "v0.1.2", "v0.1.1", "v0.1.0"),
        "more than one",
      ],
      ["a renamed heading", changelog("v0.1.2", "v0.1.0"), "renamed"],
      [
        "a duplicated heading",
        changelog("v0.1.2", "v0.1.2", "v0.1.1", "v0.1.0"),
        "more than one section",
      ],
      [
        "a version without three parts",
        changelog("v1.2", "v0.1.1", "v0.1.0"),
        "is not v",
      ],
      [
        "a version with build metadata",
        changelog("v1.2.3+b", "v0.1.1", "v0.1.0"),
        "is not v",
      ],
    ])("%s is refused, not skipped", (_name, after, why) => {
      const run = detect(base, after);
      expect(run.code).toBe(1);
      expect(run.err).toContain(why);
      expect(run.output).toBe("");
    });

    test("a version whose chart label would pass 63 characters is refused", () => {
      // "werft-" + 57 characters is the longest label chart-package.ts accepts.
      const fits = `v0.1.2-${"a".repeat(51)}`;
      const over = `v0.1.2-${"a".repeat(52)}`;
      expect(detect(base, changelog(fits, "v0.1.1", "v0.1.0")).output).toBe(
        `tag=${fits}\n`,
      );
      const run = detect(base, changelog(over, "v0.1.1", "v0.1.0"));
      expect(run.code).toBe(1);
      expect(run.err).toContain("too long");
    });

    test.each([
      ["a prerelease ending in a dash", "v1.2.3-rc-", "must end in"],
      ["a number past uint64", "v18446744073709551616.0.0", "19 or more"],
    ])("%s is refused before anything is published", (_name, heading, why) => {
      const run = detect(base, changelog(heading, "v0.1.1", "v0.1.0"));
      expect(run.code).toBe(1);
      expect(run.err).toContain(why);
    });

    test("a version whose tag exists is refused", () => {
      const run = detect(base, changelog("v0.1.2", "v0.1.1", "v0.1.0"), [
        { match: "git/ref/tags/", out: "{}" },
        noRelease,
      ]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("already exists");
    });

    test("a version with a draft Release and no tag is refused", () => {
      const run = detect(base, changelog("v0.1.2", "v0.1.1", "v0.1.0"), [
        absent,
        { match: "releases?per_page", out: "991" },
      ]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("Release for v0.1.2 already exists");
    });

    test("a lookup that fails is not an absent tag", () => {
      const run = detect(base, changelog("v0.1.2", "v0.1.1", "v0.1.0"), [
        { match: "git/ref/tags/", code: 1, out: "Server Error (HTTP 500)" },
        noRelease,
      ]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("could not look up");
    });

    test("a first push (no previous commit) is refused rather than read as all-new", () => {
      const run = detect(
        base,
        changelog("v0.1.2", "v0.1.1", "v0.1.0"),
        undefined,
        {
          zeroBefore: true,
        },
      );
      expect(run.code).toBe(1);
      expect(run.err).toContain("no previous commit");
    });

    test("a rewritten history is refused", () => {
      const run = detect(
        base,
        changelog("v0.1.2", "v0.1.1", "v0.1.0"),
        undefined,
        {
          unrelated: true,
        },
      );
      expect(run.code).toBe(1);
      expect(run.err).toContain("rewritten");
    });

    test("a release commit that still holds changelog fragments is refused before GitHub is asked", () => {
      const after = changelog("v0.1.2", "v0.1.1", "v0.1.0");
      const run = detect(base, after, [absent, noRelease], {
        files: {
          "changelog.d/README.md": "how to write one",
          "changelog.d/94S-1.md": "### 운영자가 할 일\n\n- x\n",
        },
      });
      expect(run.code).toBe(1);
      expect(run.err).toContain("changelog.d/: 94S-1.md");
      expect(run.err).toContain("changelog-release.ts v0.1.2");
      expect(run.output).toBe("");
      expect(run.calls).toEqual([]);
      // The README alone is no fragment, and an ordinary merge may add fragments.
      const readme = detect(base, after, [absent, noRelease], {
        files: { "changelog.d/README.md": "how to write one" },
      });
      expect(readme.code).toBe(0);
      expect(readme.output).toBe("tag=v0.1.2\n");
      const merge = detect(base, base, [absent, noRelease], {
        files: { "changelog.d/94S-1.md": "### 운영자가 할 일\n\n- x\n" },
      });
      expect(merge.code).toBe(0);
      expect(merge.output).toBe("tag=\n");
    });

    test("a CHANGELOG that did not exist before makes every heading new, so it is refused", () => {
      const run = detect(null, base);
      expect(run.code).toBe(1);
      expect(run.err).toContain("more than one");
    });

    /** One commit with this CHANGELOG, read by a manual run (EVENT). */
    const retry = (
      body: string,
      replies: Reply[] = [absent, noRelease],
      event = "workflow_dispatch",
    ) =>
      sandbox((directory) => {
        const repo = join(directory, "repo");
        mkdirSync(repo);
        git(repo, "init", "-q", "-b", "main");
        writeFileSync(join(repo, "CHANGELOG.md"), body);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "head");
        const head = git(repo, "rev-parse", "HEAD");
        const calls = fakeGh(directory, replies);
        const output = join(directory, "github-output");
        const run = sh(
          directory,
          [script("release-auto.sh"), "detect"],
          { EVENT: event, AFTER: head, GITHUB_OUTPUT: output },
          repo,
        );
        return {
          ...run,
          calls: calls(),
          output: existsSync(output) ? readFileSync(output, "utf8") : "",
        };
      });

    describe("a manual run (a retry)", () => {
      /** Commits each tree in turn (path -> body, null deletes) and retries the last. */
      const retryAfter = (trees: Record<string, string | null>[]) =>
        sandbox((directory) => {
          const repo = join(directory, "repo");
          mkdirSync(repo);
          git(repo, "init", "-q", "-b", "main");
          trees.forEach((tree, i) => {
            for (const [path, body] of Object.entries(tree)) {
              if (body === null) {
                rmSync(join(repo, path));
              } else {
                mkdirSync(join(repo, path, ".."), { recursive: true });
                writeFileSync(join(repo, path), body);
              }
            }
            git(repo, "add", "-A");
            git(repo, "commit", "-q", "-m", `c${i}`);
          });
          const head = git(repo, "rev-parse", "HEAD");
          const calls = fakeGh(directory, [absent, noRelease]);
          const output = join(directory, "github-output");
          const run = sh(
            directory,
            [script("release-auto.sh"), "detect"],
            { EVENT: "workflow_dispatch", AFTER: head, GITHUB_OUTPUT: output },
            repo,
          );
          return {
            ...run,
            calls: calls(),
            output: existsSync(output) ? readFileSync(output, "utf8") : "",
          };
        });

      test("a retry is refused while any fragment is left, including one merged after the refused push", () => {
        const fragment = "### 운영자가 할 일\n\n- x\n";
        const released = {
          "CHANGELOG.md": changelog("v0.1.2", "v0.1.1"),
          "changelog.d/94S-1.md": fragment,
        };
        const first = { "CHANGELOG.md": changelog("v0.1.1") };
        const moved = {
          "CHANGELOG.md": changelog("v0.1.2", "v0.1.1").replace("text", "- x"),
          "changelog.d/94S-1.md": null,
        };
        // The refused commit, a later one that kept its fragment, and one whose
        // later merge added another: a retry releases main's head, so all of
        // them ship in v0.1.2.
        for (const [trees, left] of [
          [[first, released], "94S-1.md"],
          [[first, released, { "x.txt": "fix" }], "94S-1.md"],
          [
            [first, released, moved, { "changelog.d/94S-2.md": fragment }],
            "94S-2.md",
          ],
        ] as const) {
          const run = retryAfter([...trees]);
          expect(run.code).toBe(1);
          expect(run.err).toContain(`changelog.d/: ${left}`);
          expect(run.output).toBe("");
        }
        const run = retryAfter([first, released, moved]);
        expect(run.err).toBe("");
        expect(run.code).toBe(0);
        expect(run.output).toBe("tag=v0.1.2\n");
      });

      test("retries the top version heading when its tag and Release are free", () => {
        const run = retry(base);
        expect(run.code).toBe(0);
        expect(run.out).toContain("release tag: v0.1.1");
        expect(run.output).toBe("tag=v0.1.1\n");
        expect(run.calls.length).toBe(2);
        expect(run.calls[0]).toContain("git/ref/tags/v0.1.1");
      });

      test("a released version is not retried, and that is no failure", () => {
        const tagged = retry(base, [
          { match: "git/ref/tags/", out: "{}" },
          noRelease,
        ]);
        expect(tagged.code).toBe(0);
        expect(tagged.out).toContain(
          "v0.1.1 is not retried: tag v0.1.1 already exists",
        );
        expect(tagged.out).toContain("release tag: none");
        expect(tagged.output).toBe("tag=\n");
        // A draft Release holds the name as well.
        const drafted = retry(base, [
          absent,
          { match: "releases?per_page", out: "991" },
        ]);
        expect(drafted.code).toBe(0);
        expect(drafted.out).toContain("a Release for v0.1.1 already exists");
        expect(drafted.output).toBe("tag=\n");
      });

      test("a lookup that fails stops the run rather than skipping the release", () => {
        const run = retry(base, [
          { match: "git/ref/tags/", code: 1, out: "Server Error (HTTP 500)" },
          noRelease,
        ]);
        expect(run.code).toBe(1);
        expect(run.err).toContain("could not look up");
        expect(run.output).toBe("");
      });

      test("a CHANGELOG with no version heading releases nothing and asks GitHub nothing", () => {
        const run = retry("# 변경 기록\n\n## 미출시\n\n- an edit\n");
        expect(run.code).toBe(0);
        expect(run.output).toBe("tag=\n");
        expect(run.calls).toEqual([]);
      });

      test.each([
        [
          "a top heading that is no version",
          changelog("v1.2", "v0.1.1"),
          "is not v",
        ],
        [
          "a top heading of build metadata",
          changelog("v1.2.3+b", "v0.1.1"),
          "is not v",
        ],
        [
          "a duplicated heading",
          changelog("v0.1.2", "v0.1.2", "v0.1.1"),
          "more than one section",
        ],
      ])("%s is refused", (_name, body, why) => {
        const run = retry(body);
        expect(run.code).toBe(1);
        expect(run.err).toContain(why);
        expect(run.output).toBe("");
      });

      test("only a push and a manual run read a release", () => {
        const run = retry(base, undefined, "schedule");
        expect(run.code).toBe(1);
        expect(run.err).toContain("no release is read from a schedule run");
        expect(run.calls).toEqual([]);
      });
    });
  });

  describe("main-chain", () => {
    // The fake gh prints what the script's --jq would have made of the answer.
    const mainChain = (
      replies: (Reply & { seq?: [string, number][] })[],
      env: Record<string, string>,
    ) =>
      sandbox((directory) => {
        const calls = fakeGh(directory, replies);
        return {
          ...sh(directory, [script("release-auto.sh"), "main-chain"], {
            GITHUB_SHA: sha,
            CI_POLL_SECONDS: "0",
            ...env,
          }),
          calls: calls(),
        };
      });
    const retry = { EVENT: "workflow_dispatch" };
    const push = { EVENT: "push", GITHUB_RUN_ID: "77" };
    const pushRun = { match: "actions/workflows/images.yml/runs", out: "4552" };

    test("a push waits for chart-publish-main of its own run, then passes on success", () => {
      const run = mainChain(
        [
          {
            match: "actions/runs/77/jobs",
            seq: [
              ["", 0],
              ["queued none", 0],
              ["in_progress none", 0],
              ["completed success", 0],
            ],
          },
        ],
        push,
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain("chart-publish-main passed in Images run 77");
      expect(run.calls.length).toBe(4);
      expect(run.calls[0]).toContain('select(.name == "chart-publish-main")');
      expect(run.calls[0]).toContain("filter=latest");
    });

    test("a push whose chart-publish-main does not finish in time fails", () => {
      const run = mainChain(
        [{ match: "actions/runs/77/jobs", out: "in_progress none" }],
        { ...push, MAIN_CHAIN_WAIT_SECONDS: "0" },
      );
      expect(run.code).toBe(1);
      expect(run.err).toContain("still in_progress");
    });

    test("a retry started while the push run is still on its way waits for it", () => {
      const run = mainChain(
        [
          pushRun,
          {
            match: "actions/runs/4552/jobs",
            seq: [
              ["", 0],
              ["in_progress none", 0],
              ["completed success", 0],
            ],
          },
          { match: "--jq .status", out: "in_progress" },
        ],
        retry,
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain("chart-publish-main passed in Images run 4552");
      const timedOut = mainChain(
        [
          pushRun,
          { match: "actions/runs/4552/jobs", out: "queued none" },
          { match: "--jq .status", out: "in_progress" },
        ],
        { ...retry, MAIN_CHAIN_WAIT_SECONDS: "0" },
      );
      expect(timedOut.code).toBe(1);
      expect(timedOut.err).toContain("still queued");
    });

    test("a push run that ends between two reads is judged on its final jobs", () => {
      // The job was still running when read, and the run completed right
      // after: the next round reads the run first, then its final jobs.
      const run = mainChain(
        [
          pushRun,
          {
            match: "actions/runs/4552/jobs",
            seq: [
              ["in_progress none", 0],
              ["completed success", 0],
            ],
          },
          {
            match: "--jq .status",
            seq: [
              ["in_progress", 0],
              ["completed", 0],
            ],
          },
        ],
        retry,
      );
      expect(run.code).toBe(0);
      const order = run.calls.map((call) =>
        call.includes("/jobs")
          ? "jobs"
          : call.includes(".status")
            ? "run"
            : "list",
      );
      expect(order).toEqual(["list", "run", "jobs", "run", "jobs"]);
    });

    test("a retry reads the push run of this commit", () => {
      const run = mainChain(
        [
          pushRun,
          { match: "actions/runs/4552/jobs", out: "completed success" },
          { match: "--jq .status", out: "completed" },
        ],
        retry,
      );
      expect(run.code).toBe(0);
      expect(run.out).toContain("chart-publish-main passed in Images run 4552");
      expect(run.calls[0]).toContain(`head_sha=${sha}`);
      expect(run.calls[0]).toContain("event=push");
      expect(run.calls[0]).toContain("branch=main");
      expect(run.calls[2]).toContain('select(.name == "chart-publish-main")');
    });

    test.each([
      [push, "completed failure", "concluded failure"],
      [push, "completed skipped", "concluded skipped"],
      [retry, "completed failure", "concluded failure"],
      [retry, "completed skipped", "concluded skipped"],
      // Once the push run a retry reads has ended, what is not done never ran.
      [retry, "", "is absent, not completed"],
      [retry, "in_progress none", "is in_progress, not completed"],
    ])(
      "%j with chart-publish-main %j stops the release",
      (env, answer, why) => {
        const run = mainChain(
          [
            pushRun,
            { match: "/jobs", out: answer },
            { match: "--jq .status", out: "completed" },
          ],
          env,
        );
        expect(run.code).toBe(1);
        expect(run.err).toContain(why);
      },
    );

    test("no push run, a failed lookup or another event stops the release", () => {
      const none = mainChain(
        [{ match: "actions/workflows/images.yml/runs", out: "" }],
        retry,
      );
      expect(none.code).toBe(1);
      expect(none.err).toContain(`no Images push run of ${sha}`);
      const broken = mainChain(
        [
          {
            match: "actions/workflows/images.yml/runs",
            code: 1,
            out: "HTTP 500",
          },
        ],
        retry,
      );
      expect(broken.code).toBe(1);
      expect(broken.err).toContain("could not read the Images push runs");
      const jobs = mainChain(
        [{ match: "actions/runs/77/jobs", code: 1, out: "HTTP 500" }],
        push,
      );
      expect(jobs.code).toBe(1);
      expect(jobs.err).toContain("could not read the jobs of Images run 77");
      const schedule = mainChain([], { EVENT: "schedule" });
      expect(schedule.code).toBe(1);
      expect(schedule.err).toContain(
        "no main chain is read for a schedule run",
      );
    });
  });

  describe("ci", () => {
    const ciRun = (replies: Reply[], env: Record<string, string> = {}) =>
      sandbox((directory) => {
        const calls = fakeGh(directory, replies);
        return {
          ...sh(directory, [script("release-auto.sh"), "ci"], {
            GITHUB_SHA: sha,
            CI_POLL_SECONDS: "0",
            ...env,
          }),
          calls: calls(),
        };
      });
    const state = (status: string, conclusion: string) =>
      `${status} ${conclusion} https://example.test/run`;
    const runs = (...answers: string[]) => ({
      match: "actions/workflows/ci.yml/runs",
      seq: answers.map((answer): [string, number] => [answer, 0]),
    });

    test("waits for the run of this commit to finish, then passes on success", () => {
      const run = ciRun([
        runs(
          state("queued", "none"),
          state("in_progress", "none"),
          state("completed", "success"),
        ),
      ]);
      expect(run.code).toBe(0);
      expect(run.calls.length).toBe(3);
      expect(run.calls[0]).toContain(`head_sha=${sha}`);
      expect(run.calls[0]).toContain("event=push");
      expect(run.calls[0]).toContain("branch=main");
    });

    test.each(["failure", "cancelled", "timed_out"])(
      "a run that %s fails the release",
      (conclusion) => {
        const run = ciRun([runs(state("completed", conclusion))]);
        expect(run.code).toBe(1);
        expect(run.err).toContain(`concluded ${conclusion}`);
      },
    );

    test("no run, or one that does not finish in time, is a failure and not a pass", () => {
      const missing = ciRun([runs("null none null")], { CI_WAIT_SECONDS: "0" });
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("still null");
      const slow = ciRun([runs(state("in_progress", "none"))], {
        CI_WAIT_SECONDS: "0",
      });
      expect(slow.code).toBe(1);
      expect(slow.err).toContain("still in_progress");
    });
  });

  // A gh that applies the script's own --jq to API-shaped answers: runs (the
  // ci.yml runs list) and jobs-<id> (that run's jobs); no file, a failed call.
  type Run = { id: number; head_sha: string; event: string };
  type JobRow = {
    name: string;
    conclusion: string;
    steps?: { name: string; conclusion: string }[];
    run_attempt?: number;
  };
  type Answers = { runs?: Run[]; jobs?: Record<string, JobRow[]> };
  const apiRun = (command: string, answers: Answers) =>
    sandbox((directory) => {
      mkdirSync(join(directory, "bin"));
      if (answers.runs !== undefined) {
        writeFileSync(
          join(directory, "runs"),
          JSON.stringify({ workflow_runs: answers.runs }),
        );
      }
      for (const [id, rows] of Object.entries(answers.jobs ?? {})) {
        writeFileSync(
          join(directory, `jobs-${id}`),
          JSON.stringify({ jobs: rows }),
        );
      }
      writeFileSync(
        join(directory, "bin", "gh"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${directory}/calls.log"
shift
q=.
while [ $# -gt 0 ]; do
  case "$1" in --paginate) ;; --jq) q=$2; shift ;; *) path=$1 ;; esac
  shift
done
case "$path" in
  */actions/workflows/ci.yml/runs*) f=runs ;;
  */actions/runs/*/jobs*) f="jobs-$(sed -E 's|.*actions/runs/([0-9]+)/jobs.*|\\1|' <<<"$path")" ;;
  *) exit 9 ;;
esac
[ -e "${directory}/$f" ] || { echo "gh: HTTP 502" >&2; exit 1; }
jq -r "$q" "${directory}/$f"
`,
        { mode: 0o755 },
      );
      const run = sh(directory, [script("release-auto.sh"), command], {
        GITHUB_SHA: sha,
      });
      return {
        ...run,
        calls: readFileSync(join(directory, "calls.log"), "utf8")
          .split("\n")
          .filter(Boolean),
      };
    });

  describe("conformance", () => {
    const conformanceRun = (answers: Answers) => apiRun("conformance", answers);
    const engines = ["claude_agent_sdk", "codex_app_server", "two_engines"];
    const run = (id: number, event = "push", head = sha): Run => ({
      id,
      head_sha: head,
      event,
    });
    const job = (name: string, conclusion = "success"): JobRow => ({
      name,
      conclusion,
    });
    const suite = (conclusion = "success") =>
      engines.map((e) => job(`conformance (${e})`, conclusion));

    test("its engines are ci.yml's conformance matrix", () => {
      const ci = Bun.YAML.parse(
        readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
      ) as {
        jobs: Record<string, { strategy?: { matrix: { engine?: string[] } } }>;
      };
      expect(ci.jobs.conformance?.strategy?.matrix.engine).toEqual(engines);
      expect(readFileSync(script("release-auto.sh"), "utf8")).toContain(
        `conformance_engines=(${engines.join(" ")})`,
      );
    });

    test("passes on a push or manual run of this commit whose every engine passed", () => {
      for (const event of ["push", "workflow_dispatch"]) {
        const passed = conformanceRun({
          runs: [run(42, event)],
          jobs: { "42": [job("check"), ...suite()] },
        });
        expect(passed.code).toBe(0);
        expect(passed.out).toContain("passed in ci.yml run 42");
        expect(passed.calls[0]).toContain(`head_sha=${sha}`);
      }
    });

    test("the newest run is read first, and an older one counts when it lacks an engine", () => {
      const result = conformanceRun({
        runs: [run(42), run(43)],
        jobs: {
          "43": [
            job("conformance (claude_agent_sdk)"),
            job("conformance (codex_app_server)", "failure"),
            job("conformance (two_engines)", "skipped"),
          ],
          "42": suite(),
        },
      });
      expect(result.code).toBe(0);
      expect(result.out.indexOf("run 43 did not pass")).toBeLessThan(
        result.out.indexOf("passed in ci.yml run 42"),
      );
      expect(result.out).toContain(
        "run 43 did not pass conformance on: codex_app_server, two_engines",
      );
      expect(result.out).toContain("passed in ci.yml run 42");
    });

    test("a failed, skipped or cancelled engine, a pull_request run, or another commit is no pass", () => {
      for (const conclusion of ["failure", "skipped", "cancelled"]) {
        const result = conformanceRun({
          runs: [run(42)],
          jobs: { "42": suite(conclusion) },
        });
        expect(result.code).toBe(1);
      }
      // A pull_request run tests a merge of the head, not this commit.
      const pr = conformanceRun({
        runs: [run(42, "pull_request")],
        jobs: { "42": suite() },
      });
      expect(pr.code).toBe(1);
      expect(pr.calls.some((call) => call.includes("runs/42/jobs"))).toBe(
        false,
      );
      const other = conformanceRun({
        runs: [run(42, "push", "f".repeat(40))],
        jobs: { "42": suite() },
      });
      expect(other.code).toBe(1);
      // A job named like an engine but with a suffix is not that engine.
      const near = conformanceRun({
        runs: [run(42)],
        jobs: {
          "42": engines.map((e) => job(`conformance (${e}) x`)),
        },
      });
      expect(near.code).toBe(1);
    });

    test("no run or a failed lookup stops the release", () => {
      const none = conformanceRun({ runs: [] });
      expect(none.code).toBe(1);
      expect(none.err).toContain("only=conformance");
      const lookup = conformanceRun({});
      expect(lookup.code).toBe(1);
      expect(lookup.err).toContain("could not read the ci.yml runs");
      const jobs = conformanceRun({ runs: [run(42)] });
      expect(jobs.code).toBe(1);
      expect(jobs.err).toContain("could not read the jobs of ci.yml run 42");
    });

    test("a pushed tag and the release push both check it before their approval", () => {
      expect(needsOf("publish")).toContain("tag-conformance");
      expect(jobs["tag-conformance"]?.if).toBe(jobs.publish?.if);
      expect(jobs["tag-conformance"]?.permissions).toEqual({
        contents: "read",
        actions: "read",
      });
      expect(jobs["tag-conformance"]?.steps.map((s) => s.run)).toContain(
        ".github/scripts/release-auto.sh conformance",
      );
      expect(ancestors("release-approve").has("release-gate")).toBe(true);
    });
  });

  describe("k8s-smoke", () => {
    // A main push plans k8s-smoke only for some commits (ci-plan.sh), so its
    // green run proves nothing about it: every release path reads the pass.
    const smokeRun = (answers: Answers) => apiRun("k8s-smoke", answers);
    const run = (id: number, event = "push", head = sha): Run => ({
      id,
      head_sha: head,
      event,
    });
    const step = (name: string, conclusion = "success") => ({
      name,
      conclusion,
    });
    const smoke = (job = "success", smokeStep = "success"): JobRow => ({
      name: "k8s-smoke",
      conclusion: job,
      steps: [step("Set up job"), step("deploy/kind/smoke.sh", smokeStep)],
    });
    const reusedStep = "k8s-smoke passed in the reused PR run";
    const changes = (reuse: string): JobRow => ({
      name: "changes",
      conclusion: "success",
      steps: [
        step("Reuse the PR run that tested this tree"),
        step(reusedStep, reuse),
      ],
    });
    const ci = Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as { jobs: Record<string, Job & { if?: string }> };

    test("the steps it reads are ci.yml's: the smoke itself and the reuse of a PR run that passed it", () => {
      const text = readFileSync(script("release-auto.sh"), "utf8");
      const smokeSteps = ci.jobs["k8s-smoke"]?.steps.map((s) => s.name) ?? [];
      expect(smokeSteps).toContain("deploy/kind/smoke.sh");
      expect(text).toContain(
        '(if .name == "k8s-smoke" then "deploy/kind/smoke.sh" else "k8s-smoke passed in the reused PR run" end)',
      );
      const reuse = ci.jobs.changes?.steps.find((s) => s.name === reusedStep) as
        | { if?: string }
        | undefined;
      // The same condition that drops k8s-smoke from the push's plan.
      expect(reuse?.if).toBe("steps.reuse.outputs.k8s == 'true'");
      expect(JSON.stringify(ci.jobs.changes)).toContain(
        "steps.reuse.outputs.k8s == 'true' && 'false' || steps.plan.outputs.k8s",
      );
      expect(text).toContain(`"${reusedStep}"`);
    });

    test("every attempt is read, and each job by its newest attempt", () => {
      // A rerun of another job alone leaves attempt 2 without k8s-smoke.
      const other = smokeRun({
        runs: [run(42)],
        jobs: {
          "42": [
            { ...smoke(), run_attempt: 1 },
            { ...changes("skipped"), run_attempt: 1 },
            { ...changes("skipped"), run_attempt: 2 },
          ],
        },
      });
      expect(other.code).toBe(0);
      expect(other.calls[1]).toContain("filter=all");
      // A rerun of k8s-smoke that failed is no pass, whatever attempt 1 did.
      const rerun = smokeRun({
        runs: [run(42)],
        jobs: {
          "42": [
            { ...smoke(), run_attempt: 1 },
            { ...smoke("failure", "failure"), run_attempt: 2 },
          ],
        },
      });
      expect(rerun.code).toBe(1);
      // and one that passed after a failure is.
      const fixed = smokeRun({
        runs: [run(42)],
        jobs: {
          "42": [
            { ...smoke("failure", "failure"), run_attempt: 1 },
            { ...smoke(), run_attempt: 2 },
          ],
        },
      });
      expect(fixed.code).toBe(0);
    });

    test("passes on a push or manual run of this commit whose smoke step passed", () => {
      for (const event of ["push", "workflow_dispatch"]) {
        const passed = smokeRun({
          runs: [run(42, event)],
          jobs: { "42": [changes("skipped"), smoke()] },
        });
        expect(passed.code).toBe(0);
        expect(passed.out).toContain("k8s-smoke: passed in ci.yml run 42");
        expect(passed.calls[0]).toContain(`head_sha=${sha}`);
        expect(passed.calls[0]).toContain("status=completed");
      }
    });

    test("passes on the main push that skipped it for the PR run of its tree", () => {
      const passed = smokeRun({
        runs: [run(42)],
        jobs: {
          "42": [
            changes("success"),
            { name: "k8s-smoke", conclusion: "skipped" },
          ],
        },
      });
      expect(passed.code).toBe(0);
      expect(passed.out).toContain("reused the pull request run");
    });

    test("an older run counts when the newest lacks it", () => {
      const result = smokeRun({
        runs: [run(42, "workflow_dispatch"), run(43)],
        jobs: { "43": [changes("skipped")], "42": [smoke()] },
      });
      expect(result.code).toBe(0);
      expect(result.out).toContain("ci.yml run 43 did not pass k8s-smoke");
      expect(result.out.indexOf("run 43 did not pass k8s-smoke")).toBeLessThan(
        result.out.indexOf("passed in ci.yml run 42"),
      );
    });

    test("a green run that skipped it, a failed smoke, a pull_request run or another commit is no pass", () => {
      // The commit this PR is about: main CI green, k8s-smoke left out of its plan.
      const skipped = smokeRun({
        runs: [run(42)],
        jobs: {
          "42": [
            changes("skipped"),
            { name: "k8s-smoke", conclusion: "skipped" },
          ],
        },
      });
      expect(skipped.code).toBe(1);
      expect(skipped.out).toContain("ci.yml run 42 did not pass k8s-smoke");
      expect(skipped.err).toContain("only=k8s-smoke");
      for (const [job, smokeStep] of [
        ["failure", "failure"],
        ["success", "skipped"],
        ["failure", "success"],
        ["cancelled", "success"],
      ]) {
        const result = smokeRun({
          runs: [run(42)],
          jobs: { "42": [smoke(job, smokeStep)] },
        });
        expect(result.code).toBe(1);
      }
      const reuseFailed = smokeRun({
        runs: [run(42)],
        jobs: { "42": [{ ...changes("success"), conclusion: "failure" }] },
      });
      expect(reuseFailed.code).toBe(1);
      const pr = smokeRun({
        runs: [run(42, "pull_request")],
        jobs: { "42": [smoke()] },
      });
      expect(pr.code).toBe(1);
      expect(pr.calls.some((call) => call.includes("runs/42/jobs"))).toBe(
        false,
      );
      const other = smokeRun({
        runs: [run(42, "push", "f".repeat(40))],
        jobs: { "42": [smoke()] },
      });
      expect(other.code).toBe(1);
      const near = smokeRun({
        runs: [run(42)],
        jobs: { "42": [{ ...smoke(), name: "k8s-smoke x" }] },
      });
      expect(near.code).toBe(1);
    });

    test("no run or a failed lookup stops the release", () => {
      const none = smokeRun({ runs: [] });
      expect(none.code).toBe(1);
      expect(none.err).toContain("no ci.yml push or manual run");
      expect(none.err).toContain("only=k8s-smoke");
      const lookup = smokeRun({});
      expect(lookup.code).toBe(1);
      expect(lookup.err).toContain("could not read the ci.yml runs");
      const jobs = smokeRun({ runs: [run(42)] });
      expect(jobs.code).toBe(1);
      expect(jobs.err).toContain("could not read the jobs of ci.yml run 42");
    });

    test("a pushed tag checks it before its approval, and the release push and retry in release-gate", () => {
      expect(needsOf("publish")).toContain("tag-conformance");
      expect(jobs["tag-conformance"]?.steps.map((s) => s.run)).toContain(
        ".github/scripts/release-auto.sh k8s-smoke",
      );
      for (const name of ["tag-conformance", "release-gate"]) {
        const env = jobs[name]?.steps.find(
          (s) => s.run === ".github/scripts/release-auto.sh k8s-smoke",
        )?.env;
        expect(env).toEqual({
          GH_REPO: "$" + "{{ github.repository }}",
          GH_TOKEN: "$" + "{{ github.token }}",
        });
      }
      expect(ancestors("release-approve").has("release-gate")).toBe(true);
    });
  });

  describe("tag", () => {
    const tagRun = (replies: (Reply & { seq?: [string, number][] })[]) =>
      sandbox((directory) => {
        const calls = fakeGh(directory, replies);
        return {
          ...sh(directory, [script("release-auto.sh"), "tag"], {
            TAG: "v0.1.2",
            GITHUB_SHA: sha,
            GITHUB_RUN_ID: "77",
          }),
          calls: calls(),
        };
      });
    const peeled = (value: string): Reply => ({
      match: "git/tags/tagobj",
      out: value,
    });

    test("creates the annotated tag object, then the ref, then reads the commit back", () => {
      const run = tagRun([
        { match: "-X POST repos/owner/repo/git/tags", out: "tagobj" },
        { match: "-X POST repos/owner/repo/git/refs", out: "{}" },
        peeled(sha),
        absent,
        noRelease,
      ]);
      expect(run.code).toBe(0);
      const writes = run.calls.filter((call) => call.includes("-X POST"));
      expect(writes.length).toBe(2);
      expect(writes[0]).toContain(`object=${sha}`);
      expect(writes[0]).toContain("type=commit");
      expect(writes[0]).toContain("Images run 77 ");
      expect(writes[1]).toContain("ref=refs/tags/v0.1.2");
      expect(writes[1]).toContain("sha=tagobj");
    });

    test("a tag that points anywhere but the approved commit fails", () => {
      const run = tagRun([
        { match: "-X POST repos/owner/repo/git/tags", out: "tagobj" },
        { match: "-X POST repos/owner/repo/git/refs", out: "{}" },
        peeled("f".repeat(40)),
        absent,
        noRelease,
      ]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("not the approved");
    });

    test("a tag or Release made since the approval stops it before anything is written", () => {
      const tagged = tagRun([
        {
          match: "git/ref/tags/",
          seq: [
            ["", 1],
            ["{}", 0],
          ],
        },
        noRelease,
      ]);
      expect(tagged.code).toBe(1);
      expect(tagged.calls.some((call) => call.includes("-X POST"))).toBe(false);
      const released = tagRun([
        absent,
        { match: "releases?per_page", out: "5" },
      ]);
      expect(released.code).toBe(1);
      expect(released.calls.some((call) => call.includes("-X POST"))).toBe(
        false,
      );
    });

    test("another run's tag of the version is a second release, this run's own is a retry", () => {
      const existing = (message: string): Reply[] => [
        { match: "git/ref/tags/", out: "tagobj" },
        { match: "--jq .message", out: message },
        peeled(sha),
      ];
      const other = tagRun(
        existing(
          "v0.1.2\n\nCreated by the Images run 12 after the release approval",
        ),
      );
      expect(other.code).toBe(1);
      expect(other.err).toContain("not made by this run");
      const retry = tagRun(
        existing(
          "v0.1.2\n\nCreated by the Images run 77 after the release approval",
        ),
      );
      expect(retry.code).toBe(0);
      expect(retry.calls.some((call) => call.includes("-X POST"))).toBe(false);
    });

    test("a ref that cannot be created fails and leaves nothing moved", () => {
      const run = tagRun([
        { match: "-X POST repos/owner/repo/git/tags", out: "tagobj" },
        {
          match: "-X POST repos/owner/repo/git/refs",
          code: 1,
          out: "Reference already exists (HTTP 422)",
        },
        absent,
        noRelease,
      ]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("could not create refs/tags/v0.1.2");
    });
  });
});

describe("release-stage.sh", () => {
  const apps = ["control-host", "egress-proxy", "worker", "worker-codex"];
  const stage = (
    mutate: (dir: string) => void = () => {},
    env: Record<string, string> = { RELEASE_REF: "refs/tags/v1.2.3" },
  ) => {
    const directory = mkdtempSync(join(tmpdir(), "release-stage-"));
    try {
      for (const sub of ["main", "strict"]) mkdirSync(join(directory, sub));
      for (const app of apps) {
        writeFileSync(
          join(directory, "main", `${app}.json`),
          JSON.stringify({
            app,
            ref: "refs/heads/main",
            digest: `sha256:${"a".repeat(64)}`,
            unverifiedSources: ["lenient"],
            commit: sha,
          }),
        );
        writeFileSync(
          join(directory, "strict", `${app}.json`),
          JSON.stringify(["strict"]),
        );
      }
      mutate(directory);
      const run = Bun.spawnSync(
        [
          "bash",
          script("release-stage.sh"),
          join(directory, "main"),
          join(directory, "strict"),
          join(directory, "out"),
        ],
        { env: { PATH: process.env.PATH ?? "", ...env } },
      );
      // Read before the directory goes.
      const records = Object.fromEntries(
        apps
          .filter((app) => existsSync(join(directory, "out", `${app}.json`)))
          .map((app) => [
            app,
            JSON.parse(
              readFileSync(join(directory, "out", `${app}.json`), "utf8"),
            ),
          ]),
      );
      const record = (app: string) => records[app];
      return {
        code: run.exitCode,
        err: run.stderr.toString(),
        record,
        wrote: existsSync(join(directory, "out", "worker.json")),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  test("keeps main's digest, moves the ref to the tag and keeps where it was built", () => {
    const run = stage();
    expect(run.code).toBe(0);
    for (const app of apps) {
      expect(run.record(app)).toMatchObject({
        ref: "refs/tags/v1.2.3",
        buildRef: "refs/heads/main",
        digest: `sha256:${"a".repeat(64)}`,
        unverifiedSources: ["strict"],
        commit: sha,
      });
    }
  });

  test("chart and manifest act on RELEASE_REF when a main run sets it", () => {
    expect(
      effectiveRef({
        RELEASE_REF: "refs/tags/v1.2.3",
        GITHUB_REF: "refs/heads/main",
      }),
    ).toBe("refs/tags/v1.2.3");
    expect(effectiveRef({ GITHUB_REF: "refs/tags/v1.2.3" })).toBe(
      "refs/tags/v1.2.3",
    );
    expect(
      effectiveRef({ RELEASE_REF: "", GITHUB_REF: "refs/heads/main" }),
    ).toBe("refs/heads/main");
    const sources = ["chart-package.ts", "release-manifest.ts"].map((file) =>
      readFileSync(script(file), "utf8"),
    );
    for (const source of sources) {
      expect(source).toContain("effectiveRef(process.env)");
    }
  });

  test("the staged record then passes the manifest's own ref check", () => {
    // release-manifest.ts requires record.ref === the tag ref; chartVersion
    // takes the same ref, so the tag name is one fact in both.
    expect(
      chartVersion({
        ref: "refs/tags/v1.2.3",
        sha,
        chartYamlVersion: "0.0.0",
        chartName: "werft",
      }).appVersion,
    ).toBe("v1.2.3");
  });

  test("refuses a ref that is not a release tag", () => {
    const run = stage(undefined, { RELEASE_REF: "refs/heads/main" });
    expect(run.code).toBe(1);
    expect(run.err).toContain("must be a refs/tags/v* ref");
    expect(run.wrote).toBe(false);
  });

  test("refuses a record main did not stage", () => {
    const run = stage((dir) =>
      writeFileSync(
        join(dir, "main", "worker.json"),
        JSON.stringify({
          app: "worker",
          ref: "refs/tags/v0.0.1",
          digest: "sha256:x",
        }),
      ),
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain("not staged by a main push");
  });

  test("refuses a missing strict source list", () => {
    const run = stage((dir) => rmSync(join(dir, "strict", "worker.json")));
    expect(run.code).toBe(1);
    expect(run.err).toContain("is missing");
  });
});

// Pull requests write changelog fragments; a release pull request collects
// them with the unreleased section into the version heading detect reads.
describe("changelog-release.ts", () => {
  const head = "# 변경 기록\n\n## 쓰는 방식\n\n- 규칙\n\n";
  const old = "## v0.5.0\n\n요약.\n\n### 운영자가 할 일\n\n- 옛 항목\n";
  const unreleased =
    "## 미출시\n\n### 운영자가 할 일\n\n- 미출시 항목 (#1)\n  - 아래 줄\n\n";
  const ops = (entry: string) => `### 운영자가 할 일\n\n- ${entry}\n`;

  /** Runs the script in a repository root holding this CHANGELOG and these fragments. */
  const release = (
    changelog: string,
    fragments: Record<string, string>,
    ...args: string[]
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-release-"));
    try {
      writeFileSync(join(dir, "CHANGELOG.md"), changelog);
      mkdirSync(join(dir, FRAGMENT_DIR));
      writeFileSync(join(dir, FRAGMENT_DIR, "README.md"), "how");
      for (const [name, body] of Object.entries(fragments)) {
        writeFileSync(join(dir, FRAGMENT_DIR, name), body);
      }
      const run = Bun.spawnSync(
        [process.execPath, script("changelog-release.ts"), ...args],
        {
          cwd: dir,
        },
      );
      return {
        code: run.exitCode,
        err: run.stderr.toString(),
        changelog: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
        left: readdirSync(join(dir, FRAGMENT_DIR))
          .filter((name) => name !== "README.md")
          .sort(),
        readme: existsSync(join(dir, FRAGMENT_DIR, "README.md")),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("two fragments and the unreleased section become one version section, and the fragments go", () => {
    const run = release(
      head + unreleased + old,
      {
        "94S-990.md": ops("오래된 조각"),
        "94S-1002.md": `### 보안\n\n- 보안 항목\n\n${ops("새 조각")}`,
      },
      "v0.6.0",
    );
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.changelog).toBe(
      head +
        "## v0.6.0\n\n### 보안\n\n- 보안 항목\n\n" +
        "### 운영자가 할 일\n\n- 새 조각\n- 오래된 조각\n- 미출시 항목 (#1)\n  - 아래 줄\n\n" +
        old,
    );
    expect(run.left).toEqual([]);
    expect(run.readme).toBe(true);
    // The new section is the one heading detect reads as the release.
    expect(
      [...run.changelog.matchAll(/^## (v\S+)$/gm)].map((m) => m[1]),
    ).toEqual(["v0.6.0", "v0.5.0"]);
  });

  test("without an unreleased section the fragments go above the newest version", () => {
    const run = release(head + old, { "94S-1.md": ops("조각") }, "v0.6.0");
    expect(run.code).toBe(0);
    expect(run.changelog).toBe(`${head}## v0.6.0\n\n${ops("조각")}\n${old}`);
  });

  test("nothing to collect changes nothing", () => {
    for (const changelog of [head + old, `${head}## 미출시\n\n${old}`]) {
      const run = release(changelog, {}, "v0.6.0");
      expect(run.code).toBe(0);
      expect(run.changelog).toBe(changelog);
      expect(run.readme).toBe(true);
    }
  });

  test.each([
    [
      "a heading outside the two sections",
      { "a.md": "### 추가\n\n- x\n" },
      'a.md:1: "### 추가"',
    ],
    [
      "a version heading",
      { "a.md": "## v9.9.9\n\n- x\n" },
      'a.md:1: "## v9.9.9"',
    ],
    ["text before a heading", { "a.md": "- x\n" }, "a.md:1: text before"],
    ["a section twice", { "a.md": `${ops("x")}${ops("y")}` }, "appears twice"],
    [
      "an empty section",
      { "a.md": "### 보안\n\n" },
      '"### 보안" has no entries',
    ],
    ["an empty fragment", { "a.md": "\n" }, "a.md: no section"],
    ["a file that is no .md", { "a.txt": ops("x") }, "changelog.d/a.txt"],
    [
      "CRLF line endings",
      { "a.md": ops("x").replaceAll("\n", "\r\n") },
      "a.md: CRLF",
    ],
    [
      "a fence closed by a shorter run",
      { "a.md": `${ops("x")}  \`\`\`\`\n  y\n  \`\`\`\n` },
      "a fence-like line inside a code fence",
    ],
    [
      "a fence closed by the other character",
      { "a.md": `${ops("x")}  \`\`\`\n  y\n  ~~~\n` },
      "a fence-like line inside a code fence",
    ],
    [
      "a section heading inside a fence",
      { "a.md": `${ops("x")}  \`\`\`\n### 보안\n  \`\`\`\n` },
      '"### 보안" inside a code fence',
    ],
    [
      "a top-level fence closed at a deeper indent",
      { "a.md": `${ops("x")}  \`\`\`\n  y\n      \`\`\`\n` },
      "a.md:6: a fence-like line inside a code fence",
    ],
    [
      "a relative link",
      { "a.md": ops("[절차](../docs/quickstart.md)") },
      'a.md:3: link "../docs/quickstart.md" is relative',
    ],
    [
      "a reference definition",
      { "a.md": `${ops("[절차][q]")}\n  [q]: https://example.test/q\n` },
      "a.md:3: a reference definition or a bracket",
    ],
    [
      "a reference definition in a quote",
      { "a.md": `${ops("> [q]: ../docs/quickstart.md")}` },
      "a.md:3: a reference definition",
    ],
    [
      "a fence closed with a no-break space after it",
      {
        "a.md": `${ops("x")}  \`\`\`\n  y\n  \`\`\`${String.fromCharCode(160)}\n`,
      },
      "a fence-like line inside a code fence",
    ],
    [
      "a fence-like line at another indent inside a fence",
      { "a.md": `${ops("x")}  \`\`\`sh\n   \`\`\`\n  \`\`\`\n` },
      "a.md:5: a fence-like line inside a code fence",
    ],
    [
      "an escaped bracket",
      { "a.md": ops("[q\\]x]: ../docs/quickstart.md") },
      "a.md:3: an escaped backtick or bracket",
    ],
    [
      "an escaped backtick around a link",
      { "a.md": ops("\\`[절차](../docs/quickstart.md)\\`") },
      "a.md:3: an escaped backtick or bracket",
    ],
    ["an HTML comment", { "a.md": ops("x <!-- 메모") }, "a.md:3: raw HTML"],
    ["an HTML block", { "a.md": `${ops("x")}\n  <pre>\n` }, "a.md:5: raw HTML"],
    [
      "a paragraph outside an entry",
      { "a.md": `${ops("x")}\n문단\n` },
      "a.md:5: a line that is neither an entry",
    ],
    [
      "a top-level fence",
      { "a.md": `${ops("x")}\`\`\`\ny\n\`\`\`\n` },
      "a.md:4: a line that is neither an entry",
    ],
    [
      "a section that starts indented",
      { "a.md": "### 운영자가 할 일\n\n  이어지는 문장\n" },
      'a.md: "### 운영자가 할 일" must start with an entry',
    ],
    [
      "a fence info string with a backtick",
      { "a.md": `${ops("x")}  \`\`\`bad\`info\n  y\n  \`\`\`\n` },
      "a.md:4: a fence info string",
    ],
    [
      "a reference label that runs on to the next line",
      { "a.md": ops("x\n\n  [새 문맥으로\n  계속]: https://example.test") },
      "a.md:5: a reference definition or a bracket",
    ],
    [
      "a line inside a fence less indented than the fence",
      { "a.md": `${ops("x")}  \`\`\`\nfoo\n  \`\`\`\n` },
      "a.md:5: a line inside a code fence is less indented",
    ],
    [
      "a line separator",
      { "a.md": ops(`x${String.fromCharCode(0x2028)}## v999.0.1`) },
      "a.md:3: a control character or line separator",
    ],
    [
      "a fence left open",
      { "a.md": `${ops("x")}  \`\`\`sh\n  echo\n` },
      "a.md: a code fence is not closed",
    ],
    [
      "a version heading inside a fence",
      { "a.md": `${ops("x")}  \`\`\`\n## v9.9.9\n  \`\`\`\n` },
      '"## v9.9.9"',
    ],
  ])("%s fails, and nothing is written or deleted", (_, fragments, message) => {
    const changelog = head + unreleased + old;
    const run = release(
      changelog,
      { "ok.md": ops("ok"), ...fragments },
      "v0.6.0",
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain(message);
    expect(run.changelog).toBe(changelog);
    expect(run.left).toEqual(Object.keys({ "ok.md": "", ...fragments }).sort());
  });

  test("a version that is no release, or one already listed, is refused", () => {
    const changelog = head + unreleased + old;
    for (const [version, message] of [
      ["v1.2", "is not v"],
      ["v1.2.3+b", "is not v"],
      ["v0.5.0", "already has a section for v0.5.0"],
      ["v1.2.3-rc-", "cannot be a chart version"],
      [`v1.2.3-${"a".repeat(60)}`, "cannot be a chart version"],
    ] as const) {
      const run = release(changelog, { "a.md": ops("x") }, version);
      expect(run.code).toBe(1);
      expect(run.err).toContain(message);
      expect(run.changelog).toBe(changelog);
      expect(run.left).toEqual(["a.md"]);
    }
    expect(release(changelog, {}).code).toBe(2);
  });

  test("a fence that closes is kept, and a CRLF CHANGELOG is refused", () => {
    const linked = ops(
      "[절차](https://example.test/a) [위](#v060) `handlers[name](request)`",
    );
    expect(
      collect(
        head + old,
        [
          {
            name: "c.md",
            text: `${ops("x")}  \`\`\`\n  f[a](b)\n  \`\`\`  \n`,
          },
        ],
        "v0.6.0",
      ),
    ).toContain("  f[a](b)\n");
    expect(
      collect(head + old, [{ name: "b.md", text: linked }], "v0.6.0"),
    ).toContain(linked.slice(-40));
    const fenced = `### 운영자가 할 일\n\n- 명령:\n\n  \`\`\`sh\n  run\n  \`\`\`\n`;
    expect(
      collect(head + old, [{ name: "a.md", text: fenced }], "v0.6.0"),
    ).toContain("  ```sh\n  run\n  ```\n");
    expect(() =>
      collect((head + unreleased + old).replaceAll("\n", "\r\n"), [], "v0.6.0"),
    ).toThrow("CRLF");
  });

  test("an unreleased section outside the two sections is refused", () => {
    expect(() =>
      collect(`${head}## 미출시\n\n### 기타\n\n- x\n\n${old}`, [], "v0.6.0"),
    ).toThrow('"### 기타"');
  });

  // CI holds what this repository carries to the format, so a bad fragment
  // fails its own pull request, not the release.
  test("this repository's fragments and unreleased section parse", () => {
    const names = fragmentNames(root);
    const fragments = names.map((name) => ({
      name,
      text: readFileSync(join(root, FRAGMENT_DIR, name), "utf8"),
    }));
    for (const { name, text } of fragments) {
      expect(parseSections(text, name).size).toBeGreaterThan(0);
    }
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    // A release pull request's tree has no fragment and no unreleased entry.
    const next = collect(changelog, fragments, "v999.0.0");
    expect(next === null || collect(next, [], "v999.0.1") === null).toBe(true);
  });
});
