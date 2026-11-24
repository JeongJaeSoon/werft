import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TURN_LEASE_MS,
  CONVERSATION_TURN_LIMIT_MS,
  type ConversationTurnResult,
  conversationCallIdSchema,
  conversationRuntimeIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  conversationTurnLeaseIdSchema,
} from "@werft-ai/contracts";
import type { QueuedConversationTurn } from "../ports/conversation-turn-queue.ts";
import {
  createConversationRuntimeTurns,
  createMemoryConversationTurnQueue,
} from "./conversation-turns.ts";

const START = new Date("2026-11-24T00:00:00.000Z");
const runtimeA = conversationRuntimeIdSchema.parse(crypto.randomUUID());
const runtimeB = conversationRuntimeIdSchema.parse(crypto.randomUUID());
const done: ConversationTurnResult = { outcome: "completed", text: "answer" };

function queued(): QueuedConversationTurn {
  return {
    turn_id: conversationTurnIdSchema.parse(crypto.randomUUID()),
    scope: {
      workspace_id: crypto.randomUUID(),
      agent_id: crypto.randomUUID(),
      topic_id: conversationTopicIdSchema.parse(crypto.randomUUID()),
    },
    model: "claude-haiku-5",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "egress_token", token: ["wec", "one-call"].join("_") },
    },
    call: {
      id: conversationCallIdSchema.parse(crypto.randomUUID()),
      max_tokens: 1_024,
    },
    input: { id: crypto.randomUUID(), text: "hello" },
  };
}

/** The service over a memory queue, on a clock the test moves. */
function harness() {
  let clock = START.getTime();
  const turns = createConversationRuntimeTurns({
    queue: createMemoryConversationTurnQueue(),
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
    enqueue(turn = queued(), takeInMs = 30_000) {
      return turns.queue
        .enqueue(turn, new Date(clock + takeInMs))
        .then(() => turn);
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

  test("a runtime takes the oldest waiting turn with a lease, its scope and its one-call permit", async () => {
    const h = harness();
    const first = await h.enqueue();
    const second = await h.enqueue();

    const taken = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });

    expect(taken).toMatchObject({
      turn_id: first.turn_id,
      scope: first.scope,
      provider: first.provider,
      call: first.call,
      lease_expires_at: new Date(
        START.getTime() + CONVERSATION_TURN_LEASE_MS,
      ).toISOString(),
    });
    expect(taken?.lease_id).toMatch(/^[0-9a-f-]{36}$/);
    // The first is held, so the next poll gets the second and a third nothing.
    expect(
      (await h.turns.nextTurn({ runtimeId: runtimeB, waitMs: 0 }))?.turn_id,
    ).toBe(second.turn_id);
    expect(
      await h.turns.nextTurn({ runtimeId: runtimeB, waitMs: 0 }),
    ).toBeNull();
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

  test("the holder's report ends the turn, and the same report again changes nothing", async () => {
    const h = harness();
    const turn = await h.enqueue();
    const taken = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    if (taken === null) throw new Error("not taken");
    const report = {
      runtimeId: runtimeA,
      turnId: turn.turn_id,
      leaseId: taken.lease_id,
      result: done,
    };

    expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
    expect(await h.turns.turnResult(report)).toBe("recorded");
    expect(await h.turns.turnResult(report)).toBe("duplicate");
    expect(
      await h.turns.turnResult({
        ...report,
        result: { outcome: "completed", text: "another" },
      }),
    ).toBe("conflict");
    expect(await h.turns.ended(turn.turn_id)).toEqual(done);
  });

  test("a report under another lease or from another runtime is refused, and the holder's still lands", async () => {
    const h = harness();
    const turn = await h.enqueue();
    const taken = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    if (taken === null) throw new Error("not taken");
    const own = {
      runtimeId: runtimeA,
      turnId: turn.turn_id,
      leaseId: taken.lease_id,
      result: done,
    };

    expect(await h.turns.turnResult({ ...own, runtimeId: runtimeB })).toBe(
      "not_holder",
    );
    expect(
      await h.turns.turnResult({
        ...own,
        leaseId: conversationTurnLeaseIdSchema.parse(crypto.randomUUID()),
      }),
    ).toBe("not_holder");
    expect(
      await h.turns.turnResult({
        ...own,
        turnId: conversationTurnIdSchema.parse(crypto.randomUUID()),
      }),
    ).toBe("unknown_turn");
    expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
    expect(await h.turns.turnResult(own)).toBe("recorded");
  });

  test("a lease that ends closes the turn as failed: the late report is refused and the turn is never handed out again", async () => {
    const h = harness();
    const turn = await h.enqueue();
    const taken = await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 });
    if (taken === null) throw new Error("not taken");

    h.advance(CONVERSATION_TURN_LEASE_MS - 1);
    expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
    h.advance(1);

    expect(await h.turns.ended(turn.turn_id)).toEqual({
      outcome: "failed",
      reason: "lease_expired",
    });
    expect(
      await h.turns.turnResult({
        runtimeId: runtimeA,
        turnId: turn.turn_id,
        leaseId: taken.lease_id,
        result: done,
      }),
    ).toBe("lease_expired");
    expect(
      await h.turns.nextTurn({ runtimeId: runtimeB, waitMs: 0 }),
    ).toBeNull();
    expect(await h.turns.ended(turn.turn_id)).toEqual({
      outcome: "failed",
      reason: "lease_expired",
    });
  });

  test("a turn no runtime takes in time ends as not taken, and none takes it after", async () => {
    const h = harness();
    const turn = await h.enqueue(queued(), 30_000);

    h.advance(30_000);

    expect(
      await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
    ).toBeNull();
    expect(await h.turns.ended(turn.turn_id)).toEqual({
      outcome: "failed",
      reason: "not_taken",
    });
  });

  test("a turn id is queued once, and an unknown one has no end", async () => {
    const h = harness();
    const turn = await h.enqueue();
    await expect(h.enqueue(turn)).rejects.toThrow(/already queued/);
    expect(
      await h.turns.ended(conversationTurnIdSchema.parse(crypto.randomUUID())),
    ).toBeNull();
  });
});
