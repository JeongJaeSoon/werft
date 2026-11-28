import { describe, expect, test } from "bun:test";
import type { CanonicalBundleFile } from "./bundle-validator.ts";
import type { SecretFinding, SecretScanResult } from "./secret-scan.ts";
import { gateSkillVersion } from "./skill-gate.ts";
import type { SkillGateRun } from "./skill-gate-runner.ts";
import {
  judgeRepositoryVersion,
  type RepositorySkillGate,
} from "./skill-repository-gate.ts";

const text = (value: string) => new TextEncoder().encode(value);
const file = (
  path: string,
  content: string | Uint8Array,
): CanonicalBundleFile =>
  ({
    path,
    mode: 0o644,
    bytes: typeof content === "string" ? text(content) : content,
  }) as CanonicalBundleFile;
const SKILL = `---\nname: pdf\ndescription: Reads PDFs\n---\nRead it.\n`;

function setup(
  over: {
    run?: SkillGateRun;
    scan?: SecretScanResult;
    findings?: SecretFinding[];
  } = {},
) {
  const scanned: string[][] = [];
  const hosts: ReadonlySet<string>[] = [];
  const gate: RepositorySkillGate = {
    runner: {
      async run(input) {
        hosts.push(input.allowedHosts);
        return over.run ?? { kind: "judged", result: gateSkillVersion(input) };
      },
    },
    secrets: {
      async scan(files) {
        scanned.push(files.map((one) => one.path));
        return over.scan ?? { kind: "scanned", findings: over.findings ?? [] };
      },
    },
    allowedHosts: () => new Set(["example.com"]),
  };
  const judge = (after: CanonicalBundleFile[]) =>
    judgeRepositoryVersion(gate, {
      before: null,
      after,
      repositoryRootFiles: ["LICENSE"],
    });
  return { judge, scanned, hosts };
}

describe("judging a repository skill's version", () => {
  test("passes what the rules and the scanner both let through, with the rules' warnings", async () => {
    const { judge, scanned, hosts } = setup();
    const result = await judge([file("skills/pdf/SKILL.md", SKILL)]);
    if (result.kind !== "passed") throw new Error(result.kind);
    expect(result.warnings.map((one) => one.rule)).toEqual(["license_missing"]);
    expect(scanned).toEqual([["skills/pdf/SKILL.md"]]);
    // The installation's allowlist, read for the run.
    expect(hosts).toEqual([new Set(["example.com"])]);
  });

  test("a file type the rules refuse blocks without the scanner being given it", async () => {
    const { judge, scanned } = setup();
    const result = await judge([
      file("skills/pdf/SKILL.md", SKILL),
      file("skills/pdf/tool.bin", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])),
    ]);
    expect(result).toMatchObject({
      kind: "blocked",
      blocks: [{ rule: "file_type", paths: ["skills/pdf/tool.bin"] }],
    });
    expect(scanned).toEqual([]);
  });

  test("a secret blocks, by the scanner's rule and the file, never the value", async () => {
    const { judge } = setup({
      findings: [
        { rule: "aws-access-token", path: "skills/pdf/a.md", line: 3 },
        { rule: "aws-access-token", path: "skills/pdf/a.md", line: 9 },
        { rule: "generic-api-key", path: "skills/pdf/SKILL.md", line: 1 },
      ],
    });
    expect(
      await judge([
        file("skills/pdf/SKILL.md", SKILL),
        file("skills/pdf/a.md", "x\n"),
      ]),
    ).toEqual({
      kind: "blocked",
      blocks: [
        {
          rule: "secret",
          paths: ["skills/pdf/a.md", "skills/pdf/SKILL.md"],
          samples: ["aws-access-token", "generic-api-key"],
        },
      ],
    });
  });

  test.each([
    ["busy", "gate busy"],
    ["timeout", "gate timeout"],
    ["tool_failed", "gate tool_failed"],
  ] as const)("a gate run that is %s is no pass", async (reason, detail) => {
    const { judge, scanned } = setup({ run: { kind: "failed", reason } });
    expect(await judge([file("skills/pdf/SKILL.md", SKILL)])).toEqual({
      kind: "unavailable",
      detail,
    });
    expect(scanned).toEqual([]);
  });

  test.each(["busy", "timeout", "output_limit", "tool_failed"] as const)(
    "a scan that ends %s is no pass",
    async (reason) => {
      const { judge } = setup({ scan: { kind: "failed", reason } });
      expect(await judge([file("skills/pdf/SKILL.md", SKILL)])).toEqual({
        kind: "unavailable",
        detail: `secret scan ${reason}`,
      });
    },
  );
});
