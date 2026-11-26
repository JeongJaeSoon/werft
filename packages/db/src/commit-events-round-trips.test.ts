import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { WorkerEvent } from "@werft-ai/contracts";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, isNotNull, max } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { encodeEventCursor } from "./cursors.ts";
import * as schema from "./schema.ts";
import { events } from "./schema.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

/**
 * What one append-events call costs in round trips. Each of them is sent
 * while the call holds the session row lock, and a turn makes about nine such
 * calls, so the numbers below are a budget: lower them when a statement goes
 * away, and raise them only for a statement the call cannot do without.
 */

const OWNER = testCaller("00000000-0000-4000-8000-00000000000c");
const CATALOG: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { stored: "connection:test-connection" },
    },
  },
  models: ["claude-sonnet-5"],
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: WorkerGateway;
let statements: string[];

beforeEach(async () => {
  client = await migratedPGlite();
  statements = [];
  db = drizzle(client, {
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  });
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

// One instant for every event: a replay must carry the bytes it first sent.
const OCCURRED_AT = new Date().toISOString();

function event(sourceSequence: number): WorkerEvent {
  return {
    event: "status",
    data: { phase: "running" },
    source_sequence: sourceSequence,
    occurred_at: OCCURRED_AT,
  };
}

/** A worker running its session's first turn, and a way to append to it. */
async function runningTurn() {
  const worker = await claimedSession(db, gateway, OWNER);
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  const turnId = next.input.turn_id;
  return {
    sessionId: worker.sessionId,
    // A row no append would write: a sequence stored past a hole.
    store: (sourceSequence: number) =>
      db.insert(events).values({
        sessionId: worker.sessionId,
        type: "status",
        payload: { phase: "running" },
        attemptId: worker.scope.attempt_id,
        sourceSequence,
        occurredAt: new Date(OCCURRED_AT),
      }),
    append: (sequences: number[]) =>
      gateway.appendEvents(worker.principal, {
        ...worker.scope,
        turn_id: turnId,
        batch_key: sequences.join(","),
        events: sequences.map(event),
      }),
  };
}

/** The statements one call sends; PGlite opens and closes the transaction itself. */
async function counted<T>(call: () => Promise<T>) {
  statements.length = 0;
  const result = await call();
  return { result, sent: statements.length };
}

async function newestWorkerEvent(sessionId: string) {
  const [row] = await db
    .select({ id: max(events.id) })
    .from(events)
    .where(
      and(eq(events.sessionId, sessionId), isNotNull(events.sourceSequence)),
    );
  return row?.id ?? 0;
}

describe("append-events round trips", () => {
  test("a fresh batch reads the attempt's stream once before the write and once after", async () => {
    const turn = await runningTurn();
    await turn.append([1]);
    const { result, sent } = await counted(() => turn.append([2, 3]));
    expect(result.accepted_through).toBe(3);
    expect(result.cursor).toBe(
      encodeEventCursor(await newestWorkerEvent(turn.sessionId)),
    );
    expect(sent).toBe(9);
  });

  test("a replayed batch writes nothing and reads the stream once", async () => {
    const turn = await runningTurn();
    const first = await turn.append([1, 2]);
    const { result, sent } = await counted(() => turn.append([1, 2]));
    expect(result).toEqual(first);
    expect(sent).toBe(7);
  });

  test("a batch past a hole is refused with how far the stream runs", async () => {
    const turn = await runningTurn();
    await turn.append([1, 2]);
    const refused = await turn.append([4]).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(refused?.message).toContain("resume from source_sequence 3");
    const extended = await turn.append([3]);
    expect(extended.accepted_through).toBe(3);
  });

  test("a stream stored with a hole is durable up to the hole, and past it once the hole is filled", async () => {
    const turn = await runningTurn();
    await turn.append([1, 2]);
    await turn.store(4);
    expect((await turn.append([1, 2])).accepted_through).toBe(2);
    expect((await turn.append([3])).accepted_through).toBe(4);
  });

  test("a stream that does not start at 1 has nothing durable, whatever sequence it holds", async () => {
    const turn = await runningTurn();
    // The largest integer: its successor cannot be computed, and is not.
    await turn.store(2_147_483_647);
    const refused = await turn.append([5]).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(refused?.message).toContain("resume from source_sequence 1");
  });
});
