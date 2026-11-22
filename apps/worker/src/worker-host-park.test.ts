import { describe, expect, test } from "bun:test";
import type { ControlIntent } from "@werft-ai/contracts";
import {
  approvalInputHash,
  type WorkerCheckpointState,
} from "@werft-ai/runtime-core";
import type { ScriptedStep } from "@werft-ai/runtime-core/testing";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { noWorkspace } from "./testing/no-workspace.ts";
import { scriptedRuntime, startScripted } from "./testing/scripted-engine.ts";
import { resultMessage } from "./testing/sdk-messages.ts";
import { waitFor } from "./testing/wait-for.ts";
import {
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 2_000,
  heartbeatIntervalMs: 5,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 30_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

const PARK: ControlIntent = {
  control_id: "0b6f7d1e-6a55-4c1e-9d59-2f7ad3a4c0aa",
  kind: "park",
  target_turn_id: null,
  issued_at: "2026-10-27T00:00:00.000Z",
};

const BASH_LS = {
  input: { command: "ls --token=s3cret" },
  requestId: "sdk-ls",
  tool: "Bash",
  toolUseId: "toolu_ls",
};

/** Commits every ready capture, and keeps the worker state each was given. */
function committedOn(
  gateway: FakeWorkerGateway,
  captured: Array<WorkerCheckpointState | undefined>,
  parkBlocked?: string,
): WorkerCheckpointPort {
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation, context) => {
      if (preparation.status !== "ready") return null;
      captured.push(context.workerState);
      const revision = (gateway.checkpointRevision ?? -1) + 1;
      return {
        revision,
        manifest_ref: `checkpoints/${revision}.json`,
        manifest_sha256: "a".repeat(64),
      };
    },
    parkBlocked: async () => parkBlocked,
  };
}

function harness(
  steps: ScriptedStep[],
  overrides: {
    gateway?: FakeWorkerGateway;
    parkBlocked?: string;
    timeouts?: Partial<WorkerTimeouts>;
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
      start: (launch) => startScripted(runtime, launch),
    }),
  };
  const captured: Array<WorkerCheckpointState | undefined> = [];
  const host = new WorkerHost({
    checkpoints: committedOn(gateway, captured, overrides.parkBlocked),
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: noWorkspace,
  });
  return { captured, gateway, host, log, runtime };
}

/** One turn that asks for BASH_LS, then would finish if let through. */
function askingTurn(): ScriptedStep[] {
  return [
    { type: "await-input" },
    { type: "permissions", requests: [BASH_LS] },
    { type: "emit", message: resultMessage(SESSION_ID, 1) },
    { type: "await-input" },
  ];
}

const registered = (gateway: FakeWorkerGateway) =>
  gateway.registrations.length === 1 &&
  gateway.calls.lastIndexOf("pendingControl") >
    gateway.calls.indexOf("registerPending");

