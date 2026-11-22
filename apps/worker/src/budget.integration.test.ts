import { afterEach, describe, expect, test } from "bun:test";
import type { CheckpointRef, RuntimeConfig } from "@werft-ai/contracts";
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
import { createWorkerHost, workerRuntimeRegistry } from "./composition.ts";
import type { WorkerConfig, WorkerTimeouts } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { noWorkspace } from "./testing/no-workspace.ts";
import { WorkerHost, type WorkerLogger } from "./worker-host.ts";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL = "claude-sonnet-4-5";

// A million input tokens on claude-sonnet-4-5 is $3 by the engine's price
// table: every request below costs that, so the budget decides how many run.
const THREE_DOLLARS = { input_tokens: 1_000_000, output_tokens: 1 };

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
  // Nothing else bounds the loop: composition sets no maxTurns.
  maxTurnMs: 30_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
};

/** Commits every ready capture at the next revision and remembers the engine session. */
class CommittingCheckpoints implements WorkerCheckpointPort {
  resumeHandle: string | undefined;
  private revision = 0;

  constructor(private readonly plan: RuntimeResumePlan) {}

  async restorePlan(): Promise<RuntimeResumePlan> {
    return this.plan;
  }

  async capture(
    preparation: Parameters<WorkerCheckpointPort["capture"]>[0],
  ): Promise<CheckpointRef | null> {
    if (preparation.status !== "ready") return null;
    this.resumeHandle = preparation.checkpoint.resume;
    const revision = this.revision++;
    return {
      revision,
      manifest_ref: `checkpoints/${revision}.json`,
      manifest_sha256: "a".repeat(64),
    };
  }
}

