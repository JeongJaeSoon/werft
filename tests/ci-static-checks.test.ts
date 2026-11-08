import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  strategy?: { matrix: { include: { part: string; unit?: string }[] } };
  steps: Step[];
};

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

function verdict(job: string, env: Record<string, string>, stepId?: string) {
  const steps = workflow.jobs[job]?.steps;
  const command = (stepId ? steps?.find((s) => s.id === stepId) : steps?.[0])
    ?.run;
  if (!command) throw new Error(`no verdict command in ${job}`);
  return Bun.spawnSync(["bash", "-c", command], {
    env: { ...Bun.env, ...env },
  }).exitCode;
}

test("bun-setup skips both cache steps for restore-cache false and refuses it with save-cache", () => {
  const action = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, "../.github/actions/bun-setup/action.yml"),
      "utf8",
    ),
  ) as { inputs: Record<string, { default: string }>; runs: { steps: Step[] } };
  expect(action.inputs["restore-cache"]?.default).toBe("true");
  const steps = action.runs.steps;
  const guard = steps.find((s) => s.run?.includes("save-cache: true"));
  expect(guard?.if).toBe(
    "inputs.restore-cache == 'false' && inputs.save-cache == 'true'",
  );
  expect(guard?.run).toContain("exit 1");
  const caches = steps.filter((s) => s.uses?.startsWith("actions/cache"));
  expect(caches.map((s) => s.if)).toEqual([
    "inputs.restore-cache != 'false' && inputs.save-cache == 'true'",
    "inputs.restore-cache != 'false' && inputs.save-cache != 'true'",
  ]);
});

test("a job that skips the bun cache restore installs nothing and saves nothing", () => {
  const dir = join(import.meta.dir, "../.github/workflows");
  let skipping = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const parsed = Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) as {
      jobs: Record<string, Job>;
    };
    for (const [name, job] of Object.entries(parsed.jobs)) {
      const setup = job.steps?.find(
        (step) => step.uses === "./.github/actions/bun-setup",
      );
      if (setup?.with?.["restore-cache"] !== "false") continue;
      skipping += 1;
      expect(setup.with?.["save-cache"], `${file} ${name}`).toBeUndefined();
      expect(
        job.steps.filter((step) => step.run?.includes("bun install")),
        `${file} ${name}`,
      ).toEqual([]);
    }
  }
  // forbidden-terms, helm-chart, supply-chain
  expect(skipping).toBe(3);
});

test("static checks keep one cache writer and report independent failures", () => {
  const parts = workflow.jobs["check-part"];
  expect(
    parts?.strategy?.matrix.include.filter((entry) => !entry.unit),
  ).toEqual([]);
  const job = workflow.jobs.static;
  expect(job?.name).toBe("check (static)");
  expect(job?.needs).toBeUndefined();
  for (const command of [
    "bun run typecheck",
    "bun run lint",
    "bun scripts/third-party-notices.ts --check",
  ]) {
    const steps = job?.steps.filter((step) => step.run === command);
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.if).toBe(
      command === "bun run typecheck"
        ? undefined
        : "!cancelled() && steps.install.outcome == 'success'",
    );
  }
  expect(job?.steps.find((step) => step.id === "install")?.run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(job?.steps.find((step) => step.with?.["save-cache"])?.with).toEqual({
    "save-cache": "true",
  });
  expect(parts?.steps.some((step) => step.with?.["save-cache"])).toBe(false);
});

test("required check only accepts verified product or documentation results", () => {
  const job = workflow.jobs.check;
  expect(job?.needs).toEqual([
    "changes",
    "static",
    "check-part",
    "docs-checks",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps[0]?.env?.RESULT).toBe(`\${{ needs.check-part.result }}`);
  const product = {
    PLAN: "success",
    STATIC: "success",
    DOCS: "skipped",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
  };
  expect(verdict("check", product)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("check", { ...product, RESULT: result })).not.toBe(0);
  }
  const docs = {
    ...product,
    DOCS: "success",
    TESTS: "false",
    DOCS_ONLY: "true",
    RESULT: "skipped",
  };
  expect(verdict("check", docs)).toBe(0);
  for (const key of ["PLAN", "STATIC", "DOCS"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(verdict("check", { ...docs, [key]: result })).not.toBe(0);
    }
  }
  expect(verdict("check", { ...docs, DOCS_ONLY: "" })).not.toBe(0);
  expect(verdict("check", { ...docs, RESULT: "failure" })).not.toBe(0);
  expect(workflow.jobs["docs-checks"]?.if).toContain(
    "needs.changes.outputs.docs_only == 'true'",
  );
  expect(workflow.jobs["docs-checks"]?.steps.at(-1)?.run).toBe(
    "bun test ./tests",
  );
});

