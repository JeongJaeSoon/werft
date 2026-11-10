import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  steps: { name?: string; run?: string; with?: Record<string, string> }[];
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
];

describe("the release jobs of a main run", () => {
  test("nothing but release-detect runs for a push without a new version heading", () => {
    expect(jobs["release-detect"]?.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    for (const name of releaseJobs) {
      expect(jobs[name]?.if).toBe(hasTag);
      expect(needsOf(name)).toContain("release-detect");
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

  test("it waits for main's whole chain and for ci.yml before asking anyone", () => {
    expect(needsOf("release-gate")).toContain("chart-publish-main");
    expect(needsOf("release-approve")).toEqual(
      expect.arrayContaining(["release-gate", "sources-release"]),
    );
    expect(jobs["release-gate"]?.steps.map((step) => step.run)).toEqual([
      undefined,
      ".github/scripts/release-auto.sh ci",
      ".github/scripts/release-auto.sh free",
    ]);
    // Every Debian source is verified, not only warned about, before the approval.
    expect(jobs["sources-release"]?.env?.RELEASE_REF).toBe(
      "refs/tags/${{ needs.release-detect.outputs.tag }}",
    );
  });

  test("it promotes main's staged digests under the same lock as a pushed tag", () => {
    expect(jobs["promote-release"]?.concurrency).toEqual(
      jobs.promote?.concurrency ?? {},
    );
    expect(jobs["release-publish"]?.concurrency).toEqual(
      jobs.release?.concurrency ?? {},
    );
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
      options: { zeroBefore?: boolean; unrelated?: boolean } = {},
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
          { BEFORE: beforeSha, AFTER: second, GITHUB_OUTPUT: output },
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
      expect(fits.length - 1).toBe(57);
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

    test("a CHANGELOG that did not exist before makes every heading new, so it is refused", () => {
      const run = detect(null, base);
      expect(run.code).toBe(1);
      expect(run.err).toContain("more than one");
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
