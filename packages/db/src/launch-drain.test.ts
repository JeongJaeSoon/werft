import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import { executions, sessions, turns, workerLaunches } from "./schema.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { claimedSession as claimedTestSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

/**
 * a claimed worker whose resource an isolation contract bump made
 * stale is drained, not torn down mid-turn. The store's half: the request
 * stops new turns from being handed out, and says whether one is still open.
 */

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
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

function schedulerStore() {
  return createPostgresSchedulerStore(db, {
    sessionBudget: { costUsd: 1_000, tokens: null },
    connectForLock: async () => {
      throw new Error("not used");
    },
  });
}

/** A session with its first input, bound to a claimed, pinned launch. */
async function claimedSession() {
  const { sessionId, executionId, principal, scope } = await claimedTestSession(
    db,
    gateway,
    OWNER,
  );
  return { sessionId, ref: { executionId, generation: 1 }, principal, scope };
}

async function append(sessionId: string, message: string) {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message,
    limits: LIMITS,
  });
  expect(appended.outcome).toBe("accepted");
}

async function drainRequestedAt(executionId: string) {
  const [row] = await db
    .select({ at: workerLaunches.drainRequestedAt })
    .from(workerLaunches)
    .where(eq(workerLaunches.executionId, executionId));
  return row?.at ?? null;
}

