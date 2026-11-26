import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_TURN_LEASE_MS,
  CONVERSATION_TURN_LIMIT_MS,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  type ConversationCalls,
  conversationTurnLimitReached,
  createConversationRuntimeTurns,
  createMemoryConversationTurnQueue,
  SecretKey,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ambiguousPathGuard } from "./ambiguous-path.ts";
import {
  assertConversationTurnDispatch,
  conversationRuntimeBearer,
  conversationRuntimeConfigFromEnv,
  createOperatorConversationTurns,
  DEFAULT_CONVERSATION_TURN_SOCKET,
  OPERATOR_TURN_MAX_REQUEST_BYTES,
  OPERATOR_TURN_MAX_TOKENS,
  OPERATOR_TURN_TAKE_MS,
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

  test("on starts over the queue in the database", async () => {
    const queue = schema.createPostgresConversationTurnQueue(
      drizzle(await migratedPGlite(), { schema }),
      SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY"),
    );
    expect(() =>
      assertConversationTurnDispatch(
        { CONVERSATION_TURN_DISPATCH: "true" },
        queue,
      ),
    ).not.toThrow();
  }, 60_000);

  test("refuses a value that is neither", () => {
    expect(() =>
      assertConversationTurnDispatch(
        { CONVERSATION_TURN_DISPATCH: "yes" },
        memory,
      ),
    ).toThrow(/CONVERSATION_TURN_DISPATCH/);
  });
});

type Issue = Awaited<ReturnType<ConversationCalls["issueOperatorTurn"]>>;

