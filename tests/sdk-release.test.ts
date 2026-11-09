import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = {
  id?: string;
  uses?: string;
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  "continue-on-error"?: boolean;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const text = read(".github/workflows/sdk-release.yml");
const workflow = Bun.YAML.parse(text) as Workflow;
const { build, tag, publish } = workflow.jobs;
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as Workflow;
const consumer = ci.jobs["sdk-pack-smoke"] as Job;
const check = build?.steps.find(
  (s) => s.name === "Commit and version can be released",
) as Step;
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

// Evaluate the workflow's actual gate with Actions' default success behavior.
function gate(expression: string, context: object, success = true): boolean {
  const explicit = /(?:cancelled|always|success|failure)\(\)/.test(expression);
  return (
    (explicit || success) &&
    Boolean(
      new Function(
        "github",
        "inputs",
        "needs",
        "cancelled",
        "startsWith",
        `return (${expression});`,
      )(
        ...Object.values(context),
        () => !success,
        (value: string, prefix: string) => value.startsWith(prefix),
      ),
    )
  );
}

describe("SDK release contract", () => {
  test("SDK tags do not match the image or UI release patterns", () => {
    expect(new Bun.Glob("v*").match("sdk-v0.1.0")).toBe(false);
    expect(new Bun.Glob("ui-v*").match("sdk-v0.1.0")).toBe(false);
  });
  test("release and consumer shell steps parse as bash", () => {
    for (const job of [...Object.values(workflow.jobs), consumer]) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const result = Bun.spawnSync(["bash", "-n", "-c", step.run]);
        expect(result.exitCode).toBe(0);
      }
    }
  });
  test("only version-tag pushes and manual runs start either package release", () => {
    for (const [file, prefix] of [
      ["sdk", "sdk-v*"],
      ["ui", "ui-v*"],
    ]) {
      const w = Bun.YAML.parse(
        read(`.github/workflows/${file}-release.yml`),
      ) as Workflow;
      expect(Object.keys(w.on).sort()).toEqual(["push", "workflow_dispatch"]);
      expect(w.on.push).toEqual({ tags: [prefix] });
    }
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        version: {
          description:
            "Version to publish, equal to packages/sdk/package.json. Empty is a dry run.",
          type: "string",
          required: false,
          default: "",
        },
      },
    });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("permissions and publication remain limited to their jobs", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["build", "tag", "publish"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(build?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(tag?.permissions).toEqual({ contents: "write" });
    expect(publish?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(publish?.environment).toBe("release");
    expect(tag?.environment).toBeUndefined();
    expect(publish?.needs).toEqual(["build", "tag"]);
    expect(tag?.needs).toBe("build");
    expect(runs(publish as Job).trim()).toBe(
      "npm publish ./pkg/*.tgz --provenance --access public",
    );
    expect(text).not.toContain("publish-main");
    expect(text).not.toContain("SDK_PRERELEASE");
    expect(text).not.toContain("Stamp the main prerelease version");
    expect(text).not.toContain("--tag main");
    expect(text).not.toContain("NODE_AUTH_TOKEN");
    expect(text).not.toContain("secrets");
    for (const job of Object.values(workflow.jobs)) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps) {
        expect(step["continue-on-error"]).toBeUndefined();
        expect(step.run ?? "").not.toContain("${{");
      }
    }
    for (const job of [tag, publish])
      expect(
        job?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
      ).toBe(false);
    const node = publish?.steps.find((s) =>
      s.uses?.startsWith("actions/setup-node@"),
    );
    expect(node?.with).toEqual({
      "node-version": 24,
      "registry-url": "https://registry.npmjs.org",
    });
  });

  test("release and PR consumer run the same SDK tests, build, version checks and smoke", () => {
    for (const job of [build, consumer]) {
      const script = runs(job as Job);
      const order = [
        "bun test packages/sdk examples",
        "packages/sdk/src/version.ts",
        "bun run --cwd packages/sdk build:package",
        "packages/sdk/dist/index.js",
        "bun scripts/sdk-pack-smoke.ts",
      ].map((command) => script.indexOf(command));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
    expect(consumer.needs).toBe("changes");
    expect(consumer.if).toContain("needs.changes.outputs.sdk_pack == 'true'");
    expect(consumer.if).toContain(
      "contains(fromJSON('[\"all\",\"sdk-pack-smoke\"]'), github.event.inputs.only || 'all')",
    );
    const dispatch = ci.on.workflow_dispatch as {
      inputs: { only: { options: string[] } };
    };
    expect(dispatch.inputs.only.options).toContain("sdk-pack-smoke");
    expect(consumer.permissions).toBeUndefined();
    expect(runs(consumer)).not.toContain("npm publish");
    expect(runs(build as Job)).toContain("npm pack ./packages/sdk/dist");
    expect(
      build?.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))
        ?.with,
    ).toEqual({
      name: "sdk-package",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression
      path: "${{ runner.temp }}/sdk-package/*.tgz",
      "if-no-files-found": "error",
      "retention-days": 30,
    });
    expect(check.if).toBe(
      "github.event_name == 'push' || inputs.version != ''",
    );
    const pkg = JSON.parse(read("packages/sdk/package.json"));
    expect(read("packages/sdk/src/version.ts")).toContain(
      `export const SDK_VERSION = "${pkg.version}";`,
    );
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    const pinned =
      read(".github/workflows/ci.yml") + read(".github/workflows/images.yml");
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps)
        if (step.uses?.includes("@")) {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          expect(pinned).toContain(step.uses);
        }
  });

  for (const event of ["push", "workflow_dispatch", "pull_request"])
    for (const ref of [
      "refs/heads/main",
      "refs/heads/side",
      "refs/tags/sdk-v1.2.3",
      "refs/tags/ui-v1.2.3",
    ])
      for (const version of ["", "1.2.3"]) {
        test(`publish gate: ${event} ${ref} version=${version}`, () => {
          const manual =
            event === "workflow_dispatch" &&
            ref === "refs/heads/main" &&
            version !== "";
          const pushed = event === "push" && ref.startsWith("refs/tags/sdk-v");
          const context = {
            github: { event_name: event, ref },
            inputs: { version },
            needs: {
              build: { result: "success" },
              tag: { result: manual ? "success" : "skipped" },
            },
          };
          expect(gate(tag?.if as string, context)).toBe(manual);
          expect(gate(publish?.if as string, context)).toBe(manual || pushed);
          expect(gate(publish?.if as string, context, false)).toBe(false);
          for (const result of ["failure", "cancelled", "skipped"]) {
            context.needs.build.result = result;
            expect(gate(publish?.if as string, context)).toBe(false);
          }
          context.needs.build.result = "success";
          for (const result of ["failure", "cancelled"]) {
            context.needs.tag.result = result;
            expect(gate(publish?.if as string, context)).toBe(false);
          }
        });
      }
});