describe("launch drain", () => {
  test("the turn running when the drain is asked for is the worker's last: open until it ends, and no new one is handed out", async () => {
    const { sessionId, ref, principal, scope } = await claimedSession();
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
    await append(sessionId, "second input");

    const store = schedulerStore();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: false,
    });
    const requestedAt = await drainRequestedAt(ref.executionId);
    expect(requestedAt).not.toBeNull();
    // Asked again: the first time stands.
    await store.requestDrain(ref, 60_000);
    expect(await drainRequestedAt(ref.executionId)).toEqual(requestedAt);

    // The turn it holds is still its own to finish, redelivered as ever.
    expect((await gateway.nextInput(principal, scope)).input?.turn_id).toBe(
      first.input.turn_id,
    );
    await gateway.finalize(principal, {
      ...scope,
      turn_id: first.input.turn_id,
      finalize_key: `${scope.attempt_id}:${first.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // The second input waits for the replacement.
    expect((await gateway.nextInput(principal, scope)).input).toBeNull();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: false,
      overdue: false,
    });
  });

  test("a worker still starting up is busy until its first poll, which hands it no turn", async () => {
    const { ref, principal, scope } = await claimedSession();
    const store = schedulerStore();
    // Claimed and restoring: torn down now, it would count as a failed startup.
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: false,
    });
    expect((await gateway.nextInput(principal, scope)).input).toBeNull();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: false,
      overdue: false,
    });
    const [session] = await db
      .select({
        restoreAttemptId: sessions.restoreAttemptId,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.executionId, ref.executionId));
    expect(session).toEqual({ restoreAttemptId: null, status: "queued" });
  });

  test("a drain older than the deadline is overdue, on the database clock", async () => {
    const { ref, principal, scope } = await claimedSession();
    expect((await gateway.nextInput(principal, scope)).input).not.toBeNull();
    const store = schedulerStore();
    await store.requestDrain(ref, 60_000);
    await db
      .update(workerLaunches)
      .set({ drainRequestedAt: new Date(Date.now() - 61_000) })
      .where(eq(workerLaunches.executionId, ref.executionId));
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: true,
    });
  });

  test("a launch with no binding, or asked to go, is not drained", async () => {
    const { ref } = await claimedSession();
    const store = schedulerStore();
    await db
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, ref.executionId));
    expect(await store.requestDrain(ref, 60_000)).toBeNull();
    expect(
      await store.requestDrain({ ...ref, generation: 2 }, 60_000),
    ).toBeNull();
    expect(await drainRequestedAt(ref.executionId)).toBeNull();
  });
});

describe("idle stop", () => {
  /** A claimed session whose first turn ran and finished. */
  async function idleSession(withCheckpoint = true) {
    const claimed = await claimedSession();
    const { principal, scope } = claimed;
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
    await gateway.finalize(principal, {
      ...scope,
      turn_id: first.input.turn_id,
      finalize_key: `${scope.attempt_id}:${first.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: withCheckpoint
        ? {
            revision: 0,
            manifest_ref: `manifests/${scope.session_id}/0`,
            manifest_sha256: "c".repeat(64),
          }
        : null,
    });
    return claimed;
  }

  test("an idle worker is listed, asked to stop, told so on its next poll, and handed no new input", async () => {
    const { sessionId, ref, principal, scope } = await idleSession();
    const store = schedulerStore();
    const listed = await store.idleWorkers("local_docker");
    expect(listed.stopping).toEqual([]);
    expect(listed.idle.map((w) => w.executionId)).toEqual([ref.executionId]);
    expect(listed.idle[0]?.sessionId).toBe(sessionId);

    expect(await store.requestIdleStop(ref)).toBe(true);
    expect(await drainRequestedAt(ref.executionId)).not.toBeNull();
    // Asked once: a second ask finds it already on its way out.
    expect(await store.requestIdleStop(ref)).toBe(false);
    expect((await store.idleWorkers("local_docker")).stopping).toEqual([
      { ...ref, image: expect.anything(), sessionId },
    ]);

    await append(sessionId, "after the stop");
    const next = await gateway.nextInput(principal, scope);
    expect(next.input).toBeNull();
    expect(next.draining).toBe(true);
  });

  test("a worker with a turn open is not idle, nor one awaiting a person's answer", async () => {
    const { sessionId, ref, principal, scope } = await claimedSession();
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
    const store = schedulerStore();
    expect((await store.idleWorkers("local_docker")).idle).toEqual([]);
    expect(await store.requestIdleStop(ref)).toBe(false);

    await db
      .update(turns)
      .set({ status: "needs_input" })
      .where(eq(turns.sessionId, sessionId));
    expect((await store.idleWorkers("local_docker")).idle).toEqual([]);
    expect(await store.requestIdleStop(ref)).toBe(false);
    expect(await drainRequestedAt(ref.executionId)).toBeNull();
  });

  test("a worker still starting up, or with input queued for it, is not idle", async () => {
    const { ref } = await claimedSession();
    const store = schedulerStore();
    // Claimed, first input queued, no poll yet.
    expect((await store.idleWorkers("local_docker")).idle).toEqual([]);
    expect(await store.requestIdleStop(ref)).toBe(false);

    const idle = await idleSession();
    await append(idle.sessionId, "queued for it");
    expect(
      (await store.idleWorkers("local_docker")).idle.map((w) => w.executionId),
    ).not.toContain(idle.ref.executionId);
    expect(await store.requestIdleStop(idle.ref)).toBe(false);
  });

  test("a worker whose last turn no checkpoint covers is not asked to stop", async () => {
    const { ref } = await idleSession(false);
    const store = schedulerStore();
    expect(await store.requestIdleStop(ref)).toBe(false);
    expect(await drainRequestedAt(ref.executionId)).toBeNull();
  });

  test("a session whose checkpoint did not commit is not idle", async () => {
    const { sessionId, ref } = await idleSession();
    await db
      .update(sessions)
      .set({ checkpointPendingReason: "checkpoint_failed" })
      .where(eq(sessions.id, sessionId));
    const store = schedulerStore();
    expect((await store.idleWorkers("local_docker")).idle).toEqual([]);
    expect(await store.requestIdleStop(ref)).toBe(false);
  });

  test("idle workers come longest idle first", async () => {
    const a = await idleSession();
    const b = await idleSession();
    await db
      .update(turns)
      .set({ endedAt: new Date(Date.now() - 60_000) })
      .where(eq(turns.sessionId, b.sessionId));
    await db
      .update(workerLaunches)
      .set({ slotReservedAt: new Date(Date.now() - 120_000) });
    const store = schedulerStore();
    expect(
      (await store.idleWorkers("local_docker")).idle.map((w) => w.executionId),
    ).toEqual([b.ref.executionId, a.ref.executionId]);
  });
});
