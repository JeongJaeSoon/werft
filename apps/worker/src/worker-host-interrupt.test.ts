import { describe, expect, test } from "bun:test";
import type { CheckpointRef } from "@werft-ai/contracts";
import {
  type AgentRun,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import { unwiredCheckpoints, type WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { scriptedRuntime, startScripted } from "./testing/scripted-engine.ts";
import { waitFor as pollFor } from "./testing/wait-for.ts";
import {
  inputUuid,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 1_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

function uuidForTurn(turn: number): string {
  return inputUuid(SESSION_ID, String(turn), `msg-${turn}`);
}

function resultMessage(uuid: string): EngineMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    user_message_uuid: uuid,
  };
}

function errorResult(uuid: string, terminalReason: string): EngineMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: "fake-session",
    is_error: true,
    terminal_reason: terminalReason,
    user_message_uuid: uuid,
  };
}

/** Captures a checkpoint whenever the run says one is ready. */
function capturing(): WorkerCheckpointPort & { refs: CheckpointRef[] } {
  const refs: CheckpointRef[] = [];
  return {
    refs,
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation) => {
      if (preparation.status !== "ready") return null;
      const ref: CheckpointRef = {
        revision: refs.length,
        manifest_ref: `manifests/${refs.length + 1}.json`,
        manifest_sha256: "c".repeat(64),
      };
      refs.push(ref);
      return ref;
    },
  };
}

function harness(
  steps: ScriptedStep[],
  overrides: {
    checkpoints?: WorkerCheckpointPort;
    gateway?: FakeWorkerGateway;
    logger?: WorkerLogger;
    timeouts?: Partial<WorkerTimeouts>;
    wrap?: (run: AgentRun) => AgentRun;
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = scriptedRuntime(steps);
  let starts = 0;
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: (launch) => {
        starts += 1;
        const run = startScripted(runtime, launch);
        return overrides.wrap?.(run) ?? run;
      },
    }),
  };
  const host = new WorkerHost({
    checkpoints: overrides.checkpoints ?? capturing(),
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: overrides.logger ?? silent,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: noWorkspace,
  });
  return { gateway, host, runtime, starts: () => starts };
}

const waitFor = (condition: () => boolean, label: string): Promise<void> =>
  pollFor(condition, label, { timeoutMs: 5_000, stepMs: 2 });