describe("release shell gates", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sdk-release-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, "repo");
  const origin = join(scratch, "origin.git");
  const stubs = join(scratch, "bin");
  mkdirSync(join(repo, "packages/sdk"), { recursive: true });
  mkdirSync(stubs);
  writeFileSync(
    join(repo, "packages/sdk/package.json"),
    '{"version":"1.2.3"}\n',
  );
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "--bare", "--initial-branch=main", origin);
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", origin);
  git("add", ".");
  git("commit", "-m", "release");
  git("push", "origin", "main");
  const main = git("rev-parse", "HEAD");
  git("checkout", "-b", "side");
  git("commit", "--allow-empty", "-m", "side");
  const side = git("rev-parse", "HEAD");
  writeFileSync(
    join(stubs, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
[ -z "$GH_FAILS" ] || exit 1
for last; do :; done
[ "$1" = api ] && [ "$3" = --jq ] && printf '%s' "$FAKE_RUNS" | jq -r "$last"
exit 0
`,
  );
  chmodSync(join(stubs, "gh"), 0o755);
  let serial = 0;
  const run = (env: Record<string, string> = {}, step = check) => {
    const calls = join(scratch, `calls-${serial++}`);
    const r = Bun.spawnSync(
      ["bash", "-eo", "pipefail", "-c", step.run as string],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${stubs}:${process.env.PATH}`,
          GH_CALLS: calls,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: main,
          GITHUB_REPOSITORY: "owner/repo",
          VERSION: "1.2.3",
          FAKE_RUNS: '{"workflow_runs":[{"conclusion":"success"}]}',
          ...env,
        },
      },
    );
    return {
      code: r.exitCode,
      out: r.stdout.toString() + r.stderr.toString(),
      calls: Bun.file(calls).size ? readFileSync(calls, "utf8") : "",
    };
  };
  for (const event of ["push", "workflow_dispatch"]) {
    test(`${event} checks the exact main CI before releasing`, () => {
      const result = run(
        event === "push"
          ? {
              GITHUB_EVENT_NAME: event,
              GITHUB_REF: "refs/tags/sdk-v1.2.3",
              VERSION: "ignored",
            }
          : {},
      );
      expect(result.code).toBe(0);
      expect(result.calls).toContain(
        `head_sha=${main}&event=push&branch=main&per_page=1`,
      );
    });
    for (const [name, env, message] of [
      [
        "version mismatch",
        {
          VERSION: "1.2.4",
          GITHUB_REF:
            event === "push" ? "refs/tags/sdk-v1.2.4" : "refs/heads/main",
        },
        "does not match",
      ],
      ["off main commit", { GITHUB_SHA: side }, "is not on main"],
      [
        "failed CI",
        { FAKE_RUNS: '{"workflow_runs":[{"conclusion":"failure"}]}' },
        "is failure",
      ],
      [
        "cancelled CI",
        { FAKE_RUNS: '{"workflow_runs":[{"conclusion":"cancelled"}]}' },
        "is cancelled",
      ],
      [
        "pending CI",
        { FAKE_RUNS: '{"workflow_runs":[{"conclusion":null}]}' },
        "not finished",
      ],
      ["missing CI", { FAKE_RUNS: '{"workflow_runs":[]}' }, "not finished"],
      ["CI lookup failure", { GH_FAILS: "1" }, "could not read main CI"],
    ] as [string, Record<string, string>, string][])
      test(`${event} refuses ${name}`, () => {
        const result = run({
          GITHUB_EVENT_NAME: event,
          GITHUB_REF:
            event === "push" ? "refs/tags/sdk-v1.2.3" : "refs/heads/main",
          ...env,
        });
        expect(result.code).toBe(1);
        expect(result.out).toContain("::error::");
        expect(result.out).toContain(message);
      });
  }
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["push", "refs/tags/ui-v1.2.3"],
    ["workflow_dispatch", "refs/heads/side"],
    ["workflow_dispatch", "refs/tags/sdk-v1.2.3"],
    ["pull_request", "refs/heads/main"],
  ])
    test(`shell refuses ${event} ${ref}`, () => {
      const result = run({
        GITHUB_EVENT_NAME: event as string,
        GITHUB_REF: ref as string,
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        "requires a pushed sdk-v tag or a manual run on main",
      );
      expect(result.calls).toBe("");
    });
  test("manual release refuses an existing tag but a push validates it", () => {
    git("push", "origin", `${main}:refs/tags/sdk-v1.2.3`);
    try {
      expect(run().out).toContain("tag sdk-v1.2.3 already exists");
      expect(run().code).toBe(1);
      expect(
        run({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/sdk-v1.2.3" })
          .code,
      ).toBe(0);
    } finally {
      git("push", "origin", ":refs/tags/sdk-v1.2.3");
    }
  });
  test("manual release fails closed when origin cannot look up the tag", () => {
    const real = Bun.which("git") as string;
    const path = join(stubs, "git");
    writeFileSync(
      path,
      `#!/bin/sh\n[ "$1" = ls-remote ] && exit 128\nexec "${real}" "$@"\n`,
    );
    chmodSync(path, 0o755);
    try {
      expect(run().out).toContain("could not read tag sdk-v1.2.3 from origin");
      expect(run().code).toBe(1);
    } finally {
      rmSync(path);
    }
  });
  test("tag creation is atomic at this commit and API failure stops it", () => {
    expect(run({}, tag?.steps[0]).calls.trim()).toBe(
      `api --method POST repos/owner/repo/git/refs -f ref=refs/tags/sdk-v1.2.3 -f sha=${main}`,
    );
    expect(run({ GH_FAILS: "1" }, tag?.steps[0]).code).toBe(1);
  });
});

describe("SDK changed-path planner", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sdk-paths-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
[ "$1" = fetch ] && exit 0
[ -z "$DIFF_FAILS" ] || exit 1
printf '%s\\0' "$CHANGED_PATH"
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const plan = ci.jobs.changes?.steps.find((s) => s.id === "sdk") as Step;
  let serial = 0;
  function changed(path: string, extra: Record<string, string> = {}) {
    const output = join(scratch, `output-${serial++}`);
    const result = Bun.spawnSync(
      ["bash", "-eo", "pipefail", "-c", plan.run as string],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: scratch,
          GITHUB_OUTPUT: output,
          BASE_SHA: "a".repeat(40),
          CHANGED_PATH: path,
          ...extra,
        },
      },
    );
    return {
      code: result.exitCode,
      output: Bun.file(output).size ? readFileSync(output, "utf8") : "",
    };
  }
  for (const path of [
    "packages/sdk/src/index.ts",
    "packages/client/src/index.ts",
    "packages/contracts/src/index.ts",
    "examples/sdk-approver/src/session-close.ts",
    "scripts/sdk-pack-smoke.ts",
    "LICENSE",
    "bun.lock",
    ".github/actions/bun-setup/action.yml",
    ".github/workflows/sdk-release.yml",
    ".github/workflows/ci.yml",
  ])
    test(`consumer runs for ${path}`, () => {
      expect(changed(path)).toEqual({ code: 0, output: "run=true\n" });
    });
  for (const path of [
    "docs/contributing/ci.md",
    "apps/web/src/app.tsx",
    "packages/ui/src/index.ts",
    "README.md",
  ])
    test(`consumer omits unrelated ${path}`, () => {
      expect(changed(path)).toEqual({ code: 0, output: "run=false\n" });
    });
  for (const base of ["", "invalid", "0".repeat(40)])
    test(`unknown base ${base} keeps consumer coverage`, () => {
      expect(changed("README.md", { BASE_SHA: base })).toEqual({
        code: 0,
        output: "run=true\n",
      });
    });
  test("a failed diff cannot silently omit the consumer", () => {
    expect(changed("README.md", { DIFF_FAILS: "1" }).code).toBe(1);
  });
});
