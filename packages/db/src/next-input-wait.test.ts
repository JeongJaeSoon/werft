import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { ENDED_ATTEMPT_STATES } from "@werft-ai/contracts";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import { attempts, sessions, turns } from "./schema.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * An idle worker's nextInput waits without the session row lock (94S-2243):
 * what the lock-free question answers, what notifies a waiting poll, and
 * that a poll woken that way still hands a turn out only under the fence.
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
const BUDGET = { costUsd: 1_000, tokens: null };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
/** Session ids notified on `session_events`, in order. */
let notified: string[];
let waiting: Set<{ sessionId: string; wake(): void }>;
/** How many waits a poll has begun, and how long each was to be. */
let waits: number;
let naps: number[];
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  notified = [];
  waiting = new Set();
  waits = 0;
  naps = [];
  await client.listen("session_events", (sessionId) => {
    notified.push(sessionId);
    for (const waiter of [...waiting]) {
      if (waiter.sessionId === sessionId) waiter.wake();
    }
  });
  const onAbort = (signal: AbortSignal | undefined, resolve: () => void) =>
    signal?.addEventListener("abort", () => resolve(), { once: true });
  gateway = testWorkerGateway(db, CATALOG, {
    wakeup: {
      listening: true,
      wait(sessionId, signal) {
        return new Promise<void>((resolve) => {
          const waiter = { sessionId, wake: resolve };
          waiting.add(waiter);
          signal.addEventListener("abort", () => waiting.delete(waiter), {
            once: true,
          });
          onAbort(signal, resolve);
        });
      },
    },
    options: {
      sessionBudget: BUDGET,
      leaseTtlMs: 60_000,
      // The interval never passes: only a notification ends a wait, so a
      // poll nothing notifies runs into the test's timeout.
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          waits += 1;
          naps.push(ms);
          onAbort(signal, resolve);
        }),
    },
  });
});

afterEach(async () => {
  await client.close();
});

