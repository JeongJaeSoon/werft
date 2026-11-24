import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  conversationCallIdSchema,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import { createLogger } from "@werft-ai/observability";
import {
  type ConversationCalls,
  createConversationRuntimeTurns,
  createMemoryConversationTurnQueue,
} from "@werft-ai/platform";
import {
  assertConversationTurnDispatch,
  conversationRuntimeBearer,
  conversationRuntimeConfigFromEnv,
  createOperatorConversationTurns,
  DEFAULT_CONVERSATION_TURN_SOCKET,
  OPERATOR_TURN_MAX_REQUEST_BYTES,
  OPERATOR_TURN_MAX_TOKENS,
  serveOperatorConversationTurns,
} from "./conversation-runtime.ts";
import { CONVERSATION_TURN_EXIT, main } from "./conversation-turn.ts";

const CURRENT = ["runtime", "bearer", "current", "0123456789abcdef"].join("-");
const PREVIOUS = ["runtime", "bearer", "previous", "0123456789abcdef"].join(
  "-",
);
const CALL_TOKEN = ["wec", "one-call"].join("_");
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const CONVERSATION = crypto.randomUUID();
const TOPIC = crypto.randomUUID();
const RELEASE = "release-1";
const runtimeId = conversationRuntimeIdSchema.parse(crypto.randomUUID());

