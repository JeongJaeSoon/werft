import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A concurrency group keeps one running and one pending run, and a newer run
// replaces the pending one even with cancel-in-progress: false. So a release,
// tag, publish or deploy run is safe from being dropped only if no later run
// of the same kind shares its group.

const dir = join(import.meta.dir, "..", ".github", "workflows");

type Concurrency = { group: string; "cancel-in-progress": boolean | string };
type Workflow = {
  on: Record<string, { tags?: string[] } | null>;
  concurrency?: Concurrency;
  jobs: Record<string, { concurrency?: Concurrency }>;
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
};

// Shared serial groups on a release path whose pending run can still be lost.
// Known pending under 94S-2068: not allowed, only documented, so the test keeps
// passing until each is fixed. Remove a name here when its group is fixed.
const PENDING_94S_2068: Record<string, string> = {
  pages:
    "deploys its own ref, so a later run of an older ref replaces a newer one",
  "images-promote": "check-then-write of the sha-<12> and vX tags",
  "images-release": "one GitHub Release write at a time",
};

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
        const named = [
          ...Object.keys(LATEST_WINS),
          ...Object.keys(PENDING_94S_2068),
        ].includes(group.group);
        if (literal || named) {
          // A shared group is allowed only when named here, never cancelling.
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

  test("the two lists do not overlap and have no stale names", () => {
    const used = new Set(shared());
    const names = [
      ...Object.keys(LATEST_WINS),
      ...Object.keys(PENDING_94S_2068),
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(used.has(name)).toBe(true);
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
