import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  hashWorkerToken,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  receipts,
  sessions,
  unassignedSessions,
  workerCredentials,
} from "./schema.ts";
import { reconcileExpiredLeases } from "./sessions/lease-reconcile.ts";
import {
  confirmExecutionGone,
  launchSession,
  type TestLaunch,
} from "./testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

// a claim whose response was lost is retried with the same nonce
// and answered from the attempt the first claim created. Terminate, close,
// pause and the lease sweep fence that attempt by moving the session on
// while leaving it `allocated` until the execution is seen gone
// so the replay has to judge the binding the way a new claim and the fence
// would, or it hands a stopping session fresh credentials.

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 2_000;
// Several rounds of claims and locks each; the default 5 s is one slow
// shared runner away from a false failure.
const TIMEOUT_MS = 30_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("claim replay against the session's current binding", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  const clock = new Date("2026-09-24T00:00:00.000Z");

  const gatewayWithLease = (leaseTtlMs: number) =>
    createWorkerGateway({
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
        models: ["claude-sonnet-5"],
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
        leaseTtlMs,
        now: () => clock,
        sleep: async () => {},
      },
    });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "claim_replay_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    gateway = gatewayWithLease(LEASE_TTL_MS);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const controls = () => createPostgresSessionControl(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });

  async function queuedSession(partition: string) {
    const ownerId = crypto.randomUUID();
    const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
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
    return { ...result.response, ownerId };
  }

  function claim(l: TestLaunch, via: WorkerGateway = gateway) {
    return via.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  type Claimed = Awaited<ReturnType<typeof claim>>;

  function scopeOf(claimed: Claimed): WorkerScope {
    return {
      session_id: claimed.session_id,
      turn_id: null,
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

  async function bound(name: string) {
    const partition = `${name}-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launchSession(db, { sessionId: session.session_id });
    const claimed = await claim(l);
    return { session, partition, launch: l, claimed };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  // Everything a replay writes: the token rows, the auth revision, the
  // attempt's lease. A refused replay must leave all of it as it was.
  async function replayFootprint(sessionId: string, attemptId: string) {
    const session = await sessionRow(sessionId);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    const tokens = await db
      .select({
        purpose: workerCredentials.purpose,
        tokenHash: workerCredentials.tokenHash,
        revokedAt: workerCredentials.revokedAt,
      })
      .from(workerCredentials)
      .where(eq(workerCredentials.attemptId, attemptId))
      .orderBy(
        asc(workerCredentials.createdAt),
        asc(workerCredentials.purpose),
      );
    return {
      sessionAuthRevision: session.authRevision,
      attemptAuthRevision: attempt?.authRevision,
      attemptState: attempt?.state,
      leaseExpiresAt: attempt?.leaseExpiresAt.getTime(),
      tokens: tokens.map((token) => ({
        purpose: token.purpose,
        tokenHash: Buffer.from(token.tokenHash).toString("hex"),
        revoked: token.revokedAt !== null,
      })),
    };
  }

  function terminate(session: { session_id: string; ownerId: string }) {
    return sessionRow(session.session_id).then((row) =>
      controls().terminateAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        expectedRevision: row.revision,
        reason: "operator",
        now: clock,
      }),
    );
  }

  test(
    "a replay after terminate is refused and rotates nothing",
    async () => {
      const { session, launch: l, claimed } = await bound("terminate");
      const terminated = await terminate(session);
      expect(terminated.outcome).toBe("accepted");
      const before = await replayFootprint(
        session.session_id,
        claimed.attempt_id,
      );
      expect(before.attemptState).toBe("allocated");

      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await replayFootprint(session.session_id, claimed.attempt_id),
      ).toEqual(before);
      // The kill still settles the session: the refusal left the attempt for
      // the exit observation to close, as terminate intends.
      expect(await confirmExecutionGone(db, l.executionId)).toEqual({
        sessionReleased: true,
        slotReleased: true,
      });
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "stopped",
      );
    },
    TIMEOUT_MS,
  );

  // Holds the launch row both paths lock first, lets `first` and then
  // `second` queue on it, and releases: the first waiter holds the tuple lock
  // the second queues on, so the interleaving is fixed rather than sampled.
  async function inOrderBehindLaunchLock<A, B>(
    executionId: string,
    first: () => Promise<A>,
    second: () => Promise<B>,
  ) {
    const holder = await pool.connect();
    const started: Promise<unknown>[] = [];
    let committed = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
        [executionId],
      );
      const { rows } = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const holderPid = Number(rows[0]?.pid);
      const a = first();
      started.push(a);
      const firstWaiter = await waiterBlockedBy([holderPid]);
      const b = second();
      started.push(b);
      await waiterBlockedBy([holderPid, firstWaiter], firstWaiter);
      await holder.query("COMMIT");
      committed = true;
      return await Promise.allSettled([a, b]);
    } finally {
      // A failed wait must not leave the row locked under the queued calls.
      if (!committed) await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      if (!committed) await Promise.allSettled(started);
    }
  }

  // The first backend, other than `except`, waiting on a lock one of `pids`
  // holds: these waiters, not whatever else waits in this database.
  async function waiterBlockedBy(pids: number[], except = 0) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE pg_blocking_pids(pid) && $1::int[] AND pid <> $2
          LIMIT 1`,
        [pids, except],
      );
      if (rows[0]) return Number(rows[0].pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no backend queued behind ${pids.join(",")}`);
  }

  test(
    "a replay that queued behind a terminate reads its result and is refused",
    async () => {
      const {
        session,
        launch: l,
        claimed,
      } = await bound("race-terminate-first");
      const [terminated, replay] = await inOrderBehindLaunchLock(
        l.executionId,
        () => terminate(session),
        () => claim(l),
      );
      if (terminated.status !== "fulfilled") throw terminated.reason;
      expect(terminated.value.outcome).toBe("accepted");
      expect(replay.status).toBe("rejected");
      if (replay.status === "rejected") {
        expect(replay.reason).toBeInstanceOf(WorkerGatewayError);
        expect((replay.reason as WorkerGatewayError).status).toBe(401);
      }
      const footprint = await replayFootprint(
        session.session_id,
        claimed.attempt_id,
      );
      // The first claim's tokens, one per purpose, are the only ones, and
      // the auth revision is the one that claim handed out.
      expect(footprint.tokens).toEqual(
        ["gateway", "object_store", "packages", "provider", "repository"].map(
          (purpose) => ({
            purpose,
            tokenHash: expect.any(String),
            revoked: false,
          }),
        ),
      );
      expect(footprint.sessionAuthRevision).toBe(claimed.auth_revision);
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "stopping",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a replay that got the launch row before terminate is answered, then fenced by it",
    async () => {
      const { session, launch: l, claimed } = await bound("race-replay-first");
      const [replay, terminated] = await inOrderBehindLaunchLock(
        l.executionId,
        () => claim(l),
        () => terminate(session),
      );
      if (terminated.status !== "fulfilled") throw terminated.reason;
      expect(terminated.value.outcome).toBe("accepted");
      if (replay.status !== "fulfilled") throw replay.reason;
      expect(replay.value.attempt_id).toBe(claimed.attempt_id);
      const after = await sessionRow(session.session_id);
      expect(after.admissionState).toBe("stopping");
      expect(replay.value.lease_epoch).toBe(after.leaseEpoch - 1);
      // Terminate's epoch move fences it like any worker that was running.
      expect(
        await failure(
          gateway.nextInput(principalOf(replay.value), scopeOf(replay.value)),
        ),
      ).toEqual({ status: 409, code: "STALE_EPOCH" });
      // And the retry after that is refused.
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
    },
    TIMEOUT_MS,
  );

  test(
    "a replay after an operator close is refused, as it is while the session waits on the operator",
    async () => {
      const { session, launch: l, claimed } = await bound("close");
      // The barrier an operator is asked to settle; the epoch it was raised
      // on is the claim's, so only the admission state tells them apart.
      await db
        .update(sessions)
        .set({ admissionState: "recovery_required" })
        .where(eq(sessions.id, session.session_id));
      const waiting = await replayFootprint(
        session.session_id,
        claimed.attempt_id,
      );
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await replayFootprint(session.session_id, claimed.attempt_id),
      ).toEqual(waiting);

      const row = await sessionRow(session.session_id);
      const closed = await controls().decideRecoveryAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        decision: {
          decision: "close",
          expected_revision: row.revision,
          reason: "operator gave up",
        },
        now: clock,
      });
      expect(closed.outcome).toBe("accepted");
      const before = await replayFootprint(
        session.session_id,
        claimed.attempt_id,
      );
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await replayFootprint(session.session_id, claimed.attempt_id),
      ).toEqual(before);
      await confirmExecutionGone(db, l.executionId);
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "closed",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a replay while a pause waits on the unstarted attempt is refused, and the exit still settles the pause",
    async () => {
      const { session, launch: l, claimed } = await bound("pause");
      const row = await sessionRow(session.session_id);
      const paused = await controls().pauseAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        expectedRevision: row.revision,
        reason: "save cost overnight",
        now: new Date(),
      });
      expect(paused.outcome).toBe("accepted");
      // The claimed attempt is the drainer, so the pause keeps its epoch:
      // the admission state is all that says a claim is no longer wanted.
      const pausing = await sessionRow(session.session_id);
      expect(pausing.admissionState).toBe("pausing");
      expect(pausing.leaseEpoch).toBe(claimed.lease_epoch);
      const before = await replayFootprint(
        session.session_id,
        claimed.attempt_id,
      );
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await replayFootprint(session.session_id, claimed.attempt_id),
      ).toEqual(before);
      // The pause does not hang on the refused worker: the exit observation
      // settles it. This session never ran a turn, so it has no checkpoint to
      // pause onto and the pause fails back to active.
      await confirmExecutionGone(db, l.executionId);
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "active",
      );
      if (paused.outcome !== "accepted") throw new Error(paused.outcome);
      const [receipt] = await db
        .select({ status: receipts.status })
        .from(receipts)
        .where(eq(receipts.id, paused.response.receipt_id));
      expect(receipt?.status).toBe("failed");
    },
    TIMEOUT_MS,
  );

  test(
    "a claimed launch is not rebuilt, so a replacement request leaves the replay working",
    async () => {
      const { session, launch: l, claimed } = await bound("replace-after");
      expect(
        await store().requestReplacement(
          { executionId: l.executionId, generation: l.generation },
          "stale_isolation",
          0,
        ),
      ).toBeNull();
      const replay = await claim(l);
      expect(replay.attempt_id).toBe(claimed.attempt_id);
      expect(replay.lease_epoch).toBe(claimed.lease_epoch);
      const next = await gateway.nextInput(
        principalOf(replay),
        scopeOf(replay),
      );
      expect(next.input?.turn_id).toBe("1");
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "active",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a claim racing a replacement request: exactly one of them wins the launch",
    async () => {
      for (let round = 0; round < 8; round++) {
        const partition = `replace-race-${round}-${crypto.randomUUID()}`;
        const session = await queuedSession(partition);
        const l = await launchSession(db, { sessionId: session.session_id });
        const [claimed, replaced] = await Promise.allSettled([
          claim(l),
          store().requestReplacement(
            { executionId: l.executionId, generation: l.generation },
            "stale_isolation",
            0,
          ),
        ]);
        if (replaced.status !== "fulfilled") throw replaced.reason;
        if (claimed.status === "fulfilled") {
          expect(replaced.value).toBeNull();
          // A retry of that claim is still answered with its binding.
          expect((await claim(l)).attempt_id).toBe(claimed.value.attempt_id);
        } else {
          expect(replaced.value).toBe(1);
          expect((claimed.reason as WorkerGatewayError).status).toBe(401);
          // The rebuild's nonce is gone with the old one: nothing to replay.
          expect(await failure(claim(l))).toEqual({
            status: 401,
            code: "UNAUTHORIZED",
          });
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    "once the lease sweep replaces the worker, the old nonce opens nothing and the new binding keeps its token",
    async () => {
      const brief = gatewayWithLease(300);
      const partition = `sweep-${crypto.randomUUID()}`;
      const session = await queuedSession(partition);
      const old = await launchSession(db, { sessionId: session.session_id });
      const first = await claim(old, brief);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const swept = await reconcileExpiredLeases(db, { now: clock });
      expect(
        swept.find((lease) => lease.attemptId === first.attempt_id)?.action,
      ).toBe("fenced");
      expect(await failure(claim(old, brief))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });

      // The replacement worker claims the session once the old one is gone
      // and the startup backoff its unready exit started is over.
      await confirmExecutionGone(db, old.executionId);
      await db
        .update(sessions)
        .set({ restoreRetryAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(sessions.id, session.session_id));
      await db
        .update(sessions)
        .set({ partition })
        .where(eq(sessions.id, session.session_id));
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, session.session_id));
      const replacement = await launchSession(db, {
        sessionId: session.session_id,
      });
      const second = await claim(replacement);
      expect(second.session_id).toBe(session.session_id);
      expect(second.attempt_id).not.toBe(first.attempt_id);

      const before = await replayFootprint(
        session.session_id,
        second.attempt_id,
      );
      // The late retry from the first worker: its slot is back, its attempt
      // lost, and it must not rotate the new worker's token away.
      expect(await failure(claim(old, brief))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await replayFootprint(session.session_id, second.attempt_id),
      ).toEqual(before);
      const next = await gateway.nextInput(
        principalOf(second),
        scopeOf(second),
      );
      expect(next.input?.turn_id).toBe("1");
    },
    TIMEOUT_MS,
  );

  test(
    "a claim and its late-arriving duplicate bind once, and only the later token resolves",
    async () => {
      for (let round = 0; round < 8; round++) {
        const partition = `late-${round}-${crypto.randomUUID()}`;
        const session = await queuedSession(partition);
        const l = await launchSession(db, { sessionId: session.session_id });
        const [a, b] = await Promise.all([claim(l), claim(l)]);
        expect(a.attempt_id).toBe(b.attempt_id);
        expect(a.lease_epoch).toBe(b.lease_epoch);
        const [older, newer] =
          a.auth_revision < b.auth_revision ? [a, b] : [b, a];
        expect(newer.auth_revision).toBe(older.auth_revision + 1);
        const work = createPostgresWorkerUnitOfWork(db);
        expect(
          await work.resolveCredential(
            hashWorkerToken(older.session_credential),
          ),
        ).toBeNull();
        expect(
          await work.resolveCredential(
            hashWorkerToken(newer.session_credential),
          ),
        ).toMatchObject({ kind: "session", authRevision: newer.auth_revision });
        const count = await db
          .select({ id: attempts.id })
          .from(attempts)
          .where(eq(attempts.sessionId, session.session_id));
        expect(count).toHaveLength(1);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a claim that arrives after the worker used its token cannot rotate it, even before a terminate",
    async () => {
      const { session, launch: l, claimed } = await bound("used");
      await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      await terminate(session);
      expect(await failure(claim(l))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
    },
    TIMEOUT_MS,
  );

  test(
    "a replay while the session resumes is still answered: resuming is claimable",
    async () => {
      const { session, launch: l, claimed } = await bound("resuming");
      // A resume's worker claims `resuming`; the epoch is the claim's own.
      await db
        .update(sessions)
        .set({ admissionState: "resuming" })
        .where(eq(sessions.id, session.session_id));
      const replay = await claim(l);
      expect(replay.attempt_id).toBe(claimed.attempt_id);
      expect(replay.lease_epoch).toBe(claimed.lease_epoch);
      expect(replay.auth_revision).toBe(claimed.auth_revision + 1);
    },
    TIMEOUT_MS,
  );
});
