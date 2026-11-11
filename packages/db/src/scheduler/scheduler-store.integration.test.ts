import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { sessions, unassignedSessions, workerLaunches } from "../schema.ts";
import { confirmExecutionGone } from "../testing/launches.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";

/**
 * Real PostgreSQL only: PGlite has a single connection, so it cannot show
 * two reservations racing for the last slot. Opt in with QUEUE_DATABASE_URL.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};

integration("PostgresSchedulerStore under concurrent reservations", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "scheduler_race" });
    pool = new Pool({ connectionString: database.url, max: 20 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("only one of two overlapping passes gets the pass lock", async () => {
    const store = createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });
    const [first, second] = await Promise.all([
      store.acquirePassLock(),
      store.acquirePassLock(),
    ]);
    const held = [first, second].filter((r) => r !== null);
    expect(held).toHaveLength(1);
    await held[0]?.release();
    const again = await store.acquirePassLock();
    expect(again).not.toBeNull();
    await again?.release();
  });

  test("a pass lock whose connection the server drops says so, and is free for the next pass", async () => {
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });
    const lock = await store.acquirePassLock();
    if (!lock) throw new Error("lock not taken");
    const [holder] = (
      await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
    ).rows;
    expect(holder).toBeDefined();
    await pool.query("SELECT pg_terminate_backend($1)", [holder?.pid]);
    // The server let go the moment the session ended; the holder hears about
    // it from its own socket.
    for (let i = 0; i < 50 && !lock.signal.aborted; i += 1) {
      await Bun.sleep(20);
    }
    expect(lock.signal.aborted).toBe(true);
    expect(() => lock.signal.throwIfAborted()).toThrow(/pass lock connection/);
    const idleBefore = pool.idleCount;
    await lock.release();
    // Destroyed, not parked for the next caller.
    expect(pool.idleCount).toBe(idleBefore);
    const next = await store.acquirePassLock();
    expect(next).not.toBeNull();
    await next?.release();
  });

  test("15 concurrent reservations from an empty pool yield exactly slotLimit intents", async () => {
    const store = createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });
    const ids: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(sessions).values({
        id,
        ownerId: "race",
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
      });
      await db.insert(unassignedSessions).values({ sessionId: id });
    }
    // Two passes each believe 10 slots are free and reserve concurrently.
    const attempts = [...ids, ...ids].map((sessionId) =>
      store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: new Date(),
        sessionId,
        slotLimit: 10,
      }),
    );
    const results = await Promise.all(attempts);
    const reserved = results.filter((r) => r !== null);
    expect(reserved).toHaveLength(10);
    expect(new Set(reserved.map((r) => r?.sessionId)).size).toBe(10);
    expect((await store.inspectDemand({ limit: 0 })).activeExecutionCount).toBe(
      10,
    );
  }, 60_000);

  /** One reserved launch with a credential issued, ready to be replaced. */
  async function reservedLaunch() {
    const store = createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "race",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    await db.insert(unassignedSessions).values({ sessionId });
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: new Date(),
      sessionId,
      // The reservation test above leaves its ten launches holding slots.
      slotLimit: 100,
    });
    if (!intent) throw new Error("no intent");
    await store.issueBootstrapNonce(intent);
    return { intent, sessionId, store };
  }

  test("the session keeps the image of its first reserved launch; later launches do not overwrite it", async () => {
    const { intent, sessionId, store } = await reservedLaunch();
    const firstImage = async () =>
      (
        await db
          .select({ image: sessions.firstWorkerImage })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.image;
    expect(await firstImage()).toBe(SPEC.image);

    // Gone before any worker bound: the session's signal still stands.
    await confirmExecutionGone(db, intent.executionId);
    const next = await store.reserveLaunch({
      ...SPEC,
      image: "sha256:worker-next",
      backend: "local_docker",
      now: new Date(),
      sessionId,
      slotLimit: 100,
    });
    if (!next) throw new Error("no second intent");
    expect(
      (
        await db
          .select({ image: workerLaunches.image })
          .from(workerLaunches)
          .where(eq(workerLaunches.executionId, next.executionId))
      )[0]?.image,
    ).toBe("sha256:worker-next");
    expect(await firstImage()).toBe(SPEC.image);
  });

  /** Resolves to "pending" if `promise` has not settled within `ms`. */
  function settledWithin<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), ms),
      ),
    ]);
  }

  test("a replacement request waits behind an exit confirmation holding the row and then loses to it", async () => {
    const { intent, store } = await reservedLaunch();
    // An exit confirmation in flight: it has the launch row locked and has
    // released the slot, but has not committed.
    const confirming = await pool.connect();
    try {
      await confirming.query("BEGIN");
      await confirming.query(
        "UPDATE worker_launches SET slot_released_at = now() WHERE execution_id = $1",
        [intent.executionId],
      );
      const request = store.requestReplacement(intent, "stale_isolation", 0);
      expect(await settledWithin(request, 300)).toBe("pending");
      await confirming.query("COMMIT");
      // The request re-reads the row once it gets the lock: no slot, no
      // rebuild, and nothing for the scheduler to tear down.
      expect(await request).toBeNull();
    } finally {
      confirming.release();
    }
    const [row] = await db
      .select({ reason: workerLaunches.replacementReason })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(row?.reason).toBeNull();
  }, 60_000);

  test("a replacement request waits behind a terminate holding the row and then refuses", async () => {
    const { intent, store } = await reservedLaunch();
    // A terminate in flight, as terminateAtomic orders it: the launch row
    // locked first, then the kill intent written, not yet committed.
    const terminating = await pool.connect();
    try {
      await terminating.query("BEGIN");
      await terminating.query(
        "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
        [intent.executionId],
      );
      await terminating.query(
        "UPDATE executions SET desired_state = 'terminated' WHERE id = $1",
        [intent.executionId],
      );
      const request = store.requestReplacement(intent, "stale_isolation", 0);
      expect(await settledWithin(request, 300)).toBe("pending");
      await terminating.query("COMMIT");
      // The kill intent is read after the wait, not from the snapshot taken
      // before it: a launch asked to go is never recorded for a rebuild.
      expect(await request).toBeNull();
    } finally {
      terminating.release();
    }
    const [row] = await db
      .select({
        count: workerLaunches.replacementCount,
        reason: workerLaunches.replacementReason,
      })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(row).toEqual({ count: 0, reason: null });
  }, 60_000);

  test("an exit confirmation waits behind a replacement request holding the row and then refuses", async () => {
    const { intent, sessionId, store } = await reservedLaunch();
    // A replacement request in flight: reason written, not committed.
    const requesting = await pool.connect();
    try {
      await requesting.query("BEGIN");
      await requesting.query(
        "UPDATE worker_launches SET replacement_reason = 'stale_isolation', replacement_count = 1, nonce_hash = NULL WHERE execution_id = $1",
        [intent.executionId],
      );
      const confirm = store.confirmExecutionGone(
        intent.executionId,
        new Date(),
        null,
      );
      expect(await settledWithin(confirm, 300)).toBe("pending");
      await requesting.query("COMMIT");
      await confirm;
    } finally {
      requesting.release();
    }
    // The plan committed first, so the confirmation changed nothing: the
    // launch still holds its slot and the session is still bound to it.
    const [launch] = await db
      .select({ slotReleasedAt: workerLaunches.slotReleasedAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(launch?.slotReleasedAt).toBeNull();
    const [session] = await db
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.executionId).toBe(intent.executionId);
  }, 60_000);

  test("issueBootstrapNonce writes the deadline on the database clock, not this process's", async () => {
    const store = createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "clock",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${id}`,
    });
    await db.insert(unassignedSessions).values({ sessionId: id });
    // The race test above keeps its ten slots; this one needs one more.
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: new Date(),
      sessionId: id,
      slotLimit: 100,
    });
    if (!intent) throw new Error("no intent");
    const dbNowMs = async () => {
      const [row] = await db
        .select({
          ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
        })
        .from(sql`(SELECT 1) AS one`);
      return Number(row?.ms);
    };
    // A process clock a minute ahead: a deadline derived from it would land
    // outside the bracket the database clock draws around the call.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    let floor: number;
    let ceiling: number;
    try {
      floor = await dbNowMs();
      await store.issueBootstrapNonce(intent);
      ceiling = await dbNowMs();
    } finally {
      Date.now = realNow;
    }
    const [row] = await db
      .select({ nonceExpiresAt: workerLaunches.nonceExpiresAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    const expiresAt = row?.nonceExpiresAt?.getTime() ?? Number.NaN;
    // The column keeps microseconds; the Date read back is floored to ms.
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor(floor) + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(ceiling + 600_000);
    // The listing judges expiry on the same clock.
    const [active] = (await store.listActiveExecutions("local_docker")).filter(
      (e) => e.executionId === intent.executionId,
    );
    expect(active?.nonceExpired).toBe(false);
  });
});
