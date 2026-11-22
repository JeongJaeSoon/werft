import { describe, expect, test } from "bun:test";
import type { ControlIntent } from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedRuntimeOptions,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { noWorkspace } from "./testing/no-workspace.ts";
import { scriptedRuntime, startScripted } from "./testing/scripted-engine.ts";
import { waitFor } from "./testing/wait-for.ts";
import {
  inputUuid,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 5,
  idleTimeoutMs: 80,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

const RESTORE = {
  revision: 4,
  manifest_ref: "checkpoints/4.json",
  manifest_sha256: "a".repeat(64),
};

// Every turn's capture commits at the pointer's next revision, so finalize
// always carries a checkpoint the fake gateway accepts.
function committedOn(gateway: FakeWorkerGateway): WorkerCheckpointPort {
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation) => {
      if (preparation.status !== "ready") return null;
      const revision = (gateway.checkpointRevision ?? -1) + 1;
      return {
        revision,
        manifest_ref: `checkpoints/${revision}.json`,
        manifest_sha256: "a".repeat(64),
      };
    },
  };
}

// The claim's checkpoint restored as the engine session it names, from this
// container's disk unless a restore says which revision it loaded.
function resumedOn(
  gateway: FakeWorkerGateway,
  restoredRevision?: number,
): WorkerCheckpointPort {
  return {
    ...committedOn(gateway),
    restorePlan: async () => ({
      mode: "resume",
      resume: "fake-session",
      ...(restoredRevision === undefined
        ? { localTranscriptResume: true }
        : { restoredRevision }),
    }),
  };
}

function restoredGateway(): FakeWorkerGateway {
  const gateway = new FakeWorkerGateway({ restore: RESTORE });
  gateway.checkpointRevision = RESTORE.revision;
  return gateway;
}

const PAUSE: ControlIntent = {
  control_id: "0b6f7d1e-6a55-4c1e-9d59-2f7ad3a4c001",
  kind: "pause",
  target_turn_id: null,
  issued_at: "2026-09-23T00:00:00.000Z",
};

const stale = () =>
  new WorkerGatewayRequestError(
    409,
    "REQUEST_STALE",
    "The pause this release answers is no longer the session's open one",
    false,
  );

function resultMessage(turn: number): EngineMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    usage: { input_tokens: 3 },
    user_message_uuid: inputUuid(SESSION_ID, String(turn), `msg-${turn}`),
  };
}

function harness(
  steps: ScriptedStep[],
  overrides: {
    checkpoints?: WorkerCheckpointPort;
    gateway?: FakeWorkerGateway;
    runtime?: ScriptedRuntimeOptions;
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = scriptedRuntime(steps, overrides.runtime);
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
  const host = new WorkerHost({
    checkpoints: overrides.checkpoints ?? committedOn(gateway),
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger,
    runtimes,
    timeouts,
    workspace: noWorkspace,
  });
  return { gateway, host, log, runtime };
}

describe("WorkerHost ready report", () => {
  test("reports ready with the restored revision before it asks for any input", async () => {
    const gateway = restoredGateway();
    const { host } = harness(
      [{ type: "await-input" }, { type: "emit", message: resultMessage(1) }],
      { checkpoints: resumedOn(gateway), gateway },
    );
    gateway.enqueue("what did we decide yesterday?");

    const loop = host.runLoop();
    await waitFor(() => gateway.finalized.length === 1, "the first turn");
    host.drain("received SIGTERM");
    await loop;

    expect(gateway.readies).toHaveLength(1);
    expect(gateway.readies[0]?.restored_revision).toBe(4);
    expect(gateway.calls.indexOf("ready")).toBeGreaterThanOrEqual(0);
    expect(gateway.calls.indexOf("ready")).toBeLessThan(
      gateway.calls.indexOf("nextInput"),
    );
  });

  test("a restore reports the revision it loaded, not the claim's pointer", async () => {
    const gateway = restoredGateway();
    const { host } = harness(
      [{ type: "await-input" }, { type: "emit", message: resultMessage(1) }],
      { checkpoints: resumedOn(gateway, 3), gateway },
    );
    gateway.enqueue("pick up where we left off");

    const loop = host.runLoop();
    await waitFor(() => gateway.finalized.length === 1, "the first turn");
    host.drain("received SIGTERM");
    await loop;

    expect(gateway.readies.map((ready) => ready.restored_revision)).toEqual([
      3,
    ]);
  });

  test("a claim with nothing to restore sends no report and takes input", async () => {
    const { gateway, host } = harness([{ type: "await-input" }]);
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "the first poll");
    host.drain("received SIGTERM");
    await loop;

    expect(gateway.readies).toEqual([]);
    expect(gateway.calls).not.toContain("ready");
  });

  test("a plan that started a fresh engine for a claimed checkpoint reports no restored revision", async () => {
    const gateway = restoredGateway();
    gateway.readyFailure = new WorkerGatewayRequestError(
      409,
      "CHECKPOINT_UNAVAILABLE",
      "The session was not resumed onto the checkpoint this worker restored; the resume failed",
      false,
    );
    // `committedOn` answers every restore with a new engine.
    const { host, runtime } = harness([{ type: "await-input" }], { gateway });
    gateway.enqueue("never delivered");

    const summary = await host.runLoop();

    expect(gateway.readies.map((ready) => ready.restored_revision)).toEqual([
      null,
    ]);
    expect(summary.outcome).toBe("failed");
    expect(runtime.inputs).toEqual([]);
  });

  test("an engine that cannot load the resumed transcript fails the worker before ready or any input", async () => {
    const gateway = restoredGateway();
    const { host, runtime } = harness([{ type: "await-input" }], {
      checkpoints: resumedOn(gateway),
      gateway,
      runtime: {
        resumeFailure: "The resumed transcript for session x could not be read",
      },
    });
    gateway.enqueue("never delivered");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("could not be read");
    expect(gateway.readies).toEqual([]);
    expect(gateway.calls).not.toContain("nextInput");
    expect(runtime.inputs).toEqual([]);
    // It still gives the session back, so the exit settles the resume.
    expect(gateway.releases).toHaveLength(1);
  });

  test("a resume the gateway refuses at ready fails the worker without taking input", async () => {
    const gateway = restoredGateway();
    gateway.readyFailure = new WorkerGatewayRequestError(
      409,
      "CHECKPOINT_UNAVAILABLE",
      "The session was not resumed onto the checkpoint this worker restored; the resume failed",
      false,
    );
    const { host, runtime } = harness([{ type: "await-input" }], {
      checkpoints: resumedOn(gateway),
      gateway,
    });
    gateway.enqueue("never delivered");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(gateway.calls).not.toContain("nextInput");
    expect(runtime.inputs).toEqual([]);
  });
});

