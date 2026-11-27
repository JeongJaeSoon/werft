import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SecretFinding,
  SecretScanFailure,
  SecretScanFile,
  SecretScanner,
  SecretScanResult,
} from "@werft-ai/platform";
import { killProcessGroup } from "@werft-ai/system";

/** Where apps/control-host/Dockerfile installs it. */
export const GITLEAKS_EXECUTABLE = "/usr/local/bin/gitleaks";
export const GITLEAKS_TIMEOUT_MS = 30_000;
export const GITLEAKS_MAX_CONCURRENT = 2;
/** The JSON report on stdout. */
export const GITLEAKS_REPORT_LIMIT_BYTES = 1024 * 1024;
const STDERR_KEPT_BYTES = 2048;
/** How long a killed gitleaks has to report its exit before the scan answers anyway. */
const KILL_GRACE_MS = 1000;

/**
 * Ours, always passed with --config: gitleaks would otherwise read a
 * `.gitleaks.toml` from the scanned tree (or GITLEAKS_CONFIG), which lets the
 * skill under review allowlist its own files.
 */
export const GITLEAKS_CONFIG = "[extend]\nuseDefault = true\n";

/**
 * The default config's global allowlist skips files by name (`go.sum`,
 * `package-lock.json`, `*.svg`, any path with `gitleaks.toml` in it, ...),
 * so a skill could hide a value by naming its file. Each file is copied
 * under a name of ours instead, keeping only the endings that the five
 * path-scoped default rules look for. Binary files are still skipped: gitleaks
 * tells them by content, not by name.
 */
/**
 * gitleaks skips a file whose first bytes h2non/filetype (v1.1.3 in 8.30.1)
 * types as application/*, and text can start that way: "%PDF-", "PK" + 3 + 4
 * and "MZ" are valid UTF-8. A text copy starts with newlines past the deepest
 * byte filetype reads (32773, the ISO 9660 mark), so every text file is read;
 * report lines are shifted back. This moves where gitleaks' first 100 kB read
 * ends that many bytes earlier (its cut is the next blank line, at most 25 kB
 * on); against an unprefixed run of the real binary, findings
 * at byte 0 and around the cuts were the same.
 */
const TEXT_PREFIX = Buffer.alloc(32_774, 0x0a);
export const GITLEAKS_TEXT_PREFIX_LINES = TEXT_PREFIX.byteLength;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The one line a scan with findings writes at --log-level warn. */
const LEAKS_FOUND = /^\S+ WRN leaks found: \d+$/;

const RULE_ENDINGS = /(?:\.php|\.tf|\.hcl|\.ya?ml|\.p12|\.pfx|nuget\.config)$/i;

export type GitleaksScannerOptions = {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly reportLimitBytes?: number;
  /** Each scan makes and removes a 0700 directory of its own under this. */
  readonly scratchRoot?: string;
};

type Settings = Required<Omit<GitleaksScannerOptions, "maxConcurrent">>;

/** A copy's source path, the lines put before its bytes, and its own lines. */
type Copied = {
  readonly path: string;
  readonly shift: number;
  readonly lines: number;
};

type Run =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stdout: Buffer;
      readonly stderr: string;
      /** stderr ran past what is kept: what was dropped cannot be judged. */
      readonly stderrCut: boolean;
    }
  | {
      readonly kind: "failed";
      readonly reason: SecretScanFailure;
      readonly detail: string;
    };

export function gitleaksScanner(
  options: GitleaksScannerOptions = {},
): SecretScanner {
  const settings: Settings = {
    executable: options.executable ?? GITLEAKS_EXECUTABLE,
    timeoutMs: options.timeoutMs ?? GITLEAKS_TIMEOUT_MS,
    reportLimitBytes: options.reportLimitBytes ?? GITLEAKS_REPORT_LIMIT_BYTES,
    scratchRoot: options.scratchRoot ?? tmpdir(),
  };
  const maxConcurrent = options.maxConcurrent ?? GITLEAKS_MAX_CONCURRENT;
  let running = 0;
  return {
    async scan(files) {
      // Refused rather than queued: a caller that gets no answer checks again
      // later, and a queue would only move the pile-up into this process.
      if (running >= maxConcurrent) return failed("busy");
      running++;
      try {
        return await scanOnce(files, settings);
      } catch (error) {
        return failed("tool_failed", firstLine(String(error)));
      } finally {
        running--;
      }
    },
  };
}

