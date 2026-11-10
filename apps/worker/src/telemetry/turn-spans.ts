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
  contentText,
  setContentAttribute,
} from "./content.ts";

/**
 * What the worker host needs from tracing a turn. The host feeds it the
 * engine-neutral events it already pumps, so the span tree is the same for
 * any engine adapter; nothing here reaches into one.
 */
export interface TurnSpans {
  /** The W3C traceparent of the turn's root, for calls made on its behalf. */
  traceparent(): string | undefined;
  onEvent(event: RuntimeEvent): void;
  /** A pending request got its decision. */
  decided(decided: PendingDecided): void;
  /** An approval answered at once from a grant the claim carried. */
  granted(localId: string): void;
  /** Opens `werft.checkpoint`: capture starts, and the finalize answer closes it. */
  beginCheckpoint(): CheckpointSpan;
  /** Ends every span still open and the turn itself. */
  end(outcome: { status: string; reason: string | null; usage: unknown }): void;
}

export interface CheckpointSpan {
  /** Marks the checkpoint failed or refused; `reason` is masked here. */
  fail(reason: string): void;
  /** Idempotent. */
  end(): void;
}

const NO_CHECKPOINT: CheckpointSpan = { fail() {}, end() {} };

/** The turn of a worker with telemetry off: no span exists and no work is done. */
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
  /** The public turn id: a number in a string. */
  readonly turnId: string;
  readonly message: string;
  /** The traceparent of the API request that queued the turn. */
  readonly traceContext?: string | undefined;
  /** The checkpoint pointer when the turn began. */
  readonly checkpointRevision?: number | null | undefined;
}

export interface SpanEmitterOptions {
  readonly tracer: Tracer;
  readonly masker: ContentMasker;
  readonly scope: AttemptScope;
  /** Epoch milliseconds; tests drive it. */
  readonly now?: () => number;
  /** Spans lost before reaching ingest so far; reported on each turn's root. */
  readonly dropped?: () => number;
}

/**
 * Makes one `TurnSpans` per turn of an attempt, and carries what spans share
 * across turns: the previous turn to link to, the engine start to report once.
 */
export class SpanEmitter {
  private previousTurn: SpanContext | undefined;
  private engineStart: { start: number; end: number } | undefined;

  constructor(private readonly options: SpanEmitterOptions) {}

  /** The first turn reports the start of an engine this attempt launched. */
  noteEngineStart(start: number, end: number): void {
    this.engineStart = { start, end };
  }

  /**
   * `policy` is read for this turn only: the mode is the one `nextInput` carries
   * every time, because the workspace may have changed it.
   */
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
    this.content(
      this.root,
      "gen_ai.input.messages",
      JSON.stringify([{ role: "user", content: message }]),
    );
  }

  traceparent(): string {
    return formatTraceparent(this.root.context);
  }

  onEvent(event: RuntimeEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case "public":
        this.onPublic(event.event);
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
        span.setAttribute("gen_ai.tool.call.id", request.toolCallId);
        this.waits.set(request.localId, { span, kind: request.kind });
        return;
      }
      case "approval.resolved": {
        // The engine withdrew the request itself: its call was aborted.
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
    wait.span.end(this.now());
  }

  granted(localId: string): void {
    const wait = this.waits.get(localId);
    if (wait === undefined) return;
    this.waits.delete(localId);
    wait.span.setAttribute("werft.permission_decision", "allow");
    wait.span.setAttribute("werft.permission_grant", true);
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
    // Anything still open belongs to a turn that is over.
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
      this.content(
        this.root,
        "gen_ai.output.messages",
        JSON.stringify([
          { role: "assistant", content: this.answer.join("\n") },
        ]),
      );
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
          contentText(result?.text ?? data.content),
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
    // A call inside a subagent hangs under the tool call that started it.
    const parent = this.tools.get(this.toolParents.get(toolCallId) ?? "");
    const span = this.child("werft.tool", parent ?? this.root);
    span.setAttribute("gen_ai.tool.name", tool);
    span.setAttribute("gen_ai.tool.call.id", toolCallId);
    if (this.toolInputs.has(toolCallId)) {
      this.content(
        span,
        "gen_ai.tool.call.arguments",
        contentText(this.toolInputs.get(toolCallId)),
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

  private content(span: Span, key: string, value: string): void {
    setContentAttribute(span, key, value, this.policy, this.options.masker);
  }

  /** Anthropic-shaped usage; `input_tokens` counts the cached tokens too. */
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
