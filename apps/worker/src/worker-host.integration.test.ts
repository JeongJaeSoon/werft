import { afterEach, describe, expect, test } from "bun:test";
import type { CheckpointRef, RuntimeConfig } from "@werft-ai/contracts";
import type {
  CheckpointPreparation,
  RuntimeProcessObserver,
} from "@werft-ai/runtime-core";
import { realRuntimeFor } from "@werft-ai/runtime-registry/testing";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";

import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import { runtimeStart } from "./composition.ts";
import type { WorkerTimeouts } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { waitFor as pollFor } from "./testing/wait-for.ts";
import {
  inputUuid,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const MODEL = "claude-sonnet-4-5";

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 50,
  claimTimeoutMs: 5_000,
  drainTimeoutMs: 5_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
};

/**
 * Stands in for CheckpointService: it records the engine handle a
 * finished turn could be resumed from, and hands back the plan the next
 * process should open with. It commits nothing, because a finalize carrying a
 * checkpoint is still refused.
 */
class RecordingCheckpoints implements WorkerCheckpointPort {
  resumeHandle: string | undefined;
  readonly preparations: CheckpointPreparation[] = [];

  constructor(private readonly plan: RuntimeResumePlan) {}

  async restorePlan(): Promise<RuntimeResumePlan> {
    return this.plan;
  }

  async capture(preparation: CheckpointPreparation): Promise<null> {
    this.preparations.push(preparation);
    if (preparation.status === "ready") {
      this.resumeHandle = preparation.checkpoint.resume;
    }
    return null;
  }
}

/** The installed runtime, launched the way composition launches it. */
function sdkRuntimes(
  endpoint: string,
  home: string,
  workspace: string,
  processes: RuntimeProcessObserver,
): RuntimeRegistry {
  const module = realRuntimeFor("claude_agent_sdk");
  const runtime = module.createRuntime({
    processObserver: processes,
    stateDir: home,
  });
  // The fake server stands in for the proxy's route too.
  const host = {
    egressCredentialUrl: endpoint.replace(/\/$/, ""),
    runtime: {
      claudeConfigDir: home,
      cwd: workspace,
      home,
      providerMaxRetries: 0,
    },
  };
  return {
    launcherFor: () => ({
      // What to run comes from the claim, as in composition.
      start: (launch) => runtime.start(runtimeStart(host, module, launch)),
    }),
  };
}

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

