import type { SessionEventPayload } from "@werft-ai/contracts";
import {
  formatTraceparent,
  parseTraceparent,
  type Span,
  type SpanContext,
  type Tracer,
  turnTraceId,
} from "@werft-ai/observability";
import type { RuntimeEvent } from "@werft-ai/runtime-core";

import type { PendingDecided } from "../pending-requests.ts";
import {
  type ContentMasker,
  type ContentPolicy,
  setContentAttribute,
} from "./content.ts";

export interface TurnSpans {
  traceparent(): string | undefined;
  onEvent(event: RuntimeEvent): void;
  decided(decided: PendingDecided): void;
  granted(localId: string): void;
  beginCheckpoint(): CheckpointSpan;
  end(outcome: { status: string; reason: string | null; usage: unknown }): void;
}

export interface CheckpointSpan {
  fail(reason: string): void;
  end(): void;
}

const NO_CHECKPOINT: CheckpointSpan = { fail() {}, end() {} };

export const NO_TURN_SPANS: TurnSpans = {
  traceparent: () => undefined,
  onEvent() {},
  decided() {},
  granted() {},
  beginCheckpoint: () => NO_CHECKPOINT,
  end() {},
};

export interface AttemptScope {
  readonly sessionId: string;
  readonly attemptId: string;
}

export interface TurnStart {
  readonly turnId: string;
  readonly message: string;
  readonly traceContext?: string | undefined;
  readonly checkpointRevision?: number | null | undefined;
}

export interface SpanEmitterOptions {
  readonly tracer: Tracer;
  readonly masker: ContentMasker;
  readonly scope: AttemptScope;
  readonly now?: () => number;
  readonly dropped?: () => number;
  /**
   * Adds the engine-neutral fields (`text`, `tool_call`, `tool_result`) to an
   * event as the adapter wrote it; the control plane adds them only when it
   * stores the event, after the worker has sent it.
   */
  readonly neutralize?: (event: SessionEventPayload) => SessionEventPayload;
}

export class SpanEmitter {
  private previousTurn: SpanContext | undefined;
  private engineStart: { start: number; end: number } | undefined;

  constructor(private readonly options: SpanEmitterOptions) {}

  noteEngineStart(start: number, end: number): void {
    this.engineStart = { start, end };
  }

  beginTurn(start: TurnStart, policy: ContentPolicy): TurnSpans {
    const turnNumber = Number(start.turnId);
    if (!Number.isInteger(turnNumber) || turnNumber < 1) return NO_TURN_SPANS;
    const now = this.options.now ?? Date.now;
    const traceId = turnTraceId(this.options.scope.sessionId, turnNumber);
    const links: SpanContext[] = [];
    const queued =
      start.traceContext === undefined
        ? undefined
        : parseTraceparent(start.traceContext);
    if (queued !== undefined) links.push(queued);
    if (this.previousTurn !== undefined) links.push(this.previousTurn);

    const root = this.options.tracer.startSpan("werft.turn", {
      parent: "root",
      traceId,
      links,
      startTime: now(),
      attributes: {
        "werft.attempt_id": this.options.scope.attemptId,
        "werft.turn_id": turnNumber,
        ...(start.checkpointRevision == null
          ? {}
          : { "werft.checkpoint_revision": start.checkpointRevision }),
      },
    });
    this.previousTurn = root.context;
    const turn = new ActiveTurn(
      this.options,
      root,
      policy,
      now,
      this.engineStart,
    );
    this.engineStart = undefined;
    turn.input(start.message);
    return turn;
  }
}

interface Waiting {
  span: Span;
  kind: "permission" | "question";
  toolCallId: string;
}

// The decision a person's answer makes for the tool span, in the audit list's
// words. Calls nobody was asked about carry none: the worker cannot see why
// the engine let them through.
function approvalOutcome(decision: string): {
  decision: "allow" | "deny";
  basis: string;
} {
  switch (decision) {
    case "allow":
      return { decision: "allow", basis: "approval" };
    case "deny":
      return { decision: "deny", basis: "approval_denied" };
    case "expired":
      return { decision: "deny", basis: "approval_expired" };
    default:
      return { decision: "deny", basis: "approval_cancelled" };
  }
}

