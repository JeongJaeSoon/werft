import { spawn } from "node:child_process";
import { killProcessGroup } from "@werft-ai/system";

/** How much of stderr a run keeps. */
export const STDERR_KEPT_BYTES = 2048;
/** How long a killed process has to report its exit before the run answers anyway. */
const KILL_GRACE_MS = 1000;

export type BoundedRunFailure = "timeout" | "output_limit" | "tool_failed";

export type BoundedRun =
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
      readonly reason: BoundedRunFailure;
      readonly detail: string;
    };

/**
 * Runs a helper that reads content this process does not trust, and so may
 * never end: under a time limit and a limit on what it writes to stdout,
 * killed past either. `name` is what the time limit's message calls it.
 */
export function runBounded(
  executable: string,
  args: readonly string[],
  cwd: string,
  settings: {
    readonly name: string;
    readonly timeoutMs: number;
    readonly reportLimitBytes: number;
    /** Written to the helper's stdin, which is then closed. */
    readonly stdin?: Uint8Array;
  },
): Promise<BoundedRun> {
  return new Promise((resolve) => {
    // Own process group, so the kill reaches anything it forked; no
    // inherited environment, so neither a setting meant for the helper nor
    // this process's secrets reach it.
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stderrCut = false;
    let exited = false;
    let stopped: BoundedRun | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: BoundedRun) => {
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
    const stop = (reason: BoundedRunFailure, detail: string) => {
      if (stopped !== null || settled) return;
      const run: BoundedRun = { kind: "failed", reason, detail };
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
      () =>
        stop("timeout", `${settings.name} exceeded ${settings.timeoutMs}ms`),
      settings.timeoutMs,
    );
    // A helper that ended before reading all of it: its exit says so.
    child.stdin.on("error", () => undefined);
    child.stdin.end(settings.stdin);
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
    // A killed run settles on exit, not close: close waits for every holder
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
