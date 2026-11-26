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
import type {
  ConversationTurnQueue,
  QueuedConversationTurn,
} from "../ports/conversation-turn-queue.ts";
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

/**
 * The service with a wakeup the test rings and a sleep only the test (or an
 * abort) ends, over a memory queue or the one given.
 */
function heard(
  options: {
    listening?: boolean;
    queue?: ConversationTurnQueue;
    timed?: () => Date | null;
  } = {},
) {
  const waits: { of: string; signal: AbortSignal; ring: () => void }[] = [];
  const sleeps: { ms: number; end: () => void }[] = [];
  const base = options.queue ?? createMemoryConversationTurnQueue();
  const timed = options.timed;
  const turns = createConversationRuntimeTurns({
    queue:
      timed === undefined
        ? base
        : { ...base, nextTimedChange: async () => timed() },
    now: () => START,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push({ ms, end: resolve });
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    wakeup: {
      listening: options.listening ?? true,
      wait: (of, signal) =>
        new Promise<void>((resolve) => {
          waits.push({ of, signal, ring: resolve });
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    },
  });
  return { turns, waits, sleeps };
}

// Long enough for a poll to look at the queue and start its wait.
const looked = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a poll that hears the queue change", () => {
  test("told of a queued turn, a waiting poll takes it without waiting out its sleep", async () => {
    const h = heard();
    const poll = h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 20_000 });
    await looked();
    expect(h.waits.map((wait) => wait.of)).toEqual(["next"]);
    // Nothing in the queue is timed: it would look again after the fallback.
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([5_000]);

    const turn = queued();
    await h.turns.queue.enqueue(turn, entryAt(START));
    h.waits[0]?.ring();

    expect((await poll)?.turn_id).toBe(turn.turn_id);
    // Each look listened for itself and stopped once it was done.
    expect(h.waits.map((wait) => wait.signal.aborted)).toEqual([true, true]);
  });

  test("a turn queued while the poll is looking still wakes it", async () => {
    const base = createMemoryConversationTurnQueue();
    const turn = queued();
    let looks = 0;
    const h = heard({
      queue: {
        ...base,
        lease: async (input) => {
          const taken = await base.lease(input);
          looks += 1;
          if (looks === 1) {
            // Queued and told right after the look, before the poll waits.
            await base.enqueue(turn, entryAt(START));
            for (const wait of h.waits) wait.ring();
          }
          return taken;
        },
      },
    });

    // No sleep is ended here: only the notice can bring the second look.
    expect(
      (await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 20_000 }))
        ?.turn_id,
    ).toBe(turn.turn_id);
    expect(looks).toBe(2);
  });

  test("it looks again at the queue's next timed change, at the fallback at the latest, and as a poll would when that time is already due", async () => {
    for (const [timed, waitMs, slept] of [
      // The fallback is always running; a sooner time runs beside it.
      [new Date(START.getTime() + 1_000), 20_000, [5_000, 1_000]],
      [new Date(START.getTime() + 60_000), 20_000, [5_000]],
      [new Date(START.getTime() + 10), 20_000, [5_000, 10]],
      [START, 20_000, [5_000, 250]],
      [new Date(START.getTime() - 1_000), 20_000, [5_000, 250]],
      [null, 20_000, [5_000]],
      // Never past the poll's own wait.
      [new Date(START.getTime() + 1_000), 100, [100]],
    ] as const) {
      const h = heard({ timed: () => timed });
      const stop = new AbortController();
      const poll = h.turns.nextTurn({
        runtimeId: runtimeA,
        waitMs,
        stop: stop.signal,
      });
      await looked();
      expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([...slept]);
      // A stop ends the wait itself, not only the next look.
      stop.abort();
      expect(await poll).toBeNull();
    }
  });

  test("a notice, a stop or the fallback ends the wait though the queue never says its next timed change", async () => {
    for (const end of ["notice", "stop", "fallback"] as const) {
      const base = createMemoryConversationTurnQueue();
      const turn = queued();
      const h = heard({
        // The queue never answers.
        queue: { ...base, nextTimedChange: () => new Promise(() => {}) },
      });
      const stop = new AbortController();
      const poll = h.turns.nextTurn({
        runtimeId: runtimeA,
        waitMs: 20_000,
        stop: stop.signal,
      });
      await looked();
      expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([5_000]);
      if (end === "notice") {
        await base.enqueue(turn, entryAt(START));
        h.waits[0]?.ring();
        expect((await poll)?.turn_id).toBe(turn.turn_id);
        continue;
      }
      if (end === "fallback") {
        h.sleeps[0]?.end();
        await looked();
        // It looked again, and waits again.
        expect(h.waits).toHaveLength(2);
      }
      stop.abort();
      expect(await poll).toBeNull();
    }
  });

  test("a stop ends the wait of the service's own sleep, and leaves no timer behind", async () => {
    const stop = new AbortController();
    const turns = createConversationRuntimeTurns({
      queue: createMemoryConversationTurnQueue(),
      wakeup: {
        listening: true,
        wait: (_of, signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
    });
    const started = performance.now();
    const poll = turns.nextTurn({
      runtimeId: runtimeA,
      waitMs: 20_000,
      stop: stop.signal,
    });
    await looked();
    stop.abort();
    expect(await poll).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("while no notice arrives it polls as it did without one", async () => {
    const h = heard({ listening: false, timed: () => START });
    const stop = new AbortController();
    const poll = h.turns.nextTurn({
      runtimeId: runtimeA,
      waitMs: 20_000,
      stop: stop.signal,
    });
    await looked();
    expect(h.waits).toEqual([]);
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([250]);
    stop.abort();
    h.sleeps[0]?.end();
    expect(await poll).toBeNull();
  });

  test("whoever waits for a turn's end is told of that turn", async () => {
    const h = heard();
    const turn = queued();
    await h.turns.queue.enqueue(turn, entryAt(START));
    const taken = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    if (taken === null) throw new Error("not taken");

    const ended = h.turns.ended(turn.turn_id);
    await looked();
    expect(h.waits.at(-1)?.of).toBe(turn.turn_id);
    const result: ConversationTurnResult = {
      outcome: "completed",
      text: "answer",
    };
    await h.turns.turnResult({
      runtimeId: runtimeA,
      turnId: turn.turn_id,
      leaseId: taken.lease_id,
      result,
    });
    h.waits.at(-1)?.ring();

    expect(await ended).toEqual(result);
  });
});