/** Replaces the run's interrupt, leaving everything else as it is. */
function withInterrupt(
  interrupt: (original: () => Promise<{ stillQueued: string[] }>) => Promise<{
    stillQueued: string[];
  }>,
) {
  return (run: AgentRun): AgentRun =>
    new Proxy(run, {
      get(target, property, receiver) {
        if (property === "interrupt") {
          return () => interrupt(() => target.interrupt());
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
}

/** Turn 1 runs until interrupted; turn 2 answers at once. */
const TWO_TURNS: ScriptedStep[] = [
  { type: "await-input" },
  { type: "delay", delayMs: 60_000 },
  { type: "emit", message: resultMessage(uuidForTurn(1)) },
  { type: "await-input" },
  { type: "emit", message: resultMessage(uuidForTurn(2)) },
  { type: "await-input" },
];

describe("WorkerHost interrupt", () => {
  test("records a correlated timeline from control receipt through finalize", async () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const record = (event: string, fields: Record<string, unknown> = {}) => {
      records.push({ event, fields });
    };
    const logger: WorkerLogger = {
      info: record,
      warn: record,
      error: record,
    };
    const { gateway, host, runtime } = harness(TWO_TURNS, { logger });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    await loop;

    const stages = records
      .filter(({ event }) => event === "worker.turn.interrupt.stage")
      .map(({ fields }) => fields);
    expect(stages.map(({ stage }) => stage)).toEqual([
      "control_received",
      "sdk_interrupt_called",
      "sdk_interrupt_answered",
      "engine_terminal",
      "capture_started",
      "capture_finished",
      "finalize_started",
      "finalize_finished",
    ]);
    for (const stage of stages) {
      expect(stage).toMatchObject({
        session_id: SESSION_ID,
        turn_id: "1",
        control_id: "ctl-1",
      });
      expect(stage.elapsed_ms).toBeNumber();
    }
  });

  test("stops only the targeted turn within 5s, with a checkpoint, and runs the next input on the same engine", async () => {
    const checkpoints = capturing();
    // Production cadences: the heartbeat alone would take 10s to say anything.
    const { gateway, host, runtime, starts } = harness(TWO_TURNS, {
      checkpoints,
      timeouts: { answerPollIntervalMs: 1_000, heartbeatIntervalMs: 10_000 },
    });
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");

    const asked = performance.now();
    gateway.interrupt("1");
    await waitFor(() => gateway.finalized.length >= 1, "turn 1 finalized");
    const observedMs = performance.now() - asked;
    const summary = await loop;

    expect(observedMs).toBeLessThan(5_000);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "interrupted", reason: "error_during_execution" },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(gateway.finalized[0]?.checkpoint).toEqual(checkpoints.refs[0]);
    // Both status events are in turn 1's stream: interrupting ahead of its
    // terminal, engine_stopped right behind it and inside the cut finalize
    // closes the turn at.
    const turnOne = gateway.batches
      .filter((batch) => batch.turn_id === "1")
      .flatMap((batch) => batch.events);
    expect(turnOne.map((event) => event.event)).toEqual([
      "status",
      "result",
      "status",
    ]);
    expect(turnOne[0]?.data).toEqual({ phase: "interrupting" });
    expect(turnOne[2]?.data).toEqual({
      phase: "engine_stopped",
      control_id: "ctl-1",
    });
    expect(gateway.finalized[0]?.final_source_sequence).toBe(
      turnOne[2]?.source_sequence,
    );
    // The follow-up went to the same engine session, not a new run.
    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "long task",
      "follow-up",
    ]);
    expect(starts()).toBe(1);
  });

  test("an interrupted turn without a checkpoint is closed as outcome_unknown, and the worker drains for recovery", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      checkpoints: unwiredCheckpoints,
      // Long enough that only the drain, not idling, ends the loop in time.
      timeouts: { idleTimeoutMs: 60_000 },
    });
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_checkpoint_unavailable",
      },
    ]);
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    // The session awaits a recovery decision; its next input is not run.
    expect(runtime.inputs).toHaveLength(1);
  });

  test("an aborted terminal nobody interrupted is a failure, not an interrupt", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: errorResult(uuidForTurn(1), "aborted_streaming"),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("aborted on its own");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "failed", reason: "error_during_execution" },
    ]);
  });

  // A clean interrupt's receipt precedes its terminal, but a turn that crashes
  // while handling one may report first (sdk.d.ts, SDKControlInterruptResponse).
  test.each([
    {
      name: "an acknowledgement makes it interrupted",
      answer: async () => ({ stillQueued: [] }),
      turn: {
        turnId: "1",
        status: "interrupted",
        reason: "error_during_execution",
      },
      outcome: "idle",
    },
    {
      name: "a refusal makes it a failure",
      answer: async (): Promise<{ stillQueued: string[] }> => {
        throw new Error("control channel refused the interrupt");
      },
      turn: {
        turnId: "1",
        status: "failed",
        reason: "error_during_execution",
      },
      outcome: "idle",
    },
    {
      name: "no answer within the grace leaves it unknown and fails the worker",
      answer: () => new Promise<{ stillQueued: string[] }>(() => {}),
      turn: {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_unanswered",
      },
      outcome: "failed",
    },
  ])(
    "an aborted terminal that overtakes the interrupt's receipt: $name",
    async ({ answer, turn, outcome }) => {
      let receipt: (() => void) | undefined;
      const { gateway, host, runtime } = harness(TWO_TURNS, {
        timeouts: { interruptGraceMs: 300 },
        wrap: withInterrupt(async (original) => {
          await original();
          // The terminal frame goes out while the receipt is still held.
          await new Promise<void>((resolve) => {
            receipt = resolve;
          });
          return answer();
        }),
      });
      gateway.enqueue("crashes while interrupted");
      const loop = host.runLoop();
      await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
      gateway.interrupt("1");
      await waitFor(
        () => gateway.events.some((event) => event.event === "result"),
        "the aborted terminal",
      );
      expect(gateway.finalized).toHaveLength(0);
      receipt?.();

      const summary = await loop;

      expect(summary.turns[0]).toEqual(turn);
      expect(summary.outcome).toBe(outcome);
    },
  );

  // The delays below only need to outlast the interrupt's way to the engine;
  // they are generous because a loaded runner stretches that way.
  test("an abort that follows a refused interrupt is a failure, not an interrupt", async () => {
    const { gateway, host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 1_000 },
        {
          type: "emit",
          message: errorResult(uuidForTurn(1), "aborted_streaming"),
        },
        { type: "await-input" },
      ],
      {
        wrap: withInterrupt(async () => {
          throw new Error("control channel refused the interrupt");
        }),
      },
    );
    gateway.enqueue("aborts on its own");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns[0]).toEqual({
      turnId: "1",
      status: "failed",
      reason: "error_during_execution",
    });
  });

  test.each([
    {
      name: "a success keeps its completion",
      message: resultMessage(uuidForTurn(1)),
      status: "completed",
    },
    {
      name: "an error that is no abort stays a failure",
      message: errorResult(uuidForTurn(1), "api_error"),
      status: "failed",
    },
  ])(
    "a turn that ended before the interrupt landed: $name",
    async ({ message, status }) => {
      let interrupted = false;
      const records: Array<{ event: string; fields: Record<string, unknown> }> =
        [];
      const record = (event: string, fields: Record<string, unknown> = {}) => {
        records.push({ event, fields });
      };
      const { gateway, host, runtime } = harness(
        [
          { type: "await-input" },
          { type: "delay", delayMs: 1_000 },
          { type: "emit", message },
          { type: "await-input" },
        ],
        {
          logger: { info: record, warn: record, error: record },
          // The engine had already finished: the interrupt reaches nothing.
          wrap: withInterrupt(async () => {
            interrupted = true;
            return { stillQueued: [] };
          }),
        },
      );
      gateway.enqueue("finishes anyway");
      const loop = host.runLoop();
      await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
      gateway.interrupt("1");

      const summary = await loop;

      expect(interrupted).toBe(true);
      expect(summary.turns[0]?.status).toBe(status);
      const stages = records
        .filter(({ event }) => event === "worker.turn.interrupt.stage")
        .map(({ fields }) => fields);
      expect(stages.map(({ stage }) => stage)).toEqual([
        "control_received",
        "sdk_interrupt_called",
        "sdk_interrupt_answered",
        "engine_terminal",
        "capture_started",
        "capture_finished",
        "finalize_started",
        "finalize_finished",
      ]);
      expect(stages[3]).toMatchObject({ terminal_status: status });
    },
  );

  test("an interrupt that names a turn already over does not touch the running one", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
        { type: "delay", delayMs: 40 },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      { gateway },
    );
    // A poll answered for turn 1 that lands while turn 2 runs.
    const original = gateway.pendingControl.bind(gateway);
    gateway.pendingControl = async (request) => {
      const response = await original(request);
      if (!gateway.finalized.some((call) => call.turn_id === "1")) {
        return response;
      }
      return {
        ...response,
        control: {
          control_id: "ctl-late",
          kind: "interrupt",
          target_turn_id: "1",
          issued_at: new Date().toISOString(),
        },
      };
    };
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await host.runLoop();

    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(gateway.events.some((event) => event.event === "status")).toBe(
      false,
    );
    expect(runtime.inputs).toHaveLength(2);
  });

  test("callbacks the turn was waiting on are cancelled, and their answers settle as such", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        {
          type: "permissions",
          requests: [
            {
              input: { command: "make deploy" },
              requestId: "req-deploy",
              tool: "Bash",
              toolUseId: "toolu_deploy",
            },
          ],
        },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("deploy it");
    const loop = host.runLoop();
    await waitFor(() => gateway.questions().length === 1, "question event");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns[0]?.status).toBe("interrupted");
    // The engine never got an allow for it.
    expect(
      runtime.permissionDecisions.filter(
        (decision) => decision.behavior === "allow",
      ),
    ).toEqual([]);
    // Cancelled by the interrupt, which the record says, not a person's deny.
    expect(gateway.settled).toEqual([
      {
        request_id: gateway.requestIdFor("toolu_deploy"),
        outcome: "cancelled",
        reason: "interrupt",
      },
    ]);
  });

  test("an engine that never answers the interrupt leaves the turn unknown and takes no more input", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: { interruptGraceMs: 30 },
      wrap: withInterrupt(async () => ({ stillQueued: [] })),
    });
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.outcome).toBe("failed");
    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_unanswered",
      },
    ]);
    expect(runtime.inputs).toHaveLength(1);
  });

  test("an SDK answer after the grace is recorded as late", async () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const record = (event: string, fields: Record<string, unknown> = {}) => {
      records.push({ event, fields });
    };
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      logger: { info: record, warn: record, error: record },
      timeouts: { interruptGraceMs: 20 },
      wrap: withInterrupt(async () => {
        await Bun.sleep(60);
        return { stillQueued: [] };
      }),
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    await loop;
    await Bun.sleep(60);

    const stages = records
      .filter(({ event }) => event === "worker.turn.interrupt.stage")
      .map(({ fields }) => fields);
    expect(stages.map(({ stage }) => stage)).toEqual([
      "control_received",
      "sdk_interrupt_called",
      "engine_terminal",
      "finalize_started",
      "finalize_finished",
      "late_sdk_interrupt_answered",
    ]);
    expect(stages[2]).toMatchObject({
      outcome: "timeout",
      sdk_response: "pending",
    });
    expect(stages[5]).toMatchObject({ outcome: "acknowledged" });
  });

  test("an intent handed out on every poll interrupts the turn once", async () => {
    let calls = 0;
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      // A slow engine: the intent keeps coming back until the terminal.
      wrap: withInterrupt(async (original) => {
        calls += 1;
        await Bun.sleep(40);
        return original();
      }),
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    const pollsBefore = gateway.calls.length;
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns[0]?.status).toBe("interrupted");
    expect(
      gateway.calls
        .slice(pollsBefore)
        .filter((call) => call === "pendingControl").length,
    ).toBeGreaterThan(3);
    expect(calls).toBe(1);
    expect(
      gateway.events
        .filter((event) => event.event === "status")
        .map((event) => event.data),
    ).toEqual([
      { phase: "interrupting" },
      { phase: "engine_stopped", control_id: "ctl-1" },
    ]);
  });

  test("the next input waits for the engine to answer an interrupt that arrived as the turn ended", async () => {
    let answer: () => void = () => {};
    const { gateway, host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 20 },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      {
        timeouts: { interruptGraceMs: 2_000 },
        // The engine takes the interrupt only after turn 1 has ended on its
        // own; were turn 2 sent meanwhile, it would be the one stopped.
        wrap: withInterrupt(
          () =>
            new Promise((resolve) => {
              answer = () => resolve({ stillQueued: [] });
            }),
        ),
      },
    );
    gateway.enqueue("short task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");
    await waitFor(() => gateway.finalized.length === 1, "turn 1 finalized");
    await Bun.sleep(50);
    expect(runtime.inputs).toHaveLength(1);
    answer();

    const summary = await loop;

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
  });

  test("an interrupt the engine never acknowledges keeps the next input from it", async () => {
    const { gateway, host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 20 },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      {
        timeouts: { interruptGraceMs: 30 },
        wrap: withInterrupt(() => new Promise(() => {})),
      },
    );
    gateway.enqueue("short task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.outcome).toBe("failed");
    expect(summary.turns.map((turn) => turn.status)).toEqual(["completed"]);
    // Never even taken off the queue: nothing is left for recovery to judge.
    expect(runtime.inputs).toHaveLength(1);
    expect(gateway.calls.filter((call) => call === "nextInput")).toHaveLength(
      1,
    );
  });

  test("a checkpoint the gateway refuses turns the interrupt into outcome_unknown", async () => {
    const gateway = new FakeWorkerGateway();
    const original = gateway.finalize.bind(gateway);
    gateway.finalize = async (request) => {
      if (request.checkpoint !== null) {
        throw new WorkerGatewayRequestError(
          409,
          "CHECKPOINT_UNAVAILABLE",
          "Checkpoint manifest rejected",
          false,
        );
      }
      return original(request);
    };
    const { host, runtime } = harness(TWO_TURNS, { gateway });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_checkpoint_unavailable",
      },
    ]);
    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
  });

  test("a refused checkpoint after an unanswered finalize leaves the interrupted turn open", async () => {
    const gateway = new FakeWorkerGateway();
    let calls = 0;
    gateway.finalize = async () => {
      calls += 1;
      if (calls === 1) {
        // The server may still be committing this one, checkpoint and all.
        throw new WorkerGatewayRequestError(
          0,
          null,
          "POST /finalize did not reach the gateway: timed out",
          true,
        );
      }
      throw new WorkerGatewayRequestError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        "Checkpoint manifest rejected",
        false,
      );
    };
    const { host, runtime } = harness(TWO_TURNS, { gateway });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    // No second body under the same key: recovery decides the turn.
    expect(calls).toBe(2);
    expect(summary.outcome).toBe("failed");
    expect(summary.turns).toEqual([]);
  });

  test("a capture that throws turns the interrupt into outcome_unknown", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      checkpoints: {
        restorePlan: async () => ({ mode: "new" }),
        capture: async () => {
          throw new Error("object store unreachable");
        },
      },
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns[0]).toEqual({
      turnId: "1",
      status: "outcome_unknown",
      reason: "interrupt_checkpoint_unavailable",
    });
  });

  test("an interrupt that arrives before the input is sent reaches the engine right after it", async () => {
    let release: () => void = () => {};
    const checked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      wrap: (run) =>
        new Proxy(run, {
          get(target, property, receiver) {
            if (property === "holdsInput") {
              return async (uuid: string) => {
                await checked;
                return target.holdsInput(uuid);
              };
            }
            if (property === "send") {
              return (input: Parameters<AgentRun["send"]>[0]) => {
                order.push("send");
                target.send(input);
              };
            }
            if (property === "interrupt") {
              return () => {
                order.push("interrupt");
                return target.interrupt();
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "turn 1 claimed");
    gateway.interrupt("1");
    // The intent is taken while the engine is still being asked about the input.
    await waitFor(
      () => gateway.batches.some((batch) => batch.turn_id === "1"),
      "interrupting status published",
    );
    expect(order).toEqual([]);
    release();

    const summary = await loop;

    // Interrupting an engine with nothing sent would miss the turn entirely.
    expect(order).toEqual(["send", "interrupt"]);
    expect(runtime.inputs).toHaveLength(1);
    expect(summary.turns[0]).toEqual({
      turnId: "1",
      status: "interrupted",
      reason: "error_during_execution",
    });
  });

  test("an interrupt taken while the input check hangs still ends within its grace", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: { interruptGraceMs: 50 },
      wrap: (run) =>
        new Proxy(run, {
          get(target, property, receiver) {
            if (property === "holdsInput") return () => new Promise(() => {});
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "turn 1 claimed");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.outcome).toBe("failed");
    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_unanswered",
      },
    ]);
    expect(runtime.inputs).toHaveLength(0);
  });

  test("a checkpoint capture that hangs after an interrupt ends the turn unknown within its budget", async () => {
    let captures = 0;
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: { interruptCaptureMs: 50, idleTimeoutMs: 60_000 },
      checkpoints: {
        restorePlan: async () => ({ mode: "new" }),
        capture: () => {
          captures += 1;
          return captures === 1 ? new Promise(() => {}) : Promise.resolve(null);
        },
      },
    });
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "interrupt_checkpoint_unavailable",
      },
    ]);
    expect(runtime.inputs).toHaveLength(1);
  });

  test("an abandoned interrupt capture records one terminal stage even when it later finishes", async () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const record = (event: string, fields: Record<string, unknown> = {}) => {
      records.push({ event, fields });
    };
    let captureStarted = false;
    let finishCapture: () => void = () => {};
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      logger: { info: record, warn: record, error: record },
      timeouts: { drainTimeoutMs: 20, interruptCaptureMs: 2_000 },
      checkpoints: {
        restorePlan: async () => ({ mode: "new" }),
        capture: () => {
          captureStarted = true;
          return new Promise((resolve) => {
            finishCapture = () => resolve(null);
          });
        },
      },
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");
    await waitFor(() => captureStarted, "checkpoint capture started");
    host.drain("received SIGTERM");

    await loop;
    finishCapture();
    await Bun.sleep(1);

    const captureFinishes = records
      .filter(({ event }) => event === "worker.turn.interrupt.stage")
      .map(({ fields }) => fields)
      .filter(({ stage }) => stage === "capture_finished");
    expect(captureFinishes).toEqual([
      expect.objectContaining({ outcome: "abandoned" }),
    ]);
  });

  test("a turn deadline passing mid-interrupt leaves the interrupt its outcome", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: { maxTurnMs: 100, drainTimeoutMs: 60_000 },
      // The engine takes longer to stop than the budget has left.
      wrap: withInterrupt(async (original) => {
        await Bun.sleep(200);
        return original();
      }),
    });
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(summary.turns).toEqual([
      { turnId: "1", status: "interrupted", reason: "error_during_execution" },
      { turnId: "2", status: "completed", reason: null },
    ]);
  });

  test("a capture that outlasts the interrupt's grace still commits within its own budget", async () => {
    const checkpoints = capturing();
    let stoppedBeforeCapture = false;
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: {
        interruptGraceMs: 400,
        interruptCaptureMs: 2_000,
      },
      // The engine stops near the end of the grace.
      wrap: withInterrupt(async (original) => {
        await Bun.sleep(300);
        return original();
      }),
      checkpoints: {
        ...checkpoints,
        capture: async (preparation, context) => {
          // The effect is durable before the capture starts.
          stoppedBeforeCapture = gateway.events.some(
            (event) =>
              event.event === "status" &&
              (event.data as { phase?: string }).phase === "engine_stopped",
          );
          // Longer than all of the grace, well inside the capture's budget.
          await Bun.sleep(500);
          return checkpoints.capture(preparation, context);
        },
      },
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    const summary = await loop;

    expect(stoppedBeforeCapture).toBe(true);
    expect(summary.turns[0]).toEqual({
      turnId: "1",
      status: "interrupted",
      reason: "error_during_execution",
    });
    expect(gateway.finalized[0]?.checkpoint).toEqual(checkpoints.refs[0]);
  });

  test("an interrupt the engine never acknowledges records no engine_stopped", async () => {
    const { gateway, host, runtime } = harness(TWO_TURNS, {
      timeouts: { interruptGraceMs: 30 },
      wrap: withInterrupt(() => new Promise(() => {})),
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    await loop;

    expect(
      gateway.events.filter(
        (event) =>
          event.event === "status" &&
          (event.data as { phase?: string }).phase === "engine_stopped",
      ),
    ).toHaveLength(0);
  });

  test("a refused checkpoint gives its lease back even when the unknown fallback never lands", async () => {
    let run: AgentRun | undefined;
    class Refusing extends FakeWorkerGateway {
      override async finalize(
        request: Parameters<FakeWorkerGateway["finalize"]>[0],
      ): ReturnType<FakeWorkerGateway["finalize"]> {
        if (request.checkpoint !== null) {
          throw new WorkerGatewayRequestError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            "Checkpoint rejected: digest mismatch",
            false,
          );
        }
        // The fallback's answer never comes back decided.
        throw new WorkerGatewayRequestError(503, null, "unavailable", true);
      }
    }
    const gateway = new Refusing();
    const { host, runtime } = harness(TWO_TURNS, {
      gateway,
      timeouts: { drainTimeoutMs: 100 },
      wrap: (started) => {
        run = started;
        return started;
      },
    });
    gateway.enqueue("long task");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    await loop;
    await Bun.sleep(1);

    expect(await run?.prepareCheckpoint("turn_end")).not.toMatchObject({
      reason: "checkpoint_lease_held",
    });
  });
});
