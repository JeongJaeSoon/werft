import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  type SessionEvent,
  sessionEventSchema,
} from "@werft-ai/contracts";
import type {
  AgentInput,
  RuntimeEvent,
  ToolDecisionObserver,
} from "@werft-ai/runtime-core";

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

// Built at run time so no secret-shaped literal sits in the source.
const SECRET = ["synthetic", "host", "secret", "0123456789"].join("-");

function setup() {
  const gateway = new FakeWorkerGateway();
  const run = new ScriptedRun();
  const launched: { observer: ToolDecisionObserver | undefined } = {
    observer: undefined,
  };
  const worker = new WorkerHost({
    checkpoints: { restorePlan: async () => ({ mode: "new" }) } as never,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: { info() {}, warn() {}, error() {} },
    runtimes: {
      launcherFor: () => ({
        start: (launch) => {
          launched.observer = launch.toolDecisions;
          return run;
        },
      }),
    },
    secrets: [SECRET],
    timeouts,
    workspace: noWorkspace,
  });
  return { gateway, launched, run, worker };
}

function turnOf(run: ScriptedRun, sent: AgentInput, id: string): void {
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
    {
      type: "turn.ended",
      turn: {
        isError: false,
        abortedByStop: false,
        budgetExceeded: false,
        engineResult: { outcome: "done" },
        cost: { countRestarted: false, unknown: true },
        inputs: [sent.uuid],
      },
    } satisfies RuntimeEvent,
  );
}

describe("tool decisions through the worker host", () => {
  test("a judgment the runtime reports reaches the API in the append of its turn, as a digest only", async () => {
    const { gateway, launched, run, worker } = setup();
    run.onSend = (sent) => {
      launched.observer?.observe({
        toolUseId: "toolu_1",
        parentToolUseId: undefined,
        tool: "Bash",
        input: { command: `echo ${SECRET}`, cwd: "/work" },
        decision: "allow",
        basis: "permission_mode",
      });
      turnOf(run, sent, "c1");
    };
    gateway.enqueue("go");
    await worker.runLoop();

    const decisions = gateway.batches.flatMap(
      (batch) => batch.tool_decisions ?? [],
    );
    const scrubbed = canonicalJson({
      command: "echo <redacted>",
      cwd: "/work",
    });
    expect(decisions).toEqual([
      {
        call_key: "t:toolu_1",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        input_sha256: createHash("sha256").update(scrubbed).digest("hex"),
        input_bytes: Buffer.byteLength(scrubbed),
        decision: "allow",
        basis: "permission_mode",
      },
    ]);
    // Nothing of the input travels, in the audit or anywhere else in the append.
    expect(JSON.stringify(gateway.batches)).not.toContain(SECRET);
    expect(JSON.stringify(decisions)).not.toContain("/work");
  });

  test("a run that reports nothing sends an append with no tool_decisions field", async () => {
    const { gateway, run, worker } = setup();
    run.onSend = (sent) => turnOf(run, sent, "c1");
    gateway.enqueue("go");
    await worker.runLoop();
    expect(gateway.batches.length).toBeGreaterThan(0);
    expect(gateway.batches.every((b) => !("tool_decisions" in b))).toBe(true);
  });
});
