import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { expireOverdueTerminations } from "../control-unit-of-work.ts";
import {
  createPostgresSchedulerStore,
  OVERDUE_TERMINATION_SWEEP_LIMIT,
} from "../scheduler/scheduler-store.ts";
import * as schema from "../schema.ts";
import { controlIntents, receipts, sessions, turns } from "../schema.ts";
import {
  expireOverdueInterrupts,
  settleTurnInterrupts,
} from "./turn-interrupts.ts";

/**
 * a reconciler back from a long stop finds a backlog of overdue
 * receipts. Each pass flips at most RECONCILER_BATCH_SIZE of them, so the
 * statement stays inside the pass timeout, and the next pass takes the rest.
 * The scheduler's terminate sweep has its own fixed batch.
 */

const LIMIT = 2;
const DEADLINE_MS = 60_000;
const LONG_AGO = new Date(Date.now() - 60 * 60_000);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

async function acceptedReceipt(operation: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(receipts).values({
    id,
    ownerId: "owner-a",
    operation,
    targetRef: { session_id: "session-a" },
    createdAt: LONG_AGO,
  });
  return id;
}

async function overdueInterrupts(count: number): Promise<void> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-a",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${sessionId}`,
  });
  const [turn] = await db
    .insert(turns)
    .values({ sessionId, sequence: 1, message: "m1", status: "running" })
    .returning({ id: turns.id });
  if (!turn) throw new Error("no turn");
  for (let index = 0; index < count; index += 1) {
    await db.insert(controlIntents).values({
      id: crypto.randomUUID(),
      sessionId,
      kind: "interrupt",
      targetTurnId: turn.id,
      attemptId: "attempt-a",
      receiptId: await acceptedReceipt("interrupt"),
      issuedAt: LONG_AGO,
    });
  }
}

async function unknownCount(): Promise<number> {
  return (
    await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.status, "unknown"))
  ).length;
}

describe("overdue receipt expiry takes one batch per call", () => {
  test("interrupts: limit now, the rest on the next call", async () => {
    await overdueInterrupts(LIMIT + 1);
    const expire = (dryRun: boolean) =>
      expireOverdueInterrupts(db, {
        now: new Date(),
        deadlineMs: DEADLINE_MS,
        dryRun,
        limit: LIMIT,
      });

    expect(await expire(true)).toBe(LIMIT);
    expect(await unknownCount()).toBe(0);
    expect(await expire(false)).toBe(LIMIT);
    expect(await unknownCount()).toBe(LIMIT);
    expect(await expire(false)).toBe(1);
    expect(await unknownCount()).toBe(LIMIT + 1);
    expect(await expire(false)).toBe(0);
  });

  test("terminations: limit now, the rest on the next call", async () => {
    await acceptedReceipt("terminate");
    await acceptedReceipt("revoke_execution");
    await acceptedReceipt("terminate");
    const expire = (dryRun: boolean) =>
      expireOverdueTerminations(db, {
        now: new Date(),
        deadlineMs: DEADLINE_MS,
        dryRun,
        limit: LIMIT,
      });

    expect(await expire(true)).toBe(LIMIT);
    expect(await unknownCount()).toBe(0);
    expect(await expire(false)).toBe(LIMIT);
    expect(await unknownCount()).toBe(LIMIT);
    expect(await expire(false)).toBe(1);
    expect(await unknownCount()).toBe(LIMIT + 1);
    expect(await expire(false)).toBe(0);
  });

  test("expired interrupt and terminate receipts log their final unknown result", async () => {
    await overdueInterrupts(1);
    const [interrupt] = await db
      .select({ id: controlIntents.id })
      .from(controlIntents);
    if (!interrupt) throw new Error("no interrupt intent");
    await acceptedReceipt("terminate");
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const now = new Date();

    await expireOverdueInterrupts(db, {
      now,
      deadlineMs: DEADLINE_MS,
      limit: LIMIT,
      logger,
    });
    await expireOverdueTerminations(db, {
      now,
      deadlineMs: DEADLINE_MS,
      limit: LIMIT,
      logger,
    });

    expect(sink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "control.result",
          fields: expect.objectContaining({
            control_id: interrupt.id,
            operation: "interrupt",
            outcome: "unknown",
            reason_code: "deadline_exceeded",
          }),
        }),
        expect.objectContaining({
          event: "control.result",
          fields: expect.objectContaining({
            operation: "terminate",
            outcome: "unknown",
            reason_code: "deadline_exceeded",
          }),
        }),
      ]),
    );
  });

  test("a control accepted after the worker terminal is still returned by receipt settlement", async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner-a",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId, sequence: 1, message: "m1", status: "running" })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    const receiptId = await acceptedReceipt("interrupt");
    const controlId = crypto.randomUUID();
    await db.insert(controlIntents).values({
      id: controlId,
      sessionId,
      kind: "interrupt",
      targetTurnId: turn.id,
      attemptId: "attempt-a",
      receiptId,
      issuedAt: LONG_AGO,
    });
    const effectiveAt = new Date();

    const results = await db.transaction((tx) =>
      settleTurnInterrupts(tx, {
        sessionId,
        turnRowId: turn.id,
        turnSequence: 1,
        terminal: "completed",
        terminalReason: null,
        at: effectiveAt,
      }),
    );

    expect(results).toEqual([
      expect.objectContaining({
        controlId,
        effectiveAt,
        operation: "interrupt",
        outcome: "completed",
        reasonCode: "no_op",
        sessionId,
      }),
    ]);
  });

  test("the scheduler sweep takes one batch per pass too", async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(receipts).values(
      Array.from({ length: OVERDUE_TERMINATION_SWEEP_LIMIT }, () => ({
        id: crypto.randomUUID(),
        ownerId: "owner-a",
        operation: "terminate",
        targetRef: { session_id: sessionId },
        createdAt: LONG_AGO,
      })),
    );
    const oldest = crypto.randomUUID();
    await db.insert(receipts).values({
      id: oldest,
      ownerId: "owner-a",
      operation: "terminate",
      targetRef: { session_id: sessionId },
      createdAt: new Date(LONG_AGO.getTime() - 60_000),
    });
    // The open-terminate index happens to yield created_at order; without it
    // the scan returns heap order, where the oldest comes last.
    await client.exec("DROP INDEX receipts_open_terminate_idx");
    const sink = new MemoryLogSink();
    const store = createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => Promise.reject(new Error("not used")),
      logger: new StructuredLogger({ sinks: [sink] }),
    });
    const sweep = () =>
      store.markOverdueTerminations({
        now: new Date(),
        deadlineMs: DEADLINE_MS,
      });

    expect(await sweep()).toBe(OVERDUE_TERMINATION_SWEEP_LIMIT);
    expect(await unknownCount()).toBe(OVERDUE_TERMINATION_SWEEP_LIMIT);
    expect(
      sink.records.filter(({ event }) => event === "control.result"),
    ).toHaveLength(OVERDUE_TERMINATION_SWEEP_LIMIT);
    const [first] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, oldest));
    expect(first?.status).toBe("unknown");
    expect(await sweep()).toBe(1);
    expect(
      sink.records.filter(({ event }) => event === "control.result"),
    ).toHaveLength(OVERDUE_TERMINATION_SWEEP_LIMIT + 1);
    expect(await sweep()).toBe(0);
  });
});
