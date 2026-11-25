import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONVERSATION_TURN_LEASE_MS,
  type ConversationInputId,
  type ConversationRuntimeTurn,
  type ConversationTurnResult,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
  conversationTurnIdSchema,
  conversationTurnLeaseIdSchema,
} from "@werft-ai/contracts";
import {
  createConversationRuntimeTurns,
  ENDED_TURN_KEPT_MS,
} from "../conversations/conversation-turns.ts";
import type {
  ConversationTurnQueue,
  QueuedConversationTurn,
} from "../ports/conversation-turn-queue.ts";

/** What the queue contract runs against. */
export type ConversationTurnQueueSubject = {
  queue: ConversationTurnQueue;
  /** A new turn the queue may hold: of `sameTopicAs`'s topic when given. */
  turn(sameTopicAs?: QueuedConversationTurn): Promise<QueuedConversationTurn>;
};

const START = new Date("2026-11-24T00:00:00.000Z");
const runtimeA = conversationRuntimeIdSchema.parse(crypto.randomUUID());
const runtimeB = conversationRuntimeIdSchema.parse(crypto.randomUUID());
const done: ConversationTurnResult = { outcome: "completed", text: "answer" };

/** The runtime's side over the subject's queue, on a clock the test moves. */
function harness(subject: ConversationTurnQueueSubject) {
  let clock = START.getTime();
  const turns = createConversationRuntimeTurns({
    queue: subject.queue,
    now: () => new Date(clock),
    // A waiting poll moves the clock instead of the test's time.
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const at = () => new Date(clock);
  return {
    turns,
    at,
    advance(ms: number) {
      clock += ms;
    },
    async enqueue(
      options: {
        sameTopicAs?: QueuedConversationTurn;
        takeInMs?: number;
        usableUntil?: Date;
      } = {},
    ) {
      const turn = await subject.turn(options.sameTopicAs);
      const queued = await turns.queue.enqueue(turn, {
        inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
        attempt: 1,
        takeBy: new Date(clock + (options.takeInMs ?? 30_000)),
        now: at(),
        ...(options.usableUntil === undefined
          ? {}
          : { usableUntil: options.usableUntil }),
      });
      expect(queued).toBe("queued");
      return turn;
    },
    /** The next turn, which the test expects there to be. */
    async take(runtimeId = runtimeA): Promise<ConversationRuntimeTurn> {
      const turn = await turns.nextTurn({ runtimeId, waitMs: 0 });
      if (turn === null) throw new Error("no turn was taken");
      return turn;
    },
    report(
      taken: ConversationRuntimeTurn,
      result = done,
      runtimeId = runtimeA,
    ) {
      return turns.turnResult({
        runtimeId,
        turnId: taken.turn_id,
        leaseId: taken.lease_id,
        result,
      });
    },
  };
}

/**
 * The turn queue's rules, whichever queue holds the turns: the one in memory
 * and the one in the database answer each of these the same.
 */
export function conversationTurnQueueContract(
  name: string,
  subjectOf: () => Promise<ConversationTurnQueueSubject>,
): void {
  describe(`conversation turn queue contract: ${name}`, () => {
    let subject: ConversationTurnQueueSubject;
    beforeEach(async () => {
      subject = await subjectOf();
    }, 60_000);

    test("a runtime takes the oldest waiting turn with a lease, its scope and its one-call permit", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      const second = await h.enqueue();

      const taken = await h.take();

      expect(taken).toMatchObject({
        turn_id: first.turn_id,
        scope: first.scope,
        provider: first.provider,
        call: first.call,
        input: first.input,
        fresh_input: first.fresh_input,
        lease_expires_at: new Date(
          START.getTime() + CONVERSATION_TURN_LEASE_MS,
        ).toISOString(),
      });
      expect(taken.lease_id).toMatch(/^[0-9a-f-]{36}$/);
      // The first is held, so the next poll gets the second and a third nothing.
      expect((await h.take(runtimeB)).turn_id).toBe(second.turn_id);
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeB, waitMs: 0 }),
      ).toBeNull();
    });

    test("the holder's report ends the turn, and the same report again changes nothing", async () => {
      const h = harness(subject);
      const turn = await h.enqueue();
      const taken = await h.take();

      expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
      expect(await h.report(taken)).toBe("recorded");
      expect(await h.report(taken)).toBe("duplicate");
      expect(
        await h.report(taken, { outcome: "completed", text: "another" }),
      ).toBe("conflict");
      expect(await h.turns.ended(turn.turn_id)).toEqual(done);
    });

    test("a report under another lease or from another runtime is refused, and the holder's still lands", async () => {
      const h = harness(subject);
      const turn = await h.enqueue();
      const taken = await h.take();

      expect(await h.report(taken, done, runtimeB)).toBe("not_holder");
      expect(
        await h.report({
          ...taken,
          lease_id: conversationTurnLeaseIdSchema.parse(crypto.randomUUID()),
        }),
      ).toBe("not_holder");
      expect(
        await h.report({
          ...taken,
          turn_id: conversationTurnIdSchema.parse(crypto.randomUUID()),
        }),
      ).toBe("unknown_turn");
      expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
      expect(await h.report(taken)).toBe("recorded");
    });

    test("a lease that ends closes the turn as failed: the late report is refused and the turn is never handed out again", async () => {
      const h = harness(subject);
      const turn = await h.enqueue();
      const taken = await h.take();

      h.advance(CONVERSATION_TURN_LEASE_MS - 1);
      expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBe("pending");
      h.advance(1);

      const expired = { outcome: "failed", reason: "lease_expired" } as const;
      expect(await h.turns.ended(turn.turn_id)).toEqual(expired);
      expect(await h.report(taken)).toBe("lease_expired");
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeB, waitMs: 0 }),
      ).toBeNull();
      expect(await h.turns.ended(turn.turn_id)).toEqual(expired);
    });

    test("a turn no runtime takes in time ends as not taken, and none takes it after", async () => {
      const h = harness(subject);
      const turn = await h.enqueue({ takeInMs: 30_000 });

      h.advance(30_000);

      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();
      expect(await h.turns.ended(turn.turn_id)).toEqual({
        outcome: "failed",
        reason: "not_taken",
      });
    });

    test("a topic's second turn waits while its first is out, and is taken once that one ends", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      const second = await h.enqueue({ sameTopicAs: first });
      const other = await h.enqueue();

      const a = await h.take();
      // The second is older than the other topic's, but its topic is busy.
      const b = await h.take();
      expect([a.turn_id, b.turn_id]).toEqual([first.turn_id, other.turn_id]);
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();

      await h.report(a);
      expect((await h.take()).turn_id).toBe(second.turn_id);
    });

    test("a turn queued behind its topic's turn waits its take time again from that turn's end", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      const second = await h.enqueue({ sameTopicAs: first });
      const a = await h.take();

      // Past the second's own take time, while the first is still out.
      h.advance(60_000);
      expect(await h.turns.queue.outcome(second.turn_id, h.at())).toBe(
        "pending",
      );
      await h.report(a);
      h.advance(29_000);
      expect((await h.take()).turn_id).toBe(second.turn_id);
    });

    test("one queued behind its topic's turn is not taken once a whole lease would outlast its permit", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      const late = await h.enqueue({
        sameTopicAs: first,
        usableUntil: new Date(
          h.at().getTime() + 30_000 + CONVERSATION_TURN_LEASE_MS,
        ),
      });
      const a = await h.take();
      h.advance(31_000);
      await h.report(a);
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();
      expect(await h.turns.queue.outcome(late.turn_id, h.at())).toEqual({
        outcome: "failed",
        reason: "not_taken",
      });

      // Freed in time, the next one is taken with its whole lease inside its permit.
      const second = await h.enqueue();
      const soon = await h.enqueue({
        sameTopicAs: second,
        usableUntil: new Date(
          h.at().getTime() + 30_000 + CONVERSATION_TURN_LEASE_MS,
        ),
      });
      const b = await h.take();
      h.advance(20_000);
      await h.report(b);
      expect((await h.take()).turn_id).toBe(soon.turn_id);
    });

    test("one queued behind a turn whose lease runs out waits from the lease's end", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      const second = await h.enqueue({ sameTopicAs: first });
      await h.take();
      h.advance(CONVERSATION_TURN_LEASE_MS);
      expect(await h.turns.queue.outcome(first.turn_id, h.at())).toEqual({
        outcome: "failed",
        reason: "lease_expired",
      });
      h.advance(30_000);
      expect(await h.turns.queue.outcome(second.turn_id, h.at())).toEqual({
        outcome: "failed",
        reason: "not_taken",
      });
    });

    test("an input's attempt is queued once; a retry under the next number is a turn of its own, run after the first", async () => {
      const h = harness(subject);
      const inputId: ConversationInputId = conversationInputIdSchema.parse(
        crypto.randomUUID(),
      );
      const entry = (attempt: number) => ({
        inputId,
        attempt,
        takeBy: new Date(h.at().getTime() + 30_000),
        now: h.at(),
      });
      const first = await subject.turn();
      // The same event again, as another turn of the same topic.
      const again = await subject.turn(first);
      const retry = await subject.turn(first);

      expect(await h.turns.queue.enqueue(first, entry(1))).toBe("queued");
      expect(await h.turns.queue.enqueue(again, entry(1))).toBe("duplicate");
      expect(await h.turns.queue.enqueue(retry, entry(2))).toBe("queued");
      await expect(h.turns.queue.enqueue(first, entry(3))).rejects.toThrow(
        /already queued/,
      );
      await expect(
        h.turns.queue.enqueue(await subject.turn(), entry(0)),
      ).rejects.toThrow(/attempt/);

      const a = await h.take();
      expect(a.turn_id).toBe(first.turn_id);
      // The retry is of the same topic: it waits for the first to end.
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();
      await h.report(a, { outcome: "failed", reason: "engine_failed" });
      expect((await h.take()).turn_id).toBe(retry.turn_id);
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();
      expect(await h.turns.queue.outcome(again.turn_id, h.at())).toBeNull();
    });

    test("ten minutes after its end a turn is forgotten, and its input's attempt is still not queued again", async () => {
      const h = harness(subject);
      const inputId = conversationInputIdSchema.parse(crypto.randomUUID());
      const turn = await subject.turn();
      await h.turns.queue.enqueue(turn, {
        inputId,
        attempt: 1,
        takeBy: new Date(h.at().getTime() + 30_000),
        now: h.at(),
      });
      const taken = await h.take();
      expect(await h.report(taken)).toBe("recorded");

      h.advance(ENDED_TURN_KEPT_MS - 1);
      expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toEqual(done);
      h.advance(1);
      // A poll sweeps the queue.
      expect(
        await h.turns.nextTurn({ runtimeId: runtimeA, waitMs: 0 }),
      ).toBeNull();
      expect(await h.turns.queue.outcome(turn.turn_id, h.at())).toBeNull();
      expect(await h.report(taken)).toBe("unknown_turn");
      expect(
        await h.turns.queue.enqueue(await subject.turn(turn), {
          inputId,
          attempt: 1,
          takeBy: new Date(h.at().getTime() + 30_000),
          now: h.at(),
        }),
      ).toBe("duplicate");
    });

    test("a turn behind one that is forgotten still waits from that one's end", async () => {
      const h = harness(subject);
      const first = await h.enqueue();
      // Its take time outlasts the first's being remembered.
      const second = await h.enqueue({
        sameTopicAs: first,
        takeInMs: 11 * 60_000,
      });
      const a = await h.take();
      h.advance(2 * 60_000);
      await h.report(a);

      h.advance(ENDED_TURN_KEPT_MS + 30_000);
      // Past its own take time, inside its take time again from the first's end.
      expect((await h.take()).turn_id).toBe(second.turn_id);
      expect(await h.turns.queue.outcome(first.turn_id, h.at())).toBeNull();
    });

    test("a turn id is queued once, and an unknown one has no end", async () => {
      const h = harness(subject);
      const turn = await h.enqueue();
      await expect(
        h.turns.queue.enqueue(turn, {
          inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
          attempt: 1,
          takeBy: new Date(h.at().getTime() + 30_000),
        }),
      ).rejects.toThrow(/already queued/);
      expect(
        await h.turns.ended(
          conversationTurnIdSchema.parse(crypto.randomUUID()),
        ),
      ).toBeNull();
    });
  });
}
