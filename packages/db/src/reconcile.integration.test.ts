import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  UNATTENDED_PERMISSION_MODES,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { reconcileExpiredLeases } from "./lease-reconcile.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { type Database, reconcileOrphanedSessions } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  executions,
  pendingRequests,
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
  workers,
} from "./schema.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import {
  makeFixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const RECOVERY_MODES = ["default", ...UNATTENDED_PERMISSION_MODES] as const;

// A legacy pod taking an unowned session: the claimant the orphan
// reconciler hands the session back to.
async function claim(db: Database, sessionId: string, podId: string) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.sessions)
      .set({ podId, status: "running" })
      .where(
        and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.podId)),
      )
      .returning();
    if (!claimed) return null;
    await tx
      .delete(schema.unassignedSessions)
      .where(eq(schema.unassignedSessions.sessionId, sessionId));
    return claimed;
  });
}
// Leases end on the database clock, so these tests wait for real
// time to pass. The TTL is what a loaded runner has to reach the next call
// inside a lease; waits past a deadline are only ever too long, never short.
const LEASE_TTL_MS = 2_000;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

integration("orphan reconciliation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sessionIds: string[] = [];
  const podIds: string[] = [];

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "reconcile_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await db
        .delete(unassignedSessions)
        .where(inArray(unassignedSessions.sessionId, sessionIds));
      await db
        .delete(queueMessages)
        .where(inArray(queueMessages.sessionId, sessionIds));
      await db.delete(turns).where(inArray(turns.sessionId, sessionIds));
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    if (podIds.length > 0) {
      await db.delete(workers).where(inArray(workers.podId, podIds));
    }
    sessionIds.length = 0;
    podIds.length = 0;
  }, 60_000);

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      await database.drop();
    }
  }, 60_000);

  async function seedOrphan(now: Date) {
    const sessionId = crypto.randomUUID();
    const podId = `orphan-${crypto.randomUUID()}`;
    sessionIds.push(sessionId);
    podIds.push(podId);
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "reconcile-integration",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
      podId,
      status: "running",
    });
    await db.insert(workers).values({
      podId,
      lastSeen: new Date(now.getTime() - 60_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000 + 1_000),
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "retry original row",
        status: "queued",
      })
      .returning({ id: turns.id });
    const [message] = await db
      .insert(queueMessages)
      .values({
        sessionId,
        turnId: turn?.id,
        kind: "message",
        payload: { message: "retry original row" },
        claimedBy: podId,
        claimToken: crypto.randomUUID(),
        visibleAt: new Date(now.getTime() + 60_000),
      })
      .returning({ id: queueMessages.id });
    if (!message) throw new Error("Failed to seed queue message");
    if (!turn) throw new Error("Failed to seed turn");
    return { messageId: message.id, podId, sessionId, turnId: turn.id };
  }

  test("two reconcilers recover one orphan exactly once", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const results = await Promise.all([
      reconcileOrphanedSessions(db, { now }),
      reconcileOrphanedSessions(db, { now }),
    ]);

    expect(results.flat()).toEqual([
      expect.objectContaining({
        releasedMessageIds: [seeded.messageId],
        sessionId: seeded.sessionId,
      }),
    ]);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(1);
  });

  test("preserves an in-flight row without signaling automatic replay", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    await db
      .update(turns)
      .set({ status: "running" })
      .where(eq(turns.id, seeded.turnId));

    expect(await reconcileOrphanedSessions(db, { now })).toEqual([
      expect.objectContaining({
        action: "blocked",
        blockedMessageIds: [seeded.messageId],
        releasedMessageIds: [],
        sessionId: seeded.sessionId,
      }),
    ]);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, seeded.sessionId));
    expect(session).toMatchObject({ podId: null, status: "failed" });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(0);
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.id, seeded.messageId));
    expect(message).toMatchObject({
      claimedBy: seeded.podId,
      id: seeded.messageId,
    });
  });

  test("rechecks a heartbeat that refreshes after candidate discovery", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE workers SET last_seen = $1, lease_expires_at = $2 WHERE pod_id = $3",
        [now, new Date(now.getTime() + 1_000), seeded.podId],
      );
      const reconciliation = reconcileOrphanedSessions(db, {
        now,
      });
      await Bun.sleep(20);
      await client.query("COMMIT");

      expect(await reconciliation).toEqual([]);
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, seeded.sessionId));
      expect(session).toMatchObject({
        podId: seeded.podId,
        status: "running",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  test("a new claimant takes the released session without a duplicate signal", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const newPodId = `new-${crypto.randomUUID()}`;
    const reconciliation = reconcileOrphanedSessions(db, {
      now,
    });
    const claimed = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await claim(db, seeded.sessionId, newPodId);
        if (result) return result;
        await Bun.sleep(1);
      }
      throw new Error("New worker did not claim the reconciled session");
    })();

    expect(await reconciliation).toHaveLength(1);
    expect(await claimed).toMatchObject({
      id: seeded.sessionId,
      podId: newPodId,
      status: "running",
    });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(0);
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.id, seeded.messageId));
    expect(message).toMatchObject({
      id: seeded.messageId,
      claimedBy: null,
      claimToken: null,
    });
  });
});

