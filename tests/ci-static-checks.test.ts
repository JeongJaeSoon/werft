import { expect, test } from "bun:test";
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
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  needs?: string | string[];
  outputs?: Record<string, string>;
  strategy?: { matrix: { include: { part: string; unit?: string }[] } };
  steps: Step[];
};

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

function verdict(job: string, env: Record<string, string>, stepId = "verdict") {
  const steps = workflow.jobs[job]?.steps;
  const command = steps?.find((s) => s.id === stepId)?.run;
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
  // changes, forbidden-terms, forbidden-terms-threads, helm-chart,
  // supply-chain, package-retention preview and dry-run, pages target
  expect(skipping).toBe(8);
});

test("unit parts isolate slow Slack fixtures and reject every empty part", async () => {
  const { PARTS, partOf, pick } = await import(
    "../.github/scripts/unit-part.ts"
  );
  expect(partOf("apps/control-host/src/slack/main.test.ts")).toBe(
    "control-slack",
  );
  expect(partOf("apps/control-host/src/slack-extra/a.test.ts")).toBe("rest");
  expect(partOf("apps/control-host/src/api/auth.test.ts")).toBe("rest");
  const files = PARTS.map((unit) => {
    const paths = {
      packages: "packages/a.test.ts",
      "packages-db": "packages/db/a.test.ts",
      "worker-web": "apps/web/a.test.ts",
      "control-slack": "apps/control-host/src/slack/a.test.ts",
      rest: "tests/a.test.ts",
    };
    return paths[unit];
  });
  const { matrix } = await import("../.github/scripts/unit-part.ts");
  expect(
    matrix(files)
      .map((entry) => entry.unit)
      .sort(),
  ).toEqual([...PARTS].sort());
  expect(workflow.jobs["check-part"]?.strategy?.matrix.include).toBe(
    `\${{ fromJSON(needs.changes.outputs.unit_parts) }}`,
  );
  expect(workflow.jobs["check-part"]?.["timeout-minutes"]).toBe(12);
  for (const part of PARTS) {
    expect(() => pick([], part)).toThrow(`unit part ${part} has no files`);
  }
});

