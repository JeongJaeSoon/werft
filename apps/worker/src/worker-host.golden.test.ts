import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CheckpointRef } from "@werft-ai/contracts";
import type { EngineMessage as NativeSdkMessage } from "@werft-ai/runtime-core/testing";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import {
  type ScriptedStep,
  scriptedRuntimes,
} from "./testing/golden-runtime.ts";
import { waitFor as pollFor } from "./testing/wait-for.ts";
import { inputUuid, WorkerHost, type WorkerLogger } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

// What the worker publishes and finalizes for a scripted engine, pinned to
// the bytes main produced before the runtime contract refactor (94S-827).
// Regenerate only for an intended change: UPDATE_GOLDEN=1 bun test <file>.

const GOLDEN = join(import.meta.dir, "../../../tests/fixtures/golden/worker");
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
  // Long enough that a slow machine never expires a question the scenario
  // is about to answer.
  questionTimeoutMs: 30_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

function uuidForTurn(turn: number): string {
  return inputUuid(SESSION_ID, String(turn), `msg-${turn}`);
}

function assistantMessage(text: string): NativeSdkMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "fake-session",
  };
}

function resultMessage(
  uuid: string,
  fields: Record<string, unknown> = {},
): NativeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 5 },
    user_message_uuid: uuid,
    ...fields,
  };
}

function capturing(): WorkerCheckpointPort {
  let revision = 0;
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation): Promise<CheckpointRef | null> => {
      if (preparation.status !== "ready") return null;
      revision += 1;
      return {
        revision: revision - 1,
        manifest_ref: `manifests/${revision}.json`,
        manifest_sha256: "c".repeat(64),
      };
    },
  };
}

function harness(steps: ScriptedStep[], gateway = new FakeWorkerGateway()) {
  const { engine: runtime, runtimes } = scriptedRuntimes(steps);
  const host = new WorkerHost({
    checkpoints: capturing(),
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: silent,
    runtimes,
    timeouts,
    workspace: noWorkspace,
  });
  return { gateway, host, runtime };
}

const waitFor = (condition: () => boolean, label: string): Promise<void> =>
  pollFor(condition, label, { timeoutMs: 5_000, stepMs: 2 });

const REQUEST_ID =
  /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Only the three fields that differ run to run: `occurred_at` becomes
 * `<timestamp>`, a minted `request_id` becomes `req_<uuid:n>` in order of
 * first appearance, and the session's own id in `session_id` becomes
 * `<session>`. Every other value is kept byte for byte, so a uuid or a
 * timestamp turning up anywhere else shows as a diff.
 */
