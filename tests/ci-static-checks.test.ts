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
  "timeout-minutes"?: number;
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
    "inputs.restore-cache != 'false' && inputs.save-cache == 'true' && github.event_name != 'pull_request'",
    "inputs.restore-cache != 'false' && (inputs.save-cache != 'true' || github.event_name == 'pull_request')",
  ]);
});

test("Bun cache restores on PRs but only saves outside PR events", () => {
  const action = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, "../.github/actions/bun-setup/action.yml"),
      "utf8",
    ),
  ) as { runs: { steps: Step[] } };
  const caches = action.runs.steps.filter((s) =>
    s.uses?.startsWith("actions/cache"),
  );
  for (const event of [
    "pull_request",
    "push",
    "workflow_dispatch",
    "schedule",
  ]) {
    for (const restore of ["true", "false"])
      for (const save of ["true", "false"]) {
        const selected = caches.filter((s) =>
          Boolean(
            new Function(
              `return (${s.if
                ?.replaceAll("inputs.restore-cache", JSON.stringify(restore))
                .replaceAll("inputs.save-cache", JSON.stringify(save))
                .replaceAll("github.event_name", JSON.stringify(event))});`,
            )(),
          ),
        );
        expect(selected.length).toBe(restore === "false" ? 0 : 1);
        expect(selected.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(
          restore === "true" && save === "true" && event !== "pull_request",
        );
      }
  }
  const log = action.runs.steps.find((s) => s.name === "Cache restore result");
  expect(log?.if).toBe("inputs.restore-cache != 'false'");
  expect(log?.env?.CACHE_HIT).toContain("steps.writer.outputs.cache-hit");
  expect(log?.env?.CACHE_HIT).toContain("steps.reader.outputs.cache-hit");
  for (const hit of ["true", "false"]) {
    const result = Bun.spawnSync(["bash", "-c", log?.run as string], {
      env: {
        ...process.env,
        CACHE_KEY: "bun-root-test",
        CACHE_HIT: hit,
        EVENT: "pull_request",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`exact-hit=${hit}`);
    expect(result.stdout.toString()).toContain("bun-root-test");
  }
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

test("unit parts isolate slow Slack fixtures and reject every empty part", async () => {
  const { PARTS, partOf, pick } = await import(
    "../.github/scripts/unit-part.ts"
  );
  expect(partOf("apps/control-host/src/slack/outbox.test.ts")).toBe(
    "control-slack",
  );
  expect(partOf("apps/control-host/src/slack-extra/a.test.ts")).toBe("rest");
  expect(partOf("apps/control-host/src/api/auth.test.ts")).toBe("rest");
  const units = workflow.jobs["check-part"]?.strategy?.matrix.include.map(
    (entry) => entry.unit,
  );
  expect(units?.sort()).toEqual([...PARTS].sort());
  expect(new Set(units).size).toBe(PARTS.length);
  expect(workflow.jobs["check-part"]?.["timeout-minutes"]).toBe(12);
  for (const part of PARTS) {
    expect(() => pick([], part)).toThrow(`unit part ${part} has no files`);
  }
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
    "integration-domain",
    "docs-checks",
    "storybook",
    "docs",
    "demo",
    "ui-pack",
    "workspace-quota",
    "helm-chart",
    "k8s-smoke",
    "pages",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps[0]?.env?.RESULT).toBe(
    `\${{ (github.event.inputs.only == 'check' || needs.changes.outputs.domains == '["surface"]') && needs.check-part.result || needs.integration-domain.result }}`,
  );
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

const plannedConsumers = [
  "helm-chart",
  "k8s-smoke",
  "storybook",
  "docs",
  "pages",
  "demo",
  "ui-pack",
  "workspace-quota",
] as const;

function productNeeds() {
  return {
    changes: {
      result: "success",
      outputs: {
        helm: "true",
        k8s: "true",
        site: "true",
        product: "true",
        domains: '["db","api","surface","storage","docker","egress","worker"]',
      },
    },
    static: { result: "success" },
    "check-part": { result: "skipped" },
    "docs-checks": { result: "skipped" },
    "integration-domain": { result: "success" },
    "helm-chart": { result: "success" },
    "k8s-smoke": { result: "success" },
    storybook: { result: "success" },
    docs: { result: "success" },
    pages: { result: "success" },
    demo: { result: "success" },
    "ui-pack": { result: "success" },
    "workspace-quota": { result: "success" },
  };
}

function productVerdict(needs: unknown, only = "all") {
  return verdict(
    "check",
    { RESULTS: JSON.stringify(needs), ONLY: only },
    "product-results",
  );
}

test("product results bind named jobs to the plan and selection", () => {
  const step = workflow.jobs.check?.steps.find(
    (s) => s.id === "product-results",
  );
  const { env: bindings } = step ?? {};
  expect(bindings).toEqual({
    RESULTS: `\${{ toJSON(needs) }}`,
    ONLY: `\${{ github.event.inputs.only || 'all' }}`,
  });
  expect(productVerdict(productNeeds())).toBe(0);
  const main = productNeeds();
  main.changes.outputs.site = "false";
  for (const job of ["storybook", "docs", "pages"] as const)
    main[job].result = "skipped";
  expect(productVerdict(main)).toBe(0);
  const web = productNeeds();
  Object.assign(web.changes.outputs, {
    helm: "false",
    k8s: "false",
    domains: '["surface"]',
  });
  for (const job of ["helm-chart", "k8s-smoke", "workspace-quota"] as const)
    web[job].result = "skipped";
  web["check-part"].result = "success";
  expect(productVerdict(web)).toBe(0);
  const docs = productNeeds();
  Object.assign(docs.changes.outputs, {
    helm: "false",
    k8s: "false",
    site: "false",
    product: "false",
    domains: "[]",
  });
  for (const job of plannedConsumers) docs[job].result = "skipped";
  docs["integration-domain"].result = "skipped";
  docs["docs-checks"].result = "success";
  expect(productVerdict(docs)).toBe(0);
  docs.changes.outputs.site = "true";
  for (const job of ["storybook", "docs", "pages"] as const)
    docs[job].result = "success";
  expect(productVerdict(docs)).toBe(0);
});

test.each(plannedConsumers)(
  "a planned %s must succeed, including when its condition skips it",
  (job) => {
    for (const result of [
      "skipped",
      "failure",
      "cancelled",
      "pending",
      "",
      null,
    ]) {
      expect(productVerdict({ ...productNeeds(), [job]: { result } })).not.toBe(
        0,
      );
    }
    expect(productVerdict({ ...productNeeds(), [job]: undefined })).not.toBe(0);
  },
);

test.each(["helm", "k8s", "site", "product"])(
  "the %s plan accepts only explicit boolean strings",
  (flag) => {
    for (const value of ["", "TRUE", "unknown", true, false, null, undefined]) {
      const needs = productNeeds();
      const consumers = {
        helm: ["helm-chart"],
        k8s: ["k8s-smoke"],
        site: ["storybook", "docs", "pages"],
        product: ["demo", "ui-pack", "workspace-quota"],
      } as const;
      for (const job of consumers[flag as keyof typeof consumers])
        needs[job].result = "skipped";
      expect(
        productVerdict({
          ...needs,
          changes: {
            ...needs.changes,
            outputs: { ...needs.changes.outputs, [flag]: value },
          },
        }),
      ).not.toBe(0);
    }
  },
);

test("omitted consumers must be skipped and workspace requires a product Docker domain", () => {
  for (const job of plannedConsumers) {
    const needs = productNeeds();
    Object.assign(needs.changes.outputs, {
      helm: "false",
      k8s: "false",
      site: "false",
      product: "false",
      domains: "[]",
    });
    for (const other of plannedConsumers) needs[other].result = "skipped";
    needs[job].result = "success";
    expect(productVerdict(needs)).not.toBe(0);
  }
  const withoutDocker = productNeeds();
  withoutDocker.changes.outputs.domains = '["surface"]';
  expect(productVerdict(withoutDocker)).not.toBe(0);
  withoutDocker["workspace-quota"].result = "skipped";
  expect(productVerdict(withoutDocker)).toBe(0);
  const withoutProduct = productNeeds();
  withoutProduct.changes.outputs.product = "false";
  withoutProduct.demo.result = "skipped";
  withoutProduct["ui-pack"].result = "skipped";
  expect(productVerdict(withoutProduct)).not.toBe(0);
  withoutProduct["workspace-quota"].result = "skipped";
  expect(productVerdict(withoutProduct)).toBe(0);
});

test("manual only=check permits only the explicitly unselected consumers to skip", () => {
  const needs = productNeeds();
  for (const job of plannedConsumers) needs[job].result = "skipped";
  needs["check-part"].result = "success";
  needs["integration-domain"].result = "skipped";
  expect(productVerdict(needs, "check")).toBe(0);
  expect(productVerdict(needs)).not.toBe(0);
  for (const job of plannedConsumers) {
    expect(
      productVerdict({ ...needs, [job]: { result: "success" } }, "check"),
    ).not.toBe(0);
  }
  for (const result of ["failure", "cancelled", "pending", "", null]) {
    expect(productVerdict({ ...needs, static: { result } }, "check")).not.toBe(
      0,
    );
  }
});

test("product results reject malformed needs, domains and job selections", () => {
  for (const invalid of ["", "[]", "null", "{}", "not-json"]) {
    expect(
      verdict("check", { RESULTS: invalid, ONLY: "all" }, "product-results"),
    ).not.toBe(0);
  }
  for (const domains of ["", "not-json", "null", "{}", '"docker"', "[true]"]) {
    const needs = productNeeds();
    needs.changes.outputs.domains = domains;
    expect(productVerdict(needs)).not.toBe(0);
  }
  for (const only of ["", "integration", "unknown"])
    expect(productVerdict(productNeeds(), only)).not.toBe(0);
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
    ["agent-sdk-compat", "product"],
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
