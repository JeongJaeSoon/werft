import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationRuntimeTurn,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import type {
  AgentRun,
  RuntimeEvent,
  RuntimeHostDeps,
  RuntimeModule,
  RuntimeStart,
} from "@werft-ai/runtime-core";
import { imageRuntime } from "../composition.ts";
import { fakeConversationTools } from "../testing/fake-conversation-tools.ts";
import { fakePermitRelay } from "../testing/fake-permit-relay.ts";
import { TopicDirectories } from "./topic-directories.ts";
import { TopicSessions } from "./topic-sessions.ts";
import {
  CONVERSATION_BUILTIN_TOOLS,
  createConversationTurnRunner,
} from "./turn-runner.ts";

const TOKEN = ["wec", "one-call-token"].join("_");
const BUILTIN = ["Bash", "Edit", "Read", "Write"];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "turn-runner-"));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

const turn: ConversationRuntimeTurn = conversationRuntimeTurnSchema.parse({
  turn_id: crypto.randomUUID(),
  lease_id: crypto.randomUUID(),
  lease_expires_at: "2026-11-24T00:02:30.000Z",
  scope: {
    workspace_id: crypto.randomUUID(),
    agent_id: crypto.randomUUID(),
    conversation_id: crypto.randomUUID(),
    topic_id: crypto.randomUUID(),
  },
  model: "claude-haiku-5",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "egress_token", token: TOKEN },
  },
  call: { max_tokens: 2_048 },
  input: { id: crypto.randomUUID(), text: "hello" },
  fresh_input: { id: crypto.randomUUID(), text: "assembled: hello" },
});

const ended = (
  isError = false,
  reason?: string,
  abortedByStop = false,
): RuntimeEvent => ({
  type: "turn.ended",
  turn: {
    isError,
    abortedByStop,
    budgetExceeded: false,
    ...(reason === undefined ? {} : { failure: { reason } }),
    engineResult: {},
    cost: { countRestarted: false, unknown: true },
    inputs: [],
  },
});
const said = (text: string): RuntimeEvent =>
  ({
    type: "public",
    event: { event: "assistant", data: { type: "assistant", text } },
  }) as RuntimeEvent;

/** A runtime module whose run plays `events`, or waits to be aborted. */
function scripted(events: RuntimeEvent[] | "hang" | "throw") {
  const seen: {
    deps?: RuntimeHostDeps;
    start?: RuntimeStart;
    sent: unknown[];
    closed: number;
    aborted: number;
  } = {
    sent: [],
    closed: 0,
    aborted: 0,
  };
  let abort: (() => void) | undefined;
  const run = {
    ready: async () => {
      if (events === "throw")
        throw new Error("engine would not start: secret detail");
      return {} as never;
    },
    send: (input: unknown) => seen.sent.push(input),
    async *events() {
      if (events === "hang") {
        if (seen.aborted === 0) {
          await new Promise<void>((resolve) => {
            abort = resolve;
          });
        }
        yield ended(true, undefined, true);
        return;
      }
      if (events !== "throw") yield* events;
    },
    abort: () => {
      seen.aborted += 1;
      abort?.();
    },
    finishInput: () => {},
    close: async () => {
      seen.closed += 1;
    },
  } as unknown as AgentRun;
  const module = {
    descriptor: { kind: "test_engine" },
    builtinTools: BUILTIN,
    eventCodec: {
      kind: "test_engine",
      withNeutralFields: (event: unknown) => event,
    },
    createRuntime: (deps: RuntimeHostDeps) => {
      seen.deps = deps;
      return {
        start: (start: RuntimeStart) => {
          seen.start = start;
          return run;
        },
      };
    },
  } as unknown as RuntimeModule;
  return { module, seen };
}

/** One provider call that asks for `tools` tool calls, then their results. */
const toolRound = (round: number, tools = 1): RuntimeEvent[] => {
  const ids = Array.from(
    { length: tools },
    (_, index) => `toolu_${round}_${index}`,
  );
  return [
    ...ids.flatMap((id): RuntimeEvent[] => [
      {
        type: "public",
        event: {
          id: id,
          event: "tool_use",
          data: {
            type: "assistant",
            message: { content: [{ type: "tool_use", id, name: "probe" }] },
          },
        },
      } as RuntimeEvent,
      { type: "tool.called", toolCallId: id, tool: "probe" },
    ]),
    // The engine answers every call of a response together.
    ...ids.map(
      (id) =>
        ({
          type: "public",
          event: {
            id: "result",
            event: "tool_result",
            data: { type: "tool_result", tool_use_id: id },
          },
        }) as RuntimeEvent,
    ),
  ];
};