describe("WorkerHost against the actual Claude SDK", () => {
  test("carries a session across two turns and resumes it in a new process", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-122-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`turn-${index + 1}`),
    );
    const spawned: number[] = [];
    const exited: number[] = [];
    const trail: string[] = [];
    const recording: WorkerLogger = {
      info: (event) => trail.push(event),
      warn: (event) => trail.push(event),
      error: (event) => trail.push(event),
    };
    // What composition wires: the host confirms the PID is gone from this.
    const engines = new EngineProcesses();
    const registry = (): RuntimeRegistry =>
      sdkRuntimes(server?.url ?? "", home, workspace, {
        onSpawn: (pid) => {
          spawned.push(pid);
          engines.onSpawn(pid);
        },
        onExit: (pid) => {
          exited.push(pid);
          engines.onExit(pid);
        },
      });

    const runtimeConfig: RuntimeConfig = {
      model: MODEL,
      tools: [],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "egress_token", token: "placeholder-local" },
      },
    };

    // First process: claim, two turns, release.
    const firstGateway = new FakeWorkerGateway({
      runtimeConfig,
      sessionId: SESSION_ID,
    });
    const firstCheckpoints = new RecordingCheckpoints({ mode: "new" });
    firstGateway.enqueue("first turn");
    firstGateway.enqueue("second turn");
    const first = new WorkerHost({
      checkpoints: firstCheckpoints,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      engines,
      gateway: firstGateway,
      logger: recording,
      runtimes: registry(),
      timeouts,
      // The scratch directory is no checkout; preparing one is workspace.test.ts's.
      workspace: noWorkspace,
    });

    const firstSummary = await first.runLoop();

    expect(firstSummary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(server.requests).toHaveLength(2);
    // One engine process served both turns.
    expect(spawned).toHaveLength(1);
    // Every input carried the uuid derived from the delivery it came from.
    const sent = firstGateway.events
      .filter((event) => event.event === "result")
      .map((event) => event.data);
    expect(sent).toHaveLength(2);
    // Each turn's events from its input's queued lifecycle to its result; the
    // input's completed lifecycle comes after the terminal, under no turn.
    const turnOf = new Map(
      firstGateway.batches.flatMap((batch) =>
        batch.events.map((event) => [event.source_sequence, batch.turn_id]),
      ),
    );
    expect(
      firstGateway.events.map((event) => turnOf.get(event.source_sequence)),
    ).toEqual(["1", "1", "1", "1", "1", null, "2", "2", "2", "2", "2", null]);
    expect(firstGateway.finalized.map((call) => call.finalize_key)).toEqual([
      "att_fake:1",
      "att_fake:2",
    ]);
    expect(inputUuid(SESSION_ID, "1", "msg-1")).not.toBe(
      inputUuid(SESSION_ID, "2", "msg-2"),
    );
    expect(firstGateway.releases).toHaveLength(1);
    // The host did not leave until it saw the engine's PID exit.
    expect(exited).toEqual(spawned);
    expect(trail).toContain("worker.engine.exited");
    expect(trail.indexOf("worker.engine.exited")).toBeLessThan(
      trail.indexOf("worker.released"),
    );

    // The engine session the next process has to continue.
    const resume = firstCheckpoints.resumeHandle;
    expect(resume).toBeString();
    if (resume === undefined) throw new Error("No engine session was captured");

    // Second process: a fresh host, opening the same engine session.
    const secondGateway = new FakeWorkerGateway({
      runtimeConfig,
      sessionId: SESSION_ID,
      attemptId: "att_fake_2",
      // Turn numbering is session-scoped, so a new process continues it; a
      // repeat of turn 1 would carry a uuid the engine already consumed.
      firstTurn: 3,
    });
    secondGateway.enqueue("third turn, after the restart");
    const second = new WorkerHost({
      checkpoints: new RecordingCheckpoints({
        mode: "resume",
        resume,
        // The transcript is on this container's own disk; a real restore binds
        // a revision-scoped mirror instead.
        localTranscriptResume: true,
      }),
      execution: { bootstrapNonce: "wln_test", generation: 2, id: "exec-1" },
      engines,
      gateway: secondGateway,
      logger: silent,
      runtimes: registry(),
      timeouts,
      // The scratch directory is no checkout; preparing one is workspace.test.ts's.
      workspace: noWorkspace,
    });

    const secondSummary = await second.runLoop();

    expect(secondSummary.turns).toEqual([
      { turnId: "3", status: "completed", reason: null },
    ]);
    expect(server.requests).toHaveLength(3);
    // A second, distinct engine process — and it picked the conversation up
    // rather than starting one, so the transcript came with it.
    expect(spawned).toHaveLength(2);
    expect(new Set(spawned).size).toBe(2);
    const resumedBody = JSON.stringify(server.requests[2]?.body.messages);
    expect(resumedBody).toContain("first turn");
    expect(resumedBody).toContain("third turn, after the restart");
    expect(
      secondGateway.events.some(
        (event) =>
          event.event === "result" &&
          (event.data as { session_id?: string }).session_id === resume,
      ),
    ).toBe(true);

    // Both engine processes were reaped before their hosts returned.
    expect(exited).toHaveLength(2);

    // Third process: handed turn 1 again, as a retry after a crash would be.
    // The engine already holds its uuid and would swallow it without an
    // answer; the transcript says so before anything is sent.
    const thirdGateway = new FakeWorkerGateway({
      runtimeConfig,
      sessionId: SESSION_ID,
      attemptId: "att_fake_3",
      firstTurn: 1,
    });
    thirdGateway.enqueue("first turn");
    const third = new WorkerHost({
      checkpoints: new RecordingCheckpoints({
        mode: "resume",
        resume,
        localTranscriptResume: true,
      }),
      execution: { bootstrapNonce: "wln_test", generation: 3, id: "exec-1" },
      engines,
      gateway: thirdGateway,
      logger: silent,
      runtimes: registry(),
      timeouts,
      workspace: noWorkspace,
    });
    const began = Date.now();

    const thirdSummary = await third.runLoop();

    expect(thirdSummary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "input_already_consumed",
      },
    ]);
    // Nothing reached the model again, and nothing waited on an answer.
    expect(server.requests).toHaveLength(3);
    expect(Date.now() - began).toBeLessThan(timeouts.maxTurnMs);
    expect(thirdSummary.outcome).toBe("drained");
    expect(exited).toHaveLength(3);
  }, 90_000);
});

