import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import type {
  SkillGateFailure,
  SkillGateResult,
  SkillGateRun,
  SkillGateRunner,
} from "@werft-ai/platform";
import { runBounded } from "./bounded-process.ts";

/** Above the 5.4 s the largest version (seven 1 MiB scripts) was measured at. */
export const SKILL_GATE_TIMEOUT_MS = 30_000;
export const SKILL_GATE_MAX_CONCURRENT = 2;
/** The result as JSON: eleven rules of at most 20 paths and 20 samples. */
export const SKILL_GATE_REPORT_LIMIT_BYTES = 1024 * 1024;

export type SkillGateProcessOptions = {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly reportLimitBytes?: number;
  /** The module a child runs: it reads the input and writes the result. */
  readonly entry?: string;
};

/**
 * Runs each gate in a child process, so the API's event loop keeps answering
 * while a version is read. A process rather than a worker thread, which
 * starts as fast: the kill needs nothing from the engine, what the gate
 * allocates and a crash in it stay out of the API's process, and the content
 * of a public repository is read with none of this process's environment.
 * The same runner as the secret scan (gitleaks.ts).
 */
export function skillGateProcess(
  options: SkillGateProcessOptions = {},
): SkillGateRunner {
  const entry =
    options.entry ??
    fileURLToPath(new URL("./skill-gate-process.ts", import.meta.url));
  const maxConcurrent = options.maxConcurrent ?? SKILL_GATE_MAX_CONCURRENT;
  let running = 0;
  return {
    async run(input) {
      // Refused rather than queued, as a secret scan is: the caller checks
      // again later.
      if (running >= maxConcurrent) return failed("busy");
      running++;
      try {
        const run = await runBounded(
          process.execPath,
          ["run", entry],
          dirname(entry),
          {
            name: "the skill gate",
            timeoutMs: options.timeoutMs ?? SKILL_GATE_TIMEOUT_MS,
            reportLimitBytes:
              options.reportLimitBytes ?? SKILL_GATE_REPORT_LIMIT_BYTES,
            stdin: serialize(input),
          },
        );
        if (run.kind === "failed") {
          return failed(
            run.reason === "timeout" ? "timeout" : "tool_failed",
            run.detail,
          );
        }
        if (run.code !== 0) {
          const status =
            run.code === null ? `signal ${run.signal}` : `exit ${run.code}`;
          return failed("tool_failed", `${status}: ${firstLine(run.stderr)}`);
        }
        const result = resultOf(run.stdout);
        return result === null
          ? failed("tool_failed", "the gate's result could not be read")
          : { kind: "judged", result };
      } catch (error) {
        return failed("tool_failed", firstLine(String(error)));
      } finally {
        running--;
      }
    },
  };
}

const VERDICTS = ["block", "warn", "pass"];

/** The child's answer when it has the result's shape, or null. */
function resultOf(stdout: Buffer): SkillGateResult | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout.toString("utf8"));
  } catch {
    return null;
  }
  const result = (json ?? {}) as Partial<SkillGateResult>;
  const findings = (value: unknown) =>
    Array.isArray(value) &&
    value.every(
      (one) =>
        typeof one?.rule === "string" &&
        Array.isArray(one.paths) &&
        Array.isArray(one.samples),
    );
  return typeof result.verdict === "string" &&
    VERDICTS.includes(result.verdict) &&
    findings(result.blocks) &&
    findings(result.warnings) &&
    findings(result.notices)
    ? (result as SkillGateResult)
    : null;
}

function failed(reason: SkillGateFailure, detail?: string): SkillGateRun {
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
