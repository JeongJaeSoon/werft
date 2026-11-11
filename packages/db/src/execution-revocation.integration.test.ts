import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import {
  createPostgresSessionControl,
  expireOverdueTerminations,
} from "./control-unit-of-work.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  events,
  executions,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerCredentials,
} from "./schema.ts";
import {
  EXECUTION_RESTORED,
  EXECUTION_REVOKED,
  restoreExecutionAtomic,
  revokeExecutionAtomic,
} from "./sessions/execution-revocation.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 5_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("execution Grant revocation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  const clock = new Date("2026-09-24T00:00:00.000Z");
  const now = () => clock;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "revoke_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: withSeededInstallation({
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
            permission_mode: "default",
            provider: {
              kind: "litellm",
              endpoint: "https://litellm.invalid",
              auth: {
                kind: "api_key",
                value: "catalog-provider-key",
                ref: { value_env: "PROVIDER_KEY" },
              },
            },
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1"],
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
        now,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const inputs = () => createPostgresSessionUnitOfWork(db);
  const controls = () => createPostgresSessionControl(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });
  const revoke = (sessionId: string) =>
    revokeExecutionAtomic(db, {
      sessionId,
      reason: "grant revoked",
      now: clock,
    });

  async function queuedSession(partition: string) {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const result = await inputs().acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, result.response.session_id));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, result.response.session_id));
    return { ...result.response, ownerId, partition };
  }

  function launch(sessionId: string) {
    return launchSession(db, { sessionId });
  }

  function claim(l: {
    executionId: string;
    nonce: string;
    generation: number;
  }) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }
  type Claimed = Awaited<ReturnType<typeof claim>>;

  function scopeOf(
    claimed: Claimed,
    turnId: string | null = null,
  ): WorkerScope {
    return {
      session_id: claimed.session_id,
      turn_id: turnId,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
  }

  function principalOf(claimed: Claimed): WorkerPrincipal {
    return {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  /** A bound session with turn 1 delivered to its worker. */
  async function running(name: string) {
    const session = await queuedSession(`${name}-${crypto.randomUUID()}`);
    const l = await launch(session.session_id);
    const claimed = await claim(l);
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    if (!next.input) throw new Error("no input delivered");
    return { session, launch: l, claimed };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function receiptRow(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    if (!row) throw new Error("receipt vanished");
    return row;
  }

  async function turnStatuses(sessionId: string) {
    return db
      .select({ sequence: turns.sequence, status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));
  }

  function heartbeat(claimed: Claimed) {
    return gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
  }

  function finalize(claimed: Claimed, key = "fin") {
    return gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: key,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
  }

  /**
   * Holds the session row lock the way an in-flight request does, so the
   * order in which the next two contenders queue on it is the order they
   * run in.
   */
  async function holdSessionLock(sessionId: string) {
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
      sessionId,
    ]);
    return async () => {
      await client.query("COMMIT");
      client.release();
    };
  }

  // Resolves once a backend is waiting on a row lock held by someone else,
  // so the test knows a contender is queued before it starts the next one.
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await pool.query<{ waiting: string }>(
        "SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (Number(rows[0]?.waiting) >= count) return;
      await Bun.sleep(10);
    }
    throw new Error(`${count} lock waiters never showed up`);
  }

  test("one transaction moves auth_revision and the epoch, revokes the tokens, blocks dispatch and records the kill", async () => {
    const { session, launch: l, claimed } = await running("tx");
    const appended = await inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    const before = await sessionRow(session.session_id);

    const result = await revoke(session.session_id);
    if (result.outcome !== "revoked") throw new Error(result.outcome);
    expect(result).toMatchObject({
      ownerId: session.ownerId,
      receiptStatus: "accepted",
      authRevision: before.authRevision + 1,
      executionId: l.executionId,
      // The attempt's gateway credential and its four egress tokens.
      revokedCredentials: 5,
    });

    const after = await sessionRow(session.session_id);
    expect(after.authRevision).toBe(before.authRevision + 1);
    expect(after.leaseEpoch).toBe(before.leaseEpoch + 1);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.admissionState).toBe("stopping");
    expect(after.executionRevokedAt).not.toBeNull();
    expect(after.executionRevokedReason).toBe("grant revoked");
    // Bound until the kill is observed, like a terminate.
    expect(after.executionId).toBe(l.executionId);
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desiredState).toBe("terminated");
    const tokens = await db
      .select({
        purpose: workerCredentials.purpose,
        revokedAt: workerCredentials.revokedAt,
      })
      .from(workerCredentials)
      .where(eq(workerCredentials.attemptId, claimed.attempt_id));
    // Every purpose: an egress token left live would keep the proxy calling
    // the provider or the repository for a revoked execution.
    expect(
      tokens
        .map((token) => ({
          purpose: token.purpose,
          revoked: token.revokedAt !== null,
        }))
        .sort((a, b) => a.purpose.localeCompare(b.purpose)),
    ).toEqual([
      { purpose: "gateway", revoked: true },
      { purpose: "object_store", revoked: true },
      { purpose: "packages", revoked: true },
      { purpose: "provider", revoked: true },
      { purpose: "repository", revoked: true },
    ]);
    expect(await turnStatuses(session.session_id)).toEqual([
      { sequence: 1, status: "running" },
      { sequence: 2, status: "cancelled" },
    ]);
    expect(await receiptRow(appended.response.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "SESSION_STOPPED" },
    });
    expect(await receiptRow(result.receiptId)).toMatchObject({
      ownerId: session.ownerId,
      operation: "revoke_execution",
      status: "accepted",
      targetRef: {
        session_id: session.session_id,
        turn_id: null,
        request_id: null,
      },
    });
    const audits = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(audits).toContainEqual({
      type: "system",
      payload: {
        type: "system",
        subtype: EXECUTION_REVOKED,
        reason: "grant revoked",
        actor: { kind: "operator" },
        auth_revision: before.authRevision + 1,
        execution_id: l.executionId,
        receipt_id: result.receiptId,
      },
    });
    // Like a terminate, it puts the admission it moved to on the stream.
    expect(audits).toContainEqual({
      type: "status",
      payload: {
        phase: "running",
        admission_state: "stopping",
        actor: { kind: "operator" },
      },
    });

    // A second revocation changes nothing and says so.
    const again = await revoke(session.session_id);
    expect(again).toMatchObject({
      outcome: "already_revoked",
      reason: "grant revoked",
    });
    expect((await sessionRow(session.session_id)).authRevision).toBe(
      after.authRevision,
    );
  });

  test("the old credential is refused everywhere and the worker learns at its heartbeat", async () => {
    const { session, claimed } = await running("old-cred");
    await revoke(session.session_id);

    // Its next request does not authenticate at all.
    expect(
      await failure(gateway.authenticate(claimed.session_credential)),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    // A request that authenticated before the revocation still fails its
    // fence on every write, and writes nothing.
    for (const call of [
      () => heartbeat(claimed),
      () =>
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 1,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      () => finalize(claimed),
      () => gateway.nextInput(principalOf(claimed), scopeOf(claimed)),
    ]) {
      expect(await failure(call())).toEqual({
        status: 409,
        code: "STALE_EPOCH",
      });
    }
    const workerEvents = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.sessionId, session.session_id),
          isNotNull(events.sourceSequence),
        ),
      );
    expect(workerEvents).toHaveLength(0);
    expect(await turnStatuses(session.session_id)).toEqual([
      { sequence: 1, status: "running" },
    ]);
  });

  test("a claim replay cannot rotate a live token in after the revocation", async () => {
    const session = await queuedSession(`replay-${crypto.randomUUID()}`);
    const l = await launch(session.session_id);
    // Claimed and never used: the one state in which a replay rotates.
    const claimed = await claim(l);
    await revoke(session.session_id);
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(
      await failure(gateway.authenticate(claimed.session_credential)),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    const live = await db
      .select({ revokedAt: workerCredentials.revokedAt })
      .from(workerCredentials)
      .where(eq(workerCredentials.attemptId, claimed.attempt_id));
    expect(live.every((token) => token.revokedAt !== null)).toBe(true);
  });

  test("an unobserved stop stays unknown and the turn it cut off is never a success", async () => {
    const { session, launch: l } = await running("unknown");
    const result = await revoke(session.session_id);
    if (result.outcome !== "revoked") throw new Error(result.outcome);

    // Past the deadline with the execution not seen gone: unknown, not done.
    expect(
      await expireOverdueTerminations(db, { now: clock, deadlineMs: 0 }),
    ).toBeGreaterThanOrEqual(1);
    expect(await receiptRow(result.receiptId)).toMatchObject({
      status: "unknown",
      error: { code: "BACKEND_UNAVAILABLE" },
    });

    // Once it is seen gone the receipt says so, and the turn the worker was
    // running is outcome_unknown: the revocation proves nothing about it.
    await confirmExecutionGone(db, l.executionId);
    expect(await receiptRow(result.receiptId)).toMatchObject({
      status: "succeeded",
      result: {
        execution_gone: true,
        unconfirmed_turn_id: "1",
        external_effects_reverted: false,
      },
    });
    expect(await turnStatuses(session.session_id)).toEqual([
      { sequence: 1, status: "outcome_unknown" },
    ]);
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("recovery_required");
    expect(after.executionId).toBeNull();
    expect(after.executionRevokedAt).not.toBeNull();
  });

  test("dispatch stays blocked through every lifecycle path until the operator restores", async () => {
    // An idle session with nothing bound: the revocation completes at once.
    const session = await queuedSession(`idle-${crypto.randomUUID()}`);
    const result = await revoke(session.session_id);
    if (result.outcome !== "revoked") throw new Error(result.outcome);
    expect(result.receiptStatus).toBe("succeeded");
    expect(result.executionId).toBeNull();
    const stopped = await sessionRow(session.session_id);
    expect(stopped.admissionState).toBe("stopped");

    // Force the admission state back to launchable to prove the block does
    // not rest on it: nothing dispatches while the column is set.
    await db
      .update(sessions)
      .set({ admissionState: "active" })
      .where(eq(sessions.id, session.session_id));
    await db
      .insert(unassignedSessions)
      .values({
        sessionId: session.session_id,
        partition: session.partition,
        signaledAt: clock,
      })
      .onConflictDoNothing();
    const demand = await store().inspectDemand({ limit: 1_000 });
    expect(demand.eligibleSessionIds).not.toContain(session.session_id);
    expect(
      await store().reserveLaunch({
        backend: "local_docker",
        image: "worker:test",
        now: clock,
        resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
        sessionId: session.session_id,
        slotLimit: 1_000,
      }),
    ).toBeNull();
    // A launch a pass reserved just before the revocation committed: the
    // claim refuses it on the column alone.
    await db
      .update(sessions)
      .set({ executionRevokedAt: null, executionRevokedReason: null })
      .where(eq(sessions.id, session.session_id));
    const l = await launch(session.session_id);
    await db
      .update(sessions)
      .set({
        executionRevokedAt: stopped.executionRevokedAt,
        executionRevokedReason: stopped.executionRevokedReason,
      })
      .where(eq(sessions.id, session.session_id));
    expect(await failure(claim(l))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    await db
      .update(sessions)
      .set({ admissionState: "stopped", executionId: null })
      .where(eq(sessions.id, session.session_id));

    // The owner cannot resume it or start it fresh.
    const current = await sessionRow(session.session_id);
    expect(
      await controls().resumeAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "h",
        expectedRevision: current.revision,
        now: clock,
      }),
    ).toEqual({ outcome: "execution_revoked" });
    expect(
      await controls().decideRecoveryAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "h",
        decision: {
          decision: "start_fresh",
          reason: "try again",
          expected_revision: current.revision,
        },
        now: clock,
      }),
    ).toEqual({ outcome: "execution_revoked" });

    // The operator's restore lifts only the block: the session stays
    // stopped and the auth revision does not move back.
    expect(
      await restoreExecutionAtomic(db, {
        sessionId: session.session_id,
        reason: "grant reissued",
        now: clock,
      }),
    ).toEqual({ outcome: "restored", ownerId: session.ownerId });
    const restored = await sessionRow(session.session_id);
    expect(restored.executionRevokedAt).toBeNull();
    expect(restored.executionRevokedReason).toBeNull();
    expect(restored.admissionState).toBe("stopped");
    expect(restored.authRevision).toBe(stopped.authRevision);
    const [restoredAudit] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, session.session_id),
          eq(events.type, "system"),
        ),
      )
      .orderBy(asc(events.id))
      .offset(1);
    expect(restoredAudit?.payload).toMatchObject({
      subtype: EXECUTION_RESTORED,
      reason: "grant reissued",
    });
    // Resume now gets past the block to the session's own state.
    expect(
      (
        await controls().resumeAtomic({
          principal: { ownerId: session.ownerId },
          sessionId: session.session_id,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: "h",
          expectedRevision: restored.revision,
          now: clock,
        })
      ).outcome,
    ).not.toBe("execution_revoked");
  });

  test("restore waits for the revoked execution to be observed gone", async () => {
    const { session, launch: l } = await running("restore-wait");
    await revoke(session.session_id);
    expect(
      await restoreExecutionAtomic(db, {
        sessionId: session.session_id,
        reason: "early",
        now: clock,
      }),
    ).toEqual({
      outcome: "execution_unconfirmed",
      executionId: l.executionId,
    });
    await confirmExecutionGone(db, l.executionId);
    expect(
      (
        await restoreExecutionAtomic(db, {
          sessionId: session.session_id,
          reason: "later",
          now: clock,
        })
      ).outcome,
    ).toBe("restored");
  });

  test("a closed or unknown session is refused, and nothing is written", async () => {
    expect(await revoke(crypto.randomUUID())).toEqual({
      outcome: "not_found",
    });
    const session = await queuedSession(`closed-${crypto.randomUUID()}`);
    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, session.session_id));
    const before = await sessionRow(session.session_id);
    expect(await revoke(session.session_id)).toEqual({ outcome: "closed" });
    expect(await sessionRow(session.session_id)).toEqual(before);
  });

  describe("racing in-flight worker requests", () => {
    test("a finalize that holds the session first commits, then the revocation fences it", async () => {
      const { session, claimed } = await running("race-fin-first");
      // The gateway reads the turn unlocked first, then finalizeAtomic takes
      // the fence (session and attempt) and only then the turn row. Holding
      // the turn keeps that transaction in flight with the session locked.
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM turns WHERE session_id = $1 AND sequence = 1 FOR UPDATE",
        [session.session_id],
      );
      const finalizing = finalize(claimed).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForLockWaiters(1);
      const revoking = revoke(session.session_id);
      await waitForLockWaiters(2);
      await client.query("COMMIT");
      client.release();
      const [finalized, revoked] = await Promise.all([finalizing, revoking]);
      expect(finalized.ok, String(!finalized.ok && finalized.error)).toBe(true);
      expect(revoked.outcome).toBe("revoked");
      expect(await turnStatuses(session.session_id)).toEqual([
        { sequence: 1, status: "completed" },
      ]);
      expect(await failure(heartbeat(claimed))).toEqual({
        status: 409,
        code: "STALE_EPOCH",
      });
    }, 20_000);

    test("a finalize that queues behind the revocation commits nothing", async () => {
      const { session, claimed } = await running("race-rev-first");
      const release = await holdSessionLock(session.session_id);
      const revoking = revoke(session.session_id);
      await waitForLockWaiters(1);
      const finalizing = failure(finalize(claimed));
      await waitForLockWaiters(2);
      await release();
      expect((await revoking).outcome).toBe("revoked");
      expect(await finalizing).toEqual({ status: 409, code: "STALE_EPOCH" });
      expect(await turnStatuses(session.session_id)).toEqual([
        { sequence: 1, status: "running" },
      ]);
      const [row] = await db
        .select({ status: receipts.status })
        .from(receipts)
        .where(
          and(
            eq(receipts.operation, "create_session"),
            eq(receipts.ownerId, session.ownerId),
          ),
        );
      expect(row?.status).toBe("accepted");
    }, 20_000);

    test("a lease renewal on either side of the revocation never outlives it", async () => {
      const first = await running("race-hb-first");
      const releaseFirst = await holdSessionLock(first.session.session_id);
      const beating = heartbeat(first.claimed);
      await waitForLockWaiters(1);
      const revokingFirst = revoke(first.session.session_id);
      await waitForLockWaiters(2);
      await releaseFirst();
      // The renewal that got the lock first commits; the revocation after it
      // still discards the epoch it renewed.
      expect((await beating).auth_revision).toBe(first.claimed.auth_revision);
      expect((await revokingFirst).outcome).toBe("revoked");
      expect(await failure(heartbeat(first.claimed))).toEqual({
        status: 409,
        code: "STALE_EPOCH",
      });

      const second = await running("race-rev-hb");
      const releaseSecond = await holdSessionLock(second.session.session_id);
      const revokingSecond = revoke(second.session.session_id);
      await waitForLockWaiters(1);
      const late = failure(heartbeat(second.claimed));
      await waitForLockWaiters(2);
      await releaseSecond();
      expect((await revokingSecond).outcome).toBe("revoked");
      expect(await late).toEqual({ status: 409, code: "STALE_EPOCH" });
    }, 20_000);
  });
});
