import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CONVERSATION_TURN_LEASE_MS,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
} from "@werft-ai/contracts";
import { SecretKey } from "@werft-ai/platform";
import { conversationTurnQueueContract } from "@werft-ai/platform/testing/conversation-turn-queue";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { conversationTurnQueueFixture } from "../testing/conversation-turn-queue.ts";
import { createPostgresConversationTurnQueue } from "./conversation-turn-queue.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
const now = new Date("2026-11-24T00:00:00.000Z");
const lease = { now, leaseMs: CONVERSATION_TURN_LEASE_MS };
const entry = (
  attempt = 1,
  inputId = conversationInputIdSchema.parse(crypto.randomUUID()),
) => ({
  inputId,
  attempt,
  takeBy: new Date(now.getTime() + 30_000),
  now,
});
const runtime = () => conversationRuntimeIdSchema.parse(crypto.randomUUID());

let database: Promise<TempDatabase> | undefined;
const pools: Pool[] = [];
/** One API process: its own pool on the shared database. */
async function apiProcess(): Promise<{ db: Database; pool: Pool }> {
  database ??= createTempDatabase({ prefix: "turn_queue" });
  const pool = new Pool({ connectionString: (await database).url, max: 4 });
  pools.push(pool);
  return { db: drizzle(pool, { schema }), pool };
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await (await database)?.drop();
}, 60_000);

if (testDatabaseUrl()) {
  conversationTurnQueueContract("database (Postgres)", async () => {
    const { db, pool } = await apiProcess();
    // The queue is one for the installation: no turn of another test waits.
    await pool.query("DELETE FROM conversation_turn_queue");
    const fixture = await conversationTurnQueueFixture(db);
    return {
      queue: createPostgresConversationTurnQueue(db, key),
      turn: fixture.turn,
    };
  });
}

integration("the conversation turn queue across API processes (0355)", () => {
  test("a turn queued before a restart is still there, and the next runtime takes it", async () => {
    const before = await apiProcess();
    await before.pool.query("DELETE FROM conversation_turn_queue");
    const fixture = await conversationTurnQueueFixture(before.db);
    const turn = await fixture.turn();
    expect(
      await createPostgresConversationTurnQueue(before.db, key).enqueue(
        turn,
        entry(),
      ),
    ).toBe("queued");
    await before.pool.end();
    pools.splice(pools.indexOf(before.pool), 1);

    const after = await apiProcess();
    const queue = createPostgresConversationTurnQueue(after.db, key);
    const runtimeId = runtime();
    const taken = await queue.lease({ runtimeId, ...lease });
    expect(taken).toMatchObject({
      turn_id: turn.turn_id,
      provider: turn.provider,
      fresh_input: turn.fresh_input,
    });
    if (taken === null) throw new Error("not taken");
    expect(
      await queue.report({
        turnId: turn.turn_id,
        leaseId: taken.lease_id,
        runtimeId,
        result: { outcome: "completed", text: "answer" },
        now,
      }),
    ).toBe("recorded");
    expect(await queue.outcome(turn.turn_id, now)).toEqual({
      outcome: "completed",
      text: "answer",
    });
  }, 60_000);

  test("two API processes see one queue, and each turn is leased to one runtime once", async () => {
    const a = await apiProcess();
    const b = await apiProcess();
    await a.pool.query("DELETE FROM conversation_turn_queue");
    const fixture = await conversationTurnQueueFixture(a.db);
    const queues = [
      createPostgresConversationTurnQueue(a.db, key),
      createPostgresConversationTurnQueue(b.db, key),
    ];
    const turns = await Promise.all(
      Array.from({ length: 8 }, () => fixture.turn()),
    );
    for (const [index, turn] of turns.entries()) {
      await queues[index % 2]?.enqueue(turn, entry());
    }

    const taken = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        queues[index % 2]?.lease({ runtimeId: runtime(), ...lease }),
      ),
    );
    const ids = taken.flatMap((turn) => (turn ? [turn.turn_id] : []));
    expect(ids).toHaveLength(8);
    expect(new Set(ids)).toEqual(new Set(turns.map((turn) => turn.turn_id)));
  }, 60_000);

  test("two processes leasing at once hand out one turn of a topic, not both", async () => {
    const a = await apiProcess();
    const b = await apiProcess();
    await a.pool.query("DELETE FROM conversation_turn_queue");
    const fixture = await conversationTurnQueueFixture(a.db);
    const first = await fixture.turn();
    const second = await fixture.turn(first);
    const queueA = createPostgresConversationTurnQueue(a.db, key);
    const queueB = createPostgresConversationTurnQueue(b.db, key);
    await queueA.enqueue(first, entry());
    await queueB.enqueue(second, entry());

    const taken = await Promise.all([
      queueA.lease({ runtimeId: runtime(), ...lease }),
      queueB.lease({ runtimeId: runtime(), ...lease }),
    ]);
    expect(taken.flatMap((turn) => (turn ? [turn.turn_id] : []))).toEqual([
      first.turn_id,
    ]);
  }, 60_000);

  test("one event delivered twice to two processes queues one first attempt, and its retry goes in apart", async () => {
    const a = await apiProcess();
    const b = await apiProcess();
    await a.pool.query("DELETE FROM conversation_turn_queue");
    const fixture = await conversationTurnQueueFixture(a.db);
    const inputId = conversationInputIdSchema.parse(crypto.randomUUID());
    const first = await fixture.turn();
    const again = await fixture.turn(first);
    const retry = await fixture.turn(first);
    const queueA = createPostgresConversationTurnQueue(a.db, key);
    const queueB = createPostgresConversationTurnQueue(b.db, key);

    const results = await Promise.all([
      queueA.enqueue(first, entry(1, inputId)),
      queueB.enqueue(again, entry(1, inputId)),
      queueB.enqueue(retry, entry(2, inputId)),
    ]);
    expect([...results].sort()).toEqual(["duplicate", "queued", "queued"]);
    const rows = await a.pool.query<{ attempt: number }>(
      "SELECT attempt FROM conversation_turn_queue WHERE input_id = $1 ORDER BY attempt",
      [inputId],
    );
    expect(rows.rows.map((row) => row.attempt)).toEqual([1, 2]);
  }, 60_000);
});
