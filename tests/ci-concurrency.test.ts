import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A concurrency group keeps one running and one pending run, and a newer run
// replaces the pending one even with cancel-in-progress: false. So a release,
// tag, publish or deploy run is safe from being dropped only if no later run
// of the same kind shares its group.

const dir = join(import.meta.dir, "..", ".github", "workflows");

type Concurrency = { group: string; "cancel-in-progress": boolean | string };
type Job = {
  concurrency?: Concurrency;
  if?: string;
  env?: Record<string, string>;
  steps?: { run?: string; env?: Record<string, string> }[];
};
type Workflow = {
  on: Record<string, { tags?: string[] } | null>;
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
};

const workflows = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    workflow: Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) as Workflow,
  }));

const PR_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}";

// Workflows that publish, tag, release or deploy. A tag trigger or a
// workflow_call from a release chain also counts; the list names the rest.
const RELEASE_BY_NAME = new Set([
  "images.yml",
  "pages.yml",
  "ci-image-mirror.yml",
  "worker-compat.yml",
]);
const isRelease = (file: string, workflow: Workflow) =>
  RELEASE_BY_NAME.has(file) ||
  Object.values(workflow.on).some((trigger) => trigger?.tags !== undefined);

// Shared serial groups where only the latest run matters. GitHub keeps only the
// newest waiting run of a group, so a name belongs here only when a later run
// rebuilds the whole desired state and so covers a dropped one.
// A run off main skips its job but would still replace a pending main run in
// a plain shared group, so it gets a group of its own.
const LATEST_WINS: Record<string, string> = {
  "ci-image-mirror-${{ github.ref == 'refs/heads/main' && 'main' || github.run_id }}":
    "every main run mirrors the whole list as of its own commit",
  "release-latest":
    "every run marks the highest stable of all published releases Latest",
  "pages-${{ (startsWith(github.ref, 'refs/tags/v') || github.ref == 'refs/heads/main') && 'deploy' || github.run_id }}":
    "every run deploys the site its tags and manual runs call for, not its own ref",
};

// Serial groups of one release. Jobs share one only when they release the same
// commit or the same tag, so no release waits behind another and none can
// replace another's waiting job.
const PER_RELEASE: Record<string, string> = {
  "images-promote-${{ github.sha }}":
    "vX and sha-<12> are written for one commit; its tags promote one at a time",
  "images-release-${{ github.ref_name }}": "a pushed tag's own GitHub Release",
  "images-release-${{ needs.release-detect.outputs.tag }}":
    "the GitHub Release of the tag a main run releases",
};

const NAMED = [LATEST_WINS, PER_RELEASE].flatMap((list) => Object.keys(list));

const groupsOf = ({ file, workflow }: (typeof workflows)[number]) => [
  ...(workflow.concurrency ? [{ where: file, ...workflow.concurrency }] : []),
  ...Object.entries(workflow.jobs).flatMap(([name, job]) =>
    job.concurrency ? [{ where: `${file}#${name}`, ...job.concurrency }] : [],
  ),
];

describe("release concurrency groups", () => {
  for (const entry of workflows.filter((w) => isRelease(w.file, w.workflow))) {
    for (const group of groupsOf(entry)) {
      test(`${group.where} never cancels or replaces a release run`, () => {
        const literal = !group.group.includes("{{");
        const named = NAMED.includes(group.group);
        if (literal || named) {
          // A serial group is allowed only when named here, never cancelling.
          expect(named).toBe(true);
          expect(group["cancel-in-progress"]).toBe(false);
          return;
        }
        // A pull request run is grouped by its PR number so a newer push
        // cancels it; every other run is grouped by its own run id.
        const hasPr = "pull_request" in entry.workflow.on;
        const pr = String.raw`\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}`;
        const own = String.raw`\$\{\{ github\.run_id \}\}`;
        const event = String.raw`(\$\{\{ github\.event_name \}\}-)?`;
        const shape = new RegExp(`^[a-z0-9-]+-${event}${hasPr ? pr : own}$`);
        expect(group.group).toMatch(shape);
        expect(group["cancel-in-progress"]).toBe(
          hasPr ? PR_ONLY_CANCEL : false,
        );
      });
    }
  }

  const shared = () =>
    workflows
      .filter((w) => isRelease(w.file, w.workflow))
      .flatMap(groupsOf)
      .map((g) => g.group);

  test("the lists do not overlap and have no stale names", () => {
    const used = new Set(shared());
    expect(new Set(NAMED).size).toBe(NAMED.length);
    for (const name of NAMED) expect(used.has(name)).toBe(true);
  });

  test("every release workflow is covered", () => {
    const covered = workflows.filter((w) => isRelease(w.file, w.workflow));
    expect(covered.map((w) => w.file)).toEqual(
      expect.arrayContaining([
        "images.yml",
        "pages.yml",
        "sdk-release.yml",
        "ui-release.yml",
        "worker-compat.yml",
      ]),
    );
  });
});

