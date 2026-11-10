import { describe, expect, test } from "bun:test";

import { turnTraceId } from "@werft-ai/observability";
import { createOtelTracer } from "@werft-ai/observability/otel";
import type { RuntimeEvent } from "@werft-ai/runtime-core";

import { SecretScrubber } from "../secret-scrubber.ts";
import type { ContentMasker, ContentPolicy } from "./content.ts";
import { NO_TURN_SPANS, SpanEmitter, type TurnSpans } from "./turn-spans.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const FULL: ContentPolicy = { mode: "full", maxBytes: 32768 };
const ENDED = { status: "completed", reason: null, usage: undefined } as const;

type Finished = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  links: { traceId: string; spanId: string }[];
  status: number;
};

class IdentityMasker implements ContentMasker {
  mask(text: string): string {
    return text;
  }
}

function harness(masker: ContentMasker = new IdentityMasker()) {
  const finished: Finished[] = [];
  const tracer = createOtelTracer({
    serviceName: "werft-worker",
    sampler: { kind: "always_on", ratio: 1 },
    headers: {},
    tenantHeaders: () => ({}),
    exporter: {
      export(spans, done) {
        for (const span of spans) {
          finished.push({
            name: span.name,
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: span.parentSpanContext?.spanId,
            attributes: { ...span.attributes },
            links: span.links.map((link) => ({
              traceId: link.context.traceId,
              spanId: link.context.spanId,
            })),
            status: span.status.code,
          });
        }
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  const emitter = new SpanEmitter({
    tracer,
    masker,
    scope: { sessionId: SESSION, attemptId: "attempt-1" },
  });
  return { emitter, finished, tracer };
}

const publicEvent = (event: string, data: Record<string, unknown>) =>
  ({ type: "public", event: { event, data } }) as unknown as RuntimeEvent;

const approvalRequested = (localId: string, toolCallId: string) =>
  ({
    type: "approval.requested",
    request: {
      localId,
      toolCallId,
      tool: { name: "Bash", input: {} },
      inputHash: "h",
      askedAt: 0,
      kind: "permission",
      display: {},
    },
  }) as unknown as RuntimeEvent;

/** One turn: a tool call that needs a permission, answered by a person. */
function playTurn(turn: TurnSpans, output = "done"): void {
  turn.onEvent(
    publicEvent("assistant", {
      text: "I will list files.",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
        },
      },
    }),
  );
  turn.onEvent(
    publicEvent("tool_use", {
      tool_call: { id: "tool-1", name: "Bash", input: { command: "ls" } },
    }),
  );
  turn.onEvent({ type: "tool.called", toolCallId: "tool-1", tool: "Bash" });
  turn.onEvent(approvalRequested("local-1", "tool-1"));
  turn.decided({
    requestId: "req-1",
    localId: "local-1",
    toolCallId: "tool-1",
    kind: "permission",
    decision: "allow",
    answerSurface: "slack",
  });
  turn.onEvent(
    publicEvent("tool_result", {
      tool_result: { tool_call_id: "tool-1", is_error: false, text: output },
    }),
  );
  turn.onEvent(publicEvent("assistant", { text: "All listed." }));
  turn.end({ status: "completed", reason: null, usage: { output_tokens: 9 } });
}

const named = (finished: Finished[], name: string) =>
  finished.filter((span) => span.name === name);

function printTree(finished: Finished[]): string {
  const depth = (span: Finished): number =>
    span.parentSpanId === undefined
      ? 0
      : 1 +
        depth(finished.find((p) => p.spanId === span.parentSpanId) as Finished);
  return finished
    .map((span) => `${"  ".repeat(depth(span))}${span.name}`)
    .sort()
    .join("\n");
}

describe("a turn's span tree", () => {
  test("is werft.turn over llm_request, tool, permission_wait under the tool, and checkpoint", async () => {
    const { emitter, finished, tracer } = harness();
    const turn = emitter.beginTurn({ turnId: "1", message: "list" }, FULL);
    turn.onEvent(publicEvent("assistant", { text: "I will list files." }));
    turn.onEvent(
      publicEvent("tool_use", {
        tool_call: { id: "tool-1", name: "Bash", input: { command: "ls" } },
      }),
    );
    turn.onEvent({ type: "tool.called", toolCallId: "tool-1", tool: "Bash" });
    turn.onEvent(approvalRequested("local-1", "tool-1"));
    turn.decided({
      requestId: "req-1",
      localId: "local-1",
      toolCallId: "tool-1",
      kind: "permission",
      decision: "allow",
    });
    turn.onEvent(
      publicEvent("tool_result", {
        tool_result: { tool_call_id: "tool-1", is_error: false, text: "a b" },
      }),
    );
    const checkpointSpan = turn.beginCheckpoint();
    checkpointSpan.end();
    turn.end(ENDED);
    await tracer.forceFlush();

    const root = named(finished, "werft.turn")[0] as Finished;
    const llm = named(finished, "werft.llm_request")[0] as Finished;
    const tool = named(finished, "werft.tool")[0] as Finished;
    const wait = named(finished, "werft.permission_wait")[0] as Finished;
    const checkpoint = named(finished, "werft.checkpoint")[0] as Finished;
    console.log(`span tree:\n${printTree(finished)}`);

    expect(root.parentSpanId).toBeUndefined();
    expect(llm.parentSpanId).toBe(root.spanId);
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(wait.parentSpanId).toBe(tool.spanId);
    expect(checkpoint.parentSpanId).toBe(root.spanId);
    expect(new Set(finished.map((span) => span.traceId)).size).toBe(1);
  });

  test("the trace id is the deterministic turn trace id", async () => {
    const { emitter, finished, tracer } = harness();
    emitter.beginTurn({ turnId: "1", message: "m" }, FULL).end(ENDED);
    await tracer.forceFlush();
    expect(finished[0]?.traceId).toBe("49195af5635b4ac7af24c52c73de7491");
    expect(finished[0]?.traceId).toBe(turnTraceId(SESSION, 1));
  });

  test("the next turn links to the previous one and to the queueing request", async () => {
    const { emitter, finished, tracer } = harness();
    emitter.beginTurn({ turnId: "1", message: "a" }, FULL).end(ENDED);
    const queued = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    emitter
      .beginTurn({ turnId: "2", message: "b", traceContext: queued }, FULL)
      .end(ENDED);
    await tracer.forceFlush();

    const [one, two] = named(finished, "werft.turn") as [Finished, Finished];
    expect(two.traceId).toBe(turnTraceId(SESSION, 2));
    expect(two.links).toEqual([
      { traceId: "a".repeat(32), spanId: "b".repeat(16) },
      { traceId: one.traceId, spanId: one.spanId },
    ]);
    expect(one.links).toEqual([]);
  });

  test("a turn id that is not a number traces nothing", async () => {
    const { emitter, finished, tracer } = harness();
    const turn = emitter.beginTurn({ turnId: "t-7", message: "m" }, FULL);
    expect(turn).toBe(NO_TURN_SPANS);
    expect(turn.traceparent()).toBeUndefined();
    await tracer.forceFlush();
    expect(finished).toEqual([]);
  });

  test("every span carries the attempt id", async () => {
    const { emitter, finished, tracer } = harness();
    playTurn(emitter.beginTurn({ turnId: "1", message: "list" }, FULL));
    await tracer.forceFlush();
    expect(finished.length).toBeGreaterThanOrEqual(4);
    for (const span of finished) {
      expect(span.attributes["werft.attempt_id"]).toBe("attempt-1");
    }
  });

  test("permission_wait carries the decision, the surface and the request id", async () => {
    const { emitter, finished, tracer } = harness();
    playTurn(emitter.beginTurn({ turnId: "1", message: "list" }, FULL));
    await tracer.forceFlush();
    const wait = named(finished, "werft.permission_wait")[0] as Finished;
    expect(wait.attributes).toMatchObject({
      "werft.permission_decision": "allow",
      "werft.answer_surface": "slack",
      "werft.pending_request_id": "req-1",
    });
  });

  test("tokens count cached input and the checkpoint revision rides on the root", async () => {
    const { emitter, finished, tracer } = harness();
    playTurn(
      emitter.beginTurn(
        { turnId: "1", message: "list", checkpointRevision: 4 },
        FULL,
      ),
    );
    await tracer.forceFlush();
    const llm = named(finished, "werft.llm_request")[0] as Finished;
    expect(llm.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 110,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 100,
    });
    const root = named(finished, "werft.turn")[0] as Finished;
    expect(root.attributes["werft.checkpoint_revision"]).toBe(4);
  });

  test("a subagent's tool hangs under the tool call that started it", async () => {
    const { emitter, finished, tracer } = harness();
    const turn = emitter.beginTurn({ turnId: "1", message: "m" }, FULL);
    turn.onEvent(
      publicEvent("tool_use", {
        tool_call: { id: "agent-1", name: "Task", input: {} },
      }),
    );
    turn.onEvent({ type: "tool.called", toolCallId: "agent-1", tool: "Task" });
    turn.onEvent(
      publicEvent("tool_use", {
        parent_tool_use_id: "agent-1",
        tool_call: { id: "inner-1", name: "Read", input: {} },
      }),
    );
    turn.onEvent({ type: "tool.called", toolCallId: "inner-1", tool: "Read" });
    turn.end(ENDED);
    await tracer.forceFlush();
    const tools = named(finished, "werft.tool");
    const outer = tools.find(
      (s) => s.attributes["gen_ai.tool.name"] === "Task",
    );
    const inner = tools.find(
      (s) => s.attributes["gen_ai.tool.name"] === "Read",
    );
    expect(inner?.parentSpanId).toBe(outer?.spanId);
  });

  test("a failed turn marks the root as an error", async () => {
    const { emitter, finished, tracer } = harness();
    emitter
      .beginTurn({ turnId: "1", message: "m" }, FULL)
      .end({ status: "failed", reason: "turn_timeout", usage: undefined });
    await tracer.forceFlush();
    expect((finished[0] as Finished).status).toBe(2);
  });

  test("the first turn reports the engine start once", async () => {
    const { emitter, finished, tracer } = harness();
    emitter.noteEngineStart(Date.now() - 2000, Date.now() - 1000);
    for (const id of ["1", "2"]) {
      emitter.beginTurn({ turnId: id, message: "m" }, FULL).end(ENDED);
    }
    await tracer.forceFlush();
    expect(named(finished, "werft.engine_start")).toHaveLength(1);
  });
});

describe("content attributes", () => {
  const korean = "한국어 내용입니다".repeat(20);
  const CONTENT_KEY = /^gen_ai\.(input|output|tool\.call\.(arguments|result))/;

  test("a Korean value is cut at the UTF-8 byte limit and keeps its original size", async () => {
    const { emitter, finished, tracer } = harness();
    emitter
      .beginTurn(
        { turnId: "1", message: korean },
        { mode: "full", maxBytes: 100 },
      )
      .end(ENDED);
    await tracer.forceFlush();
    const attributes = (finished[0] as Finished).attributes;
    const value = attributes["gen_ai.input.messages"] as string;
    const original = new TextEncoder().encode(
      JSON.stringify([{ role: "user", content: korean }]),
    ).byteLength;
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(100);
    expect(value).not.toContain("�");
    expect(attributes["werft.truncated.gen_ai.input.messages"]).toBe(original);
  });

  test("metadata mode puts no content on any span, and the next turn in full mode does", async () => {
    const { emitter, finished, tracer } = harness();
    playTurn(
      emitter.beginTurn(
        { turnId: "1", message: "plan" },
        { mode: "metadata", maxBytes: 32768 },
      ),
      "tool output",
    );
    playTurn(emitter.beginTurn({ turnId: "2", message: "again" }, FULL));
    await tracer.forceFlush();
    const keys = (turnId: number) =>
      finished
        .filter((s) => s.traceId === turnTraceId(SESSION, turnId))
        .flatMap((s) => Object.keys(s.attributes))
        .filter((key) => CONTENT_KEY.test(key));
    expect(keys(1)).toEqual([]);
    expect(keys(2)).toContain("gen_ai.input.messages");
    expect(keys(2)).toContain("gen_ai.tool.call.result");
    expect(keys(2)).toContain("gen_ai.output.messages");
  });

  test("a claim value in a tool result never reaches an attribute", async () => {
    const claimed = "attempt-bound-claim-value";
    const scrubber = new SecretScrubber([claimed]);
    const { emitter, finished, tracer } = harness({
      mask: (text) => scrubber.scrub(text),
    });
    playTurn(
      emitter.beginTurn({ turnId: "1", message: `use ${claimed}` }, FULL),
      `value is ${claimed} ok`,
    );
    await tracer.forceFlush();
    expect(JSON.stringify(finished)).not.toContain(claimed);
    const tool = named(finished, "werft.tool")[0] as Finished;
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe(
      "value is <redacted> ok",
    );
  });
});