function operatorHarness(
  options: {
    issue?: () => Issue;
    /** What the turn's permit was last refused for. */
    refusal?: "budget" | "concurrency";
    /** The turn's decision the server wrote as its tool was called. */
    decided?: boolean;
    release?: unknown;
    /** Wait in real time, for a test that acts while the operator waits. */
    realTime?: boolean;
    /** The kind of the conversation the turn is in. */
    place?: "channel" | "dm";
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
  const issued: Parameters<ConversationCalls["issueOperatorTurn"]>[0][] = [];
  const ended: string[] = [];
  const operator = createOperatorConversationTurns({
    turns,
    calls: {
      async issueOperatorTurn(input) {
        issued.push(input);
        return options.issue
          ? options.issue()
          : {
              outcome: "issued",
              token: CALL_TOKEN,
              // The take time and a whole lease, as the real permit's.
              expiresAt: new Date(now().getTime() + 180_000),
              place: options.place ?? "channel",
            };
      },
      async endTurn(turnId, outcome) {
        ended.push(turnId);
        const refusal = options.refusal ?? null;
        return options.decided
          ? { ended: "already_ended", state: "decided", refusal, limit: null }
          : {
              ended: "recorded",
              state: "no_decision",
              refusal,
              limit: conversationTurnLimitReached(outcome ?? null, refusal),
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
  return { turns, operator, issued, ended, request };
}

describe("an operator's conversation turn", () => {
  test("is refused before anything is reserved when no runtime is asking for turns", async () => {
    const h = operatorHarness();
    expect(await h.operator.run(h.request)).toEqual({ outcome: "no_runtime" });
    expect(h.issued).toEqual([]);
  });

  test("is given every decision tool, and ends on the record the server wrote of its decision", async () => {
    const h = operatorHarness({ realTime: true, decided: true });
    expect(await h.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
    const running = h.operator.run(h.request);
    const turn = await h.turns.nextTurn({ runtimeId, waitMs: 2_000 });
    if (turn === null) throw new Error("the turn was not queued");
    expect(turn.decision_tools).toEqual([
      "reply",
      "route_to_task",
      "spawn_task",
      "no_reply",
    ]);
    const result = {
      outcome: "completed",
      text: "",
      decision: { tool: "no_reply", reason: "not for the agent" },
    } as const;
    await h.turns.turnResult({
      runtimeId,
      turnId: turn.turn_id,
      leaseId: turn.lease_id,
      result,
    });
    expect(await running).toEqual({
      outcome: "ended",
      turn_id: turn.turn_id,
      turn: result,
      recorded: "decided",
    });
  });

  test("in a DM is not given spawn_task, as the server refuses it there", async () => {
    const h = operatorHarness({ realTime: true, decided: true, place: "dm" });
    expect(await h.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
    const running = h.operator.run(h.request);
    const turn = await h.turns.nextTurn({ runtimeId, waitMs: 2_000 });
    if (turn === null) throw new Error("the turn was not queued");
    expect(turn.decision_tools).toEqual(["reply", "route_to_task", "no_reply"]);
    await h.turns.turnResult({
      runtimeId,
      turnId: turn.turn_id,
      leaseId: turn.lease_id,
      result: { outcome: "completed", text: "" },
    });
    expect(await running).toMatchObject({ outcome: "ended" });
  });

  test("writes the turn with its permit, queues it with its scope, and ends it once the runtime reports", async () => {
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
      call: { max_tokens: OPERATOR_TURN_MAX_TOKENS },
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
      turn: { outcome: "completed", text: "hi" },
      recorded: "no_decision",
    });
    // Its row and permit end with it: no call is granted on it after.
    expect(h.ended).toEqual([turn.turn_id]);
    // A turn taken at the last moment still has its whole limit to run in.
    expect(OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS).toBeGreaterThan(
      OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LIMIT_MS,
    );
    expect(h.issued).toEqual([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        conversationId: CONVERSATION as never,
        topicId: TOPIC as never,
        // Neither a root nor a key: the operator's are not the command's to choose.
        turnId: turn.turn_id,
        operator: "ops@api-host",
        // The permit outlives the wait to be taken and the whole lease.
        ttlMs: OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS,
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
    const elsewhere = await polled(
      operatorHarness({ issue: () => ({ outcome: "unknown_conversation" }) }),
    );
    expect(await elsewhere.operator.run(elsewhere.request)).toEqual({
      outcome: "unknown_conversation",
    });
    expect(await elsewhere.turns.nextTurn({ runtimeId, waitMs: 0 })).toBeNull();
    // Nothing was written, so nothing is ended.
    expect(elsewhere.ended).toEqual([]);
  });

  test("names the refusal a turn's call ended it on", async () => {
    const h = operatorHarness({ refusal: "budget" });
    await h.turns.nextTurn({ runtimeId, waitMs: 0 });
    expect(await h.operator.run(h.request)).toMatchObject({
      outcome: "ended",
      turn: { outcome: "failed", reason: "not_taken" },
      refused: "budget",
    });
    expect(h.ended).toHaveLength(1);
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
      guard: ambiguousPathGuard({ warn: () => {} }),
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

  test("no route, Slack role or web code names the issue an operator's turn takes", () => {
    // Where it is defined, and the operator command's module.
    expect(naming("issueOperatorTurn")).toEqual([
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

  test("an operator's turn, given every decision tool, is written by the operator's issue alone", () => {
    // The one writer of a turn's requester as the operator: its store, called
    // by issueOperatorTurn only. beginConversationTurn, every other path's,
    // refuses the kind.
    expect(naming("issueTurnPermitAtomic")).toEqual([
      "packages/db/src/conversation-calls.ts",
      "packages/platform/src/limits/conversation-calls.ts",
      "packages/platform/src/limits/ports/conversation-call-store.ts",
    ]);
    const calls = readFileSync(
      join(root, "packages/platform/src/limits/conversation-calls.ts"),
      "utf8",
    );
    expect(calls.match(/\.issueTurnPermitAtomic\(/g)).toHaveLength(1);
    const operatorTurn = calls.slice(calls.indexOf("async issueOperatorTurn("));
    expect(operatorTurn.indexOf(".issueTurnPermitAtomic(")).toBeGreaterThan(0);
    expect(operatorTurn.indexOf(".issueTurnPermitAtomic(")).toBeLessThan(
      operatorTurn.indexOf("endTurn("),
    );
  }, 30_000);
});