// the lease-expiry reconciler for gateway-bound sessions. It fences
// the silent worker and asks for its execution to go; what happens to the
// turn is decided by confirmExecutionGone once the backend says it is gone.
integration("expired lease reconciliation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  // Audit stamps only: expiry is judged on the database clock.
  const clock = new Date("2026-09-23T00:00:00.000Z");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "lease_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testSessionCatalog({
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: {
            kind: "api_key",
            value: "catalog-provider-key",
            ref: { value_env: "PROVIDER_KEY" },
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function bound(
    name: string,
    mode: (typeof RECOVERY_MODES)[number] = "default",
  ) {
    const partition = `${name}-${crypto.randomUUID()}`;
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: crypto.randomUUID() },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await makeFixtureRelease(db, {
        spec: { permission_mode: mode },
      }),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
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
    const principal: WorkerPrincipal = {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
    const scope: WorkerScope = {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
    return { sessionId, executionId, claimed, principal, scope };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  test("lease expired before delivery: the worker is fenced, the kill requested, and the input runs again once the execution is confirmed gone", async () => {
    const b = await bound("before");
    await sleep(LEASE_TTL_MS + 100);

    const dry = await reconcileExpiredLeases(db, { now: clock, dryRun: true });
    expect(dry).toEqual([
      expect.objectContaining({
        action: "fenced",
        attemptId: b.claimed.attempt_id,
        dryRun: true,
        executionId: b.executionId,
        sessionId: b.sessionId,
      }),
    ]);
    expect((await sessionRow(b.sessionId)).leaseEpoch).toBe(
      b.claimed.lease_epoch,
    );

    expect(await reconcileExpiredLeases(db, { now: clock })).toEqual([
      expect.objectContaining({ action: "fenced", dryRun: false }),
    ]);
    // Idempotent: the attempt is ended, so a second pass finds nothing.
    expect(await reconcileExpiredLeases(db, { now: clock })).toEqual([]);

    const fenced = await sessionRow(b.sessionId);
    expect(fenced.leaseEpoch).toBe(b.claimed.lease_epoch + 1);
    expect(fenced.executionId).toBe(b.executionId);
    expect(fenced.admissionState).toBe("active");
    const [attempt] = await db
      .select({ state: attempts.state, endReason: attempts.endReason })
      .from(attempts)
      .where(eq(attempts.id, b.claimed.attempt_id));
    expect(attempt).toEqual({ state: "lost", endReason: "lease_expired" });
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, b.executionId));
    expect(execution?.desiredState).toBe("terminated");
    // Nothing is re-queued while the container may still be running, and
    // the worker that went quiet cannot come back on its old binding.
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, b.sessionId)),
    ).toHaveLength(0);
    await expect(
      gateway.heartbeat(b.principal, { ...b.scope, attempt_state: "running" }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_EPOCH" });
    const [launchRow] = await db
      .select({ slotReleasedAt: workerLaunches.slotReleasedAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, b.executionId));
    expect(launchRow?.slotReleasedAt).toBeNull();

    // The backend confirms the removal: the undelivered input goes back.
    expect(await confirmExecutionGone(db, b.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const released = await sessionRow(b.sessionId);
    expect(released.executionId).toBeNull();
    expect(released.admissionState).toBe("active");
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, b.sessionId));
    expect(turn?.status).toBe("queued");
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, b.sessionId)),
    ).toHaveLength(1);
  });

  // permission_mode reaches only the engine: an unattended session's lost
  // turn goes to an operator exactly as an attended one's does.
  for (const mode of RECOVERY_MODES) {
    test(`lease expired after delivery (${mode}): the turn ends outcome_unknown and the session waits for recovery`, async () => {
      const b = await bound("after", mode);
      expect(b.claimed.runtime_config.permission_mode).toBe(mode);
      const next = await gateway.nextInput(b.principal, b.scope);
      expect(next.input?.turn_id).toBe("1");
      await sleep(LEASE_TTL_MS + 100);

      expect(await reconcileExpiredLeases(db, { now: clock })).toEqual([
        expect.objectContaining({ action: "fenced", sessionId: b.sessionId }),
      ]);
      // Still undecided until the execution is confirmed gone.
      const [open] = await db
        .select({ id: turns.id, status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, b.sessionId));
      expect(open?.status).toBe("running");
      if (!open) throw new Error("turn missing");
      // A request the lost worker raised and nobody can answer any more.
      await db.insert(pendingRequests).values({
        requestId: `req-${crypto.randomUUID()}`,
        sessionId: b.sessionId,
        turnId: open.id,
        attemptId: b.claimed.attempt_id,
        kind: "permission",
        payload: {},
        inputHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      });

      await confirmExecutionGone(db, b.executionId);
      const [request] = await db
        .select({ resolvedAt: pendingRequests.resolvedAt })
        .from(pendingRequests)
        .where(eq(pendingRequests.sessionId, b.sessionId));
      expect(request?.resolvedAt).not.toBeNull();
      const [turn] = await db
        .select({ status: turns.status, outcomeUnknown: turns.outcomeUnknown })
        .from(turns)
        .where(eq(turns.sessionId, b.sessionId));
      expect(turn).toEqual({ status: "outcome_unknown", outcomeUnknown: true });
      const session = await sessionRow(b.sessionId);
      expect(session.admissionState).toBe("recovery_required");
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, b.sessionId)),
      ).toHaveLength(0);
    });
  }

  test(
    "a heartbeat that lands first keeps the lease; an attempt already released is only closed",
    async () => {
      const alive = await bound("alive");
      // Each wait leaves the same margin to the deadline it must beat.
      await sleep(LEASE_TTL_MS * 0.55);
      await gateway.heartbeat(alive.principal, {
        ...alive.scope,
        attempt_state: "running",
      });
      // Past the original lease, inside the extended one.
      await sleep(LEASE_TTL_MS * 0.55);
      expect(await reconcileExpiredLeases(db, { now: clock })).toEqual([]);

      const gone = await bound("released");
      await gateway.release(gone.principal, { ...gone.scope, reason: "idle" });
      await sleep(LEASE_TTL_MS + 100);
      // release already moved the epoch and ended the attempt: nothing to do
      // for it (the still-bound session from above expires here instead).
      expect(
        await reconcileExpiredLeases(db, { now: clock }),
      ).not.toContainEqual(
        expect.objectContaining({ attemptId: gone.claimed.attempt_id }),
      );
      const [attempt] = await db
        .select({ state: attempts.state })
        .from(attempts)
        .where(eq(attempts.id, gone.claimed.attempt_id));
      expect(attempt?.state).toBe("exited");
    },
    LEASE_TTL_MS * 5,
  );
});