/** Our name for file `index`, relative to the tree. */
function copyName(index: number, path: string): string {
  const ending = path.match(RULE_ENDINGS)?.[0] ?? "";
  return `${index}/f${ending.startsWith(".") ? ending : ending ? `.${ending}` : ""}`;
}

async function scanOnce(
  files: readonly SecretScanFile[],
  settings: Settings,
): Promise<SecretScanResult> {
  const rejected = rejectedPath(files);
  if (rejected !== null) return failed("input_rejected", rejected);
  const made = await mkdtemp(join(settings.scratchRoot, "werft-gitleaks-"));
  let result: SecretScanResult;
  try {
    result = await scanIn(made, files, settings);
  } catch (error) {
    result = failed("tool_failed", firstLine(String(error)));
  }
  try {
    await rm(made, { recursive: true, force: true });
  } catch (error) {
    // A copy left behind is not a verdict either.
    return failed("tool_failed", firstLine(`cleanup: ${String(error)}`));
  }
  return result;
}

async function scanIn(
  made: string,
  files: readonly SecretScanFile[],
  settings: Settings,
): Promise<SecretScanResult> {
  // Resolved, so the paths in the report start with the tree as passed.
  const scratch = await realpath(made);
  const tree = join(scratch, "tree");
  await mkdir(tree, { mode: 0o700 });
  const byCopy = new Map<string, Copied>();
  for (const [index, file] of files.entries()) {
    const name = copyName(index, file.path);
    await mkdir(join(tree, String(index)), { mode: 0o700 });
    const text = isText(file.bytes);
    await writeFile(
      join(tree, name),
      text ? Buffer.concat([TEXT_PREFIX, file.bytes]) : file.bytes,
      { mode: 0o600, flag: "wx" },
    );
    byCopy.set(name, {
      path: file.path,
      shift: text ? GITLEAKS_TEXT_PREFIX_LINES : 0,
      lines: lineCount(file.bytes),
    });
  }
  const config = join(scratch, "config.toml");
  await writeFile(config, GITLEAKS_CONFIG, { mode: 0o600, flag: "wx" });
  const run = await runGitleaks(
    settings.executable,
    [
      "dir",
      "--config",
      config,
      // Explicit, so no .gitleaksignore but the (absent) one here applies.
      "--gitleaks-ignore-path",
      scratch,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
      "--no-color",
      // gitleaks reports a file it could not read as a warning and goes on;
      // at this level a clean scan writes nothing to stderr.
      "--log-level",
      "warn",
      // Findings exit 0 too, so any other status is the tool failing.
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "-",
      tree,
    ],
    scratch,
    settings,
  );
  if (run.kind === "failed") return failed(run.reason, run.detail);
  if (run.code !== 0) {
    const status =
      run.code === null ? `signal ${run.signal}` : `exit ${run.code}`;
    return failed("tool_failed", `${status}: ${firstLine(run.stderr)}`);
  }
  if (run.stderrCut) {
    return failed("tool_failed", `stderr over ${STDERR_KEPT_BYTES} bytes`);
  }
  const warnings = run.stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !LEAKS_FOUND.test(line));
  if (warnings.length > 0) {
    return failed("tool_failed", `warning: ${firstLine(warnings.join("\n"))}`);
  }
  const findings = parseReport(run.stdout, tree, byCopy);
  return findings === null
    ? failed("unreadable_report")
    : { kind: "scanned", findings };
}

