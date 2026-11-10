import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionObservation,
  type ExecutionRef,
  type LaunchIntent,
  type ManagedExecution,
  runScheduler,
  type SchedulerRunSummary,
  type TerminateExecutionResult,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import { receipts, sessions, workerLaunches } from "./schema.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

/**
 * A daemon on which some sessions can never launch — the image is gone, or
 * the start is refused every time — and the rest launch fine.
 */
class PartlyBrokenBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  readonly broken = new Set<string>();
  readonly running = new Map<string, ManagedExecution>();
  readonly ensured: LaunchIntent[] = [];

  capabilities() {
    return { suspend: false };
  }

  async resolveImage(reference: string): Promise<string> {
    return reference;
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    this.ensured.push(intent);
    if (this.broken.has(intent.sessionId)) {
      throw new Error("Image worker:gone is not on this daemon");
    }
    await intent.issueBootstrapNonce();
    const providerRef = `ctr-${intent.executionId}`;
    this.running.set(intent.executionId, {
      executionId: intent.executionId,
      generation: intent.generation,
      providerRef,
      sessionId: intent.sessionId,
      state: "running",
    });
    return { created: true, providerRef, state: "running" };
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const found = this.running.get(ref.executionId);
    return found
      ? {
          found: true,
          observedAt: new Date(),
          providerRef: found.providerRef,
          state: "running",
        }
      : {
          found: false,
          observedAt: new Date(),
          providerRef: null,
          state: "unknown",
        };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    return [...this.running.values()];
  }

  async terminate(ref: ExecutionRef): Promise<TerminateExecutionResult> {
    const found = this.running.get(ref.executionId);
    if (!found) return { outcome: "absent" };
    this.running.delete(ref.executionId);
    return { outcome: "terminated", providerRef: found.providerRef };
  }
}

integration("scheduler launch failures on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "launch_failure_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const inputs = () => createPostgresSessionUnitOfWork(db);

  async function queuedSession() {
    const ownerId = crypto.randomUUID();
    const result = await inputs().acceptInputAtomic({
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
      limits: LIMITS,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return { ...result.response, ownerId };
  }

  test("slotLimit=2: two sessions that can never launch are given up on and a healthy one launches", async () => {
    const backend = new PartlyBrokenBackend();
    const badA = await queuedSession();
    const badB = await queuedSession();
    // Signalled last, so it only gets a slot once one comes back.
    const good = await queuedSession();
    backend.broken.add(badA.session_id);
    backend.broken.add(badB.session_id);
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });
    const logged: string[] = [];
    // The default backoff is judged on the database clock; a test spends it
    // by moving the retry time into the past rather than waiting it out.
    const spendBackoff = () =>
      db
        .update(workerLaunches)
        .set({ launchRetryAt: sql`clock_timestamp() - interval '1 second'` })
        .where(sql`${workerLaunches.launchRetryAt} IS NOT NULL`);
    const pass = () =>
      runScheduler({
        backend,
        image: "worker:test",
        launchFailureLimit: 3,
        logger: {
          error: (message) => logged.push(message),
          info: () => {},
          warn: () => {},
        },
        resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 64 },
        slotLimit: 2,
        store,
      });

    const summaries: SchedulerRunSummary[] = [await pass()];
    expect(summaries[0]?.failedLaunches).toHaveLength(2);
    expect(summaries[0]?.launched).toEqual([]);
    // Still inside the backoff on the database clock: both keep their slots
    // and are reported as waiting, not retried.
    const early = await pass();
    expect(early.launchesBackingOff).toHaveLength(2);
    expect(early.launched).toEqual([]);
    expect(backend.ensured).toHaveLength(2);

    for (
      let i = 0;
      i < 6 && !summaries.some((s) => s.launched.length);
      i += 1
    ) {
      await spendBackoff();
      summaries.push(await pass());
    }
    const launchedIn = summaries.findIndex((s) => s.launched.length > 0);
    expect(launchedIn).toBeGreaterThan(0);
    const final = summaries[launchedIn];
    // The limit is reached, the kills land and the slots come back, all in
    // the pass that launches the healthy session.
    expect(final?.launchesQuarantined).toHaveLength(2);
    expect(final?.killed).toHaveLength(2);
    expect(final?.launched).toHaveLength(1);
    expect(backend.running.size).toBe(1);
    expect([...backend.running.values()][0]?.sessionId).toBe(good.session_id);
    for (const bad of [badA, badB]) {
      expect(
        backend.ensured.filter((intent) => intent.sessionId === bad.session_id),
      ).toHaveLength(3);
    }

    // What the operator and the client see.
    for (const bad of [badA, badB]) {
      const [session] = await db
        .select({ admission: sessions.admissionState, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, bad.session_id));
      expect(session).toEqual({ admission: "active", status: "failed" });
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, bad.receipt_id));
      expect(receipt?.status).toBe("failed");
      expect(receipt?.error).toMatchObject({ code: "LAUNCH_FAILED" });
      const [launch] = await db
        .select({
          count: workerLaunches.launchFailureCount,
          error: workerLaunches.lastLaunchError,
          released: workerLaunches.slotReleasedAt,
        })
        .from(workerLaunches)
        .where(eq(workerLaunches.sessionId, bad.session_id));
      expect(launch?.count).toBe(3);
      expect(launch?.error).toContain("worker:gone");
      expect(launch?.released).not.toBeNull();
    }
    expect(
      logged.filter((m) => m.startsWith("Launch failed as many times")),
    ).toHaveLength(2);

    // Given up on, a session is not admitted again on its own...
    await spendBackoff();
    const quiet = await pass();
    expect(quiet.launched).toEqual([]);
    expect(quiet.failedLaunches).toEqual([]);

    // ...until new input arrives, which launches it afresh once the image
    // is back.
    backend.broken.delete(badA.session_id);
    const appended = await inputs().appendInputAtomic({
      principal: { ownerId: badA.ownerId },
      sessionId: badA.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "try again",
      limits: LIMITS,
    });
    expect(appended.outcome).toBe("accepted");
    const [requeued] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, badA.session_id));
    expect(requeued?.status).toBe("queued");
    const retried = await pass();
    expect(retried.launched).toHaveLength(1);
    const [fresh] = await db
      .select({ generation: workerLaunches.generation })
      .from(workerLaunches)
      .where(
        sql`${workerLaunches.sessionId} = ${badA.session_id} AND ${workerLaunches.slotReleasedAt} IS NULL`,
      );
    expect(fresh?.generation).toBe(2);
  }, 60_000);
});