describe("images.yml release groups", () => {
  const images = workflows.find((w) => w.file === "images.yml");
  const jobs = images?.workflow.jobs ?? {};
  const inGroup = (name: string) =>
    Object.entries(jobs)
      .filter(([, job]) => job.concurrency?.group === name)
      .map(([job]) => job);
  const tagPush =
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";

  test("a release waits only behind its own commit or tag", () => {
    const promote = "images-promote-${{ github.sha }}";
    expect(inGroup(promote)).toEqual(["promote", "promote-release"]);
    // github.ref_name is the tag only in a run a tag push started.
    expect(inGroup("images-release-${{ github.ref_name }}")).toEqual([
      "release",
    ]);
    expect(jobs.release?.if).toBe(tagPush);
    expect(
      inGroup("images-release-${{ needs.release-detect.outputs.tag }}"),
    ).toEqual(["release-publish"]);
    // No job is left in a group every release shares, but the Latest mark's.
    const literal = Object.entries(jobs)
      .filter(
        ([, job]) => job.concurrency && !job.concurrency.group.includes("{{"),
      )
      .map(([name]) => name);
    expect(literal).toEqual(["latest", "latest-release"]);
  });

  test("the shared group only marks Latest, from every release and no version of its own", () => {
    const script = ".github/scripts/release-latest.sh";
    for (const name of inGroup("release-latest")) {
      const job = jobs[name];
      // Nothing tells the job which release its run made.
      expect(job?.env).toBeUndefined();
      const runs = (job?.steps ?? []).filter((step) => step.run !== undefined);
      expect(runs.map((step) => step.run)).toEqual([script]);
      expect(Object.keys(runs[0]?.env ?? {}).sort()).toEqual([
        "GH_REPO",
        "GH_TOKEN",
      ]);
    }
    const text = readFileSync(
      join(dir, "..", "scripts", "release-latest.sh"),
      "utf8",
    );
    for (const own of ["GITHUB_REF", "GITHUB_SHA", "RELEASE_REF"]) {
      expect(text).not.toContain(own);
    }
    expect(text).toContain("release-versions.ts");
  });

  test("a release's own jobs leave the Latest mark alone", () => {
    for (const group of Object.keys(PER_RELEASE)) {
      for (const name of inGroup(group)) {
        const runs = (jobs[name]?.steps ?? []).map((step) => step.run ?? "");
        expect(runs.join("\n")).not.toContain("release-latest.sh");
      }
    }
    const publish = readFileSync(
      join(dir, "..", "scripts", "release-publish.sh"),
      "utf8",
    );
    // Every write that publishes says so; GitHub's default would take the mark.
    const publishes = publish
      .split("\n")
      .filter((line) => line.includes("draft=false") && line.includes("PATCH"));
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toContain("-f make_latest=false");
  });
});

describe("pages.yml deploys what the site should be, not the run's ref", () => {
  const pages = workflows.find((w) => w.file === "pages.yml")?.workflow;
  const jobs = (pages?.jobs ?? {}) as Record<
    string,
    Job & {
      needs?: string[];
      steps?: { uses?: string; with?: Record<string, string | number> }[];
    }
  >;
  const target = "${{ needs.target.outputs.sha }}";

  test("every job after `target` checks out the commit it picked", () => {
    const others = Object.entries(jobs).filter(([name]) => name !== "target");
    expect(others.map(([name]) => name)).toEqual(["docs", "deploy"]);
    for (const [, job] of others) {
      expect(job.needs).toContain("target");
      const checkouts = (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.ref).toBe(target);
    }
  });

  test("nothing a run builds or deploys is chosen by its own ref or commit", () => {
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "target") continue;
      for (const step of job.steps ?? []) {
        const text = JSON.stringify([step.run, step.env, step.with]);
        expect(text).not.toContain("GITHUB_SHA");
        expect(text).not.toContain("GITHUB_REF");
        expect(text).not.toContain("github.sha");
        expect(text).not.toContain("github.ref");
      }
    }
  });
});