describe("conversationRuntimeConfigFromEnv", () => {
  test("off without the bearer", () => {
    expect(conversationRuntimeConfigFromEnv({})).toBeNull();
    expect(
      conversationRuntimeConfigFromEnv({ CONVERSATION_RUNTIME_TOKEN: "" }),
    ).toBeNull();
  });

  test("takes the current bearer, and the one being rotated out beside it", () => {
    expect(
      conversationRuntimeConfigFromEnv({ CONVERSATION_RUNTIME_TOKEN: CURRENT }),
    ).toEqual({
      tokens: [CURRENT],
      socketPath: DEFAULT_CONVERSATION_TURN_SOCKET,
    });
    expect(
      conversationRuntimeConfigFromEnv({
        CONVERSATION_RUNTIME_TOKEN: CURRENT,
        CONVERSATION_RUNTIME_TOKEN_PREVIOUS: PREVIOUS,
        CONVERSATION_TURN_SOCKET: "/run/turns.sock",
      }),
    ).toEqual({ tokens: [CURRENT, PREVIOUS], socketPath: "/run/turns.sock" });
  });

  test("refuses a short bearer or a previous one alone, without echoing either", () => {
    const short = "too-short-to-be-a-lock";
    for (const env of [
      { CONVERSATION_RUNTIME_TOKEN: short },
      {
        CONVERSATION_RUNTIME_TOKEN: CURRENT,
        CONVERSATION_RUNTIME_TOKEN_PREVIOUS: short,
      },
      { CONVERSATION_RUNTIME_TOKEN_PREVIOUS: PREVIOUS },
    ]) {
      let message = "";
      try {
        conversationRuntimeConfigFromEnv(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/CONVERSATION_RUNTIME_TOKEN/);
      expect(message).not.toContain(short);
      expect(message).not.toContain(PREVIOUS);
    }
  });
});

describe("conversationRuntimeBearer", () => {
  test("is any of the configured bearers and nothing else", () => {
    const is = conversationRuntimeBearer([CURRENT, PREVIOUS]);
    expect([is(CURRENT), is(PREVIOUS)]).toEqual([true, true]);
    expect([is(null), is(""), is(`${CURRENT}x`), is(CURRENT.slice(1))]).toEqual(
      [false, false, false, false],
    );
    expect(conversationRuntimeBearer([CURRENT])(PREVIOUS)).toBe(false);
  });
});

describe("assertConversationTurnDispatch", () => {
  const memory = createMemoryConversationTurnQueue();

  test("off or unset starts on the memory queue", () => {
    for (const value of [undefined, "", "false", "0"]) {
      expect(() =>
        assertConversationTurnDispatch(
          { CONVERSATION_TURN_DISPATCH: value },
          memory,
        ),
      ).not.toThrow();
    }
  });

  test("on refuses to start over a queue held in this process's memory", () => {
    for (const value of ["true", "1"]) {
      expect(() =>
        assertConversationTurnDispatch(
          { CONVERSATION_TURN_DISPATCH: value },
          memory,
        ),
      ).toThrow(/queued in this process's memory/);
    }
    expect(() =>
      assertConversationTurnDispatch(
        { CONVERSATION_TURN_DISPATCH: "true" },
        { durable: true },
      ),
    ).not.toThrow();
  });

  test("refuses a value that is neither", () => {
    expect(() =>
      assertConversationTurnDispatch(
        { CONVERSATION_TURN_DISPATCH: "yes" },
        memory,
      ),
    ).toThrow(/CONVERSATION_TURN_DISPATCH/);
  });
});

type Issue = Awaited<ReturnType<ConversationCalls["issueForOperator"]>>;

function operatorHarness(
  options: {
    issue?: () => Issue;
    release?: unknown;
    /** Wait in real time, for a test that acts while the operator waits. */
    realTime?: boolean;
  } = {},
) {
  let clock = Date.parse("2026-11-24T00:00:00.000Z");
  const now = () => new Date(options.realTime ? Date.now() : clock);
  const turns = createConversationRuntimeTurns({
    queue: createMemoryConversationTurnQueue(),
    now,
    ...(options.realTime
      ? { pollMs: 5 }
      : {
          sleep: async (ms: number) => {
            clock += ms;
          },
        }),
  });
  const issued: Parameters<ConversationCalls["issueForOperator"]>[0][] = [];
  const callId = conversationCallIdSchema.parse(crypto.randomUUID());
  const operator = createOperatorConversationTurns({
    turns,
    calls: {
      async issueForOperator(input) {
        issued.push(input);
        return options.issue
          ? options.issue()
          : {
              outcome: "issued",
              callId,
              token: CALL_TOKEN,
              expiresAt: new Date(now().getTime() + 120_000),
            };
      },
    },
    agents: {
      async get(workspaceId: string, agentId: string) {
        if (workspaceId !== WORKSPACE || agentId !== AGENT) return null;
        return {
          active_release:
            "release" in options
              ? options.release
              : {
                  id: RELEASE,
                  connection_id: "anthropic",
                  runtime_config_snapshot: { model: "claude-haiku-5" },
                },
        };
      },
    } as never,
    catalog: {
      connections: {
        anthropic: {
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.com",
          },
        },
        responses: {
          provider: {
            kind: "openai_responses",
            endpoint: "https://api.openai.com",
          },
        },
      },
    } as never,
    now,
  });
  const request = {
    workspace_id: WORKSPACE,
    agent_id: AGENT,
    conversation_id: CONVERSATION,
    topic_id: TOPIC,
    text: "hello there",
    operator: { user: "ops", host: "api-host" },
  } as never;
  return { turns, operator, issued, callId, request };
}

describe("an operator's conversation turn", () => {
  test("is refused before anything is reserved when no runtime is asking for turns", async () => {
    const h = operatorHarness();
    expect(await h.operator.run(h.request)).toEqual({ outcome: "no_runtime" });
    expect(h.issued).toEqual([]);
  });

  test("reserves one call as the operator's own, queues the turn with its permit and scope, and returns how it ended", async () => {
    const h = operatorHarness({ realTime: true });
    // A runtime is polling.
    expect(await h.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
    const running = h.operator.run(h.request);
    const turn = await h.turns.nextTurn({ runtimeId, waitMs: 2_000 });
    if (turn === null) throw new Error("the turn was not queued");
    expect(turn).toMatchObject({
      scope: {
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        conversation_id: CONVERSATION,
        topic_id: TOPIC,
      },
      model: "claude-haiku-5",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "egress_token", token: CALL_TOKEN },
      },
      call: { id: h.callId, max_tokens: OPERATOR_TURN_MAX_TOKENS },
      input: { text: "hello there" },
    });
    expect(
      await h.turns.turnResult({
        runtimeId,
        turnId: turn.turn_id,
        leaseId: turn.lease_id,
        result: { outcome: "completed", text: "hi" },
      }),
    ).toBe("recorded");

    expect(await running).toEqual({
      outcome: "ended",
      turn_id: turn.turn_id,
      call_id: h.callId,
      turn: { outcome: "completed", text: "hi" },
    });
    expect(h.issued).toEqual([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        conversationId: CONVERSATION as never,
        topicId: TOPIC as never,
        // Neither a root nor a key: the operator's are not the command's to choose.
        callClass: "m2",
        turnId: turn.turn_id,
        releaseId: RELEASE,
        connectionId: "anthropic",
        model: "claude-haiku-5",
        maxTokens: OPERATOR_TURN_MAX_TOKENS,
        maxRequestBytes: OPERATOR_TURN_MAX_REQUEST_BYTES,
      },
    ]);
  });

  test("a turn the runtime never takes ends as not taken", async () => {
    const h = operatorHarness();
    await h.turns.nextTurn({ runtimeId, waitMs: 0 });
    expect(await h.operator.run(h.request)).toMatchObject({
      outcome: "ended",
      turn: { outcome: "failed", reason: "not_taken" },
    });
  });

  test("names why a turn was not started", async () => {
    const polled = async (h: ReturnType<typeof operatorHarness>) => {
      await h.turns.nextTurn({ runtimeId, waitMs: 0 });
      return h;
    };
    const unknown = await polled(operatorHarness());
    expect(
      await unknown.operator.run({
        ...(unknown.request as object),
        agent_id: crypto.randomUUID(),
      } as never),
    ).toEqual({ outcome: "unknown_agent" });
    const unreleased = await polled(operatorHarness({ release: null }));
    expect(await unreleased.operator.run(unreleased.request)).toEqual({
      outcome: "no_active_release",
    });
    for (const release of [
      { connection_id: "gone", runtime_config_snapshot: { model: "m" } },
      { connection_id: "responses", runtime_config_snapshot: { model: "m" } },
      { connection_id: "anthropic", runtime_config_snapshot: {} },
    ]) {
      const h = await polled(operatorHarness({ release }));
      expect(await h.operator.run(h.request)).toEqual({
        outcome: "connection_unavailable",
      });
      expect(h.issued).toEqual([]);
    }
    const refused = await polled(
      operatorHarness({
        issue: () => ({
          outcome: "refused",
          rootKind: "none",
          accountId: null,
        }),
      }),
    );
    expect(await refused.operator.run(refused.request)).toEqual({
      outcome: "budget_refused",
    });
    expect(await refused.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
    const elsewhere = await polled(
      operatorHarness({ issue: () => ({ outcome: "unknown_conversation" }) }),
    );
    expect(await elsewhere.operator.run(elsewhere.request)).toEqual({
      outcome: "unknown_conversation",
    });
    expect(await elsewhere.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
  });
});

describe("the conversation-turn command", () => {
  const args = [
    "--workspace",
    WORKSPACE,
    "--agent",
    AGENT,
    "--conversation",
    CONVERSATION,
    "--topic",
    TOPIC,
    "--text",
    "hello there",
  ];
  const capture = () => {
    const lines: string[] = [];
    return {
      lines,
      out: {
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
      },
    };
  };

  test("refuses bad arguments and an API whose runtime is off", async () => {
    const { lines, out } = capture();
    expect(await main(["--agent", AGENT], {}, out)).toBe(
      CONVERSATION_TURN_EXIT.usage,
    );
    expect(
      await main([...args.slice(0, 2), "--agent", "not-an-id"], {}, out),
    ).toBe(CONVERSATION_TURN_EXIT.usage);
    expect(await main(args, {}, out)).toBe(CONVERSATION_TURN_EXIT.off);
    expect(lines.at(-1)).toMatch(/conversation runtime is off/);
  });

  test("says so when the API's socket does not answer", async () => {
    const { lines, out } = capture();
    expect(
      await main(
        args,
        {
          CONVERSATION_RUNTIME_TOKEN: CURRENT,
          CONVERSATION_TURN_SOCKET: join(
            tmpdir(),
            `absent-${crypto.randomUUID()}.sock`,
          ),
        },
        out,
      ),
    ).toBe(CONVERSATION_TURN_EXIT.off);
    expect(lines.at(-1)).toMatch(/operator socket does not answer/);
  });

  test("starts a turn over the API's socket and prints how it ended; the API's log names who ran it and neither text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conversation-turn-"));
    const socketPath = join(directory, "turns.sock");
    const h = operatorHarness({ realTime: true });
    const logged: string[] = [];
    const server = await serveOperatorConversationTurns({
      socketPath,
      operator: h.operator,
      logger: createLogger({
        sinks: [
          { write: (record) => void logged.push(JSON.stringify(record)) },
        ],
      }),
    });
    const env = {
      CONVERSATION_RUNTIME_TOKEN: CURRENT,
      CONVERSATION_TURN_SOCKET: socketPath,
    };
    try {
      const { lines, out } = capture();
      // No runtime is polling: refused, and said on stdout.
      expect(await main(args, env, out)).toBe(CONVERSATION_TURN_EXIT.failed);
      expect(JSON.parse(lines.at(-1) ?? "")).toEqual({ outcome: "no_runtime" });

      await h.turns.nextTurn({ runtimeId, waitMs: 0 });
      const running = main(args, env, out);
      let turn = null;
      for (let tries = 0; turn === null && tries < 200; tries += 1) {
        await Bun.sleep(5);
        turn = await h.turns.nextTurn({ runtimeId, waitMs: 0 });
      }
      if (turn === null) throw new Error("the turn was not queued");
      await h.turns.turnResult({
        runtimeId,
        turnId: turn.turn_id,
        leaseId: turn.lease_id,
        result: { outcome: "completed", text: "the private answer" },
      });
      expect(await running).toBe(CONVERSATION_TURN_EXIT.completed);
      expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({
        outcome: "ended",
        turn: { outcome: "completed", text: "the private answer" },
      });
      const all = logged.join("\n");
      // The user and host the command's own process reports.
      expect(JSON.parse(logged.at(-1) ?? "").fields).toMatchObject({
        operator_user: userInfo().username,
        operator_host: hostname(),
        turn_outcome: "completed",
      });
      expect(all).not.toContain("hello there");
      expect(all).not.toContain("the private answer");
      expect(all).not.toContain(CALL_TOKEN);
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("an operator's call is the operator command's alone", () => {
  const root = join(import.meta.dir, "../../../..");
  /** The product sources naming `name`, comments included. */
  const naming = (name: string) =>
    [...new Bun.Glob("{apps,packages}/**/*.{ts,tsx}").scanSync(root)]
      .filter(
        (file) =>
          !/(^|\/)(node_modules|dist)\//.test(file) &&
          !/\.(test|integration|e2e|conformance)\.tsx?$/.test(file) &&
          new RegExp(`\\b${name}\\b`).test(
            readFileSync(join(root, file), "utf8"),
          ),
      )
      .sort();

  test("no route, Slack role or web code names the issue an operator's call takes", () => {
    // Where it is defined, and the operator command's module.
    expect(naming("issueForOperator")).toEqual([
      "apps/control-host/src/api/conversation-runtime.ts",
      "packages/platform/src/limits/conversation-calls.ts",
    ]);
    // That module's turns are served on the operator socket, by the API's
    // composition alone.
    expect(naming("createOperatorConversationTurns")).toEqual([
      "apps/control-host/src/api/conversation-runtime.ts",
      "apps/control-host/src/api/server.ts",
    ]);
    expect(naming("serveOperatorConversationTurns")).toEqual([
      "apps/control-host/src/api/conversation-runtime.ts",
      "apps/control-host/src/api/server.ts",
    ]);
  }, 30_000);
});