/** A run that plays `events`, then waits to be aborted unless it ends first. */
function playsThenHangs(events: RuntimeEvent[]) {
  const scriptedRun = scripted("hang");
  const { module, seen } = scriptedRun;
  const created = module.createRuntime;
  (module as { createRuntime: unknown }).createRuntime = (
    deps: RuntimeHostDeps,
  ) => {
    const runtime = created(deps);
    return {
      start: (start: RuntimeStart) => {
        const run = runtime.start(start);
        const hang = run.events.bind(run);
        return Object.assign(run, {
          async *events() {
            yield* events;
            yield* hang();
          },
        });
      },
    };
  };
  return { module, seen };
}

let relay = fakePermitRelay();
const runnerOf = (module: RuntimeModule, limitMs?: number) => {
  relay = fakePermitRelay();
  return createConversationTurnRunner({
    runtime: module,
    sessions: new TopicSessions(new TopicDirectories(root), relay),
    relay,
    tools: fakeConversationTools(),
    ...(limitMs === undefined ? {} : { limitMs }),
  });
};
const live = () => new AbortController().signal;

describe("createConversationTurnRunner", () => {
  test("starts the engine in the topic's own directory with the four read tools and, for a turn the server gave none, reply and no_reply alone, every built-in one denied, the call limit and its session's key for the relay", async () => {
    const { module, seen } = scripted([said("hel"), said("lo"), ended()]);

    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "completed",
      text: "hello",
    });

    const topic = join(root, turn.scope.topic_id);
    expect(seen.deps).toEqual({
      stateDir: join(topic, "home", ".claude"),
      providerMaxRetries: 0,
    });
    expect(seen.start?.config).toEqual({
      mode: "new",
      correlationId: turn.turn_id,
      cwd: join(topic, "work"),
      home: join(topic, "home"),
      tmpDir: join(topic, "tmp"),
      model: "claude-haiku-5",
      permissionMode: "dontAsk",
      tools: [
        "mcp__conversation__read_thread",
        "mcp__conversation__read_channel_summary",
        "mcp__conversation__read_turns",
        "mcp__conversation__list_open_tasks",
        "mcp__conversation__reply",
        "mcp__conversation__no_reply",
      ],
      disallowedTools: BUILTIN,
      maxTurns: 8,
      maxOutputTokens: 2_048,
      compactionOff: true,
    });
    expect(CONVERSATION_BUILTIN_TOOLS).toEqual([]);
    expect(seen.start?.bindings.provider).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: {
        kind: "egress_token",
        token: "session-1",
        transport: relay.url,
      },
    });
    // The turn's permit rode on the key while it ran, and is gone after.
    expect(relay.held).toEqual([TOKEN]);
    expect(relay.permits.get("session-1")).toBeNull();
    // Nothing of a work session rides along: no instructions file, MCP server or transcript mirror.
    const { localToolServers, ...bundle } = seen.start?.bundle ?? {};
    expect(bundle).toEqual({
      instructions: [],
      repoInstructions: null,
      mcpServers: [],
    });
    // The runtime's own read tools, a fixed list, none taking an argument.
    expect(
      localToolServers?.map((server) => ({
        name: server.name,
        tools: server.tools.map((tool) => tool.name),
      })),
    ).toEqual([
      {
        name: "conversation",
        tools: [
          "read_thread",
          "read_channel_summary",
          "read_turns",
          "list_open_tasks",
          "reply",
          "no_reply",
        ],
      },
    ]);
    expect(seen.start?.bindings.transcript).toBeUndefined();
    // A new session starts from the assembled context, and outlives its turn.
    expect(seen.sent).toEqual([
      { message: "assembled: hello", uuid: turn.fresh_input.id },
    ]);
    expect(seen.closed).toBe(0);
  });

  test("a turn the engine ends in error fails with the engine's word for it", async () => {
    const { module } = scripted([ended(true, "error_during_execution")]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "engine_failed",
      detail: "error_during_execution",
    });
    // A reason that is not a plain code is left out rather than passed on.
    const { module: wordy } = scripted([ended(true, "The provider said: no")]);
    expect(await runnerOf(wordy).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "engine_failed",
    });
  });

  test("an engine that cannot start, or ends without a turn, is a failed turn and is still closed", async () => {
    const thrown = scripted("throw");
    expect(await runnerOf(thrown.module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "runtime_failed",
    });
    expect(thrown.seen.closed).toBe(1);
    const silent = scripted([]);
    expect(await runnerOf(silent.module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "engine_failed",
    });
  });

  test("a turn past its time limit is cut and fails on the time limit", async () => {
    const { module, seen } = scripted("hang");
    expect(await runnerOf(module, 20).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "time_limit",
    });
    expect(seen.aborted).toBe(1);
    expect(seen.closed).toBe(1);
  });

  test("the eighth provider call asking for a tool cuts the turn before a ninth, on the model call limit", async () => {
    const rounds = Array.from({ length: 8 }, (_, round) => toolRound(round));
    const { module, seen } = playsThenHangs(rounds.flat());
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "model_call_limit",
    });
    expect(seen.aborted).toBe(1);
    expect(seen.closed).toBe(1);
  });

  test("a ninth provider call the engine makes anyway, past a call it was not told of, cuts the turn on the model call limit", async () => {
    // Tool results with no tool.called before them: the count of tool calls
    // never saw these calls, the count of provider calls does.
    const results = (round: number): RuntimeEvent =>
      ({
        type: "public",
        event: {
          id: "result",
          event: "tool_result",
          data: { type: "tool_result", tool_use_id: `toolu_${round}` },
        },
      }) as RuntimeEvent;
    const { module, seen } = playsThenHangs([
      ...Array.from({ length: 8 }, (_, round) => [
        said(`call ${round}`),
        // Two blocks of one response are one call.
        said("same call"),
        results(round),
      ]).flat(),
      said("ninth"),
    ]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "model_call_limit",
    });
    expect(seen.aborted).toBe(1);
  });

  test("the thirteenth tool call cuts the turn on the tool call limit, even within one provider call", async () => {
    const { module, seen } = playsThenHangs([
      ...toolRound(0, 6),
      ...toolRound(1, 6),
      ...toolRound(2, 1),
    ]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "tool_call_limit",
    });
    expect(seen.aborted).toBe(1);

    const atOnce = playsThenHangs(toolRound(0, 13));
    expect(await runnerOf(atOnce.module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "tool_call_limit",
    });
  });

  test("a turn within its limits ends as the engine ends it", async () => {
    // Eight provider calls and twelve tool calls: every limit, none past it.
    const { module, seen } = scripted([
      ...[2, 2, 2, 2, 2, 1, 1].flatMap((tools, round) =>
        toolRound(round, tools),
      ),
      said("done"),
      ended(),
    ]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "completed",
      text: "done",
    });
    expect(seen.aborted).toBe(0);
  });

  test("the engine stopping at its own copy of the call limit is the model call limit", async () => {
    const { module } = scripted([ended(true, "error_max_turns")]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "model_call_limit",
    });
  });

  test("a stop cuts the turn, which fails as interrupted", async () => {
    const { module, seen } = scripted("hang");
    const stop = new AbortController();
    const running = runnerOf(module).run(turn, stop.signal);
    await Bun.sleep(5);
    stop.abort();
    expect(await running).toEqual({ outcome: "failed", reason: "interrupted" });
    expect(seen.aborted).toBe(1);
  });

  test("refuses a runtime that names no built-in tools to deny or cannot read an answer", () => {
    const { module } = scripted([]);
    for (const lacking of [
      { ...module, builtinTools: undefined },
      { ...module, eventCodec: undefined },
    ]) {
      expect(() => runnerOf(lacking as unknown as RuntimeModule)).toThrow(
        /cannot serve conversation turns/,
      );
    }
  });

  test("the image's own runtime can serve conversation turns, and denies the tools that write, run commands and edit", () => {
    const runtime = imageRuntime();
    expect(() => runnerOf(runtime)).not.toThrow();
    expect(runtime.builtinTools).toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "NotebookEdit"]),
    );
  });
});

