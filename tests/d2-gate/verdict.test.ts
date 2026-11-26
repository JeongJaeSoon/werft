import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verdicts } from "../../.github/scripts/d2-gate-verdict.ts";

const workflow = `
domains:
          - domain: worker
            postgres: false
            localstack: false
            docker: false
            paths: [tests/]
            skips:
              - file: tests/d2-gate/gate.e2e.test.ts
                test: "(unnamed)"
              - file: tests/d2-gate/gate.e2e.test.ts
                test: "A: one"
              - file: tests/d2-gate/roles.e2e.test.ts
                test: "H1: two"
              - file: tests/d2-gate/roles.e2e.test.ts
                test: "H2: three"
              - file: tests/other.test.ts
                test: "not the gate's"
`;

const report = (cases: string) =>
  `<testsuites><testsuite name="x">${cases}</testsuite></testsuites>`;

describe("d2-gate-verdict", () => {
  test("names every declared gate test with its result", () => {
    const gate = report(
      '<testcase name="A: one" file="tests/d2-gate/gate.e2e.test.ts" />',
    );
    const roles = report(
      '<testcase name="H1: two" file="tests/d2-gate/roles.e2e.test.ts">' +
        '<failure type="AssertionError" /></testcase>' +
        '<testcase name="H2: three" file="tests/d2-gate/roles.e2e.test.ts">' +
        "<skipped /></testcase>",
    );
    expect(verdicts(workflow, [gate, roles])).toEqual([
      {
        file: "tests/d2-gate/gate.e2e.test.ts",
        test: "A: one",
        result: "PASS",
      },
      {
        file: "tests/d2-gate/roles.e2e.test.ts",
        test: "H1: two",
        result: "FAIL",
      },
      {
        file: "tests/d2-gate/roles.e2e.test.ts",
        test: "H2: three",
        result: "SKIP",
      },
    ]);
  });

  test("a declared test absent from every report is missing", () => {
    expect(
      verdicts(workflow, [report("")]).map(({ result }) => result),
    ).toEqual(["MISSING", "MISSING", "MISSING"]);
  });

  test("the integration domains declare A–E, R1–R2 and H1–H5", () => {
    const ci = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "integration-domains.yml"),
      "utf8",
    );
    expect(verdicts(ci, []).map(({ test }) => test.split(":")[0])).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "R1",
      "R2",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
    ]);
  });
});
