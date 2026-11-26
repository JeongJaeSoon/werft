import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CONVERSATION_TURN_LEASE_MS,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import { SecretKey } from "@werft-ai/platform";
import { conversationTurnQueueContract } from "@werft-ai/platform/testing/conversation-turn-queue";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { conversationTurnQueueFixture } from "../testing/conversation-turn-queue.ts";
import {
  CONVERSATION_TURN_QUEUE_CHANNEL,
  createPostgresConversationTurnQueue,
} from "./conversation-turn-queue.ts";

const key = () =>
  SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

async function database() {
  const client = await migratedPGlite();
  return { client, db: drizzle(client, { schema }) as unknown as Database };
}

conversationTurnQueueContract("database (PGlite)", async () => {
  const { db } = await database();
  const fixture = await conversationTurnQueueFixture(db);
  return {
    queue: createPostgresConversationTurnQueue(db, key()),
    turn: fixture.turn,
  };
});

describe("the conversation turn queue in the database (0355)", () => {
  const runtimeId = conversationRuntimeIdSchema.parse(crypto.randomUUID());
  const now = new Date("2026-11-24T00:00:00.000Z");
  const entry = () => ({
    inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
    attempt: 1,
    takeBy: new Date(now.getTime() + 30_000),
    now,
  });

  test("is durable, so turns may be dispatched over it", async () => {
    const { db } = await database();
    expect(createPostgresConversationTurnQueue(db, key()).durable).toBe(true);
  }, 60_000);

  test("holds the waiting turn sealed, and clears it once the turn is leased", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const turn = await fixture.turn();
    await queue.enqueue(turn, entry());

    const sealed = await client.query<{ ciphertext: Uint8Array }>(
      "SELECT turn_ciphertext AS ciphertext FROM conversation_turn_queue WHERE turn_id = $1",
      [turn.turn_id],
    );
    const stored = Buffer.from(sealed.rows[0]?.ciphertext ?? []).toString(
      "latin1",
    );
    expect(stored.length).toBeGreaterThan(0);
    // Neither the permit nor the context is there to read.
    if (turn.provider.auth.kind !== "egress_token") throw new Error("auth");
    expect(stored).not.toContain(turn.provider.auth.token);
    expect(stored).not.toContain(turn.fresh_input.text);

    const taken = await queue.lease({
      runtimeId,
      now,
      leaseMs: CONVERSATION_TURN_LEASE_MS,
    });
    expect(taken?.provider).toEqual(turn.provider);
    const after = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_turn_queue WHERE turn_nonce IS NOT NULL OR turn_ciphertext IS NOT NULL",
    );
    expect(after.rows[0]?.n).toBe("0");
  }, 60_000);

  test("a turn sealed under another key is ended as not taken, and the next one is still handed out", async () => {
    const { db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const first = await fixture.turn();
    const second = await fixture.turn();
    await createPostgresConversationTurnQueue(db, key()).enqueue(
      first,
      entry(),
    );
    const queue = createPostgresConversationTurnQueue(db, key());
    await queue.enqueue(second, entry());

    const taken = await queue.lease({
      runtimeId,
      now,
      leaseMs: CONVERSATION_TURN_LEASE_MS,
    });
    expect(taken?.turn_id).toBe(second.turn_id);
    expect(await queue.outcome(first.turn_id, now)).toEqual({
      outcome: "failed",
      reason: "not_taken",
    });
  }, 60_000);

  test("a forgotten turn's row keeps ids and times alone", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const turn = await fixture.turn();
    await queue.enqueue(turn, entry());
    const taken = await queue.lease({
      runtimeId,
      now,
      leaseMs: CONVERSATION_TURN_LEASE_MS,
    });
    if (taken === null) throw new Error("not taken");
    await queue.report({
      turnId: turn.turn_id,
      leaseId: taken.lease_id,
      runtimeId,
      result: { outcome: "completed", text: "the answer" },
      now,
    });
    await queue.outcome(turn.turn_id, new Date(now.getTime() + 10 * 60_000));
    const rows = await client.query(
      "SELECT state, outcome, lease_id = $2 AS same_lease, turn_ciphertext FROM conversation_turn_queue WHERE turn_id = $1",
      [turn.turn_id, taken.lease_id],
    );
    expect(rows.rows).toEqual([
      {
        state: "forgotten",
        outcome: null,
        same_lease: true,
        turn_ciphertext: null,
      },
    ]);
  }, 60_000);

  test("a turn's row goes with the turn", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const turn = await fixture.turn();
    await queue.enqueue(turn, entry());
    await client.query("DELETE FROM conversation_turns WHERE id = $1", [
      turn.turn_id,
    ]);
    expect(await queue.outcome(turn.turn_id, now)).toBeNull();
  }, 60_000);

  test("tells its channel of a turn queued and of each turn's end, and of nothing else", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const told: string[] = [];
    await client.listen(CONVERSATION_TURN_QUEUE_CHANNEL, (payload) => {
      told.push(payload);
    });
    const lease = { runtimeId, now, leaseMs: CONVERSATION_TURN_LEASE_MS };

    const reported = await fixture.turn();
    const attempt = entry();
    await queue.enqueue(reported, attempt);
    // The same attempt again queues nothing, and tells nothing.
    expect(await queue.enqueue(await fixture.turn(reported), attempt)).toBe(
      "duplicate",
    );
    const taken = await queue.lease(lease);
    if (taken === null) throw new Error("not taken");
    // A lease is nobody's news: nothing waits for it.
    expect(told).toEqual(["queued"]);
    await queue.report({
      turnId: reported.turn_id,
      leaseId: taken.lease_id,
      runtimeId,
      result: { outcome: "completed", text: "answer" },
      now,
    });
    expect(told).toEqual(["queued", reported.turn_id]);

    const expired = await fixture.turn();
    await queue.enqueue(expired, entry());
    await queue.lease(lease);
    await queue.outcome(
      expired.turn_id,
      new Date(now.getTime() + CONVERSATION_TURN_LEASE_MS),
    );
    const untaken = await fixture.turn();
    await queue.enqueue(untaken, entry());
    await queue.outcome(untaken.turn_id, new Date(now.getTime() + 30_000));
    expect(told.slice(2)).toEqual([
      "queued",
      expired.turn_id,
      "queued",
      untaken.turn_id,
    ]);
  }, 60_000);

  test("says when it next changes by time alone, and changes then and not before", async () => {
    const { db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(await queue.nextTimedChange?.()).toBeNull();

    // A waiting turn of a free topic: its take time.
    const first = await fixture.turn();
    await queue.enqueue(first, entry());
    expect(await queue.nextTimedChange?.()).toEqual(at(30_000));

    // Out with a runtime: its lease's end. The one behind it has no time yet.
    const behind = await fixture.turn(first);
    await queue.enqueue(behind, entry());
    await queue.lease({ runtimeId, now, leaseMs: CONVERSATION_TURN_LEASE_MS });
    const leaseEnd = CONVERSATION_TURN_LEASE_MS;
    expect(await queue.nextTimedChange?.()).toEqual(at(leaseEnd));
    expect(await queue.outcome(first.turn_id, at(leaseEnd - 1))).toBe(
      "pending",
    );
    expect(await queue.outcome(first.turn_id, at(leaseEnd))).toEqual({
      outcome: "failed",
      reason: "lease_expired",
    });

    // Freed, the one behind waits its take time again from then.
    expect(await queue.nextTimedChange?.()).toEqual(at(leaseEnd + 30_000));
    expect(await queue.outcome(behind.turn_id, at(leaseEnd + 30_000 - 1))).toBe(
      "pending",
    );
    expect(await queue.outcome(behind.turn_id, at(leaseEnd + 30_000))).toEqual({
      outcome: "failed",
      reason: "not_taken",
    });
    expect(await queue.nextTimedChange?.()).toBeNull();

    // A permit a whole lease no longer fits comes before the take time.
    const permitted = await fixture.turn();
    await queue.enqueue(permitted, {
      ...entry(),
      usableUntil: at(CONVERSATION_TURN_LEASE_MS + 10_000),
    });
    expect(await queue.nextTimedChange?.()).toEqual(at(10_001));
    expect(await queue.outcome(permitted.turn_id, at(10_000))).toBe("pending");
    expect(await queue.outcome(permitted.turn_id, at(10_001))).toEqual({
      outcome: "failed",
      reason: "not_taken",
    });
  }, 60_000);
});
