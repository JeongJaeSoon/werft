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
        await new Promise<void>((resolve) => {
          abort = resolve;
        });
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

let relay = fakePermitRelay();
const runnerOf = (module: RuntimeModule, limitMs?: number) => {
  relay = fakePermitRelay();
  return createConversationTurnRunner({
    runtime: module,
    sessions: new TopicSessions(new TopicDirectories(root), relay),
    relay,
    ...(limitMs === undefined ? {} : { limitMs }),
  });
};
const live = () => new AbortController().signal;

describe("createConversationTurnRunner", () => {
  test("starts the engine in the topic's own directory with no tool, every built-in one denied, one provider call and its session's key for the relay", async () => {
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
      tools: [],
      disallowedTools: BUILTIN,
      maxTurns: 1,
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
    expect(seen.start?.bundle).toEqual({
      instructions: [],
      repoInstructions: null,
      mcpServers: [],
    });
    expect(seen.start?.bindings.transcript).toBeUndefined();
    // A new session starts from the assembled context, and outlives its turn.
    expect(seen.sent).toEqual([
      { message: "assembled: hello", uuid: turn.fresh_input.id },
    ]);
    expect(seen.closed).toBe(0);
  });

  test("a turn the engine ends in error fails with the engine's word for it", async () => {
    const { module } = scripted([ended(true, "error_max_turns")]);
    expect(await runnerOf(module).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "engine_failed",
      detail: "error_max_turns",
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

  test("a turn past its limit is cut and fails as timed out", async () => {
    const { module, seen } = scripted("hang");
    expect(await runnerOf(module, 20).run(turn, live())).toEqual({
      outcome: "failed",
      reason: "timed_out",
    });
    expect(seen.aborted).toBe(1);
    expect(seen.closed).toBe(1);
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
