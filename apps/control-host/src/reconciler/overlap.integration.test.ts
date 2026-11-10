import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@werft-ai/db";
import {
  attempts,
  controlIntents,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workers,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createInterruptService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { reconcileOnce } from "./main.ts";
import { testCatalog } from "../test-support/catalog.ts";
import { fixtureRelease, TEST_MODEL } from "@werft-ai/db/testing/spec-pins";

const integration = testDatabaseUrl() ? describe : describe.skip;

const catalog: SessionCatalog = testCatalog({
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
      auth: { kind: "github_app", registered: true } as const,
    },
  },
});

const PASSES = 4;

// the loop never overlaps its own passes, but two reconcilers (a
// second replica, a restart racing a pass still being killed) can. Every
// sweep reads its candidates without locks and re-judges each under the row
// locks, so whichever pass gets there first acts and the rest find nothing.
// A database of its own, as in main.integration.test.ts: the passes sweep
// the whole database and the assertions count what they did.
integration("reconciler passes that overlap", () => {
  let database: TempDatabase;
  let pools: Pool[];
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "reconciler_overlap_it" });
    pools = Array.from(
      { length: PASSES },
      () => new Pool({ connectionString: database.url, max: 4 }),
    );
    db = drizzle(pools[0] as Pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      pending: createPostgresWorkerPendingStore(db),
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 60_000,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await Promise.all(pools.map((pool) => pool.end()));
    } finally {
      await database.drop();
    }
  }, 60_000);

  /** A session whose first turn is running on a claimed attempt. */
  async function runningSession() {
    const partition = `overlap-${crypto.randomUUID()}`;
    const owner = testCaller(`owner-${crypto.randomUUID()}`);
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
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
    const delivered = await gateway.nextInput(principal, {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    });
    expect(delivered.input?.turn_id).toBe("1");
    return {
      attemptId: claimed.attempt_id,
      executionId,
      leaseEpoch: claimed.lease_epoch,
      owner,
      sessionId,
    };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    return row;
  }

  async function desiredState(executionId: string) {
    const [row] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, executionId));
    return row?.desiredState;
  }

  function pass(pool: Pool) {
    const sink = new MemoryLogSink();
    return reconcileOnce(
      drizzle(pool, { schema }),
      { RECONCILER_BATCH_SIZE: "10", RECONCILER_DRY_RUN: "false" },
      new StructuredLogger({ sinks: [sink] }),
    );
  }

  test("each lease, interrupt and orphan is acted on by exactly one of several concurrent passes, and a pass after them finds nothing", async () => {
    // Heartbeat stopped: its lease ran out a minute ago.
    const silent = await runningSession();
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 minute'` })
      .where(eq(attempts.id, silent.attemptId));

    // Heartbeating, but its interrupt is past both deadlines.
    const stuck = await runningSession();
    const interrupted = await createInterruptService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresTurnInterrupts(db),
    }).interrupt(stuck.owner, stuck.sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body: { target_turn_id: "1" },
    });
    await db
      .update(controlIntents)
      .set({ issuedAt: sql`clock_timestamp() - interval '10 minutes'` })
      .where(eq(controlIntents.receiptId, interrupted.receipt_id));

    // A legacy worker mapping whose worker went away.
    const orphanId = crypto.randomUUID();
    const orphanPod = `overlap-orphan-${crypto.randomUUID()}`;
    await db.insert(sessions).values({
      id: orphanId,
      ownerId: "overlap-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${orphanId}`,
      podId: orphanPod,
      status: "running",
    });
    await db.insert(workers).values({
      podId: orphanPod,
      lastSeen: new Date(Date.now() - 60_000),
      leaseExpiresAt: new Date(Date.now() - 30_000),
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId: orphanId,
        sequence: 1,
        message: "resume after crash",
        status: "queued",
      })
      .returning({ id: turns.id });
    await db.insert(queueMessages).values({
      sessionId: orphanId,
      turnId: turn?.id,
      kind: "message",
      payload: { message: "resume after crash" },
      claimedBy: orphanPod,
      claimToken: crypto.randomUUID(),
      visibleAt: new Date(Date.now() + 60_000),
    });

    const runs = await Promise.all(pools.map((pool) => pass(pool)));

    const fencedLeases = runs.flatMap((run) =>
      run.leases.filter(({ sessionId }) => sessionId === silent.sessionId),
    );
    expect(fencedLeases).toEqual([
      {
        action: "fenced",
        attemptId: silent.attemptId,
        dryRun: false,
        executionGeneration: 1,
        executionId: silent.executionId,
        sessionId: silent.sessionId,
      },
    ]);
    expect(
      runs.flatMap((run) =>
        run.interrupts.filter(({ sessionId }) => sessionId === stuck.sessionId),
      ),
    ).toHaveLength(1);
    expect(runs.reduce((sum, run) => sum + run.interruptsOverdue, 0)).toBe(1);
    expect(
      runs.flatMap((run) =>
        run.orphans.filter(({ sessionId }) => sessionId === orphanId),
      ),
    ).toHaveLength(1);

    // One epoch step each, not one per pass.
    expect((await sessionRow(silent.sessionId))?.leaseEpoch).toBe(
      silent.leaseEpoch + 1,
    );
    expect((await sessionRow(stuck.sessionId))?.leaseEpoch).toBe(
      stuck.leaseEpoch + 1,
    );
    expect(await desiredState(silent.executionId)).toBe("terminated");
    expect(await desiredState(stuck.executionId)).toBe("terminated");
    const [lost] = await db
      .select({ state: attempts.state, endReason: attempts.endReason })
      .from(attempts)
      .where(eq(attempts.id, silent.attemptId));
    expect(lost).toEqual({ state: "lost", endReason: "lease_expired" });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, interrupted.receipt_id));
    expect(receipt?.status).toBe("unknown");
    expect(await sessionRow(orphanId)).toMatchObject({
      podId: null,
      status: "queued",
    });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, orphanId)),
    ).toHaveLength(1);

    // The pass a restarted reconciler runs next: everything above is done,
    // so it neither moves an epoch again nor rewrites the receipt.
    const again = await pass(pools[0] as Pool);
    expect(again.leases).toEqual([]);
    expect(again.interrupts).toEqual([]);
    expect(again.interruptsOverdue).toBe(0);
    expect(again.orphans).toEqual([]);
    expect((await sessionRow(silent.sessionId))?.leaseEpoch).toBe(
      silent.leaseEpoch + 1,
    );
    expect((await sessionRow(stuck.sessionId))?.leaseEpoch).toBe(
      stuck.leaseEpoch + 1,
    );
    const [unchanged] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, interrupted.receipt_id));
    expect(unchanged?.updatedAt).toEqual(receipt?.updatedAt);
  }, 60_000);
});
