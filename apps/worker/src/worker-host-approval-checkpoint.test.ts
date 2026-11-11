import { describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  type SessionEvent,
  sessionEventSchema,
} from "@werft-ai/contracts";
import {
  type AgentInput,
  approvalInputHash,
  type RuntimeEvent,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { ScriptedRun } from "./testing/scripted-run.ts";
import { WorkerHost } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

const REF: CheckpointRef = {
  revision: 0,
  manifest_ref: "checkpoints/0/approval.json",
  manifest_sha256: "a".repeat(64),
};

/** A run that takes approval-wait checkpoints, and is ready to. */
function checkpointingRun(): ScriptedRun {
  const run = new ScriptedRun();
  run.capabilities = {
    ...run.capabilities,
    effective: { ...run.capabilities.effective, approvalCheckpoint: true },
  };
  run.approvalWait = {
    status: "ready",
    checkpoint: { engine: "scripted", resume: "s-1", sdkVersion: "0" },
  };
  return run;
}

function host(
  run: ScriptedRun,
  capture: WorkerCheckpointPort["capture"],
  approvalCheckpointMs?: number,
) {
  const gateway = new FakeWorkerGateway();
  const log: string[] = [];
  const worker = new WorkerHost({
    checkpoints: { restorePlan: async () => ({ mode: "new" }), capture },
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: {
      info: (event) => log.push(event),
      warn: (event) => log.push(event),
      error: (event) => log.push(event),
    },
    runtimes: { launcherFor: () => ({ start: () => run }) },
    timeouts,
    workspace: noWorkspace,
    ...(approvalCheckpointMs === undefined ? {} : { approvalCheckpointMs }),
  });
  return { gateway, log, worker };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2_000) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function ask(run: ScriptedRun, sent: AgentInput, id: string): void {
  const input = { command: `run ${id}` };
  run.push(
    {
      type: "public",
      event: sessionEventSchema.parse({
        id,
        event: "system",
        data: { type: "system", subtype: "tool_call", call: id },
      }) as SessionEvent,
      inputs: [sent.uuid],
    },
    { type: "tool.called", toolCallId: id, tool: "shell" },
    {
      type: "approval.requested",
      request: {
        localId: `local-${id}`,
        toolCallId: id,
        tool: { name: "shell", input },
        inputHash: approvalInputHash("shell", input),
        askedAt: performance.now(),
        kind: "permission",
        display: input,
      },
    },
  );
}

function finish(run: ScriptedRun, sent: AgentInput): void {
  run.push({
    type: "turn.ended",
    turn: {
      isError: false,
      abortedByStop: false,
      budgetExceeded: false,
      engineResult: { outcome: "done" },
      cost: { countRestarted: false, unknown: true },
      inputs: [sent.uuid],
    },
  } satisfies RuntimeEvent);
}

/** Starts a turn that asks once, and returns once the request is registered. */
async function waiting(
  run: ScriptedRun,
  gateway: FakeWorkerGateway,
  worker: WorkerHost,
  registrations = 1,
) {
  let sent: AgentInput | undefined;
  run.onSend = (input) => {
    sent = input;
    ask(run, input, "c1");
  };
  gateway.enqueue("go");
  const loop = worker.runLoop();
  await until(
    () => gateway.registrations.length === registrations,
    "the registration",
  );
  const end = async () => {
    if (sent !== undefined) finish(run, sent);
    await loop;
  };
  return { end };
}

describe("WorkerHost approval-wait checkpoints", () => {
  test("registers the request with the checkpoint, then voids it before the next tool starts", async () => {
    const run = checkpointingRun();
    const { gateway, worker } = host(run, async () => REF);
    const { end } = await waiting(run, gateway, worker);

    expect(gateway.registrations[0]?.checkpoint).toEqual({
      ...REF,
      answers_through: 0,
    });
    await until(() => run.heldApprovalLeases === 0, "the lease release");
    expect(run.admissionGuard).toBeDefined();
    expect(gateway.invalidations).toEqual([]);

    expect(await run.admit("c2")).toBe(true);
    expect(gateway.invalidations.map((entry) => entry.manifest_ref)).toEqual([
      REF.manifest_ref,
    ]);
    // Void once: later admissions pass straight through.
    expect(run.admissionGuard).toBeUndefined();
    await end();
  });

  test("refuses the next tool when the checkpoint cannot be voided", async () => {
    const run = checkpointingRun();
    const { gateway, worker } = host(run, async () => REF);
    const { end } = await waiting(run, gateway, worker);
    await until(() => run.admissionGuard !== undefined, "the guard");
    gateway.invalidationFailure = new Error("connection reset");

    expect(await run.admit("c2")).toBe(false);
    expect(run.admissionGuard).toBeDefined();

    gateway.invalidationFailure = undefined;
    expect(await run.admit("c2")).toBe(true);
    expect(gateway.invalidations).toHaveLength(1);
    await end();
  });

  test("registers without a checkpoint when the capture runs past the deadline", async () => {
    const run = checkpointingRun();
    const { gateway, log, worker } = host(run, () => new Promise(() => {}), 20);
    const { end } = await waiting(run, gateway, worker);

    expect(gateway.registrations[0]?.checkpoint).toBeUndefined();
    expect(run.heldApprovalLeases).toBe(0);
    expect(run.admissionGuard).toBeUndefined();
    expect(log).toContain("worker.approval_checkpoint.skipped");
    await end();
  });

  test("registers again without the checkpoint when the gateway refuses it", async () => {
    const run = checkpointingRun();
    const { gateway, worker } = host(run, async () => REF);
    gateway.registerFailures.push(
      new WorkerGatewayRequestError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        "manifest missing",
        false,
      ),
    );
    const { end } = await waiting(run, gateway, worker, 2);

    expect(gateway.registrations.map((entry) => entry.checkpoint)).toEqual([
      { ...REF, answers_through: 0 },
      undefined,
    ]);
    await until(() => run.heldApprovalLeases === 0, "the lease release");
    // Nothing committed it, so nothing guards the next tool.
    expect(run.admissionGuard).toBeUndefined();
    await end();
  });

  test("takes no checkpoint for a run that does not negotiate them", async () => {
    const run = checkpointingRun();
    run.capabilities = {
      ...run.capabilities,
      effective: { ...run.capabilities.effective, approvalCheckpoint: false },
    };
    let captures = 0;
    const { gateway, worker } = host(run, async () => {
      captures += 1;
      return REF;
    });
    const { end } = await waiting(run, gateway, worker);

    expect(gateway.registrations[0]?.checkpoint).toBeUndefined();
    expect(captures).toBe(0);
    await end();
  });
});
