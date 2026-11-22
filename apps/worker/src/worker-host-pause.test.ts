import { describe, expect, test } from "bun:test";
import type {
  AppendEventsRequest,
  ControlIntent,
  ReleaseResponse,
} from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";
import type {
  EngineMessage,
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
  // Fast, so the heartbeat's control hint reaches an idle worker quickly.
  heartbeatIntervalMs: 5,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
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

const PAUSE: ControlIntent = {
  control_id: "0b6f7d1e-6a55-4c1e-9d59-2f7ad3a4c001",
  kind: "pause",
  target_turn_id: null,
  issued_at: "2026-09-23T00:00:00.000Z",
};

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
    checkpoints?: (gateway: FakeWorkerGateway) => WorkerCheckpointPort;
    gateway?: FakeWorkerGateway;
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
  const host = new WorkerHost({
    checkpoints: (overrides.checkpoints ?? committedOn)(gateway),
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: noWorkspace,
  });
  return { gateway, host, log, runtime };
}

describe("WorkerHost pause", () => {
  test("finishes the turn in flight, answers included, finalizes it with its checkpoint, then releases for the pause", async () => {
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
    ]);
    gateway.enqueue("first message");
    gateway.enqueue("second message, left queued by the pause");
    const loop = host.runLoop();

    await waitFor(() => gateway.questions().length === 1, "the question");
    gateway.control = PAUSE;
    await waitFor(
      () => log.includes("worker.pause.requested"),
      "the pause to reach the worker",
    );
    // Pausing still takes answers for the turn it is draining.
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_ls"),
      kind: "permission",
      decision: "allow",
    });

    const summary = await loop;

    expect(summary.outcome).toBe("paused");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(runtime.permissionDecisions).toEqual([{ behavior: "allow" }]);
    // No new input after the pause: the second message was never asked for.
    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "first message",
    ]);
    expect(gateway.finalized[0]?.checkpoint?.revision).toBe(0);
    expect(gateway.releases).toHaveLength(1);
    expect(gateway.releases[0]?.pause_control_id).toBe(PAUSE.control_id);
    // The order the pause is carried out in.
    const order = [
      log.indexOf("worker.pause.requested"),
      log.indexOf("worker.turn.finalized"),
      log.indexOf("worker.pause.committed"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(gateway.calls.indexOf("finalize")).toBeLessThan(
      gateway.calls.indexOf("release"),
    );
    expect(gateway.calls.lastIndexOf("nextInput")).toBeLessThan(
      gateway.calls.indexOf("finalize"),
    );
  });

  test("a mirror error that arrives while the pause flushes is recorded instead of releasing for the pause", async () => {
    // Events after turn 1's finalize land only once the gateway holds the
    // mirror error, so the error arrives while the pause is flushing them.
    const gateway = new (class extends FakeWorkerGateway {
      override async appendEvents(request: AppendEventsRequest) {
        if (this.finalized.length > 0) {
          for (let waited = 0; waited < 2_000; waited += 2) {
            if (this.heartbeats.some((beat) => beat.transcript?.mirror_error))
              break;
            await Bun.sleep(2);
          }
        }
        return super.appendEvents(request);
      }
    })();
    const { host, log } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(1) },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "status",
            session_id: "fake-session",
          },
        },
        { type: "delay", delayMs: 30 },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "await-input" },
      ],
      {
        checkpoints: (on) => ({
          ...committedOn(on),
          mirror: () => ({ persistedAt: null }),
        }),
        gateway,
        timeouts: { heartbeatIntervalMs: 60_000 },
      },
    );
    gateway.enqueue("first message");
    gateway.control = PAUSE;

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(log).not.toContain("worker.pause.committed");
    expect(
      gateway.heartbeats.some((beat) => beat.transcript?.mirror_error),
    ).toBe(true);
    // Released as a drain, after the error was recorded, never as a pause.
    expect(gateway.releases.map((release) => release.pause_control_id)).toEqual(
      [undefined],
    );
  });

  test("an idle worker pauses instead of timing out", async () => {
    const { gateway, host } = harness([{ type: "await-input" }], {
      timeouts: { idleTimeoutMs: 1 },
    });
    gateway.control = PAUSE;

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("paused");
    expect(gateway.releases.map((release) => release.pause_control_id)).toEqual(
      [PAUSE.control_id],
    );
  });

  describe("a pause release whose answer is lost", () => {
    const lostAnswer = () =>
      new WorkerGatewayRequestError(0, null, "POST /release timed out", true);
    const revoked = () =>
      new WorkerGatewayRequestError(
        401,
        "UNAUTHORIZED",
        "Worker token is missing, expired or revoked",
        false,
      );

    // The first try commits and `answer` decides what the worker hears of
    // it; `retry` answers every later try, by default as the credential the
    // commit revoked does.
    function commitsFirst(
      gateway: FakeWorkerGateway,
      answer: () => Promise<void>,
      retry: () => Promise<ReleaseResponse> = async () => {
        throw revoked();
      },
    ): void {
      const release = gateway.release.bind(gateway);
      let committed = false;
      gateway.release = async (request) => {
        if (committed) return retry();
        const response = await release(request);
        committed = true;
        await answer();
        return response;
      };
    }

    test("ends paused when the retry is refused for the credential the commit revoked", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      commitsFirst(gateway, async () => {
        throw lostAnswer();
      });
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
      expect(log).toContain("worker.pause.committed");
      expect(log).not.toContain("worker.ownership.lost");
      // Both tries answer the pause; nothing gives the session back again.
      expect(
        gateway.releases.map((release) => release.pause_control_id),
      ).toEqual([PAUSE.control_id]);
    });

    // UNAUTHORIZED for a beat sent after the commit; STALE_EPOCH for one
    // that authenticated before it and waited on the fence.
    test.each(["UNAUTHORIZED", "STALE_EPOCH"] as const)(
      "ends paused when a heartbeat is refused with %s while the release is still unanswered",
      async (code) => {
        const { gateway, host, log } = harness([{ type: "await-input" }], {
          timeouts: { idleTimeoutMs: 1 },
        });
        commitsFirst(gateway, () => {
          gateway.heartbeatFailure = code;
          return new Promise<void>(() => {});
        });
        gateway.control = PAUSE;

        const summary = await host.runLoop();

        expect(summary.outcome).toBe("paused");
        expect(log).not.toContain("worker.ownership.lost");
        expect(gateway.releases).toHaveLength(1);
      },
    );

    // A retry that authenticated before the first try committed waits on
    // its fence and finds the epoch moved on.
    test("ends paused when the retry answers the binding superseded", async () => {
      const { gateway, host } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      commitsFirst(
        gateway,
        async () => {
          throw lostAnswer();
        },
        async () => ({ released: false }),
      );
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
    });

    test("stays paused when a heartbeat refusal is read first and the retry answers superseded after it", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      commitsFirst(
        gateway,
        async () => {
          throw lostAnswer();
        },
        async () => {
          gateway.heartbeatFailure = "STALE_EPOCH";
          await waitFor(
            () => log.includes("worker.pause.committed"),
            "the heartbeat's refusal",
          );
          return { released: false };
        },
      );
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
      expect(log).not.toContain("worker.ownership.lost");
    });

    // The commit's own stop intent is what brings the SIGTERM.
    test("a drain while the release is unanswered still ends paused when a heartbeat is refused", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      commitsFirst(gateway, async () => {
        host.drain("received SIGTERM");
        gateway.heartbeatFailure = "UNAUTHORIZED";
        throw lostAnswer();
      });
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
      expect(log).not.toContain("worker.failed");
      expect(gateway.releases).toHaveLength(1);
    });

    test("a drain that gives up on the unanswered release ends paused when the final release is refused", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      commitsFirst(gateway, async () => {
        host.drain("received SIGTERM");
        throw lostAnswer();
      });
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
      expect(log).not.toContain("worker.failed");
    });

    test("a drain that gives up on a release that did not commit ends drained", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      const release = gateway.release.bind(gateway);
      let tries = 0;
      gateway.release = async (request) => {
        tries += 1;
        if (tries === 1) {
          host.drain("received SIGTERM");
          throw lostAnswer();
        }
        return release(request);
      };
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("drained");
      expect(log).not.toContain("worker.failed");
      expect(gateway.releases.map((r) => r.pause_control_id)).toEqual([
        undefined,
      ]);
    });

    test("a retry of a release that did not commit goes through as before", async () => {
      const { gateway, host } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      const release = gateway.release.bind(gateway);
      let tries = 0;
      gateway.release = async (request) => {
        tries += 1;
        if (tries === 1) throw lostAnswer();
        return release(request);
      };
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("paused");
      expect(tries).toBe(2);
    });

    test("a release refused before any try went unanswered is a lease loss", async () => {
      const { gateway, host, log } = harness([{ type: "await-input" }], {
        timeouts: { idleTimeoutMs: 1 },
      });
      gateway.release = async () => {
        throw revoked();
      };
      gateway.control = PAUSE;

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("lease_lost");
      expect(log).not.toContain("worker.pause.committed");
    });
  });

  test("a refused pause keeps the lease and the engine, asking again, until something else stops the worker", async () => {
    const { gateway, host, log } = harness([
      { type: "await-input" },
      { type: "emit", message: resultMessage(1) },
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

    await waitFor(() => log.includes("worker.pause.blocked"), "the refusal");
    const beats = gateway.heartbeats.length;
    await waitFor(
      () => gateway.heartbeats.length > beats + 2,
      "heartbeats while held",
    );
    // Held, the release is asked again each interval: that is how
    // the worker learns a resume cancelled the pause.
    await waitFor(() => gateway.releases.length > 2, "the release asked again");
    expect(log).not.toContain("worker.released");
    expect(
      log.filter((event) => event === "worker.pause.blocked"),
    ).toHaveLength(1);

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    // The held attempt still gives the session back when it does go, without
    // claiming the pause it could not commit.
    const ids = gateway.releases.map((release) => release.pause_control_id);
    expect(ids.at(-1)).toBeUndefined();
    expect(ids.slice(0, -1).every((id) => id === PAUSE.control_id)).toBe(true);
  });
});