describe("WorkerHost park", () => {
  test("a drain parks a turn that waits only on a person: interrupted with its checkpoint, the request left open, its arguments kept unredacted", async () => {
    const { captured, gateway, host, log, runtime } = harness(askingTurn());
    gateway.enqueue("run ls");
    const loop = host.runLoop();
    await waitFor(() => registered(gateway), "the request to register");

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "interrupted", reason: "input_wait_parked" },
    ]);
    // The engine was told to stop, not that a person refused.
    expect(runtime.permissionDecisions).toEqual([
      {
        behavior: "deny",
        message: "The approval was set aside for a later turn",
        interrupt: true,
      },
    ]);
    expect(gateway.finalized[0]?.checkpoint).not.toBeNull();
    const requestId = gateway.registrations[0]?.request_id ?? "";
    expect(captured).toEqual([
      {
        pendingApprovals: [
          {
            input: BASH_LS.input,
            inputHash: approvalInputHash("Bash", BASH_LS.input),
            kind: "permission",
            requestId,
            tool: "Bash",
            toolCallId: "toolu_ls",
          },
        ],
      },
    ]);
    // Settling it would close the row the finalize parks.
    expect(gateway.settled).toEqual([]);
    expect(gateway.releases.map((release) => release.stop_kind)).toEqual([
      "drain",
    ]);
    expect(log).toContain("worker.turn.parking");
  });

  test("a drain applies an answer already given before it judges the turn, and lets the turn finish", async () => {
    const { gateway, host, log, runtime } = harness(askingTurn(), {
      timeouts: { answerPollIntervalMs: 60_000 },
    });
    gateway.enqueue("run ls");
    const loop = host.runLoop();
    // No regular poll comes in time: only the drain's own one can read it.
    await waitFor(
      () => gateway.registrations.length === 1,
      "the request to register",
    );
    gateway.answer({
      request_id: gateway.registrations[0]?.request_id ?? "",
      kind: "permission",
      decision: "allow",
    });

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(runtime.permissionDecisions).toEqual([{ behavior: "allow" }]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(log).not.toContain("worker.turn.parking");
  });

  test("a drain whose turn could leave no checkpoint denies the wait as before", async () => {
    const { gateway, host, log, runtime } = harness(askingTurn(), {
      parkBlocked: "the transcript is over its limit",
    });
    gateway.enqueue("run ls");
    const loop = host.runLoop();
    await waitFor(() => registered(gateway), "the request to register");

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(log).toContain("worker.park.unavailable");
    expect(log).not.toContain("worker.turn.parking");
    expect(runtime.permissionDecisions).toEqual([
      { behavior: "deny", message: "This worker is shutting down" },
    ]);
    expect(summary.turns[0]?.reason).not.toBe("input_wait_parked");
    expect(gateway.settled.map((settled) => settled.outcome)).toEqual([
      "cancelled",
    ]);
  });

  test("a park control cuts the turn, finalizes it parked and releases for the control", async () => {
    const { captured, gateway, host, runtime } = harness(askingTurn());
    gateway.enqueue("run ls");
    gateway.enqueue("left queued by the park");
    const loop = host.runLoop();
    await waitFor(() => registered(gateway), "the request to register");

    gateway.control = PARK;
    const summary = await loop;

    expect(summary.outcome).toBe("paused");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "interrupted", reason: "input_wait_parked" },
    ]);
    expect(runtime.permissionDecisions[0]).toMatchObject({ interrupt: true });
    expect(captured[0]?.pendingApprovals).toHaveLength(1);
    expect(gateway.releases.map((release) => release.pause_control_id)).toEqual(
      [PARK.control_id],
    );
    expect(gateway.parkDeclines).toEqual([]);
    expect(runtime.inputs.map((input) => input.message)).toEqual(["run ls"]);
  });

  test("a park that comes with an answer is declined before the turn is touched, and the turn goes on", async () => {
    const { gateway, host, runtime } = harness(askingTurn());
    gateway.enqueue("run ls");
    const loop = host.runLoop();
    await waitFor(() => registered(gateway), "the request to register");

    // One poll brings both: the answer is applied first.
    gateway.answer({
      request_id: gateway.registrations[0]?.request_id ?? "",
      kind: "permission",
      decision: "allow",
    });
    gateway.control = PARK;
    await waitFor(() => gateway.parkDeclines.length === 1, "the decline");
    host.drain("test over");
    const summary = await loop;

    expect(gateway.parkDeclines[0]).toMatchObject({
      pause_control_id: PARK.control_id,
      reason: "answer_applied",
    });
    expect(runtime.permissionDecisions).toEqual([{ behavior: "allow" }]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
  });

  test("a park that could leave no checkpoint is declined and the request keeps waiting", async () => {
    const { gateway, host, runtime } = harness(askingTurn(), {
      parkBlocked: "the transcript is over its limit",
    });
    gateway.enqueue("run ls");
    const loop = host.runLoop();
    await waitFor(() => registered(gateway), "the request to register");

    gateway.control = PARK;
    await waitFor(() => gateway.parkDeclines.length === 1, "the decline");

    expect(gateway.parkDeclines[0]?.reason).toBe("checkpoint_unavailable");
    expect(runtime.permissionDecisions).toEqual([]);
    gateway.answer({
      request_id: gateway.registrations[0]?.request_id ?? "",
      kind: "permission",
      decision: "allow",
    });
    await waitFor(
      () => runtime.permissionDecisions.length === 1,
      "the answer to land",
    );
    host.drain("test over");
    await loop;
    expect(runtime.permissionDecisions).toEqual([{ behavior: "allow" }]);
  });

  test("a grant answers the first matching call once; a second is asked again, and what is left is reported unused", async () => {
    const gateway = new FakeWorkerGateway();
    const hash = approvalInputHash("Bash", BASH_LS.input);
    gateway.grants = [
      {
        request_id: "req_parked_ls",
        turn_id: "1",
        tool: "Bash",
        input_hash: hash,
      },
      {
        request_id: "req_parked_rm",
        turn_id: "1",
        tool: "Bash",
        input_hash: approvalInputHash("Bash", { command: "rm -rf out" }),
      },
    ];
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "permissions", requests: [BASH_LS] },
        {
          type: "permissions",
          requests: [
            { ...BASH_LS, requestId: "sdk-ls-2", toolUseId: "toolu_2" },
          ],
        },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("resume with what was answered");
    const loop = host.runLoop();
    await waitFor(() => gateway.registrations.length === 1, "the second ask");
    gateway.answer({
      request_id: gateway.registrations[0]?.request_id ?? "",
      kind: "permission",
      decision: "deny",
    });
    const summary = await loop;

    expect(runtime.permissionDecisions).toEqual([
      { behavior: "allow" },
      {
        behavior: "deny",
        message: "The user denied this request without giving a reason.",
      },
    ]);
    expect(gateway.registrations[0]?.request.kind).toBe("permission");
    expect(summary.turns[0]?.status).toBe("completed");
    expect(gateway.delivered).toEqual([
      { request_id: "req_parked_ls", outcome: "grant_consumed" },
      { request_id: "req_parked_rm", outcome: "grant_unused" },
    ]);
  });

  test("a call whose arguments changed is asked again, and the grant is left unused", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.grants = [
      {
        request_id: "req_parked_ls",
        turn_id: "1",
        tool: "Bash",
        input_hash: approvalInputHash("Bash", BASH_LS.input),
      },
    ];
    const changed = {
      ...BASH_LS,
      input: { command: "ls -la" },
      requestId: "sdk-ls-changed",
      toolUseId: "toolu_changed",
    };
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "permissions", requests: [changed] },
        { type: "emit", message: resultMessage(SESSION_ID, 1) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("resume with what was answered");
    const loop = host.runLoop();
    await waitFor(() => gateway.registrations.length === 1, "the new ask");
    gateway.answer({
      request_id: gateway.registrations[0]?.request_id ?? "",
      kind: "permission",
      decision: "deny",
    });
    const summary = await loop;

    expect(runtime.permissionDecisions).toEqual([
      {
        behavior: "deny",
        message: "The user denied this request without giving a reason.",
      },
    ]);
    expect(summary.turns[0]?.status).toBe("completed");
    expect(gateway.delivered).toEqual([
      { request_id: "req_parked_ls", outcome: "grant_unused" },
    ]);
  });
});
