import { createHash } from "node:crypto";
import {
  auditIdOf,
  canonicalJsonOfJson,
  INVALID_TOOL_NAME,
  type ToolDecisionReport,
} from "@werft-ai/contracts";
import type {
  ObservedToolDecision,
  ToolDecisionObserver,
} from "@werft-ai/runtime-core";

import type { SecretScrubber } from "./secret-scrubber.ts";

export type ToolAuditCollectorOptions = {
  /** Read per judgment: the claim that brings the secrets arrives after the host is built. */
  scrubber: () => SecretScrubber;
  /** The turn a judgment belongs to; null between turns, where nothing is recorded. */
  turnId: () => string | null;
  /** The request id this worker registered for the run's local id, once it did. */
  requestIdOf: (localId: string) => string | undefined;
  enqueue: (report: ToolDecisionReport, turnId: string) => void;
};

/**
 * Turns what the runtime saw into the report the API records. Only a digest
 * and a size of the input leave: the input is scrubbed of the secrets this
 * worker holds first, so the digest is of the same text the events show.
 *
 * It records whether or not tracing is on, and never throws into the engine.
 */
export class ToolAuditCollector implements ToolDecisionObserver {
  // Calls without a usable id are numbered within their turn.
  private ordinalTurn: string | null = null;
  private ordinal = 0;

  constructor(private readonly options: ToolAuditCollectorOptions) {}

  observe(decision: ObservedToolDecision): void {
    try {
      const turnId = this.options.turnId();
      if (turnId === null) return;
      this.options.enqueue(this.report(decision, turnId), turnId);
    } catch {
      // The audit is not a gate: a report that cannot be built is not sent.
    }
  }

  private report(
    decision: ObservedToolDecision,
    turnId: string,
  ): ToolDecisionReport {
    const scrubber = this.options.scrubber();
    const toolUseId = this.usableId(scrubber, decision.toolUseId);
    const parentToolUseId = this.usableId(scrubber, decision.parentToolUseId);
    const toolName =
      scrubber.scrub(decision.tool) === decision.tool
        ? decision.tool
        : INVALID_TOOL_NAME;
    const digest = this.digest(scrubber, decision.input);
    const requestId =
      decision.approval === undefined
        ? undefined
        : this.options.requestIdOf(decision.approval.localId);
    return {
      call_key:
        toolUseId === undefined ? this.nextKey(turnId) : `t:${toolUseId}`,
      tool_name: toolName.length === 0 ? INVALID_TOOL_NAME : toolName,
      ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
      ...(parentToolUseId === undefined
        ? {}
        : { parent_tool_use_id: parentToolUseId }),
      ...(digest === undefined
        ? {}
        : { input_sha256: digest.sha256, input_bytes: digest.bytes }),
      decision: decision.decision,
      basis: decision.basis,
      ...(requestId === undefined ? {} : { pending_request_id: requestId }),
      ...(decision.approval === undefined
        ? {}
        : { approval_input_hash: decision.approval.inputHash }),
    };
  }

  // An id the scrubber would change held a secret: it is not an id to keep.
  private usableId(
    scrubber: SecretScrubber,
    id: string | undefined,
  ): string | undefined {
    if (id === undefined || auditIdOf(id) === null) return undefined;
    return scrubber.scrub(id) === id ? id : undefined;
  }

  private digest(
    scrubber: SecretScrubber,
    input: Record<string, unknown>,
  ): { sha256: string; bytes: number } | undefined {
    try {
      const canonical = canonicalJsonOfJson(scrubber.scrub(input));
      return {
        sha256: createHash("sha256").update(canonical).digest("hex"),
        bytes: Buffer.byteLength(canonical),
      };
    } catch {
      // Not representable as canonical JSON: the call is recorded without one.
      return undefined;
    }
  }

  private nextKey(turnId: string): string {
    if (this.ordinalTurn !== turnId) {
      this.ordinalTurn = turnId;
      this.ordinal = 0;
    }
    this.ordinal += 1;
    return `n:${this.ordinal}`;
  }
}
