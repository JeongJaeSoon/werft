import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeAnthropicServer,
  type FakeReply,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { DriverRun as AgentRun } from "./driver.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Native = Record<string, unknown> & { type: string };

// A million input tokens on claude-sonnet-4-5 is $3 by the engine's own
// price table, so each reply below costs a known, round amount.
const THREE_DOLLARS = { input_tokens: 1_000_000, output_tokens: 1 };

function costly(reply: FakeReply): FakeReply {
  return { ...reply, usage: THREE_DOLLARS };
}

/** A tool call the engine refuses, so the model loops until something stops it. */
const loop = costly(toolReply("Bash", { command: "true" }));

function config(
  endpoint: string,
  workspace: string,
  home: string,
): ClaudeRuntimeConfig {
  return {
    claudeConfigDir: home,
    correlationId: "budget",
    mode: "new",
    cwd: workspace,
    home,
    maxTurns: 10,
    model: "claude-sonnet-4-5",
    profile: {
      kind: "anthropic",
      endpoint,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: ["project"],
    tools: [],
  };
}

const deny = {
  onPermission: async () => ({
    behavior: "deny" as const,
    message: "no tools",
  }),
};

/** Sends one input and reads the run to its end. */
async function oneTurn(run: AgentRun): Promise<Native[]> {
  const seen: Native[] = [];
  run.send({ message: "go", uuid: crypto.randomUUID() });
  let finished = false;
  try {
    for await (const frame of run) {
      const native = frame.envelope.message as Native;
      seen.push(native);
      if (native.type === "result") {
        finished = true;
        run.finishInput();
      }
    }
  } catch (error) {
    // A session whose last turn failed exits 1 once its input closes.
    if (!finished) throw error;
  }
  return seen;
}

function resultOf(seen: Native[]): Native {
  const results = seen.filter((native) => native.type === "result");
  expect(results).toHaveLength(1);
  return results[0] as Native;
}

describe("maxBudgetUsd with the actual Claude SDK", () => {
  test("ends a turn mid-loop once its estimated cost reaches the budget", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    server = startFakeAnthropicServer(loop);
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });

    const seen = await oneTurn(
      runtime.start(
        {
          ...config(server.url, isolated.workspace, isolated.home),
          maxBudgetUsd: 5,
        },
        deny,
      ),
    );

    // $3 is under the budget and the loop goes on; $6 is over it and the
    // turn ends there, well short of maxTurns.
    expect(server.requests).toHaveLength(2);
    const result = resultOf(seen);
    expect(result).toMatchObject({
      subtype: "error_max_budget_usd",
      is_error: true,
    });
    expect(result.total_cost_usd).toBeCloseTo(6, 3);
  }, 60_000);

  test("a budget of nothing starts the engine and ends the first request's turn", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    server = startFakeAnthropicServer(loop);
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });

    const seen = await oneTurn(
      runtime.start(
        {
          ...config(server.url, isolated.workspace, isolated.home),
          maxBudgetUsd: 0,
        },
        deny,
      ),
    );

    expect(server.requests).toHaveLength(1);
    expect(resultOf(seen).subtype).toBe("error_max_budget_usd");
  }, 60_000);

  test("a resumed run counts from zero, so the budget it gets is all it may spend", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      index === 0 ? costly(textReply("first")) : loop,
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const first = resultOf(
      await oneTurn(runtime.start(config(server.url, workspace, home), deny)),
    );
    expect(first.total_cost_usd).toBeCloseTo(3, 3);
    const sessionId = first.session_id as string;

    const resumed = resultOf(
      await oneTurn(
        runtime.start(
          {
            ...config(server.url, workspace, home),
            localTranscriptResume: true,
            maxBudgetUsd: 5,
            mode: "resume",
            resume: sessionId,
          },
          deny,
        ),
      ),
    );

    // Had the $3 of the first run counted, one $3 request would have
    // reached $6 and ended the turn; the resumed run needed two.
    expect(server.requests).toHaveLength(3);
    expect(resumed).toMatchObject({
      subtype: "error_max_budget_usd",
      session_id: sessionId,
    });
    // Since SDK 0.3.277 the reported total of a resumed query starts from the
    // session's earlier $3 (3 + 6), while the budget above still counts from
    // zero.
    expect(resumed.total_cost_usd).toBeCloseTo(9, 3);
  }, 60_000);

  // Why the worker drains once the count starts over (worker-host observe):
  // the budget is measured against this count, not against what was spent.
  test("/clear starts the count over, and the budget with it", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-279-" });
    server = startFakeAnthropicServer((request) =>
      JSON.stringify(request.body.messages).includes("loop now")
        ? loop
        : costly(textReply("ok")),
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(
      {
        ...config(server.url, isolated.workspace, isolated.home),
        maxBudgetUsd: 5,
      },
      deny,
    );
    const inputs = ["spend three dollars", "/clear", "loop now"];
    const results: Native[] = [];
    let sent = 0;
    run.send({ message: inputs[sent++] as string, uuid: crypto.randomUUID() });
    try {
      for await (const frame of run) {
        const native = frame.envelope.message as Native;
        if (native.type !== "result") continue;
        results.push(native);
        if (sent < inputs.length) {
          run.send({
            message: inputs[sent++] as string,
            uuid: crypto.randomUUID(),
          });
        } else {
          run.finishInput();
        }
      }
    } catch (error) {
      if (results.length < inputs.length) throw error;
    }

    expect(results.map((result) => result.total_cost_usd)).toEqual([
      expect.closeTo(3, 3),
      0,
      expect.closeTo(6, 3),
    ]);
    expect(results[1]?.session_id).not.toBe(results[0]?.session_id);
    // $3 was spent before the clear, yet the loop ran two $3 requests
    // against a $5 budget: the count it checked had started from zero.
    expect(server.requests).toHaveLength(3);
    expect(results[2]?.subtype).toBe("error_max_budget_usd");
  }, 60_000);
});
