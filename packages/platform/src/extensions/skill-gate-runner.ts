import type { SkillGateInput, SkillGateResult } from "./skill-gate.ts";

/**
 * Why a gate run has no answer. None of them is a pass: the version is not
 * judged, and the next check runs the gate again.
 */
export type SkillGateFailure =
  /** As many runs as the runner allows are already going. */
  | "busy"
  /** The run went past its time limit and was stopped. */
  | "timeout"
  /** The run could not start, or ended without an answer. */
  | "tool_failed";

export type SkillGateRun =
  | { readonly kind: "judged"; readonly result: SkillGateResult }
  | {
      readonly kind: "failed";
      readonly reason: SkillGateFailure;
      /** For logs: the first line of what went wrong. */
      readonly detail?: string;
    };

/**
 * `gateSkillVersion` away from the caller's event loop: one version's files
 * can hold it for seconds. The runner itself is outside this package
 * (apps/control-host/src/wiring/skill-gate.ts), because it starts a process.
 */
export interface SkillGateRunner {
  run(input: SkillGateInput): Promise<SkillGateRun>;
}