test("required integration never treats an unplanned skip as success", () => {
  const job = workflow.jobs.integration;
  expect(job?.needs).toEqual([
    "changes",
    "integration-domain",
    "e2e",
    "quickstart",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps[0]?.env?.RESULT).toBe(
    `\${{ needs.integration-domain.result }}`,
  );
  const product = {
    PLAN: "success",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
    EVENT: "pull_request",
    ONLY: "all",
    E2E: "success",
    QUICKSTART: "success",
  };
  expect(verdict("integration", product)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("integration", { ...product, RESULT: result })).not.toBe(0);
  }
  const docs = {
    ...product,
    PLAN: "success",
    TESTS: "false",
    DOCS_ONLY: "true",
    RESULT: "skipped",
  };
  expect(verdict("integration", docs)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("integration", { ...docs, PLAN: result })).not.toBe(0);
  }
  expect(verdict("integration", { ...docs, DOCS_ONLY: "" })).not.toBe(0);
  expect(verdict("integration", { ...docs, RESULT: "failure" })).not.toBe(0);
});

test("integration refuses cancelled heavy jobs even after every domain passed", () => {
  const passed = {
    PLAN: "success",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
    EVENT: "pull_request",
    ONLY: "all",
    E2E: "success",
    QUICKSTART: "success",
  };
  for (const key of ["E2E", "QUICKSTART"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(verdict("integration", { ...passed, [key]: result })).not.toBe(0);
    }
  }
  const manual = {
    ...passed,
    EVENT: "workflow_dispatch",
    ONLY: "integration",
    E2E: "skipped",
    QUICKSTART: "skipped",
  };
  expect(verdict("integration", manual)).toBe(0);
  for (const key of ["E2E", "QUICKSTART"]) {
    for (const result of ["failure", "cancelled", "success", ""]) {
      expect(verdict("integration", { ...manual, [key]: result })).not.toBe(0);
    }
  }
  expect(verdict("integration", { ...manual, EVENT: "pull_request" })).not.toBe(
    0,
  );
  expect(verdict("integration", { ...manual, ONLY: "all" })).not.toBe(0);
  expect(verdict("integration", { ...manual, RESULT: "failure" })).not.toBe(0);
  expect(verdict("integration", { ...passed, EVENT: "push" })).toBe(0);
  expect(
    verdict("integration", { ...passed, EVENT: "workflow_dispatch" }),
  ).toBe(0);
  for (const key of ["EVENT", "ONLY"]) {
    expect(verdict("integration", { ...passed, [key]: "" })).not.toBe(0);
  }
  const env = workflow.jobs.integration?.steps[0]?.env;
  expect(env?.E2E).toBe(`\${{ needs.e2e.result }}`);
  expect(env?.QUICKSTART).toBe(`\${{ needs.quickstart.result }}`);
  expect(env?.EVENT).toBe(`\${{ github.event_name }}`);
  expect(env?.ONLY).toBe(`\${{ github.event.inputs.only || 'all' }}`);
});

test("e2e and quickstart validate the plan but stop when the workflow is cancelled", () => {
  for (const [name, flag, variable] of [
    ["e2e", "product", "PRODUCT"],
    ["quickstart", "quickstart", "QUICKSTART"],
  ]) {
    if (!name || !flag || !variable) throw new Error("missing guard case");
    const job = workflow.jobs[name];
    expect(job?.needs).toBe("changes");
    expect(job?.if).toMatch(/^!cancelled\(\)/);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "true",
        DOCS_ONLY: "false",
      }),
    ).toBe(0);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "false",
        DOCS_ONLY: "true",
      }),
    ).toBe(0);
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(
        verdict(name, {
          PLAN: state,
          [variable]: "false",
          DOCS_ONLY: "true",
        }),
      ).not.toBe(0);
    }
    // Only the guide plan may be off outside a prose PR: a leaf-app change
    // reaches neither the images nor the guides. e2e never is.
    const off = verdict(name, {
      PLAN: "success",
      [variable]: "false",
      DOCS_ONLY: "false",
    });
    if (name === "quickstart") expect(off).toBe(0);
    else expect(off).not.toBe(0);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "",
        DOCS_ONLY: "true",
      }),
    ).not.toBe(0);
    for (const step of job?.steps
      .slice(1)
      .filter((s) => s.id !== "verdict" && s.id !== "cancelled") ?? []) {
      expect(step.if).toContain(`needs.changes.outputs.${flag} == 'true'`);
    }
  }
  expect(
    verdict("quickstart", {
      PLAN: "success",
      QUICKSTART: "true",
      DOCS_ONLY: "true",
    }),
  ).toBe(0);
});