test("static checks keep one cache writer and report independent failures", () => {
  const parts = workflow.jobs["check-part"];
  expect(workflow.jobs.changes?.outputs?.unit_parts).toBe(
    `\${{ steps.units.outputs.matrix }}`,
  );
  expect(workflow.jobs.changes?.outputs?.sdk_pack).toBe(
    `\${{ steps.reuse.outputs.sdk_pack == 'true' && 'false' || steps.sdk.outputs.run }}`,
  );
  expect(
    workflow.jobs.changes?.steps.map((step) => step.id ?? step.uses),
  ).toEqual([
    expect.stringContaining("actions/checkout@"),
    "plan",
    "sdk",
    "conformance",
    "./.github/actions/bun-setup",
    "domains",
    "reuse",
    "units",
  ]);
  const job = workflow.jobs.static;
  expect(job?.name).toBe("check (static)");
  // A main push that reuses the PR run of its tree skips it.
  expect(job?.needs).toBe("changes");
  expect(job?.if).toMatch(/^needs\.changes\.outputs\.reused == '' && /);
  for (const command of [
    "bun run typecheck",
    "bun run lint",
    "bun scripts/third-party-notices.ts --check",
    "bun .github/scripts/vendor-names.ts",
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
    "docs",
    "demo",
    "ui-pack",
    "sdk-pack-smoke",
    "workspace-quota",
    "helm-chart",
    "k8s-smoke",
    "pages",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps.find((s) => s.id === "verdict")?.env?.RESULT).toBe(
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
  "docs",
  "pages",
  "demo",
  "ui-pack",
  "sdk-pack-smoke",
  "workspace-quota",
] as const;

function productNeeds() {
  return {
    changes: {
      result: "success",
      outputs: {
        helm: "true",
        k8s: "true",
        sdk_pack: "true",
        site: "true",
        product: "true",
        domains:
          '["db","sessions","api","surface","storage","docker","egress","worker"]',
      },
    },
    static: { result: "success" },
    "check-part": { result: "skipped" },
    "docs-checks": { result: "skipped" },
    "integration-domain": { result: "success" },
    "helm-chart": { result: "success" },
    "k8s-smoke": { result: "success" },
    docs: { result: "success" },
    pages: { result: "success" },
    demo: { result: "success" },
    "ui-pack": { result: "success" },
    "sdk-pack-smoke": { result: "success" },
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
  for (const job of ["docs", "pages"] as const) main[job].result = "skipped";
  expect(productVerdict(main)).toBe(0);
  const web = productNeeds();
  Object.assign(web.changes.outputs, {
    helm: "false",
    k8s: "false",
    sdk_pack: "false",
    domains: '["surface"]',
  });
  for (const job of [
    "helm-chart",
    "k8s-smoke",
    "sdk-pack-smoke",
    "workspace-quota",
  ] as const)
    web[job].result = "skipped";
  web["check-part"].result = "success";
  expect(productVerdict(web)).toBe(0);
  const docs = productNeeds();
  Object.assign(docs.changes.outputs, {
    helm: "false",
    k8s: "false",
    sdk_pack: "false",
    site: "false",
    product: "false",
    domains: "[]",
  });
  for (const job of plannedConsumers) docs[job].result = "skipped";
  docs["integration-domain"].result = "skipped";
  docs["docs-checks"].result = "success";
  expect(productVerdict(docs)).toBe(0);
  docs.changes.outputs.site = "true";
  for (const job of ["docs", "pages"] as const) docs[job].result = "success";
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

test.each(["helm", "k8s", "sdk_pack", "site", "product"])(
  "the %s plan accepts only explicit boolean strings",
  (flag) => {
    for (const value of ["", "TRUE", "unknown", true, false, null, undefined]) {
      const needs = productNeeds();
      const consumers = {
        helm: ["helm-chart"],
        k8s: ["k8s-smoke"],
        sdk_pack: ["sdk-pack-smoke"],
        site: ["docs", "pages"],
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
      sdk_pack: "false",
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
    "e2e-gate",
    "conformance",
    "quickstart-gate",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps.find((s) => s.id === "verdict")?.env?.RESULT).toBe(
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
    CONFORMANCE_PLAN: "false",
    CONFORMANCE: "skipped",
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
  // A pull request: the conformance suite is not planned and never runs.
  const passed = {
    PLAN: "success",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
    EVENT: "pull_request",
    ONLY: "all",
    E2E: "success",
    CONFORMANCE_PLAN: "false",
    CONFORMANCE: "skipped",
    QUICKSTART: "success",
  };
  expect(verdict("integration", passed)).toBe(0);
  for (const key of ["E2E", "QUICKSTART"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(verdict("integration", { ...passed, [key]: result })).not.toBe(0);
    }
  }
  // An unplanned suite that ran anyway, or a plan a pull request cannot have.
  for (const result of ["success", "failure", "cancelled", ""]) {
    expect(verdict("integration", { ...passed, CONFORMANCE: result })).not.toBe(
      0,
    );
  }
  expect(
    verdict("integration", {
      ...passed,
      CONFORMANCE_PLAN: "true",
      CONFORMANCE: "success",
    }),
  ).not.toBe(0);
  // A release push and a manual run of everything must run and pass it.
  const release = {
    ...passed,
    EVENT: "push",
    CONFORMANCE_PLAN: "true",
    CONFORMANCE: "success",
  };
  expect(verdict("integration", release)).toBe(0);
  expect(
    verdict("integration", { ...release, EVENT: "workflow_dispatch" }),
  ).toBe(0);
  for (const event of ["push", "workflow_dispatch"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(
        verdict("integration", {
          ...release,
          EVENT: event,
          CONFORMANCE: result,
        }),
      ).not.toBe(0);
    }
  }
  for (const plan of ["", "maybe"]) {
    expect(
      verdict("integration", { ...release, CONFORMANCE_PLAN: plan }),
    ).not.toBe(0);
  }
  // An ordinary main push plans none; a manual run of everything always does.
  expect(verdict("integration", { ...passed, EVENT: "push" })).toBe(0);
  expect(
    verdict("integration", { ...passed, EVENT: "workflow_dispatch" }),
  ).not.toBe(0);
  const manual = {
    ...passed,
    EVENT: "workflow_dispatch",
    ONLY: "integration",
    E2E: "skipped",
    CONFORMANCE: "skipped",
    QUICKSTART: "skipped",
  };
  expect(verdict("integration", manual)).toBe(0);
  for (const key of ["E2E", "CONFORMANCE", "QUICKSTART"]) {
    for (const result of ["failure", "cancelled", "success", ""]) {
      expect(verdict("integration", { ...manual, [key]: result })).not.toBe(0);
    }
  }
  expect(verdict("integration", { ...manual, EVENT: "pull_request" })).not.toBe(
    0,
  );
  expect(verdict("integration", { ...manual, ONLY: "all" })).not.toBe(0);
  expect(verdict("integration", { ...manual, RESULT: "failure" })).not.toBe(0);
  for (const key of ["EVENT", "ONLY"]) {
    expect(verdict("integration", { ...passed, [key]: "" })).not.toBe(0);
  }
  // The scenario and guide verdicts are the two gate jobs, which hold
  // those jobs' results to the plan.
  const env = workflow.jobs.integration?.steps.find(
    (s) => s.id === "verdict",
  )?.env;
  expect(env?.E2E).toBe(`\${{ needs.e2e-gate.result }}`);
  expect(env?.CONFORMANCE).toBe(`\${{ needs.conformance.result }}`);
  expect(env?.CONFORMANCE_PLAN).toBe(
    `\${{ needs.changes.outputs.conformance }}`,
  );
  expect(env?.QUICKSTART).toBe(`\${{ needs.quickstart-gate.result }}`);
  expect(env?.EVENT).toBe(`\${{ github.event_name }}`);
  expect(env?.ONLY).toBe(`\${{ github.event.inputs.only || 'all' }}`);
});

test("e2e and quickstart start only with work, and the gate holds their results to the plan", () => {
  for (const [name, display, flag] of [
    ["e2e", "e2e (scenario)", "product"],
    ["quickstart", "quickstart (guides)", "quickstart"],
  ] as const) {
    const job = workflow.jobs[name];
    // A manual run of this job alone has no gate to report the required
    // name, so the job carries it; everywhere else it must not.
    expect(job?.name).toBe(
      `\${{ github.event.inputs.only == '${name}' && '${name}' || '${display}' }}`,
    );
    expect(job?.needs).toBe("changes");
    expect(job?.if).toMatch(
      new RegExp(
        `^!cancelled\\(\\) && \\(needs\\.changes\\.outputs\\.${flag} == 'true' \\|\\| github\\.event\\.inputs\\.only == '${name}'\\) && `,
      ),
    );
    // A manual run of the job alone always starts it, and fails on a plan
    // that failed or left it nothing to do.
    const manual = job?.steps[0];
    expect(manual?.name).toBe("Plan of a manual run");
    expect(manual?.if).toBe(`github.event.inputs.only == '${name}'`);
    const variable = flag === "product" ? "PRODUCT" : "QUICKSTART";
    expect(manual?.env?.[variable]).toBe(
      `\${{ needs.changes.outputs.${flag} }}`,
    );
    const plan = (env: Record<string, string>) =>
      Bun.spawnSync(["bash", "-e", "-c", manual?.run ?? "exit 9"], {
        env: { PATH: Bun.env.PATH ?? "", ...env },
      }).exitCode;
    expect(plan({ PLAN: "success", [variable]: "true" })).toBe(0);
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(plan({ PLAN: state, [variable]: "true" })).not.toBe(0);
    }
    for (const value of ["false", ""]) {
      expect(plan({ PLAN: "success", [variable]: value })).not.toBe(0);
    }
    const gate = workflow.jobs[`${name}-gate`];
    expect(gate?.needs).toEqual(["changes", name]);
    expect(gate?.steps.find((s) => s.id === "verdict")?.if).toBe(
      "!cancelled()",
    );
  }
  const e2e = (env: Record<string, string>) =>
    verdict("e2e-gate", { PLAN: "success", REUSED: "", ...env });
  expect(
    e2e({ PRODUCT: "true", DOCS_ONLY: "false", SCENARIO: "success" }),
  ).toBe(0);
  expect(
    e2e({ PRODUCT: "false", DOCS_ONLY: "true", SCENARIO: "skipped" }),
  ).toBe(0);
  for (const state of ["failure", "cancelled", "skipped", ""]) {
    expect(
      e2e({ PRODUCT: "true", DOCS_ONLY: "false", SCENARIO: state }),
    ).not.toBe(0);
    // A plan that never came: the job skipped with it.
    expect(
      e2e({
        PLAN: state,
        PRODUCT: "false",
        DOCS_ONLY: "true",
        SCENARIO: "skipped",
      }),
    ).not.toBe(0);
  }
  // e2e is never off outside a prose PR, and never runs when it is off.
  expect(
    e2e({ PRODUCT: "false", DOCS_ONLY: "false", SCENARIO: "skipped" }),
  ).not.toBe(0);
  expect(
    e2e({ PRODUCT: "false", DOCS_ONLY: "true", SCENARIO: "success" }),
  ).not.toBe(0);
  expect(e2e({ PRODUCT: "", DOCS_ONLY: "true", SCENARIO: "skipped" })).not.toBe(
    0,
  );

  const guides = (env: Record<string, string>) =>
    verdict("quickstart-gate", { PLAN: "success", ...env });
  for (const docs of ["true", "false"]) {
    expect(
      guides({ QUICKSTART: "true", DOCS_ONLY: docs, GUIDES: "success" }),
    ).toBe(0);
    // Only the guide plan may be off outside a prose PR: a leaf-app change
    // reaches neither the images nor the guides.
    expect(
      guides({ QUICKSTART: "false", DOCS_ONLY: docs, GUIDES: "skipped" }),
    ).toBe(0);
    expect(
      guides({ QUICKSTART: "false", DOCS_ONLY: docs, GUIDES: "success" }),
    ).not.toBe(0);
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(
        guides({ QUICKSTART: "true", DOCS_ONLY: docs, GUIDES: state }),
      ).not.toBe(0);
      expect(
        guides({
          PLAN: state,
          QUICKSTART: "false",
          DOCS_ONLY: docs,
          GUIDES: "skipped",
        }),
      ).not.toBe(0);
    }
  }
  expect(
    guides({ QUICKSTART: "", DOCS_ONLY: "true", GUIDES: "skipped" }),
  ).not.toBe(0);

  const env = (job: string) =>
    workflow.jobs[job]?.steps.find((s) => s.id === "verdict")?.env;
  expect(env("e2e-gate")?.SCENARIO).toBe(`\${{ needs.e2e.result }}`);
  expect(env("quickstart-gate")?.GUIDES).toBe(
    `\${{ needs.quickstart.result }}`,
  );
});

test("the required e2e and quickstart names are gate jobs of this workflow, never check runs it creates", () => {
  // A check run created through the API joins the oldest check suite of the
  // commit, whichever workflow owns it. Once that workflow runs again on the
  // commit the merge gate no longer counts the check, and the pull request
  // stays blocked with every required name green. A job reports in the suite
  // of its own run.
  const source = readFileSync(
    join(import.meta.dir, "../.github/workflows/ci.yml"),
    "utf8",
  );
  expect(source).not.toContain("check-runs");
  for (const job of Object.values(workflow.jobs)) {
    expect(job.permissions?.checks).toBeUndefined();
  }
  const all = "(github.event.inputs.only || 'all') == 'all'";
  for (const name of ["e2e", "quickstart"]) {
    const gate = workflow.jobs[`${name}-gate`];
    // It runs whenever it carries the name: a skipped check of a required
    // name passes. Skipped under another `only`, GitHub names the check by
    // this expression (unevaluated, or its other branch), not by the name.
    expect(gate?.name).toBe(`\${{ ${all} && '${name}' || '${name} (gate)' }}`);
    expect(gate?.if).toBe(`always() && ${all}`);
    expect(gate?.steps.map((s) => s.id)).toEqual(["verdict", "cancelled"]);
    expect(JSON.stringify(gate)).not.toContain("continue-on-error");
  }
  // Outside the gates and a manual run of e2e or quickstart alone (see
  // above), no job carries those names, so a skipped one cannot stand in.
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === "e2e-gate" || id === "quickstart-gate") continue;
    const name = (job.name ?? id).replace(
      /^\$\{\{ github\.event\.inputs\.only == '(e2e|quickstart)' && '\1' \|\| '(.*)' \}\}$/,
      "$2",
    );
    expect(["e2e", "quickstart"]).not.toContain(name);
  }
  expect(workflow.jobs.integration?.steps.map((s) => s.id)).toEqual([
    "verdict",
    "cancelled",
  ]);
});

test("docs/ci/checks.md names each required check by the one job that reports it", () => {
  const root = join(import.meta.dir, "..");
  const dir = join(root, ".github/workflows");
  const reporters = readdirSync(dir).flatMap((file) => {
    const { on, jobs } = Bun.YAML.parse(
      readFileSync(join(dir, file), "utf8"),
    ) as {
      on: string | string[] | Record<string, unknown>;
      jobs: Record<string, Job>;
    };
    const events =
      typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
    if (!events.includes("pull_request")) return [];
    return Object.entries(jobs).map(([id, job]) => {
      // The name a pull request sees: `only` is a dispatch input, unset there.
      const [, only, value, chosen, other] =
        /^\$\{\{ (github\.event\.inputs\.only|\(github\.event\.inputs\.only \|\| 'all'\)) == '([^']*)' && '([^']*)' \|\| '([^']*)' \}\}$/.exec(
          job.name ?? "",
        ) ?? [];
      const unset = only === "github.event.inputs.only" ? "" : "all";
      const name = only ? (unset === value ? chosen : other) : (job.name ?? id);
      // An expression this test does not evaluate may still pick any string
      // it quotes (images.yml's build). One taken from a matrix is not seen.
      const quoted = only
        ? []
        : [...(job.name ?? "").matchAll(/'([^']*)'/g)].map(([, text]) => text);
      return { file, id, name, quoted };
    });
  });
  const section =
    readFileSync(join(root, "docs/ci/checks.md"), "utf8")
      .split(/^## 필수 check$/m)[1]
      ?.split(/^### /m)[0] ?? "";
  const rows = [
    ...section.matchAll(/^\| `([^`]+)` \| `([^`]+)` · `([^`]+)` \|/gm),
  ].map(([, name, file, id]) => ({ file, id, name, quoted: [] }));
  // The ruleset's names (the document gives the command that compares them).
  expect(rows.map((row) => row.name).sort()).toEqual([
    "check",
    "e2e",
    "forbidden-terms",
    "gitleaks",
    "integration",
    "quickstart",
    "supply-chain",
  ]);
  for (const row of rows) {
    // A second job of the name could report it skipped, and a skipped required
    // check passes.
    expect(
      reporters.filter(
        (job) => job.name === row.name || job.quoted.includes(row.name),
      ),
    ).toEqual([row]);
  }
});

test("check:fast runs lint, the job assignment check and guard tests that exist", () => {
  const root = join(import.meta.dir, "..");
  const { scripts } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const steps = scripts["check:fast"]?.split(" && ") ?? [];
  expect(steps.slice(0, 2)).toEqual([
    // `bun run lint` with the errors alone: its 20 diagnostics are otherwise
    // spent on warnings, and the error that failed it is not shown.
    "biome check --diagnostic-level=error .",
    "bun .github/scripts/integration-jobs.ts files db 1 >/dev/null",
  ]);
  // A guard that moved would otherwise drop out on a developer's machine only.
  const [bun, test, ...files] = steps[2]?.split(" ") ?? [];
  expect([bun, test]).toEqual(["bun", "test"]);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(file).toMatch(/^\.\/.*\.test\.ts$/);
    expect(existsSync(join(root, file))).toBe(true);
  }
});

test("all product and site consumers use the same explicit plan", () => {
  for (const [name, flag] of [
    ["check-part", "tests"],
    ["integration-domain", "tests"],
    ["docs", "site"],
    ["demo", "product"],
    ["ui-pack", "product"],
    ["workspace-quota", "product"],
    ["agent-sdk-compat", "product"],
    ["e2e", "product"],
    ["quickstart", "quickstart"],
    ["helm-chart", "helm"],
    ["k8s-smoke", "k8s"],
  ]) {
    if (!name || !flag) throw new Error("missing plan consumer");
    const job = workflow.jobs[name];
    expect([job?.needs].flat()).toContain("changes");
    expect(job?.if).toContain(`needs.changes.outputs.${flag} == 'true'`);
  }
  expect(workflow.jobs.pages?.needs).toEqual(["docs"]);
  expect(
    workflow.jobs.changes?.steps.find((step) => step.id === "plan")?.env
      ?.BASE_REF,
  ).toBe(`\${{ github.event.pull_request.base.ref }}`);
  for (const key of ["site", "docs_only"]) {
    expect(workflow.jobs.changes?.outputs?.[key]).toBe(
      `\${{ steps.plan.outputs.${key} }}`,
    );
  }
  // A main push that reuses the PR run of its tree drops those suites;
  // otherwise every flag is the plan's.
  for (const [key, off] of [
    ["tests", "false"],
    ["product", "false"],
    ["quickstart", "false"],
    ["domains", "[]"],
  ] as const) {
    expect(workflow.jobs.changes?.outputs?.[key]).toBe(
      `\${{ steps.reuse.outputs.reused != '' && '${off}' || steps.plan.outputs.${key} }}`,
    );
  }
  for (const key of ["helm", "k8s"]) {
    expect(workflow.jobs.changes?.outputs?.[key]).toBe(
      `\${{ steps.reuse.outputs.${key} == 'true' && 'false' || steps.plan.outputs.${key} }}`,
    );
  }
  const reuse = workflow.jobs.changes?.steps.find((s) => s.id === "reuse");
  expect(reuse?.if).toBe(
    "github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  expect(reuse?.run).toBe(
    'bash .github/scripts/ci-reuse.sh >>"$GITHUB_OUTPUT"',
  );
});

test("a reused PR run passes the required gates only with its URL", () => {
  const reused = "https://github.com/o/r/actions/runs/1";
  const check = {
    PLAN: "success",
    STATIC: "success",
    RESULT: "skipped",
    DOCS: "skipped",
    TESTS: "false",
    DOCS_ONLY: "false",
  };
  expect(verdict("check", { ...check, REUSED: reused }, "verdict")).toBe(0);
  expect(verdict("check", { ...check, REUSED: "" }, "verdict")).not.toBe(0);
  expect(
    verdict(
      "check",
      { ...check, RESULT: "success", TESTS: "true", REUSED: reused },
      "verdict",
    ),
  ).not.toBe(0);
  const integration = {
    PLAN: "success",
    RESULT: "skipped",
    E2E: "success",
    CONFORMANCE_PLAN: "false",
    CONFORMANCE: "skipped",
    QUICKSTART: "success",
    EVENT: "push",
    ONLY: "all",
    TESTS: "false",
    DOCS_ONLY: "false",
  };
  expect(
    verdict("integration", { ...integration, REUSED: reused }, "verdict"),
  ).toBe(0);
  expect(
    verdict("integration", { ...integration, REUSED: "" }, "verdict"),
  ).not.toBe(0);
  // The push skips its own static job only on reuse; a failed one never passes.
  const unreused = { ...check, STATIC: "skipped" };
  expect(verdict("check", { ...unreused, REUSED: reused })).toBe(0);
  expect(verdict("check", { ...unreused, REUSED: "" })).not.toBe(0);
  for (const state of ["failure", "cancelled", ""]) {
    expect(
      verdict("check", { ...check, STATIC: state, REUSED: reused }),
    ).not.toBe(0);
  }
  // conformance is planned apart from reuse (see the conformance plan test).
  const final = {
    PLAN: "success",
    PRODUCT: "false",
    DOCS_ONLY: "false",
    SCENARIO: "skipped",
  };
  expect(verdict("e2e-gate", { ...final, REUSED: reused })).toBe(0);
  expect(verdict("e2e-gate", { ...final, REUSED: "" })).not.toBe(0);
  // Reuse never excuses a scenario that ran and failed.
  expect(
    verdict("e2e-gate", {
      ...final,
      PRODUCT: "true",
      SCENARIO: "failure",
      REUSED: reused,
    }),
  ).not.toBe(0);
  // The non-blocking probe has no PR run to reuse, so it still runs.
  expect(workflow.jobs["agent-sdk-compat"]?.if).toContain(
    "(needs.changes.outputs.product == 'true' || needs.changes.outputs.reused != '')",
  );
});

test("the conformance suite runs on a release push or a manual run, never on a pull request", () => {
  const changes = workflow.jobs.changes;
  expect(changes?.outputs?.conformance).toBe(
    `\${{ steps.conformance.outputs.run }}`,
  );
  const job = workflow.jobs.conformance;
  expect(job?.needs).toBe("changes");
  expect(job?.if).toContain("needs.changes.outputs.conformance == 'true'");
  const command = changes?.steps.find((s) => s.id === "conformance")?.run;
  if (!command) throw new Error("no conformance plan step");
  // detect, stood in for: what it prints and how it exits. It must not write
  // its own `tag=` into this step's outputs.
  const plan = (env: Record<string, string>, detect = "exit 9") => {
    const dir = mkdtempSync(join(tmpdir(), "conformance-plan-"));
    try {
      mkdirSync(join(dir, ".github/scripts"), { recursive: true });
      writeFileSync(
        join(dir, ".github/scripts/release-auto.sh"),
        `echo "tag=from-detect" >>"$GITHUB_OUTPUT"\n${detect}\n`,
      );
      const output = join(dir, "output");
      writeFileSync(output, "");
      const run = Bun.spawnSync(["bash", "-e", "-c", command], {
        cwd: dir,
        env: { PATH: Bun.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
      });
      expect(run.exitCode).toBe(0);
      return readFileSync(output, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  expect(plan({ EVENT: "pull_request", ONLY: "all" })).toBe("run=false\n");
  expect(plan({ EVENT: "workflow_dispatch", ONLY: "all" })).toBe("run=true\n");
  expect(plan({ EVENT: "workflow_dispatch", ONLY: "conformance" })).toBe(
    "run=true\n",
  );
  expect(plan({ EVENT: "workflow_dispatch", ONLY: "integration" })).toBe(
    "run=false\n",
  );
  const push = { EVENT: "push", ONLY: "all" };
  expect(plan(push, 'echo "release tag: none"')).toBe("run=false\n");
  expect(plan(push, 'echo "release tag: v1.2.3"')).toBe("run=true\n");
  // A push detect cannot read is treated as a release.
  expect(plan(push, "exit 1")).toBe("run=true\n");
});

test("an integration domain no changed path reaches starts no job", () => {
  const job = workflow.jobs["integration-domain"];
  expect(job?.strategy?.matrix.include).toBe(
    "${{ fromJSON(needs.changes.outputs.integration_matrix) }}",
  );
  expect(JSON.stringify(job?.steps)).not.toContain("steps.gate");
  const changes = workflow.jobs.changes;
  expect(changes?.outputs?.integration_matrix).toBe(
    "${{ steps.domains.outputs.matrix }}",
  );
  // The bun the planner needs, wherever a matrix of either kind is made.
  expect(
    changes?.steps.find((s) => s.uses === "./.github/actions/bun-setup")?.if,
  ).toBe("steps.plan.outputs.tests == 'true'");
  const step = changes?.steps.find((s) => s.id === "domains");
  // Made before reuse is judged: ci-reuse.sh holds a reused run to these job
  // names. A reused run still starts no domain, as its tests flag is off.
  expect(step?.if).toBe("steps.plan.outputs.tests == 'true'");
  const ids = changes?.steps.map((s) => s.id) ?? [];
  expect(ids.indexOf("domains")).toBeGreaterThan(-1);
  expect(ids.indexOf("domains")).toBeLessThan(ids.indexOf("reuse"));
  expect(changes?.outputs?.tests).toContain("steps.reuse.outputs.reused != ''");
  expect(
    changes?.steps.find((s) => s.id === "reuse")?.env?.INTEGRATION_MATRIX,
  ).toBe("${{ steps.domains.outputs.matrix }}");
  expect(step?.env?.DOMAINS).toBe("${{ steps.plan.outputs.domains }}");
  const plan = (domains: string) => {
    const dir = mkdtempSync(join(tmpdir(), "integration-matrix-"));
    try {
      const output = join(dir, "output");
      writeFileSync(output, "");
      const run = Bun.spawnSync(["bash", "-e", "-c", step?.run ?? "exit 9"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...Bun.env, GITHUB_OUTPUT: output, DOMAINS: domains },
      });
      return { exitCode: run.exitCode, output: readFileSync(output, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const web = plan('["surface"]');
  expect(web.exitCode).toBe(0);
  // One line, one entry per shard of the one planned domain.
  expect(web.output).toStartWith("matrix=[");
  expect(web.output.split("\n")).toEqual([expect.any(String), ""]);
  const entries = JSON.parse(web.output.slice("matrix=".length)) as {
    domain: string;
    name: string;
    postgres: boolean;
  }[];
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).toMatchObject({ domain: "surface", postgres: true });
  }
  expect(entries.map((e) => e.name)).toEqual(
    entries.length === 1
      ? ["surface"]
      : entries.map((_, i) => `surface ${i + 1}/${entries.length}`),
  );
  // A plan the declaration cannot meet fails `changes`, and with it the gates.
  for (const domains of ['["nope"]', "[]", ""]) {
    const bad = plan(domains);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.output).toBe("");
  }
  expect(workflow.jobs["workspace-quota"]?.if).toContain(
    "contains(fromJSON(needs.changes.outputs.domains), 'docker')",
  );
});

test("cancelled workflows fail without unsupported status functions in env", () => {
  for (const name of ["check", "integration", "e2e-gate", "quickstart-gate"]) {
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

test("a heavy job that passed ran every step it carries", () => {
  // The gate reads the job's result, so no step may skip itself on a plan or
  // a status: only the after-the-fact checks and uploads have conditions.
  for (const [name, ran] of [
    ["e2e", ["scenario"]],
    ["quickstart", ["guide", "api-guide"]],
  ] as const) {
    const steps = workflow.jobs[name]?.steps ?? [];
    for (const id of ran) {
      expect(steps.filter((s) => s.id === id)).toHaveLength(1);
    }
    // Nor may a step or the job swallow a failure.
    expect(JSON.stringify(workflow.jobs[name])).not.toContain(
      "continue-on-error",
    );
    for (const step of steps.slice(1)) {
      expect([undefined, "!cancelled()", "always()"]).toContain(step.if);
    }
    expect(steps.some((s) => s.id === "verdict" || s.id === "cancelled")).toBe(
      false,
    );
  }
});
