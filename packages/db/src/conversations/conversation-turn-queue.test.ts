import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CONVERSATION_TURN_LEASE_MS,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import {
  derivedSecretKey,
  openWithKey,
  SecretKey,
} from "@werft-ai/platform";
import { conversationTurnQueueContract } from "@werft-ai/platform/testing/conversation-turn-queue";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { conversationTurnQueueFixture } from "../testing/conversation-turn-queue.ts";
import { createPostgresConversationTurnQueue } from "./conversation-turn-queue.ts";

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

  test("holds the waiting turn sealed, and keeps its input alone once the turn is leased", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const secret = key();
    const queue = createPostgresConversationTurnQueue(db, secret);
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
    // What stays while it runs is its input alone, for a task it may ask
    // for (v1-b/E3): never its permit.
    const kept = await client.query<{
      nonce: Uint8Array;
      ciphertext: Uint8Array;
    }>(
      "SELECT turn_nonce AS nonce, turn_ciphertext AS ciphertext FROM conversation_turn_queue WHERE turn_id = $1",
      [turn.turn_id],
    );
    const opened = openWithKey(
      derivedSecretKey(secret, "conversation-turn-queue"),
      Buffer.from(`conversation_turn_queue|${turn.turn_id}`, "utf8"),
      {
        nonce: Buffer.from(kept.rows[0]?.nonce ?? []),
        ciphertext: Buffer.from(kept.rows[0]?.ciphertext ?? []),
      },
    );
    expect(JSON.parse(opened)).toEqual({ input: turn.input });
    expect(opened).not.toContain(turn.provider.auth.token);
  }, 60_000);

  test("a leased turn an older image ends keeps no copy past the deadline", async () => {
    const { client, db } = await database();
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(db, key());
    const turn = await fixture.turn();
    await queue.enqueue(turn, entry());
    await queue.lease({ runtimeId, now, leaseMs: CONVERSATION_TURN_LEASE_MS });
    // An older image's lease-expired sweep, which clears no ciphertext.
    await client.query(
      `UPDATE conversation_turn_queue SET state = 'ended',
         outcome = '{"outcome":"failed","reason":"lease_expired"}'::jsonb,
         ended_at = now() WHERE turn_id = $1`,
      [turn.turn_id],
    );
    await queue.outcome(turn.turn_id, new Date(now.getTime() + 61 * 60_000));
    const left = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_turn_queue WHERE turn_nonce IS NOT NULL OR input_kept_until IS NOT NULL",
    );
    expect(left.rows[0]?.n).toBe("0");
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
});
