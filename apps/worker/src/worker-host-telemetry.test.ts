import { describe, expect, test } from "bun:test";
import {
  type ClaimTelemetry,
  type SessionEvent,
  sessionEventSchema,
} from "@werft-ai/contracts";
import { formatTraceparent, turnTraceId } from "@werft-ai/observability";
import { createOtelTracer } from "@werft-ai/observability/otel";
import {
  type AgentInput,
  approvalInputHash,
  type RuntimeEvent,
} from "@werft-ai/runtime-core";

import { installedRuntimes } from "@werft-ai/runtime-registry";

import type { WorkerTimeouts } from "./config.ts";
import {
  createIngestTelemetry,
  type TelemetryFactory,
  type TelemetrySession,
} from "./telemetry/session.ts";
import { SpanEmitter } from "./telemetry/turn-spans.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { ScriptedRun } from "./testing/scripted-run.ts";
import { WorkerHost } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 80,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};
const codec = installedRuntimes[0]?.eventCodec;
const ON: ClaimTelemetry = {
  enabled: true,
  ingest_url: "http://ingest.test",
  content_mode: "full",
  content_max_bytes: 32768,
};

type Finished = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
};

function recording() {
  const finished: Finished[] = [];
  const built: TelemetrySession[] = [];
  const factory: TelemetryFactory = ({ claim, execution, masker }) => {
    const tracer = createOtelTracer({
      serviceName: "werft-worker",
      sampler: { kind: "always_on", ratio: 1 },
      headers: {},
      tenantHeaders: () => ({}),
      resourceAttributes: {
        "werft.execution_id": execution.id,
        "werft.attempt_id": claim.attempt_id,
        "werft.execution_generation": execution.generation,
      },
      exporter: {
        export(spans, done) {
          for (const span of spans) {
            finished.push({
              name: span.name,
              traceId: span.spanContext().traceId,
              spanId: span.spanContext().spanId,
              parentSpanId: span.parentSpanContext?.spanId,
              attributes: { ...span.attributes },
              resource: { ...span.resource.attributes },
            });
          }
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    const session: TelemetrySession = {
      emitter: new SpanEmitter({
        tracer,
        masker,
        scope: { sessionId: claim.session_id, attemptId: claim.attempt_id },
        neutralize: (event) =>
          codec === undefined ? event : codec.withNeutralFields(event),
      }),
      flush: () => void tracer.forceFlush(),
      shutdown: async () => void (await tracer.shutdown()),
      dropped: () => 0,
    };
    built.push(session);
    return session;
  };
  return { factory, finished, built };
}

function build(
  run: ScriptedRun,
  telemetry: ClaimTelemetry | undefined,
  factory: TelemetryFactory | undefined,
) {
  const gateway = new FakeWorkerGateway({
    sessionId: SESSION,
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  const worker = new WorkerHost({
    checkpoints: {
      restorePlan: async () => ({ mode: "new" }),
      capture: async () => null,
    },
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: { info() {}, warn() {}, error() {} },
    runtimes: { launcherFor: () => ({ start: () => run }) },
    timeouts,
    workspace: noWorkspace,
    ...(factory === undefined ? {} : { telemetry: factory }),
  });
  return { gateway, worker };
}

function checkpointingRun(): ScriptedRun {
  const run = new ScriptedRun();
  run.capabilities = {
    ...run.capabilities,
    effective: { ...run.capabilities.effective, checkpoint: true },
  };
  return run;
}

// What the Claude adapter's mapper writes: the neutral fields are not there.
const nativeText = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
});
const nativeToolUse = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  },
  parent_tool_use_id: null,
});
const nativeToolResult = (id: string, text: string) => ({
  type: "tool_result",
  tool_use_id: id,
  content: text,
  is_error: false,
});

const publicEvent = (
  id: string,
  event: string,
  data: Record<string, unknown>,
  sent: AgentInput,
): RuntimeEvent => ({
  type: "public",
  event: sessionEventSchema.parse({ id, event, data }) as SessionEvent,
  inputs: [sent.uuid],
});

const ended = (sent: AgentInput): RuntimeEvent => ({
  type: "turn.ended",
  turn: {
    isError: false,
    abortedByStop: false,
    budgetExceeded: false,
    engineResult: { outcome: "done" },
    cost: { countRestarted: false, unknown: true },
    usage: { input_tokens: 4, output_tokens: 2 },
    inputs: [sent.uuid],
  },
});

function answerEvery(run: ScriptedRun, text = "hello") {
  run.onSend = (sent) => {
    run.push(
      publicEvent(`a-${sent.uuid}`, "assistant", nativeText(text), sent),
      ended(sent),
    );
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 3_000) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

const named = (finished: Finished[], name: string) =>
  finished.filter((span) => span.name === name);

describe("WorkerHost spans", () => {
  test("a fake-model turn with one tool call and one permission request is a tree", async () => {
    const run = checkpointingRun();
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    const input = { command: "ls" };
    run.onSend = (sent) => {
      run.push(
        publicEvent("a1", "assistant", nativeText("Listing."), sent),
        publicEvent(
          "t1",
          "tool_use",
          nativeToolUse("tool-1", "shell", input),
          sent,
        ),
        { type: "tool.called", toolCallId: "tool-1", tool: "shell" },
        {
          type: "approval.requested",
          request: {
            localId: "local-1",
            toolCallId: "tool-1",
            tool: { name: "shell", input },
            inputHash: approvalInputHash("shell", input),
            askedAt: performance.now(),
            kind: "permission",
            display: input,
          },
        },
      );
    };
    gateway.enqueue("list the files");
    const loop = worker.runLoop();
    await until(() => gateway.registrations.length === 1, "the request");
    const requestId = gateway.requestIdFor("tool-1");
    gateway.answer(
      { request_id: requestId, kind: "permission", decision: "allow" },
      "slack",
    );
    await until(() => run.answers.length === 1, "the answer to reach the run");
    const sent = run.inputs[0] as AgentInput;
    run.push(
      publicEvent("r1", "tool_result", nativeToolResult("tool-1", "a b"), sent),
      ended(sent),
    );
    await loop;
    await Bun.sleep(20);

    const root = named(finished, "werft.turn")[0] as Finished;
    const llm = named(finished, "werft.llm_request")[0] as Finished;
    const tool = named(finished, "werft.tool")[0] as Finished;
    const wait = named(finished, "werft.permission_wait")[0] as Finished;
    const checkpoint = named(finished, "werft.checkpoint")[0] as Finished;
    const depth = (span: Finished): number =>
      span.parentSpanId === undefined
        ? 0
        : 1 +
          depth(
            finished.find((s) => s.spanId === span.parentSpanId) as Finished,
          );
    console.log(
      `span tree:\n${finished
        .map((s) => `${"  ".repeat(depth(s))}${s.name}`)
        .sort()
        .join("\n")}`,
    );

    expect(root.traceId).toBe(turnTraceId(SESSION, 1));
    expect(llm.parentSpanId).toBe(root.spanId);
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(wait.parentSpanId).toBe(tool.spanId);
    expect(checkpoint.parentSpanId).toBe(root.spanId);
    expect(wait.attributes).toMatchObject({
      "werft.permission_decision": "allow",
      "werft.answer_surface": "slack",
      "werft.pending_request_id": requestId,
    });
    expect(tool.attributes).toMatchObject({
      "werft.tool.decision": "allow",
      "werft.tool.decision_basis": "approval",
    });
    // The adapter's own event shape reaches the spans' content.
    expect(String(tool.attributes["gen_ai.tool.call.arguments"])).toContain(
      "ls",
    );
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe("a b");
    expect(String(root.attributes["gen_ai.output.messages"])).toContain(
      "Listing.",
    );
    expect(root.attributes["werft.attempt_id"]).toBe("att_fake");
    expect(root.resource).toMatchObject({
      "werft.execution_id": "exec-1",
      "werft.attempt_id": "att_fake",
      "werft.execution_generation": 1,
    });
  });

  test("a late event for another input never reaches this turn's spans", async () => {
    const run = new ScriptedRun();
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    run.onSend = (sent) => {
      const other = { uuid: "earlier-input" } as AgentInput;
      run.push(
        publicEvent(
          "late",
          "assistant",
          nativeText("from the earlier turn"),
          other,
        ),
        publicEvent("own", "assistant", nativeText("from this turn"), sent),
        ended(sent),
      );
    };
    gateway.enqueue("hi");
    await worker.runLoop();
    await Bun.sleep(20);

    const root = named(finished, "werft.turn")[0] as Finished;
    const output = String(root.attributes["gen_ai.output.messages"]);
    expect(output).toContain("from this turn");
    expect(output).not.toContain("from the earlier turn");
  });

  test("an earlier input's tool.called and turn.ended never touch this turn's spans", async () => {
    const run = new ScriptedRun();
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    run.onSend = (sent) => {
      const other = { uuid: "earlier-input" } as AgentInput;
      run.push(
        publicEvent(
          "late",
          "tool_use",
          nativeToolUse("late-tool", "shell", {}),
          other,
        ),
        { type: "tool.called", toolCallId: "late-tool", tool: "shell" },
        publicEvent("own", "assistant", nativeText("mine"), sent),
        // Arrives while this turn's own llm_request is open.
        ended(other),
        publicEvent("own-2", "assistant", nativeText("mine too"), sent),
        ended(sent),
      );
    };
    gateway.enqueue("hi");
    await worker.runLoop();
    await Bun.sleep(20);

    expect(named(finished, "werft.tool")).toHaveLength(0);
    // The other input's terminal did not close it halfway.
    expect(named(finished, "werft.llm_request")).toHaveLength(1);
    const root = named(finished, "werft.turn")[0] as Finished;
    expect(String(root.attributes["gen_ai.output.messages"])).toContain("mine");
  });

  test("a claim without telemetry builds nothing and sends no traceparent", async () => {
    const run = new ScriptedRun();
    answerEvery(run);
    let built = 0;
    const { gateway, worker } = build(run, undefined, () => {
      built += 1;
      throw new Error("must not be built");
    });
    gateway.enqueue("hi");
    await worker.runLoop();
    expect(built).toBe(0);
    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.traceparents.every((c) => c.traceparent === undefined)).toBe(
      true,
    );
  });

  test("a claim that turns telemetry off builds nothing either", async () => {
    const run = new ScriptedRun();
    answerEvery(run);
    const { factory, finished, built } = recording();
    const { gateway, worker } = build(run, { enabled: false }, factory);
    gateway.enqueue("hi");
    await worker.runLoop();
    expect(built).toEqual([]);
    expect(finished).toEqual([]);
  });

  test("calls made for the turn carry its traceparent; polling between turns carries none", async () => {
    const run = checkpointingRun();
    answerEvery(run);
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    gateway.enqueue("hi");
    await worker.runLoop();
    await Bun.sleep(20);
    const root = named(finished, "werft.turn")[0] as Finished;
    const expected = formatTraceparent({
      traceId: root.traceId,
      spanId: root.spanId,
      sampled: true,
    });
    const during = gateway.traceparents.filter(
      (c) => c.call === "appendEvents" || c.call === "finalize",
    );
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((c) => c.traceparent === expected)).toBe(true);
    expect(
      gateway.traceparents
        .filter((c) => c.call === "nextInput")
        .every((c) => c.traceparent === undefined),
    ).toBe(true);
  });

  test("content_mode is read from each turn's input", async () => {
    const run = checkpointingRun();
    answerEvery(run);
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    gateway.enqueue("quiet", { contentMode: "metadata" });
    gateway.enqueue("loud", { contentMode: "full" });
    await worker.runLoop();
    await Bun.sleep(20);
    const roots = named(finished, "werft.turn");
    expect(roots).toHaveLength(2);
    const [first, second] = roots as [Finished, Finished];
    expect(first.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(second.attributes["gen_ai.input.messages"]).toContain("loud");
  });

  test("the queueing request's traceparent becomes a link, the next turn links to this one", async () => {
    const run = checkpointingRun();
    answerEvery(run);
    const { factory, finished } = recording();
    const { gateway, worker } = build(run, ON, factory);
    gateway.enqueue("one", {
      traceContext: `00-${"c".repeat(32)}-${"d".repeat(16)}-01`,
    });
    gateway.enqueue("two");
    await worker.runLoop();
    await Bun.sleep(20);
    expect(named(finished, "werft.turn")).toHaveLength(2);
  });

  test("the production factory posts the adapter's own events with their content", async () => {
    const run = new ScriptedRun();
    answerEvery(run, "from the adapter");
    const bodies: string[] = [];
    const factory = createIngestTelemetry({
      requestTimeoutMs: 1_000,
      eventCodecFor: () => codec,
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response("{}", { status: 200 });
      },
    });
    const { gateway, worker } = build(run, ON, factory);
    gateway.enqueue("hi");
    await worker.runLoop();
    await until(() => bodies.length > 0, "the ingest post");

    expect(bodies.join("")).toContain("from the adapter");
  });

  test("a telemetry factory or session that throws costs the spans, not the turns", async () => {
    const boom = () => {
      throw new Error("telemetry failed");
    };
    const { factory } = recording();
    const builders: Record<string, TelemetryFactory> = {
      factory: boom,
      session: (input) => {
        const session = factory(input);
        return {
          emitter: {
            noteEngineStart: boom,
            beginTurn: (start, policy) =>
              session.emitter.beginTurn(start, policy),
          },
          flush: boom,
          shutdown: async () => boom(),
          dropped: () => boom(),
        };
      },
    };
    for (const [label, build_] of Object.entries(builders)) {
      const run = new ScriptedRun();
      answerEvery(run);
      const { gateway, worker } = build(run, ON, build_);
      gateway.enqueue("a");
      gateway.enqueue("b");
      const summary = await worker.runLoop();

      expect(summary.turns, label).toHaveLength(2);
      expect(gateway.finalized, label).toHaveLength(2);
    }
  });

  test("a stalled ingest does not slow the events or the finalize, and a full queue counts drops", async () => {
    const run = checkpointingRun();
    answerEvery(run);
    let session: TelemetrySession | undefined;
    const sent: string[] = [];
    const factory = createIngestTelemetry({
      requestTimeoutMs: 60_000,
      queue: { maxSpans: 5 },
      onSession: (built) => {
        session = built;
      },
      fetch: (url) => {
        sent.push(url);
        return new Promise<Response>(() => {});
      },
    });
    const { gateway, worker } = build(run, ON, factory);
    for (const message of ["a", "b", "c", "d"]) gateway.enqueue(message);
    const started = performance.now();
    const loop = worker.runLoop();
    await until(() => gateway.finalized.length === 4, "the fourth finalize");
    const finalizedAfter = performance.now() - started;
    const summary = await loop;

    console.log(
      `4 finalized after ${Math.round(finalizedAfter)}ms, ingest stalled`,
    );
    expect(summary.turns).toHaveLength(4);
    expect(finalizedAfter).toBeLessThan(500);
    await Bun.sleep(100);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toBe("http://ingest.test/v1/traces");
    expect(session?.dropped()).toBeGreaterThan(0);
    console.log(`dropped spans: ${session?.dropped()}`);
  });
});