function normalize(value: unknown): unknown {
  const seen = new Map<string, string>();
  const field = (key: string, node: string): string => {
    if (key === "occurred_at" && TIMESTAMP.test(node)) return "<timestamp>";
    if (key === "session_id" && node === SESSION_ID) return "<session>";
    if (key === "request_id" && REQUEST_ID.test(node)) {
      let name = seen.get(node);
      if (name === undefined) {
        name = `req_<uuid:${seen.size}>`;
        seen.set(node, name);
      }
      return name;
    }
    return node;
  };
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      return key === undefined ? node : field(key, node);
    }
    if (Array.isArray(node)) return node.map((child) => walk(child));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([name, child]) => [name, walk(child, name)]),
      );
    }
    return node;
  };
  return walk(value);
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  const path = join(GOLDEN, `${name}.json`);
  const text = `${JSON.stringify(normalize(value), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await Bun.write(path, text);
    return;
  }
  expect(text).toBe(await Bun.file(path).text());
}

/**
 * Everything a scenario left at the gateway, in the order it arrived. Events
 * are listed one by one with their turn: how a flush groups them into
 * batches depends on timing, not on the contract.
 */
function recorded(
  gateway: FakeWorkerGateway,
  summary: Awaited<ReturnType<WorkerHost["runLoop"]>>,
) {
  return {
    turns: summary.turns,
    events: gateway.batches.flatMap((batch) =>
      batch.events.map((event) => ({ turn_id: batch.turn_id, ...event })),
    ),
    finalized: gateway.finalized.map((call) => ({
      finalize_key: call.finalize_key,
      final_source_sequence: call.final_source_sequence,
      terminal: call.terminal,
      checkpoint: call.checkpoint,
    })),
  };
}

describe("worker public events (golden)", () => {
  test("a completed turn", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      { type: "emit", message: assistantMessage("an answer") },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(1), { total_cost_usd: 0.25 }),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await expectGolden(
      "completed-turn",
      recorded(gateway, await host.runLoop()),
    );
  });

  test("tool calls that wait on an approval and a question", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        {
          type: "permissions",
          requests: [
            {
              input: { command: "ls -la", description: "List files" },
              requestId: "req-allow",
              tool: "Bash",
              toolUseId: "toolu_allow",
            },
            {
              input: { command: "rm -rf /" },
              requestId: "req-deny",
              tool: "Bash",
              toolUseId: "toolu_deny",
            },
            {
              input: {
                questions: [
                  {
                    header: "where",
                    question: "Which environment?",
                    multiSelect: false,
                    options: [
                      { label: "staging", description: "safe" },
                      { label: "production", description: "not" },
                    ],
                  },
                ],
              },
              requestId: "req-question",
              tool: "AskUserQuestion",
              toolUseId: "toolu_question",
            },
          ],
        },
        { type: "tool-start", toolUseId: "toolu_allow" },
        { type: "tool-end", toolUseId: "toolu_allow" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      gateway,
    );
    gateway.enqueue("do some work");
    const loop = host.runLoop();
    await waitFor(() => gateway.questions().length === 3, "three questions");
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_allow"),
      kind: "permission",
      decision: "allow",
    });
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_deny"),
      kind: "permission",
      decision: "deny",
      reason: "Not on this workspace",
    });
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_question"),
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });
    const summary = await loop;

    // Registration runs concurrently per callback, so its arrival order is
    // not part of the contract; the tool call id is.
    const byToolUse = <T>(items: T[], id: (item: T) => unknown) =>
      [...items].sort((a, b) => String(id(a)).localeCompare(String(id(b))));
    await expectGolden("approvals", {
      ...recorded(gateway, summary),
      // Written by the gateway on registration, not appended by the worker.
      questions: byToolUse(
        gateway.questions().map((event) => event.data),
        (data) => (data as { tool_use_id?: unknown }).tool_use_id,
      ),
      // Request ids are fresh per callback; the input hash is what an answer
      // is checked against.
      registrations: byToolUse(
        gateway.registrations.map(({ request_id: _id, ...rest }) => rest),
        (registration) => registration.announce?.tool_use_id,
      ),
      decisions: runtime.permissionDecisions,
    });
  });

  test("an engine result that failed the turn", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(1), {
          subtype: "error_max_turns",
          is_error: true,
          stop_reason: null,
          terminal_reason: "max_turns",
          total_cost_usd: 0.5,
        }),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await expectGolden("error-result", recorded(gateway, await host.runLoop()));
  });

  test("a provider that kept refusing", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "system",
          subtype: "api_retry",
          error: "server_error",
          error_status: 503,
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: {
          ...assistantMessage("API Error: 500"),
          error: "server_error",
        },
      },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(1), {
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 500,
          total_cost_usd: 0,
        }),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await expectGolden("api-error", recorded(gateway, await host.runLoop()));
  });

  test("a turn the engine ended on its budget", async () => {
    const gateway = new FakeWorkerGateway({ remainingBudgetUsd: 4.5 });
    const { host } = harness(
      [
        { type: "await-input" },
        {
          type: "emit",
          message: resultMessage(uuidForTurn(1), {
            subtype: "error_max_budget_usd",
            is_error: true,
            total_cost_usd: 4.75,
          }),
        },
        { type: "await-input" },
      ],
      gateway,
    );
    gateway.enqueue("a turn that loops on tools");

    await expectGolden(
      "budget-exceeded",
      recorded(gateway, await host.runLoop()),
    );
  });

  test("an interrupted turn followed by the next one", async () => {
    const { gateway, host, runtime } = harness([
      { type: "await-input" },
      { type: "delay", delayMs: 60_000 },
      { type: "emit", message: resultMessage(uuidForTurn(1)) },
      { type: "await-input" },
      { type: "emit", message: resultMessage(uuidForTurn(2)) },
      { type: "await-input" },
    ]);
    gateway.enqueue("long task");
    gateway.enqueue("follow-up");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "turn 1 delivered");
    gateway.interrupt("1");

    await expectGolden("interrupted", recorded(gateway, await loop));
  });

  test("tool results and a subagent's messages", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_task",
                name: "Task",
                input: { prompt: "look around" },
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "inside the subagent" },
              {
                type: "tool_use",
                id: "toolu_sub",
                name: "Read",
                input: { file_path: "README.md" },
              },
            ],
          },
          parent_tool_use_id: "toolu_task",
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_sub",
                content: "# readme",
              },
              { type: "text", text: "not a tool result" },
            ],
          },
          parent_tool_use_id: "toolu_task",
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_task",
                content: [{ type: "text", text: "found a readme" }],
                is_error: false,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(1), { total_cost_usd: 0.125 }),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("delegate");

    await expectGolden("tool-results", recorded(gateway, await host.runLoop()));
  });

  test("messages that name no session", async () => {
    const { session_id: _assistant, ...assistant } =
      assistantMessage("no session here");
    const { session_id: _result, ...result } = resultMessage(uuidForTurn(1), {
      total_cost_usd: 0.25,
    });
    const { gateway, host } = harness([
      { type: "await-input" },
      { type: "emit", message: assistant as NativeSdkMessage },
      { type: "emit", message: result as NativeSdkMessage },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await expectGolden(
      "no-session-id",
      recorded(gateway, await host.runLoop()),
    );
  });

  test("costs that are not finite numbers", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(1), { total_cost_usd: 0.5 }),
      },
      { type: "await-input" },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(2), {
          total_cost_usd: Number.NaN,
        }),
      },
      { type: "await-input" },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(3), {
          total_cost_usd: Number.POSITIVE_INFINITY,
        }),
      },
      { type: "await-input" },
      {
        type: "emit",
        message: resultMessage(uuidForTurn(4), { total_cost_usd: 0.75 }),
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("first");
    gateway.enqueue("second");
    gateway.enqueue("third");
    gateway.enqueue("fourth");

    await expectGolden(
      "non-finite-cost",
      recorded(gateway, await host.runLoop()),
    );
  });
});
