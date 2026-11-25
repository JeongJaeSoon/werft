import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TURN_LEASE_MS,
  CONVERSATION_TURN_LIMIT_MS,
  type ConversationTurnResult,
  conversationIdSchema,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import type { QueuedConversationTurn } from "../ports/conversation-turn-queue.ts";
import { conversationTurnQueueContract } from "../testing/conversation-turn-queue-contract.ts";
import {
  createConversationRuntimeTurns,
  createMemoryConversationTurnQueue,
} from "./conversation-turns.ts";

const START = new Date("2026-11-24T00:00:00.000Z");
const runtimeA = conversationRuntimeIdSchema.parse(crypto.randomUUID());

function queued(sameTopicAs?: QueuedConversationTurn): QueuedConversationTurn {
  return {
    turn_id: conversationTurnIdSchema.parse(crypto.randomUUID()),
    scope: sameTopicAs?.scope ?? {
      workspace_id: crypto.randomUUID(),
      agent_id: crypto.randomUUID(),
      conversation_id: conversationIdSchema.parse(crypto.randomUUID()),
      topic_id: conversationTopicIdSchema.parse(crypto.randomUUID()),
    },
    model: "claude-haiku-5",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "egress_token", token: ["wec", "one-call"].join("_") },
    },
    call: { max_tokens: 1_024 },
    input: { id: crypto.randomUUID(), text: "hello" },
    fresh_input: { id: crypto.randomUUID(), text: "hello" },
  };
}

const entryAt = (at: Date) => ({
  inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
  attempt: 1,
  takeBy: new Date(at.getTime() + 30_000),
  now: at,
});

conversationTurnQueueContract("memory", async () => ({
  queue: createMemoryConversationTurnQueue(),
  turn: async (sameTopicAs) => queued(sameTopicAs),
}));

/** The service over a memory queue, on a clock the test moves. */
function harness(
  topicSessions?: Parameters<
    typeof createConversationRuntimeTurns
  >[0]["topicSessions"],
) {
  let clock = START.getTime();
  const turns = createConversationRuntimeTurns({
    queue: createMemoryConversationTurnQueue(),
    ...(topicSessions === undefined ? {} : { topicSessions }),
    now: () => new Date(clock),
    // A waiting poll moves the clock instead of the test's time.
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return {
    turns,
    advance(ms: number) {
      clock += ms;
    },
    at: () => new Date(clock),
    async enqueue(turn = queued()) {
      await turns.queue.enqueue(turn, entryAt(new Date(clock)));
      return turn;
    },
  };
}

describe("conversation turns over the memory queue", () => {
  test("the lease is the turn's two minutes and thirty seconds to report it", () => {
    expect(CONVERSATION_TURN_LEASE_MS).toBe(
      CONVERSATION_TURN_LIMIT_MS + 30_000,
    );
    expect(createMemoryConversationTurnQueue().durable).toBe(false);
  });

  test("a poll waits for a turn up to its wait, and says so to whoever asks if a runtime is there", async () => {
    const h = harness();
    expect(h.turns.runtimePolledWithin(60_000)).toBe(false);

    expect(
      await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 1_000 }),
    ).toBeNull();
    expect(h.at().getTime() - START.getTime()).toBe(1_000);
    expect(h.turns.runtimePolledWithin(60_000)).toBe(true);
    h.advance(60_001);
    expect(h.turns.runtimePolledWithin(60_000)).toBe(false);

    const stopped = new AbortController();
    stopped.abort();
    const before = h.at().getTime();
    expect(
      await h.turns.nextTurn({
        runtimeId: runtimeA,
        waitMs: 20_000,
        stop: stopped.signal,
      }),
    ).toBeNull();
    expect(h.at().getTime()).toBe(before);
  });

  test("a turn is handed out through the topic session check, which learns how it ended", async () => {
    const ended: unknown[] = [];
    const h = harness({
      handOut: async (turn) => ({
        ...turn,
        fresh_input: { ...turn.fresh_input, text: "assembled" },
        topic_session: "keep",
      }),
      ended: (turnId, completed) => ended.push({ turnId, completed }),
    });
    const turn = await h.enqueue();

    const out = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    if (out === null) throw new Error("not taken");
    expect(out.fresh_input.text).toBe("assembled");
    expect(out.topic_session).toBe("keep");
    const failed: ConversationTurnResult = {
      outcome: "failed",
      reason: "engine_failed",
    };
    const report = {
      runtimeId: runtimeA,
      turnId: turn.turn_id,
      leaseId: out.lease_id,
      result: failed,
    };
    await h.turns.turnResult(report);
    // A repeated report is not news to it.
    await h.turns.turnResult(report);
    expect(ended).toEqual([{ turnId: turn.turn_id, completed: false }]);
  });
});

describe("the limit a conversation turn ended on", () => {
  test("each turn leased is told, with its lease, before the runtime has it", async () => {
    const told: Array<[string, string]> = [];
    const turns = createConversationRuntimeTurns({
      queue: createMemoryConversationTurnQueue(),
      now: () => START,
      leased: async (turn) => {
        told.push([turn.turn_id, turn.lease_expires_at]);
      },
    });
    const turn = queued();
    await turns.queue.enqueue(turn, entryAt(START));
    expect(told).toEqual([]);
    await turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    expect(told).toEqual([
      [
        turn.turn_id,
        new Date(START.getTime() + CONVERSATION_TURN_LEASE_MS).toISOString(),
      ],
    ]);
    // A poll that finds nothing tells nothing.
    await turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    expect(told).toHaveLength(1);
  });
});
