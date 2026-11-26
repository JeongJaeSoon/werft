import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type SessionCatalog,
  WORKER_LEASE_LOST_END_REASON,
  type WorkerGateway,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { fromDbNow } from "./db-clock.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  deletedSources,
  sessions,
  turns,
  workspaces,
} from "./schema.ts";
import { CUT_OFF_INPUT_LINE } from "./sessions/cut-off-input.ts";
import { testWorkerGateway, workerOf } from "./testing/gateway.ts";
import { launchSession } from "./testing/launches.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * The turn right after one its worker's lost lease cut off is handed the
 * cut-off turn's input first: that input came after the checkpoint the next
 * turn starts from.
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
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };
const PREPENDED = `${CUT_OFF_INPUT_LINE}\n\nfirst input\n\nsecond input`;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

/** A session whose first turn ("first input") a claimed worker is running. */
async function runningTurn() {
  const worker = await claimedSession(db, gateway, OWNER);
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  return worker;
}

/** The worker gives its lease up and the scheduler sees it gone. */
async function cutOff(worker: {
  executionId: string;
  scope: { attempt_id: string };
}) {
  await db
    .update(attempts)
    .set({ leaseExpiresAt: fromDbNow(-1_000) })
    .where(eq(attempts.id, worker.scope.attempt_id));
  await createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
    executionId: worker.executionId,
    now: new Date(),
    endReason: WORKER_LEASE_LOST_END_REASON,
  });
}

/** A new worker on the session, as the scheduler launches the next one. */
async function nextWorker(sessionId: string) {
  const { executionId, generation, nonce } = await launchSession(db, {
    sessionId,
  });
  const claimed = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    },
  );
  return workerOf(claimed, executionId);
}

async function delivered(worker: Awaited<ReturnType<typeof nextWorker>>) {
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  return next.input;
}

const send = async (sessionId: string, message: string) => {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message,
    limits: LIMITS,
  });
  expect(appended.outcome).toBe("accepted");
};

async function recordOf(sessionId: string, sequence: number) {
  const [row] = await db
    .select({
      turn: turns.prependedTurn,
      skipped: turns.prependSkipReason,
      message: turns.message,
    })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
  return row;
}

const publicTurn = (sessionId: string, turnId: string) =>
  createPostgresSessionReader(db).getTurn(OWNER.ownerId, sessionId, turnId);

/** Gives the cut-off first turn a direct source the next delivery reads. */
async function sourceOfFirstTurn(sessionId: string, source: object) {
  await db
    .update(turns)
    .set({ sources: { direct: [source], inherited: [] } as never })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
}

describe("the turn right after a cut-off turn", () => {
  test("a message sent after the cut gets the cut-off input first, recorded on the turn", async () => {
    const worker = await runningTurn();
    await cutOff(worker);
    await send(worker.sessionId, "second input");

    const input = await delivered(await nextWorker(worker.sessionId));
    expect(input.turn_id).toBe("2");
    expect(input.message).toBe(PREPENDED);
    // The turn as sent stays as typed; only the record names the cut turn.
    expect(await recordOf(worker.sessionId, 2)).toEqual({
      turn: 1,
      skipped: null,
      message: "second input",
    });
    expect(await publicTurn(worker.sessionId, "2")).toMatchObject({
      message: "second input",
      prepended_turn_id: "1",
    });
    expect(await publicTurn(worker.sessionId, "1")).toMatchObject({
      prepended_turn_id: null,
    });
  });

  test("a message that waited behind the turn gets it too", async () => {
    const worker = await runningTurn();
    await send(worker.sessionId, "second input");
    await cutOff(worker);

    const input = await delivered(await nextWorker(worker.sessionId));
    expect(input.turn_id).toBe("2");
    expect(input.message).toBe(PREPENDED);
  });

  test("a redelivery gives the same input, the cut-off one once", async () => {
    const worker = await runningTurn();
    await cutOff(worker);
    await send(worker.sessionId, "second input");
    const next = await nextWorker(worker.sessionId);

    const first = await delivered(next);
    const again = await delivered(next);
    expect(again).toEqual(first);
    expect(again.message.split(CUT_OFF_INPUT_LINE)).toHaveLength(2);
    expect(await recordOf(worker.sessionId, 2)).toMatchObject({
      turn: 1,
      skipped: null,
    });
  });

  test("a turn after the next one gets nothing put first", async () => {
    const worker = await runningTurn();
    await send(worker.sessionId, "second input");
    await send(worker.sessionId, "third input");
    await cutOff(worker);
    const next = await nextWorker(worker.sessionId);
    await delivered(next);
    expect(await recordOf(worker.sessionId, 3)).toMatchObject({
      turn: null,
      skipped: null,
    });
  });

  test("the continuation ([Continue]) runs the cut-off input alone", async () => {
    const worker = await runningTurn();
    await cutOff(worker);
    const continued = await createPostgresSessionUnitOfWork(
      db,
    ).appendInputAtomic({
      principal: { ...OWNER, requestId: crypto.randomUUID() },
      sessionId: worker.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "continue:1",
      message: "",
      continueTurn: 1,
      limits: LIMITS,
    });
    expect(continued.outcome).toBe("accepted");

    const input = await delivered(await nextWorker(worker.sessionId));
    expect(input.turn_id).toBe("2");
    expect(input.message).toBe("first input");
    expect(await recordOf(worker.sessionId, 2)).toMatchObject({
      turn: 1,
      skipped: "continuation",
    });
    expect(await publicTurn(worker.sessionId, "2")).toMatchObject({
      prepended_turn_id: null,
    });
  });
});

describe("a cut-off input that cannot be given again", () => {
  test("deleted in Slack or by an admin: left out, recorded, and a redelivery leaves it out too", async () => {
    const worker = await runningTurn();
    await send(worker.sessionId, "second input");
    const workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, worker.sessionId));
    const place = { team_id: "T1", channel_id: "C1", ts: "1700000000.000100" };
    await sourceOfFirstTurn(worker.sessionId, place);
    await db.insert(deletedSources).values({
      workspaceId,
      teamId: place.team_id,
      channelId: place.channel_id,
      ts: place.ts,
      deletedAt: new Date(),
      reason: "slack_deleted" as never,
    });
    await cutOff(worker);
    const next = await nextWorker(worker.sessionId);

    expect((await delivered(next)).message).toBe("second input");
    expect(await recordOf(worker.sessionId, 2)).toMatchObject({
      turn: 1,
      skipped: "deleted_source",
    });
    // Even once the mark is gone, the redelivery decides as the first did.
    await db.delete(deletedSources);
    expect((await delivered(next)).message).toBe("second input");
  });

  test("a web input no longer readable where it is kept: left out and recorded", async () => {
    const worker = await runningTurn();
    await send(worker.sessionId, "second input");
    await sourceOfFirstTurn(worker.sessionId, {
      input_id: crypto.randomUUID(),
    });
    await cutOff(worker);
    const next = await nextWorker(worker.sessionId);

    expect((await delivered(next)).message).toBe("second input");
    expect(await recordOf(worker.sessionId, 2)).toMatchObject({
      turn: 1,
      skipped: "unreadable_web_input",
    });
    expect((await delivered(next)).message).toBe("second input");
  });
});
