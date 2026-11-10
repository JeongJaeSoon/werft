import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import {
  INCOMPATIBLE_CHECKPOINT_REASON,
  RESTORE_FAILURE_LIMIT,
} from "./restore-failures.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  events,
  sessionPinCutover,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { confirmExecutionGone } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const MANIFEST_SHA = "c".repeat(64);

const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};

const catalog: SessionCatalog = withSeededInstallation({
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
});

integration("startup failures before ready on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "restore_fail_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      checkpointProtocol: {
        async requestCheckpoint() {
          throw new Error("not used");
        },
        async getRestorePlan() {
          throw new Error("not used");
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
    await pool.end();
    await database.drop();
  }, 60_000);

  const controls = () => createPostgresSessionControl(db);
  const inputs = () => createPostgresSessionUnitOfWork(db);
  const reader = () => createPostgresSessionReader(db);
  const scheduler = () =>
    createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope;
    executionId: string;
  };
  type Session = { sessionId: string; ownerId: string; partition: string };

  async function newSession(name: string): Promise<Session> {
    const partition = `${name}-${crypto.randomUUID()}`;
    const ownerId = `owner-${crypto.randomUUID()}`;
    const accepted = await inputs().acceptInputAtomic({
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
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
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
    return { sessionId, ownerId, partition };
  }

  function workerOf(
    claimed: Awaited<ReturnType<WorkerGateway["bootstrapClaim"]>>,
    executionId: string,
  ): Worker {
    return {
      principal: {
        kind: "session",
        attemptId: claimed.attempt_id,
        sessionId: claimed.session_id,
        leaseEpoch: claimed.lease_epoch,
        executionGeneration: claimed.execution_generation,
        authRevision: claimed.auth_revision,
      },
      scope: {
        session_id: claimed.session_id,
        turn_id: null,
        attempt_id: claimed.attempt_id,
        lease_epoch: claimed.lease_epoch,
        execution_generation: claimed.execution_generation,
        auth_revision: claimed.auth_revision,
      },
      executionId,
    };
  }

  // The scheduler's own path: demand, reservation, nonce, claim.
  async function claimReserved(session: Session) {
    const store = scheduler();
    const demand = await store.inspectDemand({ limit: 1_000 });
    expect(demand.eligibleSessionIds).toContain(session.sessionId);
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: new Date(),
      sessionId: session.sessionId,
      slotLimit: 1_000,
    });
    if (!intent) throw new Error("no reservation");
    const nonce = await store.issueBootstrapNonce({
      executionId: intent.executionId,
      generation: intent.generation,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: intent.executionId,
      execution_generation: intent.generation,
      credential: { kind: "launch_nonce", nonce },
    });
    expect(claimed.session_id).toBe(session.sessionId);
    return { worker: workerOf(claimed, intent.executionId), claimed };
  }

  async function launchable(session: Session): Promise<boolean> {
    const demand = await scheduler().inspectDemand({ limit: 1_000 });
    return demand.eligibleSessionIds.includes(session.sessionId);
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function queuedTurns(sessionId: string) {
    return (
      await db
        .select({ status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(asc(turns.sequence))
    ).filter(({ status }) => status === "queued").length;
  }

  async function systemEvents(sessionId: string, subtype: string) {
    const rows = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.id));
    return rows
      .map(({ payload }) => payload as Record<string, unknown>)
      .filter((payload) => payload.subtype === subtype);
  }

  /** The backoff the last failure started, spent on the database clock. */
  async function spendBackoff(session: Session) {
    await db
      .update(sessions)
      .set({ restoreRetryAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(sessions.id, session.sessionId));
  }

  async function decide(
    session: Session,
    decision: "retry_restore" | "start_fresh",
    reason = "the cause is fixed",
  ) {
    return controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision,
        expected_revision: (await sessionRow(session.sessionId)).revision,
        reason,
      },
      now: new Date(),
    });
  }

  const NOT_RESTORE_FAILED = {
    outcome: "not_restore_failed",
    admissionState: "recovery_required",
  } as const;

  /**
   * Turn 1 ran and committed checkpoint 0 and its worker went idle; a
   * second input now waits for a worker that has to restore checkpoint 0.
   */
  async function checkpointedSession(name: string): Promise<Session> {
    const session = await newSession(name);
    const { worker } = await claimReserved(session);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    if (!next.input) throw new Error("no input delivered");
    await gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: next.input.turn_id,
      finalize_key: `${worker.scope.attempt_id}:${next.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${session.sessionId}/0`,
        manifest_sha256: MANIFEST_SHA,
      },
    });
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    const appended = await inputs().appendInputAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input needs the restore",
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    });
    expect(appended.outcome).toBe("accepted");
    expect((await sessionRow(session.sessionId)).restoreAttemptId).toBeNull();
    return session;
  }

  const REFUSED =
    "Checkpoint restore refused (CHECKPOINT_UNAVAILABLE): manifests/x/0 arrived damaged: it fails the store's own checksum";
  const INCOMPATIBLE =
    "Checkpoint restore refused (INCOMPATIBLE_CHECKPOINT): sdkVersion 1 where this worker runs 2";

  /** A worker claims with the restore, fails it, releases, and is seen gone. */
  async function failRestore(session: Session, release = true) {
    const { worker, claimed } = await claimReserved(session);
    expect(claimed.restore?.revision).toBe(0);
    expect((await sessionRow(session.sessionId)).restoreAttemptId).toBe(
      claimed.attempt_id,
    );
    if (release) {
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: REFUSED,
      });
    }
    await confirmExecutionGone(db, worker.executionId);
    return claimed;
  }

  test("counts restores that end before ready, backs off between them, and holds the session for an operator at the limit", async () => {
    const session = await checkpointedSession("limit");
    const start = (await sessionRow(session.sessionId)).executionGeneration;

    const first = await failRestore(session);
    const backingOff = await sessionRow(session.sessionId);
    expect(backingOff.admissionState).toBe("active");
    expect(backingOff.restoreFailureCount).toBe(1);
    expect(backingOff.restoreFailureReason).toBe(REFUSED);
    expect(backingOff.restoreAttemptId).toBeNull();
    // The first startup backoff, on the database clock.
    const [clock] = await db
      .execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`)
      .then((result) => result.rows);
    const wait =
      (backingOff.restoreRetryAt?.getTime() ?? 0) -
      new Date(String(clock?.now)).getTime();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    // Signalled again, but no launch until the backoff ends.
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.sessionId)),
    ).toHaveLength(1);
    expect(await launchable(session)).toBe(false);
    expect(
      await scheduler().reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: new Date(),
        sessionId: session.sessionId,
        slotLimit: 1_000,
      }),
    ).toBeNull();
    const detail = await reader().getSession(
      session.ownerId,
      session.sessionId,
    );
    expect(detail?.attention).toEqual({
      code: "RESTORE_FAILED",
      reason: REFUSED,
      failures: 1,
      retry_at: backingOff.restoreRetryAt?.toISOString() ?? null,
    });

    for (let failures = 2; failures < RESTORE_FAILURE_LIMIT; failures++) {
      await spendBackoff(session);
      await failRestore(session);
      const row = await sessionRow(session.sessionId);
      expect(row.admissionState).toBe("active");
      expect(row.restoreFailureCount).toBe(failures);
      expect(await launchable(session)).toBe(false);
    }

    // The last allowed one fails too, this time without releasing: a
    // worker killed in the middle of its restore counts the same.
    await spendBackoff(session);
    await failRestore(session, false);
    const held = await sessionRow(session.sessionId);
    expect(held.admissionState).toBe("recovery_required");
    expect(held.status).toBe("failed");
    expect(held.restoreFailureCount).toBe(RESTORE_FAILURE_LIMIT);
    expect(held.restoreFailureReason).toBe("execution_gone");
    expect(held.restoreRetryAt).toBeNull();
    // One generation per allowed restore, and none after.
    expect(held.executionGeneration).toBe(start + RESTORE_FAILURE_LIMIT);
    expect(await launchable(session)).toBe(false);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.sessionId)),
    ).toHaveLength(0);
    // The input is kept for whatever the operator decides.
    expect(await queuedTurns(session.sessionId)).toBe(1);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toEqual({
      code: "RESTORE_FAILED",
      reason: "execution_gone",
      failures: RESTORE_FAILURE_LIMIT,
      retry_at: null,
    });
    const failed = await systemEvents(
      session.sessionId,
      "checkpoint_restore_failed",
    );
    expect(failed.map(({ failures }) => failures)).toEqual([1, 2, 3]);
    expect(failed[0]).toMatchObject({
      checkpoint_revision: 0,
      limit: RESTORE_FAILURE_LIMIT,
      reason: REFUSED,
    });
    expect(failed.at(-1)?.retry_at).toBeNull();
    expect(first.attempt_id).not.toBe(held.restoreAttemptId);

    // start_fresh goes on without the checkpoint, and the count with it.
    const decided = await controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "start_fresh",
        expected_revision: held.revision,
        reason: "the checkpoint keeps failing to restore",
      },
      now: new Date(),
    });
    expect(decided.outcome).toBe("accepted");
    const fresh = await sessionRow(session.sessionId);
    expect(fresh.admissionState).toBe("active");
    expect(fresh.restoreFailureCount).toBe(0);
    expect(fresh.restoreFailureReason).toBeNull();
    expect(await launchable(session)).toBe(true);
    const { claimed } = await claimReserved(session);
    expect(claimed.restore).toBeNull();
    // Nothing to restore, but still a startup on trial.
    expect((await sessionRow(session.sessionId)).restoreAttemptId).toBe(
      claimed.attempt_id,
    );
  });

  test("holds an incompatible checkpoint after its first failed launch", async () => {
    const session = await checkpointedSession("incompatible");
    const start = (await sessionRow(session.sessionId)).executionGeneration;
    const { worker } = await claimReserved(session);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: INCOMPATIBLE,
    });
    await confirmExecutionGone(db, worker.executionId);

    const held = await sessionRow(session.sessionId);
    expect(held.admissionState).toBe("recovery_required");
    expect(held.status).toBe("failed");
    expect(held.restoreFailureCount).toBe(1);
    expect(held.restoreFailureReason).toBe(INCOMPATIBLE_CHECKPOINT_REASON);
    expect(held.restoreRetryAt).toBeNull();
    expect(held.executionGeneration).toBe(start + 1);
    expect(await launchable(session)).toBe(false);
    expect(await queuedTurns(session.sessionId)).toBe(1);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toEqual({
      code: "RESTORE_FAILED",
      reason: INCOMPATIBLE_CHECKPOINT_REASON,
      failures: 1,
      retry_at: null,
    });
    expect(
      await systemEvents(session.sessionId, "checkpoint_restore_failed"),
    ).toEqual([
      expect.objectContaining({
        checkpoint_revision: 0,
        failures: 1,
        limit: RESTORE_FAILURE_LIMIT,
        reason: INCOMPATIBLE_CHECKPOINT_REASON,
        retry_at: null,
      }),
    ]);
    const [status] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.sessionId, session.sessionId), eq(events.type, "status")),
      )
      .orderBy(desc(events.id))
      .limit(1);
    expect(status?.payload).toMatchObject({
      phase: "failed",
      admission_state: "recovery_required",
      reason: INCOMPATIBLE_CHECKPOINT_REASON,
    });

    expect(await decide(session, "retry_restore")).toMatchObject({
      outcome: "accepted",
    });
    const retried = await sessionRow(session.sessionId);
    expect(retried.admissionState).toBe("active");
    expect(retried.restoreFailureCount).toBe(0);
    expect(retried.restoreFailureReason).toBeNull();
    expect(await launchable(session)).toBe(true);
  });

  test("holds a checkpoint no configured image can restore before anything launches, and retry_restore lets it back", async () => {
    const fresh = await newSession("launch-hold-none");
    expect(await scheduler().pointerRuntimeOf(fresh.sessionId)).toEqual({
      pointer: { kind: "none" },
      checkpointRevision: 0,
    });
    const session = await checkpointedSession("launch-hold");
    // This gateway's verifier records no runtime, as a checkpoint committed
    // before the columns existed would read.
    expect(await scheduler().pointerRuntimeOf(session.sessionId)).toEqual({
      pointer: { kind: "unrecorded" },
      checkpointRevision: 0,
    });
    const hold = (checkpointRevision: number) =>
      scheduler().holdIncompatibleBeforeLaunch({
        sessionId: session.sessionId,
        checkpointRevision,
        detail: "no configured worker image runs sdkVersion 0.3.260",
        now: new Date(),
      });

    // A pointer that moved since the pass read it is the pass's to reread.
    expect(await hold(1)).toBe("stale");
    expect((await sessionRow(session.sessionId)).admissionState).toBe("active");

    expect(await hold(0)).toBe("held");
    const held = await sessionRow(session.sessionId);
    expect(held).toMatchObject({
      admissionState: "recovery_required",
      status: "failed",
      restoreFailureCount: 1,
      restoreFailureReason: INCOMPATIBLE_CHECKPOINT_REASON,
      restoreRetryAt: null,
    });
    expect(await launchable(session)).toBe(false);
    expect(await queuedTurns(session.sessionId)).toBe(1);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toEqual({
      code: "RESTORE_FAILED",
      reason: INCOMPATIBLE_CHECKPOINT_REASON,
      failures: 1,
      retry_at: null,
    });
    expect(
      await systemEvents(session.sessionId, "checkpoint_restore_failed"),
    ).toEqual([
      expect.objectContaining({
        checkpoint_revision: 0,
        detected_at: "launch",
        detail: "no configured worker image runs sdkVersion 0.3.260",
        failures: 1,
        reason: INCOMPATIBLE_CHECKPOINT_REASON,
      }),
    ]);
    // Held already: a second pass records nothing more.
    expect(await hold(0)).toBe("stale");
    expect((await sessionRow(session.sessionId)).restoreFailureCount).toBe(1);

    expect(await decide(session, "retry_restore")).toMatchObject({
      outcome: "accepted",
    });
    expect(await launchable(session)).toBe(true);
  });

  test("a checkpoint start_fresh retired holds no image and no session", async () => {
    const session = await checkpointedSession("launch-hold-fresh");
    const hold = () =>
      scheduler().holdIncompatibleBeforeLaunch({
        sessionId: session.sessionId,
        checkpointRevision: 0,
        detail: "no configured worker image runs it",
        now: new Date(),
      });
    expect(await hold()).toBe("held");
    expect(await decide(session, "start_fresh")).toMatchObject({
      outcome: "accepted",
    });
    expect((await sessionRow(session.sessionId)).checkpointRevision).toBe(0);
    expect(await scheduler().pointerRuntimeOf(session.sessionId)).toEqual({
      pointer: { kind: "none" },
      checkpointRevision: 0,
    });
    // A pass that read the pointer before the decision is refused too.
    expect(await hold()).toBe("stale");
    expect((await sessionRow(session.sessionId)).admissionState).toBe("active");
    expect(await launchable(session)).toBe(true);
  });

  test("leaves a session with a launch in flight to that launch", async () => {
    const session = await checkpointedSession("launch-hold-open");
    const intent = await scheduler().reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: new Date(),
      sessionId: session.sessionId,
      slotLimit: 1_000,
    });
    if (!intent) throw new Error("no reservation");
    expect(
      await scheduler().holdIncompatibleBeforeLaunch({
        sessionId: session.sessionId,
        checkpointRevision: 0,
        detail: "no configured worker image runs it",
        now: new Date(),
      }),
    ).toBe("stale");
    expect((await sessionRow(session.sessionId)).admissionState).toBe("active");
  });

  test("retry_restore restores the same checkpoint again, with the count started over", async () => {
    const session = await checkpointedSession("retry");
    await failRestore(session);
    // Backing off is not stopped: the scheduler is still retrying on its own.
    expect(await decide(session, "retry_restore")).toEqual({
      ...NOT_RESTORE_FAILED,
      admissionState: "active",
    });
    for (let failures = 2; failures <= RESTORE_FAILURE_LIMIT; failures++) {
      await spendBackoff(session);
      await failRestore(session);
    }
    const held = await sessionRow(session.sessionId);
    expect(held.admissionState).toBe("recovery_required");

    const statusEvents = async () =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(
            and(
              eq(events.sessionId, session.sessionId),
              eq(events.type, "status"),
            ),
          )
          .orderBy(asc(events.id))
      ).map(({ payload }) => payload);
    const statusBefore = (await statusEvents()).length;

    // The held session may carry the status of an ended one, which the gate
    // does not count. This one has no release to pin from, so with the pin
    // authoritative retrying is refused in words, not by the trigger.
    await db
      .update(sessions)
      .set({ status: "failed" })
      .where(eq(sessions.id, session.sessionId));
    await db
      .update(sessionPinCutover)
      .set({ authoritative: true, flippedAt: new Date() });
    try {
      expect(await decide(session, "retry_restore", "no pin")).toEqual({
        outcome: "pin_required",
      });
      expect(await sessionRow(session.sessionId)).toMatchObject({
        admissionState: "recovery_required",
        status: "failed",
        revision: held.revision,
      });
    } finally {
      await db
        .update(sessionPinCutover)
        .set({ authoritative: false, flippedAt: null });
      await db
        .update(sessions)
        .set({ status: held.status })
        .where(eq(sessions.id, session.sessionId));
    }

    const decided = await decide(session, "retry_restore", "proxy fixed");
    expect(decided.outcome).toBe("accepted");
    // One status event says where it went.
    expect((await statusEvents()).slice(statusBefore)).toEqual([
      {
        phase: "queued",
        admission_state: "active",
        decision: "retry_restore",
        actor: { owner_id: session.ownerId },
      },
    ]);
    const retried = await sessionRow(session.sessionId);
    expect(retried).toMatchObject({
      admissionState: "active",
      status: "queued",
      revision: held.revision + 1,
      leaseEpoch: held.leaseEpoch + 1,
      restoreFailureCount: 0,
      restoreFailureReason: null,
      restoreRetryAt: null,
      restoreAttemptId: null,
      checkpointRevision: held.checkpointRevision,
    });
    expect(await queuedTurns(session.sessionId)).toBe(1);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toBeNull();
    expect(
      (await systemEvents(session.sessionId, "recovery_decision")).at(-1),
    ).toMatchObject({
      decision: "retry_restore",
      reason: "proxy fixed",
      resulting_admission_state: "active",
      checkpoint_revision: 0,
      resumable: false,
    });
    // Signalled again for its queued input.
    expect(await launchable(session)).toBe(true);

    // The next claim restores the checkpoint the failing ones did, on trial
    // again: a fourth failure is the first of a new count.
    const claimed = await failRestore(session);
    expect(claimed.restore?.revision).toBe(0);
    const again = await sessionRow(session.sessionId);
    expect(again.admissionState).toBe("active");
    expect(again.restoreFailureCount).toBe(1);
    expect(
      (await systemEvents(session.sessionId, "checkpoint_restore_failed")).map(
        ({ failures }) => failures,
      ),
    ).toEqual([1, 2, 3, 1]);
  });

  test("a restore reported ready clears the count, and its later exit is not a restore failure", async () => {
    const session = await checkpointedSession("ready");
    await failRestore(session);
    await spendBackoff(session);

    const { worker } = await claimReserved(session);
    // Not the revision it was handed: proves nothing.
    await gateway.ready(worker.principal, {
      ...worker.scope,
      restored_revision: null,
    });
    expect((await sessionRow(session.sessionId)).restoreFailureCount).toBe(1);

    expect(
      await gateway.ready(worker.principal, {
        ...worker.scope,
        restored_revision: 0,
      }),
    ).toEqual({ activated: false });
    const ready = await sessionRow(session.sessionId);
    expect(ready.restoreFailureCount).toBe(0);
    expect(ready.restoreRetryAt).toBeNull();
    expect(ready.restoreFailureReason).toBeNull();
    expect(ready.restoreAttemptId).toBeNull();
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toBeNull();

    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "drain",
    });
    await confirmExecutionGone(db, worker.executionId);
    const after = await sessionRow(session.sessionId);
    expect(after.restoreFailureCount).toBe(0);
    expect(after.restoreRetryAt).toBeNull();
    expect(await launchable(session)).toBe(true);
  });

  test("keeps a worker's release reason to one bounded line, on the attempt and the session", async () => {
    const session = await checkpointedSession("reason");
    const { worker, claimed } = await claimReserved(session);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: `${"x".repeat(5_000)}\r\n    at restorePlan (session-checkpoints.ts:1:1)`,
    });
    await confirmExecutionGone(db, worker.executionId);

    const [attempt] = await db
      .select({ endReason: attempts.endReason })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    const row = await sessionRow(session.sessionId);
    for (const stored of [attempt?.endReason, row.restoreFailureReason]) {
      expect(stored).toHaveLength(500);
      expect(stored?.endsWith("…")).toBe(true);
      expect(stored).not.toContain("\n");
    }
  });

  const CLONE_FAILED =
    "Workspace preparation failed: git fetch exited 128: repository not found";

  /** A worker claims with nothing to restore and fails to prepare the workspace. */
  async function failStartup(session: Session, release = true) {
    const { worker, claimed } = await claimReserved(session);
    expect(claimed.restore).toBeNull();
    expect((await sessionRow(session.sessionId)).restoreAttemptId).toBe(
      claimed.attempt_id,
    );
    if (release) {
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: CLONE_FAILED,
      });
    }
    await confirmExecutionGone(db, worker.executionId);
    return claimed;
  }

  test("a claim with nothing to restore that never asks for input is counted the same, and held as STARTUP_FAILED at the limit", async () => {
    const session = await newSession("fresh-limit");
    const start = (await sessionRow(session.sessionId)).executionGeneration;

    await failStartup(session);
    const backingOff = await sessionRow(session.sessionId);
    expect(backingOff.admissionState).toBe("active");
    expect(backingOff.restoreFailureCount).toBe(1);
    expect(backingOff.restoreRetryAt).not.toBeNull();
    expect(await launchable(session)).toBe(false);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toEqual({
      code: "STARTUP_FAILED",
      reason: CLONE_FAILED,
      failures: 1,
      retry_at: backingOff.restoreRetryAt?.toISOString() ?? null,
    });

    for (let failures = 2; failures <= RESTORE_FAILURE_LIMIT; failures++) {
      await spendBackoff(session);
      await failStartup(session);
    }
    const held = await sessionRow(session.sessionId);
    expect(held.admissionState).toBe("recovery_required");
    expect(held.status).toBe("failed");
    expect(held.executionGeneration).toBe(start + RESTORE_FAILURE_LIMIT);
    expect(await launchable(session)).toBe(false);
    expect(await queuedTurns(session.sessionId)).toBe(1);
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toEqual({
      code: "STARTUP_FAILED",
      reason: CLONE_FAILED,
      failures: RESTORE_FAILURE_LIMIT,
      retry_at: null,
    });
    const failed = await systemEvents(session.sessionId, "startup_failed");
    expect(failed.map(({ failures }) => failures)).toEqual([1, 2, 3]);
    expect(failed[0]).not.toHaveProperty("checkpoint_revision");
    expect(
      await systemEvents(session.sessionId, "checkpoint_restore_failed"),
    ).toEqual([]);
    const [status] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.sessionId, session.sessionId), eq(events.type, "status")),
      )
      .orderBy(desc(events.id))
      .limit(1);
    expect(status?.payload).toMatchObject({
      phase: "failed",
      admission_state: "recovery_required",
      reason: "startup_failed",
    });

    // Nothing to restore: retry_restore is not the way on.
    expect(await decide(session, "retry_restore")).toEqual(NOT_RESTORE_FAILED);

    // Once the cause is fixed, start_fresh launches again.
    const decided = await controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "start_fresh",
        expected_revision: held.revision,
        reason: "the repository is back",
      },
      now: new Date(),
    });
    expect(decided.outcome).toBe("accepted");
    expect((await sessionRow(session.sessionId)).restoreFailureCount).toBe(0);
    expect(await launchable(session)).toBe(true);
  });

  test("a worker that asked for input once is not a failed startup, whatever it did before — an older worker sends no ready", async () => {
    const session = await newSession("fresh-ready");
    await failStartup(session);
    await spendBackoff(session);

    const { worker } = await claimReserved(session);
    // Queued input is handed over; an empty poll would clear it the same.
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input).not.toBeNull();
    const ready = await sessionRow(session.sessionId);
    expect(ready.restoreFailureCount).toBe(0);
    expect(ready.restoreRetryAt).toBeNull();
    expect(ready.restoreAttemptId).toBeNull();
    expect(
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention,
    ).toBeNull();
    if (!next.input) throw new Error("no input delivered");
    await gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: next.input.turn_id,
      finalize_key: `${worker.scope.attempt_id}:${next.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${session.sessionId}/0`,
        manifest_sha256: MANIFEST_SHA,
      },
    });
    // Its idle exit.
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    const after = await sessionRow(session.sessionId);
    expect(after.restoreFailureCount).toBe(0);
    expect(after.admissionState).toBe("active");
    expect(
      await systemEvents(session.sessionId, "startup_failed"),
    ).toHaveLength(1);
  });

  test("a startup a signal drained is not counted, and the failures before it still are", async () => {
    const session = await newSession("drained");
    await failStartup(session);
    await spendBackoff(session);
    const { worker } = await claimReserved(session);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "received SIGTERM",
      stop_kind: "drain",
    });
    await confirmExecutionGone(db, worker.executionId);
    const row = await sessionRow(session.sessionId);
    expect(row.admissionState).toBe("active");
    expect(row.restoreFailureCount).toBe(1);
    expect(row.restoreFailureReason).toBe(CLONE_FAILED);
    expect(row.restoreAttemptId).toBeNull();
    expect(await launchable(session)).toBe(true);
    expect(
      await systemEvents(session.sessionId, "startup_failed"),
    ).toHaveLength(1);
  });

  test("an exit after the first turn started stays with the unknown-turn recovery, not the startup count", async () => {
    const session = await newSession("after-turn");
    const { worker } = await claimReserved(session);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input).not.toBeNull();
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "The engine stream ended",
    });
    await confirmExecutionGone(db, worker.executionId);
    const row = await sessionRow(session.sessionId);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.restoreFailureCount).toBe(0);
    expect(row.restoreRetryAt).toBeNull();
    expect(await systemEvents(session.sessionId, "startup_failed")).toEqual([]);
    // An unknown turn is abandon's or confirm_completed's.
    expect(await decide(session, "retry_restore")).toEqual(NOT_RESTORE_FAILED);
  });

  test("a startup the session asked to stop is not a failed one", async () => {
    const session = await newSession("terminated");
    const { worker } = await claimReserved(session);
    const row = await sessionRow(session.sessionId);
    const terminated = await controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "operator",
      now: new Date(),
    });
    expect(terminated.outcome).toBe("accepted");
    // The kill lands mid-startup; the fenced worker cannot release.
    await confirmExecutionGone(db, worker.executionId);
    const after = await sessionRow(session.sessionId);
    expect(after.admissionState).toBe("stopped");
    expect(after.restoreFailureCount).toBe(0);
    expect(await systemEvents(session.sessionId, "startup_failed")).toEqual([]);
  });
});