function setup(
  endpoint: string,
  home: string,
  workspace: string,
): { config: WorkerConfig; runtimeConfig: RuntimeConfig } {
  return {
    config: {
      bootstrapNonce: "wln_test",
      executionGeneration: 1,
      egressCredentialUrl: endpoint.replace(/\/$/, ""),
      executionId: "exec-1",
      gatewayUrl: "http://127.0.0.1:9",
      objectStore: {
        bucket: "unused",
        endpoint: "http://127.0.0.1:9",
        region: "ap-northeast-1",
        scope: `sessions/${SESSION_ID}/`,
      },
      runtime: {
        claudeConfigDir: home,
        cwd: workspace,
        home,
        providerMaxRetries: 0,
      },
      timeouts,
    },
    runtimeConfig: {
      model: MODEL,
      tools: [],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint,
        auth: { kind: "egress_token", token: "placeholder-local" },
      },
    },
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

describe("session budget inside a turn, through the composed runtime", () => {
  test("a local clear command captures through the production process watcher", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "capture-grace-" });
    const { home, workspace } = isolated;
    for (const args of [
      ["init", "-q"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
      expect(result.exitCode).toBe(0);
    }
    await Promise.all(
      Array.from({ length: 3087 }, (_, index) =>
        Bun.write(`${workspace}/file-${index}.txt`, "workspace context\n"),
      ),
    );
    expect(
      Bun.spawnSync(["git", "add", "."], { cwd: workspace }).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "-qm",
          "workspace",
        ],
        { cwd: workspace },
      ).exitCode,
    ).toBe(0);
    server = startFakeAnthropicServer([textReply("unused")]);
    const { config, runtimeConfig } = setup(server.url, home, workspace);
    runtimeConfig.tools = ["Bash", "Read", "Glob", "Grep"];
    const gateway = new FakeWorkerGateway({
      runtimeConfig,
      sessionId: SESSION_ID,
    });
    gateway.enqueue("/clear");
    const rejected: string[] = [];
    const host = createWorkerHost(config, {
      checkpoints: new CommittingCheckpoints({ mode: "new" }),
      gateway,
      logger: {
        ...silent,
        warn: (event) => rejected.push(event),
      },
      workspace: noWorkspace,
    });

    await host.runLoop();

    expect(server.requests).toHaveLength(0);
    expect(rejected).not.toContain("worker.checkpoint.rejected");
    expect(gateway.finalized[0]?.checkpoint).toMatchObject({ revision: 0 });
  });

  test("the claim's remaining budget ends a tool loop mid-turn, and a resume gets its own", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    const { home, workspace } = isolated;
    // A tool call the engine refuses, so the model loops until something
    // stops it.
    server = startFakeAnthropicServer({
      ...toolReply("Bash", { command: "true" }),
      usage: THREE_DOLLARS,
    });
    const { config, runtimeConfig } = setup(server.url, home, workspace);
    const engines = new EngineProcesses();

    // First attempt: $5 left. $3 goes on, $6 is past it, so the turn ends
    // after its second request instead of running to the turn deadline.
    const firstGateway = new FakeWorkerGateway({
      remainingBudgetUsd: 5,
      runtimeConfig,
      sessionId: SESSION_ID,
    });
    const firstCheckpoints = new CommittingCheckpoints({ mode: "new" });
    firstGateway.enqueue("loop on tools");
    const first = await new WorkerHost({
      checkpoints: firstCheckpoints,
      engines,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway: firstGateway,
      logger: silent,
      runtimes: workerRuntimeRegistry(config, engines),
      timeouts,
      workspace: noWorkspace,
    }).runLoop();

    expect(server.requests).toHaveLength(2);
    expect(first.turns).toEqual([
      { turnId: "1", status: "failed", reason: "budget_exceeded" },
    ]);
    const cut = firstGateway.finalized[0];
    expect(cut?.terminal).toMatchObject({
      status: "failed",
      reason: "budget_exceeded",
      result: { subtype: "error_max_budget_usd" },
    });
    expect(cut?.terminal.cost_usd).toBeCloseTo(6, 3);
    // The cut turn still leaves a restore point behind.
    expect(cut?.checkpoint).toMatchObject({ revision: 0 });
    const resume = firstCheckpoints.resumeHandle;
    if (resume === undefined) throw new Error("No engine session was captured");

    // Second attempt, resumed: its budget is its own claim's figure. $2 left
    // ends it after one $3 request, where the first claim's $5 would have
    // let a second one through.
    const secondGateway = new FakeWorkerGateway({
      attemptId: "att_fake_2",
      firstTurn: 2,
      remainingBudgetUsd: 2,
      runtimeConfig,
      sessionId: SESSION_ID,
    });
    secondGateway.enqueue("loop on tools again");
    const second = await new WorkerHost({
      checkpoints: new CommittingCheckpoints({
        mode: "resume",
        resume,
        localTranscriptResume: true,
      }),
      engines,
      execution: { bootstrapNonce: "wln_test", generation: 2, id: "exec-1" },
      gateway: secondGateway,
      logger: silent,
      runtimes: workerRuntimeRegistry(config, engines),
      timeouts,
      workspace: noWorkspace,
    }).runLoop();

    expect(server.requests).toHaveLength(3);
    expect(second.turns).toEqual([
      { turnId: "2", status: "failed", reason: "budget_exceeded" },
    ]);
    expect(secondGateway.finalized[0]?.terminal.cost_usd).toBeCloseTo(3, 3);
    expect(JSON.stringify(server.requests[2]?.body.messages)).toContain(
      "loop on tools",
    );
  }, 90_000);

  test("/clear ends the attempt, so the next turn runs on a fresh claim's budget", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((request) =>
      JSON.stringify(request.body.messages).includes("loop now")
        ? { ...toolReply("Bash", { command: "true" }), usage: THREE_DOLLARS }
        : { ...textReply("ok"), usage: THREE_DOLLARS },
    );
    const { config, runtimeConfig } = setup(server.url, home, workspace);
    const engines = new EngineProcesses();
    const gateway = new FakeWorkerGateway({
      remainingBudgetUsd: 5,
      runtimeConfig,
      sessionId: SESSION_ID,
    });
    gateway.enqueue("spend three dollars");
    gateway.enqueue("/clear");
    gateway.enqueue("loop now");

    const summary = await new WorkerHost({
      checkpoints: new CommittingCheckpoints({ mode: "new" }),
      engines,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway,
      logger: silent,
      runtimes: workerRuntimeRegistry(config, engines),
      timeouts,
      workspace: noWorkspace,
    }).runLoop();

    // The clear is finalized; the loop is left for the next claim, which
    // carries the session's real remainder ($2) rather than a fresh $5.
    expect(summary.outcome).toBe("drained");
    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(server.requests).toHaveLength(1);
  }, 90_000);
});