/** Resolves once the SDK gives up the request, or after `ms` regardless. */
function abandonedBy(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const waitFor = (condition: () => boolean, label: string): Promise<void> =>
  pollFor(condition, label, { timeoutMs: 30_000, stepMs: 20 });

/** Commits a checkpoint whenever the run says one is ready. */
function committing(): WorkerCheckpointPort & { refs: CheckpointRef[] } {
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

// The SDK has no `interrupted` terminal reason: an interrupt ends the turn as
// an abort, and only the host knows it asked for one.
describe("WorkerHost interrupt against the actual Claude SDK", () => {
  const cases: Array<{
    moment: "streaming" | "tool";
    terminalReason: string;
    withCheckpoint: boolean;
  }> = [
    {
      moment: "streaming",
      terminalReason: "aborted_streaming",
      withCheckpoint: true,
    },
    {
      moment: "streaming",
      terminalReason: "aborted_streaming",
      withCheckpoint: false,
    },
    { moment: "tool", terminalReason: "aborted_tools", withCheckpoint: true },
    { moment: "tool", terminalReason: "aborted_tools", withCheckpoint: false },
  ];

  test.each(cases)(
    "an interrupt while $moment ($terminalReason) ends the turn as interrupted, checkpoint captured: $withCheckpoint",
    async ({ moment, terminalReason, withCheckpoint }) => {
      isolated = await createIsolatedWorkspace({ prefix: "94s-287-" });
      const { home, workspace } = isolated;
      server = startFakeAnthropicServer(async (request, index) => {
        if (moment === "tool" && index === 0) {
          return toolReply("Bash", {
            command: "touch interrupted.txt",
            description: "Create a file",
          });
        }
        // Held open: only the interrupt ends this response.
        await abandonedBy(request.signal, 30_000);
        return textReply("too late");
      });
      const engines = new EngineProcesses();
      const gateway = new FakeWorkerGateway({
        runtimeConfig: {
          model: MODEL,
          tools: moment === "tool" ? ["Bash"] : [],
          permission_mode: "default",
          provider: {
            kind: "anthropic",
            endpoint: server.url,
            auth: { kind: "egress_token", token: "placeholder-local" },
          },
        },
        sessionId: SESSION_ID,
      });
      const checkpoints = withCheckpoint
        ? committing()
        : new RecordingCheckpoints({ mode: "new" });
      gateway.enqueue("run until interrupted");
      const host = new WorkerHost({
        checkpoints,
        execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
        engines,
        gateway,
        logger: silent,
        runtimes: sdkRuntimes(server.url, home, workspace, engines),
        timeouts,
        workspace: noWorkspace,
      });

      const loop = host.runLoop();
      if (moment === "tool") {
        await waitFor(
          () => gateway.registrations.length === 1,
          "the permission request",
        );
      } else {
        await waitFor(() => server?.requests.length === 1, "the model call");
      }
      gateway.interrupt("1");
      const summary = await loop;

      const finalized = gateway.finalized[0];
      expect(finalized?.terminal.result).toMatchObject({
        terminal_reason: terminalReason,
      });
      if (withCheckpoint) {
        expect(summary.turns).toEqual([
          {
            turnId: "1",
            status: "interrupted",
            reason: "error_during_execution",
          },
        ]);
        expect(finalized?.checkpoint).toEqual(
          (checkpoints as ReturnType<typeof committing>).refs[0] ?? null,
        );
        expect(finalized?.checkpoint).not.toBeNull();
      } else {
        expect(summary.turns).toEqual([
          {
            turnId: "1",
            status: "outcome_unknown",
            reason: "interrupt_checkpoint_unavailable",
          },
        ]);
        expect(finalized?.checkpoint).toBeNull();
        expect(summary.outcome).toBe("drained");
      }
      // The tool never ran: its permission was voided by the interrupt.
      expect(await Bun.file(`${workspace}/interrupted.txt`).exists()).toBe(
        false,
      );
    },
    90_000,
  );
});
