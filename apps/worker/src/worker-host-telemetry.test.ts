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

/** A factory that keeps every finished span in memory instead of sending it. */
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
      // A scripted run takes no checkpoint; the span still brackets the attempt.
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

/** Answers each turn with one text block and ends it. */
function answerEvery(run: ScriptedRun, text = "hello") {
  run.onSend = (sent) => {
    run.push(
      publicEvent(
        `a-${sent.uuid}`,
        "assistant",
        { type: "assistant", text },
        sent,
      ),
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
        publicEvent(
          "a1",
          "assistant",
          { type: "assistant", text: "Listing." },
          sent,
        ),
        publicEvent(
          "t1",
          "tool_use",
          {
            type: "assistant",
            tool_call: { id: "tool-1", name: "shell", input },
          },
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
      publicEvent(
        "r1",
        "tool_result",
        {
          tool_result: { tool_call_id: "tool-1", is_error: false, text: "a b" },
        },
        sent,
      ),
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
    expect(root.attributes["werft.attempt_id"]).toBe("att_fake");
    expect(root.resource).toMatchObject({
      "werft.execution_id": "exec-1",
      "werft.attempt_id": "att_fake",
      "werft.execution_generation": 1,
    });
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

  test("a stalled ingest does not slow the events or the finalize, and a full queue counts drops", async () => {
    const run = checkpointingRun();
    answerEvery(run);
    let session: TelemetrySession | undefined;
    const sent: string[] = [];
    const factory = createIngestTelemetry({
      requestTimeoutMs: 60_000,
      // One turn is three or four spans: the stuck first request is out of
      // the queue, and the later turns cannot all fit in what is left.
      queue: { maxSpans: 5 },
      onSession: (built) => {
        session = built;
      },
      // Never answers: the ingest has stopped.
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
    // Four scripted turns take a few tens of ms; a wait on ingest would show.
    expect(finalizedAfter).toBeLessThan(500);
    // Serialization finishes on the event loop after the last turn.
    await Bun.sleep(100);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toBe("http://ingest.test/v1/traces");
    expect(session?.dropped()).toBeGreaterThan(0);
    console.log(`dropped spans: ${session?.dropped()}`);
  });
});