describe("WorkerHost pause withdrawn by a resume", () => {
  test("a held worker whose pause was cancelled goes back to its input loop on the same engine", async () => {
    const { gateway, host, log, runtime } = harness([
      { type: "await-input" },
      { type: "emit", message: resultMessage(1) },
      { type: "await-input" },
      { type: "emit", message: resultMessage(2) },
      { type: "await-input" },
    ]);
    gateway.pauseRefusal = new WorkerGatewayRequestError(
      409,
      "CHECKPOINT_UNAVAILABLE",
      "The pause cannot commit yet (checkpoint_unavailable); keep the lease",
      false,
    );
    gateway.enqueue("first message");
    gateway.control = PAUSE;
    const loop = host.runLoop();

    await waitFor(() => log.includes("worker.pause.blocked"), "the hold");
    // The resume cancelled it: the pause is no longer handed out, and the
    // release that answers it is refused as stale.
    gateway.control = null;
    gateway.pauseRefusal = stale();
    gateway.enqueue("second message, after the cancel");

    await waitFor(() => gateway.finalized.length === 2, "the second turn");
    host.drain("received SIGTERM");
    const summary = await loop;

    expect(log).toContain("worker.pause.withdrawn");
    expect(summary.outcome).toBe("drained");
    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    // One engine, each input once: nothing was restarted.
    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "first message",
      "second message, after the cancel",
    ]);
    expect(gateway.releases.at(-1)?.pause_control_id).toBeUndefined();
    expect(log).not.toContain("worker.pause.committed");
  });

  test("a pause cancelled while its turn ran lets that turn finish once and takes the next input", async () => {
    const { gateway, host, log, runtime } = harness([
      { type: "await-input" },
      {
        type: "permissions",
        requests: [
          {
            input: { command: "ls" },
            requestId: "req-ls",
            tool: "Bash",
            toolUseId: "toolu_ls",
          },
        ],
      },
      { type: "emit", message: resultMessage(1) },
      { type: "await-input" },
      { type: "emit", message: resultMessage(2) },
      { type: "await-input" },
    ]);
    gateway.enqueue("first message");
    const loop = host.runLoop();

    await waitFor(() => gateway.questions().length === 1, "the question");
    gateway.control = PAUSE;
    await waitFor(
      () => log.includes("worker.pause.requested"),
      "the pause to reach the worker",
    );
    gateway.control = null;
    gateway.pauseRefusal = stale();
    gateway.enqueue("second message");
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_ls"),
      kind: "permission",
      decision: "allow",
    });

    await waitFor(() => gateway.finalized.length === 2, "the second turn");
    host.drain("received SIGTERM");
    await loop;

    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "first message",
      "second message",
    ]);
    expect(gateway.finalized.map((done) => done.turn_id)).toEqual(["1", "2"]);
    const pauseReleases = gateway.releases.filter(
      (release) => release.pause_control_id === PAUSE.control_id,
    );
    expect(pauseReleases).toHaveLength(1);
    expect(log).toContain("worker.pause.withdrawn");
  });
});
