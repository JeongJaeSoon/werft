import { spawn } from "node:child_process";
import {
  CODEX_CLI_VERSION,
  CODEX_DESCRIPTOR,
} from "@werft-ai/runtime-codex-codec";
import { messageOf, unsupportedFeaturesReason } from "@werft-ai/runtime-core";

import { sandboxProbeArgs } from "./config.ts";

const PROBE_TIMEOUT_MS = 15_000;
const STDERR_LIMIT_BYTES = 2_048;
const DETAIL_CHARS = 180;

/**
 * Runs `true` in the sandbox `auto` runs commands in, and says why it
 * could not, or undefined when it ran. Judged by the exit status alone: the
 * engine words its failures differently by cause (seccomp, AppArmor, a
 * kernel without user namespaces), and warns on stderr even when it works.
 */
export function probeSandbox(options: {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, sandboxProbeArgs(), {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      resolve(messageOf(error));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(`no answer within ${options.timeoutMs ?? PROBE_TIMEOUT_MS} ms`);
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(undefined);
        return;
      }
      resolve(lastProblem(stderr) ?? `exit ${code ?? signal}`);
    });
  });
}

/** The line that names the failure: bubblewrap's own, else the last one. */
function lastProblem(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((l) => l.startsWith("bwrap:")) ?? lines.at(-1);
  return line?.slice(0, DETAIL_CHARS);
}

/**
 * The refusal the worker releases the session with. It opens as
 * `unsupportedFeaturesReason` does, so the control plane stops the session on
 * the first launch instead of retrying one every launch would repeat.
 */
export function sandboxRefusal(detail: string): string {
  // The cause goes last: the control plane keeps the first 500 characters.
  return `${autoRefused()} here: auto mode runs only in Codex's bubblewrap sandbox, which could not start in this worker. Use another permission mode until an operator fixes the worker nodes. Cause: ${detail}`;
}

/** As `sandboxRefusal`, for an installation whose operator turned it off. */
export function sandboxTurnedOffRefusal(): string {
  return `${autoRefused()} here: auto mode runs only in Codex's bubblewrap sandbox, which an operator turned off on this installation (Helm codexSandbox.enabled=false, CODEX_SANDBOX=disabled on compose). Use another permission mode.`;
}

function autoRefused(): string {
  return unsupportedFeaturesReason(
    { kind: CODEX_DESCRIPTOR.kind, version: CODEX_CLI_VERSION },
    ["classifier_review"],
  );
}
