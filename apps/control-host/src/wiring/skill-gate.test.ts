import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateSkillVersion, type SkillGateInput } from "@werft-ai/platform";
import { skillGateProcess } from "./skill-gate.ts";

const dir = mkdtempSync(join(tmpdir(), "skill-gate-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let made = 0;
/** A module run in the gate's place. */
function entry(body: string): string {
  const path = join(dir, `entry-${++made}.ts`);
  writeFileSync(path, `${body}\n`);
  return path;
}
const PASS = '{"verdict":"pass","blocks":[],"warnings":[],"notices":[]}';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const text = (value: string) => new TextEncoder().encode(value);
const file = (path: string, bytes: Uint8Array) => ({
  path,
  mode: 0o644 as const,
  bytes,
  sha256: "",
});
const SKILL = `---\nname: pdf\ndescription: Reads PDFs\n---\nRead it.\n`;
const input = (extra: ReturnType<typeof file>[] = []): SkillGateInput => ({
  before: null,
  after: [file("skills/pdf/SKILL.md", text(SKILL)), ...extra],
  repositoryRootFiles: ["LICENSE"],
  allowedHosts: new Set(["example.com"]),
});

describe("the gate in a process of its own", () => {
  test("judges a version as the rules do in this process: bytes, hosts and all", async () => {
    const version = input([
      file("skills/pdf/tool.bin", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])),
      file("skills/pdf/notes.md", text("See https://elsewhere.test/a\n")),
    ]);
    const expected = gateSkillVersion(version);
    expect(expected.blocks.map((one) => one.rule)).toEqual(["file_type"]);
    expect(await skillGateProcess().run(version)).toEqual({
      kind: "judged",
      result: expected,
    });
  }, 30_000);

  test("leaves this process's event loop turning while a large version is read", async () => {
    // Text the rules read end to end, a megabyte of it.
    const large = text("lorem ipsum dolor sit amet\n".repeat(40_000));
    let ticks = 0;
    const ticking = setInterval(() => {
      ticks += 1;
    }, 5);
    const run = await skillGateProcess().run(
      input([file("skills/pdf/notes.md", large)]),
    );
    clearInterval(ticking);
    expect(run.kind).toBe("judged");
    expect(ticks).toBeGreaterThan(5);
  }, 60_000);

  test("gives the child none of this process's environment", async () => {
    process.env.WERFT_SKILL_GATE_TEST_INHERITED = "1";
    const run = await skillGateProcess({
      entry: entry(
        `process.stdout.write(JSON.stringify({ verdict: "pass", blocks: [], warnings: [], notices: [{ rule: process.env.WERFT_SKILL_GATE_TEST_INHERITED ?? "unset", paths: [], samples: [] }] }));`,
      ),
    }).run(input());
    delete process.env.WERFT_SKILL_GATE_TEST_INHERITED;
    expect(run).toMatchObject({
      kind: "judged",
      result: { notices: [{ rule: "unset" }] },
    });
  }, 30_000);

  test("a run past its time limit is killed and is no answer", async () => {
    const pidFile = join(dir, "stuck.pid");
    const run = await skillGateProcess({
      timeoutMs: 1_500,
      entry: entry(
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfor (;;) {}`,
      ),
    }).run(input());
    expect(run).toEqual({
      kind: "failed",
      reason: "timeout",
      detail: "the skill gate exceeded 1500ms",
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test.each([
    [
      "an error exit",
      `process.stderr.write("boom\\nmore\\n"); process.exit(3);`,
      "exit 3: boom",
    ],
    [
      "an answer that is not JSON",
      `process.stdout.write("not json");`,
      "the gate's result could not be read",
    ],
    [
      "an answer without the result's shape",
      `process.stdout.write('{"verdict":"pass","blocks":[]}');`,
      "the gate's result could not be read",
    ],
    [
      "a verdict the rules do not have",
      `process.stdout.write('{"verdict":"fine","blocks":[],"warnings":[],"notices":[]}');`,
      "the gate's result could not be read",
    ],
    ["no answer at all", "", "the gate's result could not be read"],
  ])(
    "%s is no pass",
    async (_what, body, detail) => {
      expect(
        await skillGateProcess({ entry: entry(body) }).run(input()),
      ).toEqual({ kind: "failed", reason: "tool_failed", detail });
    },
    30_000,
  );

  test("an answer past its size limit stops the run", async () => {
    const run = await skillGateProcess({
      reportLimitBytes: 1024,
      entry: entry(`process.stdout.write("x".repeat(64 * 1024)); for (;;) {}`),
    }).run(input());
    expect(run).toEqual({
      kind: "failed",
      reason: "tool_failed",
      detail: "report over 1024 bytes",
    });
  }, 30_000);

  test("a module that is not there is no pass", async () => {
    const run = await skillGateProcess({
      entry: join(dir, "missing.ts"),
    }).run(input());
    expect(run).toMatchObject({ kind: "failed", reason: "tool_failed" });
  }, 30_000);

  test("past its concurrency a run is refused at once, and taken again once one ends", async () => {
    const gate = skillGateProcess({
      maxConcurrent: 1,
      entry: entry(
        `await new Promise((resolve) => setTimeout(resolve, 700));\nprocess.stdout.write(${JSON.stringify(PASS)});`,
      ),
    });
    const first = gate.run(input());
    expect(await gate.run(input())).toEqual({ kind: "failed", reason: "busy" });
    expect((await first).kind).toBe("judged");
    expect((await gate.run(input())).kind).toBe("judged");
  }, 30_000);
});
