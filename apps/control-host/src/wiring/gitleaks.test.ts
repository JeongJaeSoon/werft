import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITLEAKS_CONFIG, gitleaksScanner } from "./gitleaks.ts";

// A stand-in for the gitleaks executable: the real one runs in the image
// smoke (.github/scripts/image-smoke.sh). The scanner passes no environment,
// so every command here is named by its absolute path.
const dir = mkdtempSync(join(tmpdir(), "gitleaks-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let made = 0;
function fake(body: string): string {
  const path = join(dir, `fake-${++made}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function scratch(): string {
  return mkdtempSync(join(dir, "scratch-"));
}
const text = (path: string, content: string) => ({
  path,
  bytes: new TextEncoder().encode(content),
});

describe("gitleaksScanner", () => {
  test("scans our copy with our config, our ignore path and no environment", async () => {
    const seen = join(dir, "seen");
    const executable = fake(
      [
        `for a in "$@"; do printf '%s\\n' "$a"; done >${seen}.argv`,
        `/usr/bin/env >${seen}.env`,
        `/bin/pwd >${seen}.cwd`,
        `/bin/cat "$PWD/config.toml" >${seen}.config`,
        `(cd "$PWD/tree" && /usr/bin/find . -type f | /usr/bin/sort) >${seen}.files`,
        `printf '[{"RuleID":"generic-api-key","File":"%s/tree/scripts/run.sh","StartLine":3,"Secret":"REDACTED"},{"RuleID":"a","File":"%s/tree/SKILL.md","StartLine":1}]' "$PWD" "$PWD"`,
      ].join("\n"),
    );
    process.env.WERFT_GITLEAKS_TEST_INHERITED = "1";
    const root = scratch();
    const result = await gitleaksScanner({
      executable,
      scratchRoot: root,
    }).scan([
      text("SKILL.md", "---\nname: s\n---\n"),
      text("scripts/run.sh", "echo\n"),
    ]);
    delete process.env.WERFT_GITLEAKS_TEST_INHERITED;

    expect(result).toEqual({
      kind: "scanned",
      findings: [
        { rule: "a", path: "SKILL.md", line: 1 },
        { rule: "generic-api-key", path: "scripts/run.sh", line: 3 },
      ],
    });
    const cwd = readFileSync(`${seen}.cwd`, "utf8").trim();
    expect(cwd.startsWith(join(realpathSync(root), "werft-gitleaks-"))).toBe(
      true,
    );
    expect(readFileSync(`${seen}.argv`, "utf8").trim().split("\n")).toEqual([
      "dir",
      "--config",
      join(cwd, "config.toml"),
      "--gitleaks-ignore-path",
      cwd,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
      "--no-color",
      "--log-level",
      "error",
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "-",
      join(cwd, "tree"),
    ]);
    expect(readFileSync(`${seen}.config`, "utf8")).toBe(GITLEAKS_CONFIG);
    expect(readFileSync(`${seen}.files`, "utf8")).toBe(
      "./SKILL.md\n./scripts/run.sh\n",
    );
    const env = readFileSync(`${seen}.env`, "utf8");
    expect(env).not.toContain("WERFT_GITLEAKS_TEST_INHERITED");
    expect(env).not.toMatch(/^HOME=/m);
    // The copy is gone once the scan has answered.
    expect(readdirSync(root)).toEqual([]);
  });

  test("an empty report is a scan with no findings", async () => {
    const executable = fake("printf '[]'");
    expect(
      await gitleaksScanner({ executable, scratchRoot: scratch() }).scan([]),
    ).toEqual({
      kind: "scanned",
      findings: [],
    });
  });

  test("kills the whole process group past the time limit and keeps no copy", async () => {
    const executable = fake("/bin/sleep 30 &\n/bin/sleep 30");
    const root = scratch();
    const started = performance.now();
    const result = await gitleaksScanner({
      executable,
      scratchRoot: root,
      timeoutMs: 200,
    }).scan([text("a.md", "x")]);
    expect(result).toEqual({
      kind: "failed",
      reason: "timeout",
      detail: "gitleaks exceeded 200ms",
    });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(readdirSync(root)).toEqual([]);
  });

  test("stops a report that grows past its limit", async () => {
    const executable = fake("/usr/bin/yes '[]' | /usr/bin/head -c 100000");
    expect(
      await gitleaksScanner({
        executable,
        scratchRoot: scratch(),
        reportLimitBytes: 1000,
      }).scan([]),
    ).toEqual({
      kind: "failed",
      reason: "output_limit",
      detail: "report over 1000 bytes",
    });
  });

  test.each([
    [
      "an error exit",
      "echo 'FTL unable to load config' >&2\nexit 1",
      "tool_failed",
    ],
    ["a report that is not JSON", "printf 'nope'", "unreadable_report"],
    ["a report that is not a list", "printf '{}'", "unreadable_report"],
    [
      "a finding outside our copy",
      'printf \'[{"RuleID":"a","File":"/etc/x","StartLine":1}]\'',
      "unreadable_report",
    ],
    [
      "a finding with no line",
      'printf \'[{"RuleID":"a","File":"%s/tree/a"}]\' "$PWD"',
      "unreadable_report",
    ],
  ])("%s is a failure, not a pass", async (_name, body, reason) => {
    const result = await gitleaksScanner({
      executable: fake(body),
      scratchRoot: scratch(),
    }).scan([text("a", "x")]);
    expect(result).toMatchObject({ kind: "failed", reason });
  });

  test("an error exit names the status and the first error line", async () => {
    const result = await gitleaksScanner({
      executable: fake("echo 'FTL unable to load config' >&2\nexit 1"),
      scratchRoot: scratch(),
    }).scan([]);
    expect(result).toEqual({
      kind: "failed",
      reason: "tool_failed",
      detail: "exit 1: FTL unable to load config",
    });
  });

  test("a missing executable is a failure", async () => {
    const result = await gitleaksScanner({
      executable: join(dir, "missing"),
      scratchRoot: scratch(),
    }).scan([]);
    expect(result).toMatchObject({ kind: "failed", reason: "tool_failed" });
  });

  test.each([
    "/etc/passwd",
    "../x",
    "a/../../x",
    "a//b",
    "./a",
    "a/",
    "",
    "a\0b",
  ])("refuses the path %p before writing anything", async (path) => {
    const root = scratch();
    const result = await gitleaksScanner({
      executable: fake("printf '[]'"),
      scratchRoot: root,
    }).scan([text(path, "x")]);
    expect(result).toMatchObject({ kind: "failed", reason: "input_rejected" });
    expect(readdirSync(root)).toEqual([]);
  });

  test("refuses a path given twice", async () => {
    const result = await gitleaksScanner({
      executable: fake("printf '[]'"),
      scratchRoot: scratch(),
    }).scan([text("a", "x"), text("a", "y")]);
    expect(result).toMatchObject({ kind: "failed", reason: "input_rejected" });
  });

  test("answers busy past the concurrency limit, and runs again once one ends", async () => {
    const scanner = gitleaksScanner({
      executable: fake("/bin/sleep 0.3\nprintf '[]'"),
      scratchRoot: scratch(),
      maxConcurrent: 1,
    });
    const first = scanner.scan([]);
    expect(await scanner.scan([])).toEqual({ kind: "failed", reason: "busy" });
    expect(await first).toEqual({ kind: "scanned", findings: [] });
    expect(await scanner.scan([])).toEqual({ kind: "scanned", findings: [] });
  });
});
