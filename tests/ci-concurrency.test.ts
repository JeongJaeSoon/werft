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

// Fixed groups that serialize on purpose. GitHub keeps only the newest waiting
// run of such a group, so each needs a reason a dropped run loses nothing.
const SERIALIZED: Record<string, string> = {
  pages: "the site ends at the newest run's content",
  "ci-image-mirror": "every run mirrors the whole list of the newest main",
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
        if (literal) {
          // A shared group is allowed only when named here, never cancelling.
          expect(Object.keys(SERIALIZED)).toContain(group.group);
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

  test("a fixed group stays on the serialized list", () => {
    const used = workflows
      .filter((w) => isRelease(w.file, w.workflow))
      .flatMap(groupsOf)
      .map((g) => g.group)
      .filter((group) => !group.includes("{{"));
    for (const group of used) expect(SERIALIZED[group]).toBeString();
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