async function until(check: () => boolean) {
  for (let tries = 0; !check(); tries += 1) {
    if (tries > 2_000) throw new Error("never happened");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function schedulerStore() {
  return createPostgresSchedulerStore(db, {
    sessionBudget: BUDGET,
    connectForLock: async () => {
      throw new Error("not used");
    },
  });
}

/** A claimed session whose first turn ran and finished under a checkpoint. */
async function idleSession() {
  const claimed = await claimedSession(db, gateway, OWNER);
  const { principal, scope } = claimed;
  const first = await gateway.nextInput(principal, scope);
  if (!first.input) throw new Error("no input delivered");
  await gateway.finalize(principal, {
    ...scope,
    turn_id: first.input.turn_id,
    finalize_key: `${scope.attempt_id}:${first.input.turn_id}`,
    final_source_sequence: 0,
    terminal: { status: "completed", reason: null, result: null, usage: null },
    checkpoint: {
      revision: 0,
      manifest_ref: `manifests/${scope.session_id}/0`,
      manifest_sha256: "c".repeat(64),
    },
  });
  return {
    ...claimed,
    ref: { executionId: claimed.executionId, generation: 1 },
    fence: {
      sessionId: scope.session_id,
      attemptId: scope.attempt_id,
      leaseEpoch: scope.lease_epoch,
      executionGeneration: scope.execution_generation,
      authRevision: scope.auth_revision,
    },
  };
}

type Idle = Awaited<ReturnType<typeof idleSession>>;

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

function pending(fence: Idle["fence"], budget = BUDGET) {
  return createPostgresWorkerUnitOfWork(db).nextInputPending({ fence, budget });
}

/** A poll of the idle worker, returned once it has begun to wait. */
async function waitingPoll({ principal, scope }: Idle) {
  const begun = waits;
  const polling = gateway.nextInput(principal, { ...scope, wait_ms: 20_000 });
  polling.catch(() => {});
  await until(() => waits > begun);
  // In an object: an async function returning the promise itself would make
  // its caller wait for the poll's answer.
  return { polling };
}

function queuedTurns(sessionId: string) {
  return db
    .select({ status: turns.status, attemptId: turns.attemptId })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")));
}

describe("the lock-free question of a waiting nextInput", () => {
  test("an idle session has nothing pending; a queued turn is, and stays so while this attempt holds it", async () => {
    const idle = await idleSession();
    expect(await pending(idle.fence)).toBe(false);
    await append(idle.sessionId, "second input");
    expect(await pending(idle.fence)).toBe(true);
    const handed = await gateway.nextInput(idle.principal, idle.scope);
    expect(handed.input?.message).toBe("second input");
    // Redelivered to the same attempt on every poll until it is finalized.
    expect(await pending(idle.fence)).toBe(true);
  });

  const SENT_BACK: [string, (idle: Idle) => Promise<unknown>][] = [
    [
      "the scheduler asked the idle worker to stop",
      async (idle) =>
        expect(await schedulerStore().requestIdleStop(idle.ref)).toBe(true),
    ],
    [
      "the attempt is draining",
      (idle) =>
        db
          .update(attempts)
          .set({ state: "draining" })
          .where(eq(attempts.id, idle.fence.attemptId)),
    ],
    [
      "the session's model moved after the claim",
      (idle) =>
        db
          .update(attempts)
          .set({ model: "claimed-model" })
          .where(eq(attempts.id, idle.fence.attemptId)),
    ],
    [
      "the lease ran out",
      (idle) =>
        db
          .update(attempts)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(attempts.id, idle.fence.attemptId)),
    ],
    [
      "the session's epoch moved on",
      (idle) =>
        db
          .update(sessions)
          .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
          .where(eq(sessions.id, idle.sessionId)),
    ],
    [
      "the attempt ended",
      (idle) =>
        db
          .update(attempts)
          .set({ state: ENDED_ATTEMPT_STATES[0] })
          .where(eq(attempts.id, idle.fence.attemptId)),
    ],
  ];
  for (const [what, change] of SENT_BACK) {
    test(`once ${what}, the poll is sent back to the fenced read`, async () => {
      const idle = await idleSession();
      expect(await pending(idle.fence)).toBe(false);
      await change(idle);
      expect(await pending(idle.fence)).toBe(true);
    });
  }

  test("a spent budget and a binding nobody holds are the fenced read's to answer too", async () => {
    const idle = await idleSession();
    expect(await pending(idle.fence, { costUsd: 0, tokens: null })).toBe(true);
    expect(await pending({ ...idle.fence, attemptId: "att_unknown" })).toBe(
      true,
    );
  });

  test("a head that is neither queued nor this attempt's is nothing to wake for", async () => {
    const idle = await idleSession();
    await append(idle.sessionId, "second input");
    // Delivered to an attempt that is gone and never finalized: only the
    // reconciler may decide it, and nextInputAtomic hands it to no one.
    await db
      .update(turns)
      .set({ status: "running" })
      .where(
        and(eq(turns.sessionId, idle.sessionId), eq(turns.status, "queued")),
      );
    expect(await pending(idle.fence)).toBe(false);
    expect(
      (await gateway.nextInput(idle.principal, idle.scope)).input,
    ).toBeNull();
  });
});

describe("a nextInput waiting on an idle session", () => {
  test("is handed a turn queued meanwhile as soon as it commits, and only that once", async () => {
    const idle = await idleSession();
    const { polling } = await waitingPoll(idle);
    // Nothing queued: only a notification is expected to end this wait.
    expect(naps.at(-1)).toBe(5_000);
    await append(idle.sessionId, "second input");
    const handed = await polling;
    expect(handed.input?.message).toBe("second input");
    expect(notified).toContain(idle.sessionId);
    // Asked again, the same attempt is given the same turn, not another run.
    const again = await gateway.nextInput(idle.principal, idle.scope);
    expect(again.input?.turn_id).toBe(handed.input?.turn_id);
    const running = await db
      .select({ attemptId: turns.attemptId })
      .from(turns)
      .where(
        and(eq(turns.sessionId, idle.sessionId), eq(turns.status, "running")),
      );
    expect(running).toEqual([{ attemptId: idle.fence.attemptId }]);
  });

  test("reads a queued turn the session holds back at the short interval, and is handed it once the hold lifts", async () => {
    const idle = await idleSession();
    await append(idle.sessionId, "held input");
    await db
      .update(sessions)
      .set({ takeoverRequiredAt: new Date() })
      .where(eq(sessions.id, idle.sessionId));
    const { polling } = await waitingPoll(idle);
    // Not the 5 s of a poll with nothing queued: the end of a takeover is
    // announced to no one.
    expect(naps.at(-1)).toBe(250);
    expect(await queuedTurns(idle.sessionId)).toHaveLength(1);
    await db
      .update(sessions)
      .set({ takeoverRequiredAt: null })
      .where(eq(sessions.id, idle.sessionId));
    // This harness's sleep never ends by itself: a notification stands in
    // for the 250 ms running out.
    await db.execute(
      sql`SELECT pg_notify('session_events', ${idle.sessionId})`,
    );
    expect((await polling).input?.message).toBe("held input");
  });

  test("is told to stop as soon as the scheduler asks the idle worker to", async () => {
    const idle = await idleSession();
    const { polling } = await waitingPoll(idle);
    expect(await schedulerStore().requestIdleStop(idle.ref)).toBe(true);
    const answer = await polling;
    expect(answer.input).toBeNull();
    expect(answer.draining).toBe(true);
  });

  test("is answered draining as soon as its own worker beats draining, and only that beat says so", async () => {
    const idle = await idleSession();
    const { polling } = await waitingPoll(idle);
    const before = notified.length;
    // What a stopping worker sends before it waits for this poll's answer.
    await gateway.heartbeat(idle.principal, {
      ...idle.scope,
      attempt_state: "draining",
    });
    const answer = await polling;
    expect(answer.input).toBeNull();
    expect(answer.draining).toBe(true);
    // The beats that follow renew the lease and announce nothing.
    await gateway.heartbeat(idle.principal, {
      ...idle.scope,
      attempt_state: "draining",
    });
    await db.execute(sql`SELECT pg_notify('session_events', 'marker')`);
    await until(() => notified.includes("marker"));
    expect(notified.slice(before)).toEqual([idle.sessionId, "marker"]);
  });

  test("a draining beat is answered without waiting for its notification", async () => {
    const idle = await idleSession();
    // A database that takes the beat and never answers the notification.
    const stalled = new Proxy(db, {
      get: (target, key, receiver) =>
        key === "execute"
          ? () => new Promise(() => {})
          : Reflect.get(target, key, receiver),
    });
    const beat = await createPostgresWorkerUnitOfWork(stalled).heartbeatAtomic({
      fence: idle.fence,
      now: new Date(),
      leaseTtlMs: 60_000,
      credentialTtlMs: 60_000,
      attemptState: "draining",
    });
    expect(beat.outcome).toBe("ok");
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, idle.fence.attemptId));
    expect(attempt?.state).toBe("draining");
  });

  const LOST: [string, string, (idle: Idle) => Promise<unknown>][] = [
    [
      "whose lease ran out",
      "LEASE_EXPIRED",
      (idle) =>
        db
          .update(attempts)
          .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(attempts.id, idle.fence.attemptId)),
    ],
    [
      "whose session another attempt took",
      "STALE_EPOCH",
      (idle) =>
        db
          .update(sessions)
          .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
          .where(eq(sessions.id, idle.sessionId)),
    ],
  ];
  for (const [what, code, lose] of LOST) {
    test(`a poll ${what} is refused when a queued turn wakes it, and the turn stays queued`, async () => {
      const idle = await idleSession();
      const { polling } = await waitingPoll(idle);
      await lose(idle);
      await append(idle.sessionId, "second input");
      await expect(polling).rejects.toMatchObject({ status: 409, code });
      // Nothing was handed out: the turn is still the next attempt's to run.
      expect(await queuedTurns(idle.sessionId)).toEqual([
        { status: "queued", attemptId: null },
      ]);
    });
  }

  test("a drain notifies the session the first time it is asked for, not on every pass", async () => {
    const claimed = await claimedSession(db, gateway, OWNER);
    const first = await gateway.nextInput(claimed.principal, claimed.scope);
    if (!first.input) throw new Error("no input delivered");
    const ref = { executionId: claimed.executionId, generation: 1 };
    const store = schedulerStore();
    const before = notified.length;
    expect((await store.requestDrain(ref, 60_000))?.busy).toBe(true);
    await until(() => notified.length > before);
    expect((await store.requestDrain(ref, 60_000))?.busy).toBe(true);
    // A notification the second pass raised would have arrived by now.
    await db.execute(sql`SELECT pg_notify('session_events', 'marker')`);
    await until(() => notified.includes("marker"));
    expect(notified.slice(before)).toEqual([claimed.sessionId, "marker"]);
  });
});