function runGitleaks(
  executable: string,
  args: readonly string[],
  cwd: string,
  settings: { readonly timeoutMs: number; readonly reportLimitBytes: number },
): Promise<Run> {
  return new Promise((resolve) => {
    // Own process group, so the kill reaches anything it forked; no
    // inherited environment, so neither GITLEAKS_CONFIG nor this process's
    // secrets reach it.
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stderrCut = false;
    let exited = false;
    let stopped: Run | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: Run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (stopped !== null) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve(run);
    };
    const stop = (reason: SecretScanFailure, detail: string) => {
      if (stopped !== null || settled) return;
      const run: Run = { kind: "failed", reason, detail };
      stopped = run;
      // Once the leader's exit is reported it has been reaped and its number
      // may be someone else's: only what still holds the pipes is left, and
      // the pipes are closed instead.
      if (exited) {
        settle(run);
        return;
      }
      killProcessGroup(child.pid);
      grace = setTimeout(() => settle(run), KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => stop("timeout", `gitleaks exceeded ${settings.timeoutMs}ms`),
      settings.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped !== null) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > settings.reportLimitBytes) {
        stop("output_limit", `report over ${settings.reportLimitBytes} bytes`);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.byteLength > STDERR_KEPT_BYTES) stderrCut = true;
      if (stderrBytes >= STDERR_KEPT_BYTES) return;
      const kept = chunk.subarray(0, STDERR_KEPT_BYTES - stderrBytes);
      stderr.push(kept);
      stderrBytes += kept.byteLength;
    });
    child.on("error", (error) =>
      settle(
        stopped ?? {
          kind: "failed",
          reason: "tool_failed",
          detail: error.message,
        },
      ),
    );
    // A killed scan settles on exit, not close: close waits for every holder
    // of the pipes, and the point of the kill is not to.
    child.on("exit", () => {
      exited = true;
      if (stopped !== null) settle(stopped);
    });
    child.on("close", (code, signal) =>
      settle(
        stopped ?? {
          kind: "exited",
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stderrCut,
        },
      ),
    );
  });
}

function rejectedPath(files: readonly SecretScanFile[]): string | null {
  const seen = new Set<string>();
  for (const { path } of files) {
    const segments = path.split("/");
    if (
      path.includes("\0") ||
      segments.some((s) => s === "" || s === "." || s === "..")
    ) {
      return `path ${JSON.stringify(path)}`;
    }
    if (seen.has(path)) return `duplicate path ${JSON.stringify(path)}`;
    seen.add(path);
  }
  return null;
}

/** The report's findings under the paths we were given, or null. */
function parseReport(
  stdout: Buffer,
  tree: string,
  byCopy: ReadonlyMap<string, Copied>,
): SecretFinding[] | null {
  let report: unknown;
  try {
    report = JSON.parse(stdout.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(report)) return null;
  const prefix = `${tree}/`;
  const findings: SecretFinding[] = [];
  for (const entry of report) {
    const { RuleID, File, StartLine } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    const copied =
      typeof File === "string" && File.startsWith(prefix)
        ? byCopy.get(File.slice(prefix.length))
        : undefined;
    const line =
      copied !== undefined && Number.isSafeInteger(StartLine)
        ? (StartLine as number) - copied.shift
        : 0;
    if (
      typeof RuleID !== "string" ||
      copied === undefined ||
      line < 1 ||
      line > copied.lines
    ) {
      return null;
    }
    findings.push({ rule: RuleID, path: copied.path, line });
  }
  return findings.sort(
    (a, b) =>
      byCodeUnit(a.path, b.path) ||
      a.line - b.line ||
      byCodeUnit(a.rule, b.rule),
  );
}

/** Lines as gitleaks counts them: one more than the newlines. */
function lineCount(bytes: Uint8Array): number {
  let lines = 1;
  for (const byte of bytes) if (byte === 0x0a) lines++;
  return lines;
}

/** Rule 3's text: strict UTF-8 with no NUL. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function failed(reason: SecretScanFailure, detail?: string): SecretScanResult {
  return detail === undefined
    ? { kind: "failed", reason }
    : { kind: "failed", reason, detail };
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? text).slice(
    0,
    300,
  );
}
