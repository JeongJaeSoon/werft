import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
/** The JSON report on stdout. Redacted findings are a few hundred bytes each. */
export const GITLEAKS_REPORT_LIMIT_BYTES = 1024 * 1024;
const STDERR_KEPT_BYTES = 2048;

/**
 * Ours, always passed with --config: gitleaks would otherwise read a
 * `.gitleaks.toml` from the scanned tree (or GITLEAKS_CONFIG), which lets the
 * skill under review allowlist its own files.
 */
export const GITLEAKS_CONFIG = "[extend]\nuseDefault = true\n";

export type GitleaksScannerOptions = {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly reportLimitBytes?: number;
  /** Each scan makes and removes a 0700 directory of its own under this. */
  readonly scratchRoot?: string;
};

type Run =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stdout: Buffer;
      readonly stderr: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: SecretScanFailure;
      readonly detail: string;
    };

export function gitleaksScanner(
  options: GitleaksScannerOptions = {},
): SecretScanner {
  const settings = {
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
      } finally {
        running--;
      }
    },
  };
}

async function scanOnce(
  files: readonly SecretScanFile[],
  settings: Required<Omit<GitleaksScannerOptions, "maxConcurrent">>,
): Promise<SecretScanResult> {
  const rejected = rejectedPath(files);
  if (rejected !== null) return failed("input_rejected", rejected);
  // Resolved, so the paths in the report start with the tree as passed.
  const scratch = await realpath(
    await mkdtemp(join(settings.scratchRoot, "werft-gitleaks-")),
  );
  try {
    const tree = join(scratch, "tree");
    for (const file of files) {
      const target = join(tree, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600 });
    }
    await mkdir(tree, { recursive: true, mode: 0o700 });
    const config = join(scratch, "config.toml");
    await writeFile(config, GITLEAKS_CONFIG, { mode: 0o600 });
    const run = await runGitleaks(
      settings.executable,
      [
        "dir",
        "--config",
        config,
        // The scratch directory, which holds no .gitleaksignore; the default
        // (the working directory) is one a caller could have filled.
        "--gitleaks-ignore-path",
        scratch,
        "--ignore-gitleaks-allow",
        "--redact",
        "--no-banner",
        "--no-color",
        "--log-level",
        "error",
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
      return failed("tool_failed", firstLine(`${status}: ${run.stderr}`));
    }
    const findings = parseReport(run.stdout, tree);
    return findings === null
      ? failed("unreadable_report")
      : { kind: "scanned", findings };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
    let stderr = "";
    let stopped: Run | null = null;
    let settled = false;
    const settle = (run: Run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const stop = (reason: SecretScanFailure, detail: string) => {
      if (stopped !== null) return;
      stopped = { kind: "failed", reason, detail };
      killProcessGroup(child.pid);
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
      if (stderr.length < STDERR_KEPT_BYTES) {
        stderr = (stderr + chunk.toString()).slice(0, STDERR_KEPT_BYTES);
      }
    });
    child.on("error", (error) =>
      settle({ kind: "failed", reason: "tool_failed", detail: error.message }),
    );
    // A killed scan settles on exit, not close: close waits for every holder
    // of the pipes, and the point of the kill is not to.
    child.on("exit", () => {
      if (stopped !== null) settle(stopped);
    });
    child.on("close", (code, signal) =>
      settle(
        stopped ?? {
          kind: "exited",
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr,
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

/** The report's findings with paths relative to the tree, or null. */
function parseReport(stdout: Buffer, tree: string): SecretFinding[] | null {
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
    if (
      typeof RuleID !== "string" ||
      typeof File !== "string" ||
      !File.startsWith(prefix) ||
      !Number.isSafeInteger(StartLine)
    ) {
      return null;
    }
    findings.push({
      rule: RuleID,
      path: File.slice(prefix.length),
      line: StartLine as number,
    });
  }
  return findings.sort(
    (a, b) =>
      byCodeUnit(a.path, b.path) ||
      a.line - b.line ||
      byCodeUnit(a.rule, b.rule),
  );
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