test("all product and site consumers use the same explicit plan", () => {
  for (const [name, flag] of [
    ["check-part", "tests"],
    ["integration-domain", "tests"],
    ["storybook", "site"],
    ["docs", "site"],
    ["demo", "product"],
    ["ui-pack", "product"],
    ["workspace-quota", "product"],
    ["helm-chart", "helm"],
    ["k8s-smoke", "k8s"],
  ]) {
    if (!name || !flag) throw new Error("missing plan consumer");
    const job = workflow.jobs[name];
    expect([job?.needs].flat()).toContain("changes");
    expect(job?.if).toContain(`needs.changes.outputs.${flag} == 'true'`);
  }
  expect(workflow.jobs.pages?.needs).toEqual(["docs", "storybook"]);
  expect(
    workflow.jobs.changes?.steps.find((step) => step.id === "plan")?.env
      ?.BASE_REF,
  ).toBe(`\${{ github.event.pull_request.base.ref }}`);
  for (const key of [
    "tests",
    "product",
    "site",
    "quickstart",
    "docs_only",
    "helm",
    "k8s",
    "domains",
  ]) {
    expect(workflow.jobs.changes?.outputs?.[key]).toBe(
      `\${{ steps.plan.outputs.${key} }}`,
    );
  }
});

test("an integration domain no changed path reaches runs no step but its gate", () => {
  const steps = workflow.jobs["integration-domain"]?.steps ?? [];
  expect(steps[0]?.id).toBe("gate");
  expect(steps[0]?.env?.PLANNED).toBe(
    "${{ contains(fromJSON(needs.changes.outputs.domains), matrix.domain) }}",
  );
  expect(steps[0]?.run).toBe('echo "run=$PLANNED" >>"$GITHUB_OUTPUT"');
  // A step that only runs after another one failed needs no gate of its own.
  for (const step of steps.slice(1)) {
    if (step.if?.startsWith("failure()")) continue;
    expect(step.if).toContain("steps.gate.outputs.run == 'true'");
  }
  expect(workflow.jobs["workspace-quota"]?.if).toContain(
    "contains(fromJSON(needs.changes.outputs.domains), 'docker')",
  );
});

test("cancelled workflows fail without unsupported status functions in env", () => {
  for (const name of ["check", "integration", "e2e", "quickstart"]) {
    const job = workflow.jobs[name];
    expect(job?.steps.at(-1)?.id).toBe("cancelled");
    const cancelled = job?.steps.find((s) => s.id === "cancelled");
    expect(cancelled?.if).toBe("cancelled()");
    expect(verdict(name, {}, "cancelled")).not.toBe(0);
    expect(job?.steps.find((s) => s.id === "verdict")?.if).toContain(
      "!cancelled()",
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      for (const value of Object.values(step.env ?? {})) {
        expect(String(value)).not.toMatch(
          /\b(always|cancelled|success|failure)\s*\(/,
        );
      }
    }
  }
});

test("required heavy jobs verify actual outcomes after planned steps", () => {
  const e2e = {
    PLAN: "success",
    PRODUCT: "true",
    DOCS_ONLY: "false",
    SCENARIO: "success",
  };
  expect(verdict("e2e", e2e, "verdict")).toBe(0);
  for (const state of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("e2e", { ...e2e, SCENARIO: state }, "verdict")).not.toBe(0);
  }
  expect(
    verdict(
      "e2e",
      {
        ...e2e,
        PRODUCT: "false",
        DOCS_ONLY: "true",
        SCENARIO: "skipped",
      },
      "verdict",
    ),
  ).toBe(0);
  expect(verdict("e2e", {}, "cancelled")).not.toBe(0);

  const quickstart = {
    PLAN: "success",
    QUICKSTART: "true",
    DOCS_ONLY: "false",
    GUIDE: "success",
    API_GUIDE: "success",
  };
  expect(verdict("quickstart", quickstart, "verdict")).toBe(0);
  for (const key of ["GUIDE", "API_GUIDE"]) {
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(
        verdict("quickstart", { ...quickstart, [key]: state }, "verdict"),
      ).not.toBe(0);
    }
  }
  expect(
    verdict(
      "quickstart",
      {
        PLAN: "success",
        QUICKSTART: "false",
        DOCS_ONLY: "true",
        GUIDE: "skipped",
        API_GUIDE: "skipped",
      },
      "verdict",
    ),
  ).toBe(0);
  expect(verdict("quickstart", {}, "cancelled")).not.toBe(0);

  for (const name of ["e2e", "quickstart"]) {
    const final = workflow.jobs[name]?.steps.find((s) => s.id === "verdict");
    expect(final?.if).toBe("always() && !cancelled()");
  }
  expect(
    workflow.jobs.e2e?.steps.find((s) => s.id === "verdict")?.env?.SCENARIO,
  ).toBe(`\${{ steps.scenario.outcome }}`);
  const finalGuide = workflow.jobs.quickstart?.steps.find(
    (s) => s.id === "verdict",
  );
  expect(finalGuide?.env?.GUIDE).toBe(`\${{ steps.guide.outcome }}`);
  expect(finalGuide?.env?.API_GUIDE).toBe(`\${{ steps.api-guide.outcome }}`);
});