class ActiveTurn implements TurnSpans {
  private llm: Span | undefined;
  private lastBlockAt: number;
  private readonly tools = new Map<string, Span>();
  private readonly toolInputs = new Map<string, unknown>();
  private readonly toolParents = new Map<string, string>();
  private readonly waits = new Map<string, Waiting>();
  private readonly answer: string[] = [];
  private ended = false;

  constructor(
    private readonly options: SpanEmitterOptions,
    private readonly root: Span,
    private readonly policy: ContentPolicy,
    private readonly now: () => number,
    engineStart: { start: number; end: number } | undefined,
  ) {
    this.lastBlockAt = now();
    if (engineStart !== undefined) {
      this.child("werft.engine_start", this.root, engineStart.start).end(
        engineStart.end,
      );
    }
  }

  input(message: string): void {
    this.content(this.root, "gen_ai.input.messages", [
      { role: "user", content: message },
    ]);
  }

  traceparent(): string {
    return formatTraceparent(this.root.context);
  }

  onEvent(event: RuntimeEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case "public":
        this.onPublic(this.options.neutralize?.(event.event) ?? event.event);
        return;
      case "tool.called":
        this.closeLlm();
        this.startTool(event.toolCallId, event.tool);
        return;
      case "approval.requested": {
        this.closeLlm();
        const { request } = event;
        const parent = this.tools.get(request.toolCallId) ?? this.root;
        const span = this.child(
          request.kind === "permission"
            ? "werft.permission_wait"
            : "werft.question_wait",
          parent,
        );
        span.setAttribute(
          "gen_ai.tool.call.id",
          this.options.masker.mask(request.toolCallId),
        );
        this.waits.set(request.localId, {
          span,
          kind: request.kind,
          toolCallId: request.toolCallId,
        });
        return;
      }
      case "approval.resolved": {
        const wait = this.waits.get(event.localId);
        if (wait === undefined) return;
        this.waits.delete(event.localId);
        wait.span.setAttribute("werft.permission_decision", event.outcome);
        wait.span.end(this.now());
        return;
      }
      case "turn.ended":
        this.closeLlm();
        this.usage(this.root, event.turn.usage);
        return;
      default:
        return;
    }
  }

  decided(decided: PendingDecided): void {
    const wait = this.waits.get(decided.localId);
    if (wait === undefined) return;
    this.waits.delete(decided.localId);
    wait.span.setAttribute("werft.pending_request_id", decided.requestId);
    wait.span.setAttribute(
      wait.kind === "permission"
        ? "werft.permission_decision"
        : "werft.question_decision",
      decided.decision,
    );
    if (decided.answerSurface !== undefined) {
      wait.span.setAttribute("werft.answer_surface", decided.answerSurface);
    }
    if (wait.kind === "permission") {
      this.markApproval(wait.toolCallId, decided.decision);
    }
    wait.span.end(this.now());
  }

  private markApproval(toolCallId: string, decision: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool === undefined) return;
    const outcome = approvalOutcome(decision);
    tool.setAttribute("werft.tool.decision", outcome.decision);
    tool.setAttribute("werft.tool.decision_basis", outcome.basis);
  }

  granted(localId: string): void {
    const wait = this.waits.get(localId);
    if (wait === undefined) return;
    this.waits.delete(localId);
    wait.span.setAttribute("werft.permission_decision", "allow");
    wait.span.setAttribute("werft.permission_grant", true);
    this.markApproval(wait.toolCallId, "allow");
    wait.span.end(this.now());
  }

  beginCheckpoint(): CheckpointSpan {
    const span = this.child("werft.checkpoint", this.root);
    let ended = false;
    return {
      fail: (reason) => span.setError(this.options.masker.mask(reason)),
      end: () => {
        if (ended) return;
        ended = true;
        span.end(this.now());
      },
    };
  }

  end(outcome: {
    status: string;
    reason: string | null;
    usage: unknown;
  }): void {
    if (this.ended) return;
    this.closeLlm();
    const at = this.now();
    for (const wait of this.waits.values()) wait.span.end(at);
    this.waits.clear();
    for (const tool of this.tools.values()) tool.end(at);
    this.tools.clear();
    this.ended = true;
    this.root.setAttribute("werft.turn.status", outcome.status);
    if (outcome.status === "failed" || outcome.status === "outcome_unknown") {
      this.root.setError(
        this.options.masker.mask(outcome.reason ?? outcome.status),
      );
    }
    if (this.answer.length > 0) {
      this.content(this.root, "gen_ai.output.messages", [
        { role: "assistant", content: this.answer.join("\n") },
      ]);
    }
    this.usage(this.root, outcome.usage);
    const lost = this.options.dropped?.() ?? 0;
    if (lost > 0) this.root.setAttribute("werft.telemetry_dropped", lost);
    this.root.end(at);
  }

  private onPublic(event: { event: string; data: unknown }): void {
    const data = asRecord(event.data) ?? {};
    switch (event.event) {
      case "assistant":
      case "tool_use": {
        const at = this.now();
        this.llm ??= this.child(
          "werft.llm_request",
          this.root,
          this.lastBlockAt,
        );
        this.lastBlockAt = at;
        this.usage(this.llm, asRecord(data.message)?.usage);
        if (event.event === "assistant" && typeof data.text === "string") {
          this.answer.push(data.text);
        }
        const call = asRecord(data.tool_call);
        if (call !== undefined && typeof call.id === "string") {
          this.toolInputs.set(call.id, call.input);
          if (typeof data.parent_tool_use_id === "string") {
            this.toolParents.set(call.id, data.parent_tool_use_id);
          }
        }
        return;
      }
      case "tool_result": {
        this.closeLlm();
        const result = asRecord(data.tool_result);
        const id =
          typeof result?.tool_call_id === "string"
            ? result.tool_call_id
            : typeof data.tool_use_id === "string"
              ? data.tool_use_id
              : undefined;
        const span = id === undefined ? undefined : this.tools.get(id);
        if (id === undefined || span === undefined) return;
        this.tools.delete(id);
        this.content(
          span,
          "gen_ai.tool.call.result",
          result?.text ?? data.content,
        );
        if (result?.is_error === true || data.is_error === true) {
          span.setError("tool reported an error");
        }
        span.end(this.now());
        this.lastBlockAt = this.now();
        return;
      }
      default:
        return;
    }
  }

  private startTool(toolCallId: string, tool: string): void {
    const parent = this.tools.get(this.toolParents.get(toolCallId) ?? "");
    const span = this.child("werft.tool", parent ?? this.root);
    // Model-chosen strings are masked even where content is off.
    span.setAttribute("gen_ai.tool.name", this.options.masker.mask(tool));
    span.setAttribute(
      "gen_ai.tool.call.id",
      this.options.masker.mask(toolCallId),
    );
    if (this.toolInputs.has(toolCallId)) {
      this.content(
        span,
        "gen_ai.tool.call.arguments",
        this.toolInputs.get(toolCallId),
      );
      this.toolInputs.delete(toolCallId);
    }
    this.tools.set(toolCallId, span);
  }

  private closeLlm(): void {
    if (this.llm === undefined) return;
    this.llm.end(this.lastBlockAt);
    this.llm = undefined;
  }

  private child(name: string, parent: Span, startTime = this.now()): Span {
    return this.options.tracer.startSpan(name, {
      parent: parent.context,
      startTime,
      attributes: { "werft.attempt_id": this.options.scope.attemptId },
    });
  }

  private content(span: Span, key: string, value: unknown): void {
    setContentAttribute(span, key, value, this.policy, this.options.masker);
  }

  // Anthropic usage: `input_tokens` counts the cached tokens too.
  private usage(span: Span, usage: unknown): void {
    const record = asRecord(usage);
    if (record === undefined) return;
    const number = (key: string) =>
      typeof record[key] === "number" ? (record[key] as number) : undefined;
    const input = number("input_tokens");
    const output = number("output_tokens");
    const cacheRead = number("cache_read_input_tokens");
    const cacheCreation = number("cache_creation_input_tokens");
    if (input !== undefined) {
      span.setAttribute(
        "gen_ai.usage.input_tokens",
        input + (cacheRead ?? 0) + (cacheCreation ?? 0),
      );
    }
    if (output !== undefined)
      span.setAttribute("gen_ai.usage.output_tokens", output);
    if (cacheRead !== undefined) {
      span.setAttribute("gen_ai.usage.cache_read.input_tokens", cacheRead);
    }
    if (cacheCreation !== undefined) {
      span.setAttribute(
        "gen_ai.usage.cache_creation.input_tokens",
        cacheCreation,
      );
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
