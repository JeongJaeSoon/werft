import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITLEAKS_CONFIG,
  gitleaksScanner,
  GITLEAKS_TEXT_PREFIX_LINES as SHIFT,
} from "./gitleaks.ts";

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
const text = (path: string, content = "x") => ({
  path,
  bytes: new TextEncoder().encode(content),
});
const report = (file: string, line = 1) =>
  `printf '[{"RuleID":"a","File":"%s/tree/${file}","StartLine":${line + SHIFT}}]' "$PWD"`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
        `/bin/cat "$PWD/tree/1/f" >${seen}.copied`,
        `printf '[{"RuleID":"generic-api-key","File":"%s/tree/1/f","StartLine":${3 + SHIFT},"Secret":"REDACTED"},{"RuleID":"a","File":"%s/tree/0/f","StartLine":${1 + SHIFT}}]' "$PWD" "$PWD"`,
      ].join("\n"),
    );
    process.env.WERFT_GITLEAKS_TEST_INHERITED = "1";
    const root = scratch();
    const result = await gitleaksScanner({
      executable,
      scratchRoot: root,
    }).scan([
      text("SKILL.md", "---\nname: s\n---\n"),
      text("scripts/run.sh", "echo run\n"),
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
      "warn",
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "-",
      join(cwd, "tree"),
    ]);
    expect(readFileSync(`${seen}.config`, "utf8")).toBe(
      "[extend]\nuseDefault = true\n",
    );
    expect(GITLEAKS_CONFIG).toBe("[extend]\nuseDefault = true\n");
    expect(readFileSync(`${seen}.files`, "utf8")).toBe("./0/f\n./1/f\n");
    // Text is read past filetype's sniff, so no leading magic can skip it.
    expect(readFileSync(`${seen}.copied`, "utf8")).toBe(
      `${"\n".repeat(SHIFT)}echo run\n`,
    );
    const env = readFileSync(`${seen}.env`, "utf8");
    expect(env).not.toContain("WERFT_GITLEAKS_TEST_INHERITED");
    expect(env).not.toMatch(/^HOME=/m);
    // The copy is gone once the scan has answered.
    expect(readdirSync(root)).toEqual([]);
  });

  // The default config's global allowlist skips these names; the copies
  // carry none of them, only the endings the path-scoped rules need.
  test("copies each file under a name of ours, keeping only rule endings", async () => {
    const seen = join(dir, "names");
    const executable = fake(
      `(cd "$PWD/tree" && /usr/bin/find . -type f | /usr/bin/sort) >${seen}\nprintf '[]'`,
    );
    await gitleaksScanner({ executable, scratchRoot: scratch() }).scan(
      [
        "go.sum",
        "refs/package-lock.json",
        "scripts/gitleaks.toml",
        "icon.svg",
        "vendor/github.com/x/y.go",
        "deploy/secret.yaml",
        "infra/main.TF",
        "nuget.config",
        "certs/key.pfx",
        "site/index.php",
      ].map((path) => text(path)),
    );
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([
      "./0/f",
      "./1/f",
      "./2/f",
      "./3/f",
      "./4/f",
      "./5/f.yaml",
      "./6/f.TF",
      "./7/f.nuget.config",
      "./8/f.pfx",
      "./9/f.php",
    ]);
  });

  test("the leaks-found line gitleaks writes with findings is not a warning", async () => {
    const result = await gitleaksScanner({
      executable: fake(
        `echo '6:11PM WRN leaks found: 1' >&2\n${report("0/f", 2)}`,
      ),
      scratchRoot: scratch(),
    }).scan([text("a.sh")]);
    expect(result).toEqual({
      kind: "scanned",
      findings: [{ rule: "a", path: "a.sh", line: 2 }],
    });
  });

  test("a file that is not rule 3's text is copied as it is, lines unshifted", async () => {
    const seen = join(dir, "binary");
    const bytes = [
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a),
      Uint8Array.of(0x61, 0x00, 0x62),
    ];
    const result = await gitleaksScanner({
      executable: fake(
        `/bin/cat "$PWD/tree/0/f" >${seen}.0\n/bin/cat "$PWD/tree/1/f" >${seen}.1\nprintf '[{"RuleID":"a","File":"%s/tree/1/f","StartLine":1}]' "$PWD"`,
      ),
      scratchRoot: scratch(),
    }).scan(bytes.map((b, i) => ({ path: `m${i}.png`, bytes: b })));
    expect(result).toEqual({
      kind: "scanned",
      findings: [{ rule: "a", path: "m1.png", line: 1 }],
    });
    expect(readFileSync(`${seen}.0`)).toEqual(Buffer.from(bytes[0] ?? []));
    expect(readFileSync(`${seen}.1`)).toEqual(Buffer.from(bytes[1] ?? []));
  });

  test("an empty report is a scan with no findings", async () => {
    const executable = fake("printf '[]'");
    expect(
      await gitleaksScanner({ executable, scratchRoot: scratch() }).scan([]),
    ).toEqual({ kind: "scanned", findings: [] });
  });

  test("kills the whole process group past the time limit and keeps no copy", async () => {
    const pidFile = join(dir, "timeout.pid");
    const executable = fake(
      `/bin/sleep 30 &\necho $! >${pidFile}\n/bin/sleep 30`,
    );
    const root = scratch();
    const started = performance.now();
    // Long enough for the shell to write the pid file under a loaded runner.
    const result = await gitleaksScanner({
      executable,
      scratchRoot: root,
      timeoutMs: 1000,
    }).scan([text("a.md")]);
    expect(result).toEqual({
      kind: "failed",
      reason: "timeout",
      detail: "gitleaks exceeded 1000ms",
    });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(readdirSync(root)).toEqual([]);
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test("answers at the time limit when the leader is gone but a child holds the pipes", async () => {
    const executable = fake("/bin/sleep 3 &\nexit 0");
    const started = performance.now();
    const result = await gitleaksScanner({
      executable,
      scratchRoot: scratch(),
      timeoutMs: 200,
    }).scan([]);
    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("kills a report that grows past its limit", async () => {
    const pidFile = join(dir, "limit.pid");
    const executable = fake(`/usr/bin/yes '[]' &\necho $! >${pidFile}\nwait`);
    const result = await gitleaksScanner({
      executable,
      scratchRoot: scratch(),
      reportLimitBytes: 1000,
    }).scan([]);
    expect(result).toEqual({
      kind: "failed",
      reason: "output_limit",
      detail: "report over 1000 bytes",
    });
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test.each([
    [
      "an error exit",
      "echo 'FTL unable to load config' >&2\nexit 1",
      "tool_failed",
    ],
    [
      "a warning on a clean exit",
      "echo 'WRN skipping file: could not get info' >&2\nprintf '[]'",
      "tool_failed",
    ],
    [
      "stderr past what is kept",
      "/usr/bin/head -c 3000 /dev/zero | /usr/bin/tr '\\0' '\\n' >&2\necho 'WRN skipping file' >&2\nprintf '[]'",
      "tool_failed",
    ],
    [
      "a warning after the leaks line",
      "echo '6:11PM WRN leaks found: 1' >&2\necho '6:11PM WRN skipping file' >&2\nprintf '[]'",
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
      "a finding in a file we did not write",
      report("9/f"),
      "unreadable_report",
    ],
    ["a finding on line 0", report("0/f", 0), "unreadable_report"],
    [
      "a finding with no line",
      'printf \'[{"RuleID":"a","File":"%s/tree/0/f"}]\' "$PWD"',
      "unreadable_report",
    ],
  ])("%s is a failure, not a pass", async (_name, body, reason) => {
    const result = await gitleaksScanner({
      executable: fake(body),
      scratchRoot: scratch(),
    }).scan([text("a")]);
    expect(result).toMatchObject({ kind: "failed", reason });
  });

  test("an error exit names the status and the first error line", async () => {
    const result = await gitleaksScanner({
      executable: fake(
        "echo >&2\necho 'FTL unable to load config' >&2\necho 'more' >&2\nexit 1",
      ),
      scratchRoot: scratch(),
    }).scan([]);
    expect(result).toEqual({
      kind: "failed",
      reason: "tool_failed",
      detail: "exit 1: FTL unable to load config",
    });
    const warned = await gitleaksScanner({
      executable: fake("echo 'WRN one' >&2\necho 'WRN two' >&2\nprintf '[]'"),
      scratchRoot: scratch(),
    }).scan([]);
    expect(warned).toEqual({
      kind: "failed",
      reason: "tool_failed",
      detail: "warning: WRN one",
    });
  });

  test("a missing executable is a failure", async () => {
    const result = await gitleaksScanner({
      executable: join(dir, "missing"),
      scratchRoot: scratch(),
    }).scan([]);
    expect(result).toMatchObject({ kind: "failed", reason: "tool_failed" });
  });

  test("a scratch directory that cannot be made is a failure, and frees its slot", async () => {
    const scanner = gitleaksScanner({
      executable: fake("printf '[]'"),
      scratchRoot: join(dir, "no-such-dir"),
      maxConcurrent: 1,
    });
    expect(await scanner.scan([])).toMatchObject({
      kind: "failed",
      reason: "tool_failed",
    });
    expect(await scanner.scan([])).toMatchObject({
      kind: "failed",
      reason: "tool_failed",
    });
    expect(existsSync(join(dir, "no-such-dir"))).toBe(false);
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
  ])("refuses the path %p before making a copy", async (path) => {
    const seen = join(dir, `refused-${++made}`);
    const root = scratch();
    const result = await gitleaksScanner({
      executable: fake(`echo ran >${seen}\nprintf '[]'`),
      scratchRoot: root,
    }).scan([text("ok.md"), text(path)]);
    expect(result).toMatchObject({ kind: "failed", reason: "input_rejected" });
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(seen)).toBe(false);
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