describe("a conversation turn's decision tools", () => {
  /** A runtime whose engine calls `tool` with `input`, says "done" and ends. */
  function deciding(tool: string, input: Record<string, unknown>) {
    const { module, seen } = scripted([]);
    const created = module.createRuntime;
    (module as { createRuntime: unknown }).createRuntime = (
      deps: RuntimeHostDeps,
    ) => {
      const runtime = created(deps);
      return {
        start: (start: RuntimeStart) => {
          const run = runtime.start(start);
          return Object.assign(run, {
            async *events() {
              const local = start.bundle.localToolServers?.[0]?.tools.find(
                (each) => each.name === tool,
              );
              await local?.call(new AbortController().signal, input);
              yield said("done");
              yield ended();
            },
          });
        },
      };
    };
    return { module, seen };
  }
  const ALL = ["reply", "route_to_task", "spawn_task", "no_reply"] as const;
  const named = (tools: readonly string[]) =>
    tools.map((tool) => `mcp__conversation__${tool}`);
  const READS = named([
    "read_thread",
    "read_channel_summary",
    "read_turns",
    "list_open_tasks",
  ]);

  test("a turn is given the decision tools the server chose, and ends with the one the control host accepted", async () => {
    const { module, seen } = deciding("reply", {
      body: "Here it is.",
      reason: "asked",
    });
    const tools = fakeConversationTools();
    relay = fakePermitRelay();
    const runner = createConversationTurnRunner({
      runtime: module,
      sessions: new TopicSessions(new TopicDirectories(root), relay),
      relay,
      tools,
    });
    const full = { ...turn, decision_tools: [...ALL] };
    expect(await runner.run(full, live())).toEqual({
      outcome: "completed",
      text: "done",
      decision: { tool: "reply", body: "Here it is.", reason: "asked" },
    });
    // The golden list: the four reads and the four decisions, nothing else.
    expect(seen.start?.config.tools).toEqual([...READS, ...named(ALL)]);
    expect(
      seen.start?.bundle.localToolServers?.[0]?.tools.map((each) => each.name),
    ).toEqual([
      "read_thread",
      "read_channel_summary",
      "read_turns",
      "list_open_tasks",
      ...ALL,
    ]);
    expect(tools.decisions).toEqual([
      {
        turnId: turn.turn_id,
        leaseId: turn.lease_id,
        decision: { tool: "reply", body: "Here it is.", reason: "asked" },
      },
    ]);
  });

  test("an agent requester's next turn on the topic does not go on in a session given more tools", async () => {
    const { module, seen } = deciding("no_reply", { reason: "quiet" });
    relay = fakePermitRelay();
    const runner = createConversationTurnRunner({
      runtime: module,
      sessions: new TopicSessions(new TopicDirectories(root), relay),
      relay,
      tools: fakeConversationTools(),
    });
    await runner.run({ ...turn, decision_tools: [...ALL] }, live());
    const first = seen.start;
    const agents = {
      ...turn,
      turn_id: conversationRuntimeTurnSchema.shape.turn_id.parse(
        crypto.randomUUID(),
      ),
      topic_session: "keep" as const,
      decision_tools: ["reply", "no_reply"] as ("reply" | "no_reply")[],
    };
    expect(await runner.run(agents, live())).toMatchObject({
      outcome: "completed",
      decision: { tool: "no_reply" },
    });
    // A new engine, started with the agent's tools alone.
    expect(seen.start).not.toBe(first);
    expect(seen.start?.config.tools).toEqual([
      ...READS,
      ...named(["reply", "no_reply"]),
    ]);
  });

  test("a turn that ends with no accepted decision reports none", async () => {
    const { module } = deciding("no_reply", { reason: "quiet" });
    relay = fakePermitRelay();
    const tools = fakeConversationTools();
    tools.decide = () => ({ outcome: "refused", reason: "tool_not_allowed" });
    const runner = createConversationTurnRunner({
      runtime: module,
      sessions: new TopicSessions(new TopicDirectories(root), relay),
      relay,
      tools,
    });
    expect(await runner.run(turn, live())).toEqual({
      outcome: "completed",
      text: "done",
    });
  });
});
