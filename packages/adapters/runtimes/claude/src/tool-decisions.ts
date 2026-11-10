import type {
  ObservedToolDecision,
  ToolDecisionObserver,
} from "@werft-ai/runtime-core";
import { redactToolInput } from "./mapper.ts";

const UNDECIDED_REMEMBERED = 1_000;

type Undecided = {
  tool: string;
  input: Record<string, unknown>;
  basis: "trusted_tool" | "permission_mode" | "engine_internal";
};

/**
 * Where the adapter's tool judgments become observations. A judgment the
 * adapter makes itself is reported at once. A call it only let through
 * (`PreToolUse` returned without refusing) is reported when the engine says
 * the tool ran: only then is "allowed" true, because the engine's own rules
 * can still refuse it after the adapter's pre-check.
 *
 * Reporting never changes a decision: an observer that throws is ignored.
 */
export class ToolDecisions {
  private readonly undecided = new Map<string, Undecided>();

  constructor(private readonly observer: ToolDecisionObserver | undefined) {}

  decide(decision: Omit<ObservedToolDecision, "parentToolUseId">): void {
    if (decision.toolUseId !== undefined) {
      this.undecided.delete(decision.toolUseId);
    }
    emitToolDecision(this.observer, decision);
  }

  admitted(
    toolUseId: string,
    tool: string,
    input: Record<string, unknown>,
    basis: Undecided["basis"],
  ): void {
    if (this.observer === undefined) return;
    this.undecided.delete(toolUseId);
    this.undecided.set(toolUseId, { tool, input, basis });
    if (this.undecided.size > UNDECIDED_REMEMBERED) {
      const [oldest] = this.undecided.keys();
      if (oldest !== undefined) this.undecided.delete(oldest);
    }
  }

  answeredElsewhere(toolUseId: string): void {
    this.undecided.delete(toolUseId);
  }

  ran(toolUseId: string): void {
    const call = this.undecided.get(toolUseId);
    if (call === undefined) return;
    this.undecided.delete(toolUseId);
    emitToolDecision(this.observer, {
      toolUseId,
      tool: call.tool,
      input: call.input,
      decision: call.basis === "engine_internal" ? "unknown" : "allow",
      basis: call.basis,
    });
  }

  refusedByEngine(toolUseId: string): void {
    this.undecided.delete(toolUseId);
  }
}

export function emitToolDecision(
  observer: ToolDecisionObserver | undefined,
  decision: Omit<ObservedToolDecision, "parentToolUseId">,
): void {
  if (observer === undefined) return;
  try {
    observer.observe({
      ...decision,
      parentToolUseId: undefined,
      input: redactToolInput(decision.input),
    });
  } catch {
    // The audit is not a gate: a failure to record cannot stop the call.
  }
}
