import { describe, expect, test } from "bun:test";
import {
  type AgentRun,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import type { CaptureRefusal, WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { noWorkspace } from "./testing/no-workspace.ts";
import { scriptedRuntime, startScripted } from "./testing/scripted-engine.ts";
import { resultMessage } from "./testing/sdk-messages.ts";
import {
  type OutsideTurnCheckpoint,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 200,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

function backgroundTasks(...ids: string[]): EngineMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash" })),
  };
}

type Capture = { status: string; kind: string };

/**
 * A port that names its refusals the way SessionCheckpoints does. Each entry
 * of `failures` fails one ready capture, in order.
 */
function namingPort(
  gateway: FakeWorkerGateway,
  failures: CaptureRefusal[] = [],
  everyTime?: CaptureRefusal,
  captureMs = 0,
) {
  const captures: Capture[] = [];
  const refusals: string[] = [];
  const port: WorkerCheckpointPort = {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation, context) => {
      captures.push({
        status: preparation.status,
        kind: context.captureKind ?? "turn_end",
      });
      if (preparation.status !== "ready") {
        context.refused?.({
          reason: preparation.reason,
          infrastructure: false,
        });
        return null;
      }
      const failure = everyTime ?? failures.shift();
      if (failure !== undefined) {
        context.refused?.(failure);
        return null;
      }
      if (captureMs > 0) await Bun.sleep(captureMs);
      const revision = (gateway.checkpointRevision ?? -1) + 1;
      return {
        revision,
        manifest_ref: `checkpoints/${revision}.json`,
        manifest_sha256: "a".repeat(64),
      };
    },
    finalizeRefused: async (detail) => {
      refusals.push(detail);
    },
  };
  return { captures, port, refusals };
}

function harness(
  steps: ScriptedStep[],
  overrides: {
    captureMs?: number;
    engines?: EngineExitWatch;
    everyTime?: CaptureRefusal;
    failures?: CaptureRefusal[];
    gateway?: FakeWorkerGateway;
    outsideTurnCheckpoint?: Partial<OutsideTurnCheckpoint>;
    timeouts?: Partial<WorkerTimeouts>;
    wrapRun?: (run: AgentRun) => AgentRun;
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = scriptedRuntime(steps);
  const log: string[] = [];
  const logger: WorkerLogger = {
    info: (event) => log.push(event),
    warn: (event) => log.push(event),
    error: (event) => log.push(event),
  };
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: (launch) => {
        const run = startScripted(runtime, launch);
        return overrides.wrapRun?.(run) ?? run;
      },
    }),
  };
  const checkpoints = namingPort(
    gateway,
    overrides.failures,
    overrides.everyTime,
    overrides.captureMs,
  );
  const host = new WorkerHost({
    checkpoints: checkpoints.port,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: noWorkspace,
    // Short everywhere: no test waits out a production grace.
    outsideTurnCheckpoint: {
      idleBackgroundGraceMs: 400,
      stopSignalWaitMs: 200,
      settleWaitMs: 200,
      retryBackoffMs: [5],
      retryHoldMs: 2_000,
      commitRetryMs: 200,
      ...overrides.outsideTurnCheckpoint,
    },
    ...(overrides.engines === undefined ? {} : { engines: overrides.engines }),
  });
  return { ...checkpoints, gateway, host, log, runtime };
}

const INFRASTRUCTURE: CaptureRefusal = {
  reason: "publish_failed",
  infrastructure: true,
};
const REFUSED: CaptureRefusal = {
  reason: "publish_failed",
  infrastructure: false,
};

/** One turn that ends with a background task still running, which ends `afterMs` later. */
function backgroundTurn(afterMs: number): ScriptedStep[] {
  return [
    { type: "await-input" },
    { type: "emit", message: backgroundTasks("bash_1") },
    { type: "emit", message: resultMessage(SESSION_ID, 1) },
    { type: "delay", delayMs: afterMs },
    { type: "emit", message: backgroundTasks() },
    { type: "await-input" },
  ];
}

const twoTurns: ScriptedStep[] = [
  { type: "await-input" },
  { type: "emit", message: resultMessage(SESSION_ID, 1) },
  { type: "await-input" },
  { type: "emit", message: resultMessage(SESSION_ID, 2) },
  { type: "await-input" },
];

