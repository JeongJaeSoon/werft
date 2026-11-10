import type { ToolAuditBasis } from "@werft-ai/contracts";

/**
 * What a runtime tells its host about one judgment on one tool call, for the
 * audit record (observability design 7.6). The host decides what to do with
 * it; the runtime only says what it saw.
 */
export type ObservedToolDecision = {
  toolUseId: string | undefined;
  parentToolUseId: string | undefined;
  tool: string;
  /**
   * The arguments after the runtime's own redaction, the same copy it shows
   * in events. The host redacts what it alone knows before hashing, and
   * never stores or sends the text.
   */
  input: Record<string, unknown>;
  decision: "allow" | "deny" | "unknown";
  /** `approval_asked` is the platform's own row and `approval_unverified` its verdict. */
  basis: Exclude<ToolAuditBasis, "approval_asked" | "approval_unverified">;
  /**
   * Set when `basis` rests on a person's answer: the run's id for the
   * request, and the hash it computed over the arguments before redaction
   * (`approvalInputHash`). The host maps the id to the request it registered.
   */
  approval?: { localId: string; inputHash: string };
};

/**
 * A runtime's way to report tool judgments. Small on purpose: reporting a
 * judgment and asking a person (`onPermission`) are different abilities.
 * A host that records nothing passes none, so no runtime has to carry a
 * placeholder. `observe` must not throw into the engine's decision path;
 * a runtime calls it inside a guard.
 */
export interface ToolDecisionObserver {
  observe(decision: ObservedToolDecision): void;
}