describe("WorkerHost checkpoints outside a turn", () => {
  test("a turn that left background work running is checkpointed between turns once the work ends", async () => {
    const { captures, gateway, host } = harness(backgroundTurn(30), {
      timeouts: { idleTimeoutMs: 250 },
    });
    gateway.enqueue("run a build in the background");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    // The turn stays as it ended: completed, finalized without a checkpoint.
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((call) => call.checkpoint)).toEqual([null]);
    expect(captures).toEqual([
      { status: "rejected", kind: "turn_end" },
      { status: "ready", kind: "between_turns" },
    ]);
    expect(
      gateway.checkpointCommits.map((commit) => [
        commit.turn_id,
        commit.checkpoint.revision,
      ]),
    ).toEqual([["1", 0]]);
    expect(gateway.checkpointRevision).toBe(0);
  });

  test("an idle exit waits while background work is within its grace, then captures and exits", async () => {
    const { captures, gateway, host, log } = harness(backgroundTurn(130));
    gateway.enqueue("run a build in the background");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(log).toContain("worker.idle.background_grace");
    expect(log).not.toContain("worker.idle.background_stopped");
    expect(captures.at(-1)).toEqual({
      status: "ready",
      kind: "before_idle_exit",
    });
    expect(gateway.checkpointCommits.map((commit) => commit.turn_id)).toEqual([
      "1",
    ]);
  });

  test("past the grace the run's processes are stopped, named by command on the stream, and the checkpoint is taken before the exit", async () => {
    const signals: Array<[string, number[]]> = [];
    let alive = [4243];
    const engines: EngineExitWatch = {
      descendants: async () => alive,
      commands: async () => ["sleep"],
      signal: (pids, signal) => {
        signals.push([signal, [...pids]]);
        alive = [];
      },
      exited: async () => true,
      running: [],
      kill() {},
    };
    const { captures, gateway, host, log } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "await-input" },
      ],
      { engines, outsideTurnCheckpoint: { idleBackgroundGraceMs: 0 } },
    );
    gateway.enqueue("start a dev server and leave it");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(signals).toEqual([["SIGTERM", [4243]]]);
    expect(log).toContain("worker.idle.background_stopped");
    expect(
      gateway.events
        .filter((event) => event.event === "system")
        .map((event) => event.data),
    ).toContainEqual({
      type: "system",
      subtype: "background_tasks_stopped",
      commands: ["sleep"],
    });
    expect(captures).toEqual([
      { status: "rejected", kind: "turn_end" },
      { status: "ready", kind: "before_idle_exit" },
    ]);
    expect(gateway.checkpointCommits.map((commit) => commit.turn_id)).toEqual([
      "1",
    ]);
  });

  test("with afterIdleGrace wait, the exit is put off until the work ends and nothing is stopped", async () => {
    const signals: string[] = [];
    let alive = [4243];
    const engines: EngineExitWatch = {
      descendants: async () => alive,
      commands: async () => ["node"],
      signal: (_pids, signal) => {
        signals.push(signal);
      },
      exited: async () => true,
      running: [],
      kill() {},
    };
    const { gateway, host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "await-input" },
      ],
      {
        engines,
        outsideTurnCheckpoint: {
          idleBackgroundGraceMs: 0,
          afterIdleGrace: "wait",
        },
      },
    );
    gateway.enqueue("start a dev server and leave it");
    const loop = host.runLoop();
    let exited = false;
    void loop.then(() => {
      exited = true;
    });

    await Bun.sleep(1_400);
    expect(exited).toBe(false);
    alive = [];
    const summary = await loop;

    expect(summary.outcome).toBe("idle");
    expect(signals).toEqual([]);
    expect(gateway.checkpointCommits).toHaveLength(1);
  });

  test("a publish the infrastructure failed is retried in the lease, and the next input stays queued until it lands", async () => {
    const { captures, gateway, host } = harness(twoTurns, {
      failures: [INFRASTRUCTURE, INFRASTRUCTURE],
    });
    gateway.enqueue("first");
    gateway.enqueue("second, queued while the checkpoint is owed");

    const summary = await host.runLoop();

    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    const firstFinalize = gateway.calls.indexOf("finalize");
    const commit = gateway.calls.indexOf("commitCheckpoint");
    expect(commit).toBeGreaterThan(firstFinalize);
    // Not one poll for input between the turn's end and its checkpoint.
    expect(gateway.calls.slice(firstFinalize, commit)).not.toContain(
      "nextInput",
    );
    expect(captures.slice(0, 3)).toEqual([
      { status: "ready", kind: "turn_end" },
      { status: "ready", kind: "between_turns" },
      { status: "ready", kind: "between_turns" },
    ]);
    expect(
      gateway.checkpointCommits.map((call) => [
        call.turn_id,
        call.checkpoint.revision,
      ]),
    ).toEqual([["1", 0]]);
    // The second turn ran after it, on its own checkpoint.
    expect(gateway.finalized[1]?.checkpoint?.revision).toBe(1);
  });

  test("a capture the workspace itself refuses does not hold the next turn, whose finalize commits", async () => {
    const { gateway, host } = harness(twoTurns, { failures: [REFUSED] });
    gateway.enqueue("write a file over the limit");
    gateway.enqueue("remove it");

    const summary = await host.runLoop();

    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(gateway.finalized.map((call) => call.checkpoint?.revision)).toEqual([
      undefined,
      0,
    ]);
    // Covered by the second turn's own commit: nothing was owed any more.
    expect(gateway.checkpointCommits).toEqual([]);
  });

  test("past the hold's limit input is asked for again and the checkpoint is tried once more before the idle exit", async () => {
    const { captures, gateway, host, log } = harness(twoTurns, {
      everyTime: INFRASTRUCTURE,
      outsideTurnCheckpoint: { retryHoldMs: 40 },
    });
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await host.runLoop();

    expect(log).toContain("worker.checkpoint.hold_ended");
    expect(summary.outcome).toBe("idle");
    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(gateway.checkpointCommits).toEqual([]);
    expect(captures.at(-1)?.kind).toBe("before_idle_exit");
    // The hold is spent once: the second turn's failure does not hold again.
    expect(
      log.filter((event) => event === "worker.checkpoint.hold_ended"),
    ).toHaveLength(1);
  });

  test("a commit the gateway refuses is recorded like a refused finalize and tried once more before the idle exit, not in a loop", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.checkpointCommitFailure = new WorkerGatewayRequestError(
      409,
      "REQUEST_STALE",
      "No checkpoint is committed onto turn 1: a later turn has started",
      false,
    );
    const { host, refusals } = harness(backgroundTurn(20), {
      gateway,
      timeouts: { idleTimeoutMs: 150 },
    });
    gateway.enqueue("run a build in the background");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(gateway.checkpointCommits).toHaveLength(2);
    expect(refusals).toHaveLength(2);
    expect(gateway.checkpointRevision).toBeNull();
  });

  test("a capture refused at the turn's end is taken again before the idle exit, with no background work to wait for", async () => {
    const { captures, gateway, host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "await-input" },
      ],
      { failures: [REFUSED] },
    );
    gateway.enqueue("write a file over the limit, then remove it");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(captures).toEqual([
      { status: "ready", kind: "turn_end" },
      { status: "ready", kind: "before_idle_exit" },
    ]);
    expect(
      gateway.checkpointCommits.map((call) => [
        call.turn_id,
        call.checkpoint.revision,
      ]),
    ).toEqual([["1", 0]]);
  });

  test("a hold ends at its limit, not a backoff step past it, and no capture starts once it has", async () => {
    const { captures, gateway, host, log } = harness(twoTurns, {
      everyTime: INFRASTRUCTURE,
      outsideTurnCheckpoint: { retryHoldMs: 60, retryBackoffMs: [5_000] },
    });
    gateway.enqueue("first");
    gateway.enqueue("second");
    const started = performance.now();

    const summary = await host.runLoop();

    // One backoff step is 5 s; the hold gave the second turn its input after
    // 60 ms.
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(log).toContain("worker.checkpoint.hold_ended");
    expect(captures.map((capture) => capture.kind)).toEqual([
      "turn_end",
      "turn_end",
      "before_idle_exit",
    ]);
    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  test("a capture the engine began answering a finished task during is given up, and taken again once that answer has ended", async () => {
    const { captures, gateway, host, refusals } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        // The task's end reaches the engine while the turn's capture runs.
        { type: "delay", delayMs: 30 },
        {
          type: "emit",
          message: { type: "system", subtype: "task_notification" },
        },
        { type: "delay", delayMs: 150 },
        {
          type: "emit",
          message: { ...resultMessage(SESSION_ID, 1), user_message_uuid: null },
        },
        { type: "await-input" },
      ],
      { captureMs: 90, timeouts: { idleTimeoutMs: 600 } },
    );
    gateway.enqueue("sleep 1 in the background and stop");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    // The turn's own capture held the notification without the answer.
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    expect(refusals).toEqual([
      "the engine began an answer of its own during the capture",
    ]);
    expect(captures).toEqual([
      { status: "ready", kind: "turn_end" },
      { status: "ready", kind: "between_turns" },
    ]);
    expect(
      gateway.checkpointCommits.map((call) => [
        call.turn_id,
        call.checkpoint.revision,
      ]),
    ).toEqual([["1", 0]]);
  });

  test("a capture is given up as well when that answer began and ended while it ran", async () => {
    const { captures, gateway, host, refusals } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "delay", delayMs: 30 },
        {
          type: "emit",
          message: { type: "system", subtype: "task_notification" },
        },
        { type: "delay", delayMs: 20 },
        {
          type: "emit",
          message: { ...resultMessage(SESSION_ID, 1), user_message_uuid: null },
        },
        { type: "await-input" },
      ],
      { captureMs: 150, timeouts: { idleTimeoutMs: 800 } },
    );
    gateway.enqueue("sleep 1 in the background and stop");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    expect(refusals).toHaveLength(1);
    expect(captures).toEqual([
      { status: "ready", kind: "turn_end" },
      { status: "ready", kind: "between_turns" },
    ]);
    expect(gateway.checkpointCommits.map((call) => call.turn_id)).toEqual([
      "1",
    ]);
  });

  test("the capture before an idle exit that the engine's answer cut into is taken once more when the answer has ended", async () => {
    let alive = [4243];
    const engines: EngineExitWatch = {
      descendants: async () => alive,
      commands: async () => ["sleep"],
      signal: () => {
        alive = [];
      },
      exited: async () => true,
      running: [],
      kill() {},
    };
    const { captures, gateway, host, refusals } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        // Told its work was stopped, the engine answers while the exit's
        // capture is running: the turn's own capture waits a second for the
        // process to leave, the exit follows it, and its capture runs for
        // most of the next one.
        { type: "delay", delayMs: 1_500 },
        {
          type: "emit",
          message: { type: "system", subtype: "task_notification" },
        },
        { type: "delay", delayMs: 20 },
        {
          type: "emit",
          message: { ...resultMessage(SESSION_ID, 1), user_message_uuid: null },
        },
        { type: "await-input" },
      ],
      {
        captureMs: 800,
        engines,
        outsideTurnCheckpoint: {
          idleBackgroundGraceMs: 0,
          settleWaitMs: 2_000,
        },
      },
    );
    gateway.enqueue("start a dev server and leave it");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(refusals).toHaveLength(1);
    expect(captures).toEqual([
      { status: "rejected", kind: "turn_end" },
      { status: "ready", kind: "before_idle_exit" },
      { status: "ready", kind: "before_idle_exit" },
    ]);
    expect(gateway.checkpointCommits.map((call) => call.turn_id)).toEqual([
      "1",
    ]);
  }, 15_000);

  test("a run that never says whether it is quiet fails the worker at its budget instead of holding the session", async () => {
    let finalized = false;
    const { gateway, host, log } = harness(backgroundTurn(20), {
      timeouts: { idleTimeoutMs: 5_000, startupTimeoutMs: 150 },
      wrapRun: (run) =>
        new Proxy(run, {
          get(target, key, receiver) {
            if (key === "prepareCheckpoint") {
              return (...args: Parameters<AgentRun["prepareCheckpoint"]>) =>
                finalized
                  ? new Promise<never>(() => {})
                  : target.prepareCheckpoint(...args);
            }
            const value = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const finalize = gateway.finalize.bind(gateway);
    gateway.finalize = async (request) => {
      const answer = await finalize(request);
      finalized = true;
      return answer;
    };
    gateway.enqueue("run a build in the background");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(log).toContain("worker.stage.timeout");
    expect(gateway.checkpointCommits).toEqual([]);
  }, 10_000);

  test("a server without the commit route is asked once for a turn: the debt is dropped and what was uploaded is given up", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.checkpointCommitFailure = new WorkerGatewayRequestError(
      404,
      "NOT_FOUND",
      "Not found",
      false,
    );
    const { captures, host, refusals } = harness(backgroundTurn(20), {
      gateway,
      timeouts: { idleTimeoutMs: 150 },
    });
    gateway.enqueue("run a build in the background");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(gateway.checkpointCommits).toHaveLength(1);
    expect(
      captures.filter((capture) => capture.status === "ready"),
    ).toHaveLength(1);
    expect(refusals).toHaveLength(1);
  });

  test("an answer the engine gives on its own after the turn's checkpoint is captured again", async () => {
    const { captures, gateway, host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "delay", delayMs: 40 },
        {
          type: "emit",
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
            parent_tool_use_id: null,
          },
        },
        {
          type: "emit",
          message: { ...resultMessage(SESSION_ID, 1), user_message_uuid: null },
        },
        { type: "await-input" },
      ],
      { timeouts: { idleTimeoutMs: 250 } },
    );
    gateway.enqueue("sleep 90 in the background, then say done");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(captures).toEqual([
      { status: "ready", kind: "turn_end" },
      { status: "ready", kind: "between_turns" },
    ]);
    expect(gateway.finalized[0]?.checkpoint?.revision).toBe(0);
    expect(
      gateway.checkpointCommits.map((call) => [
        call.turn_id,
        call.checkpoint.revision,
      ]),
    ).toEqual([["1", 1]]);
  });
});
