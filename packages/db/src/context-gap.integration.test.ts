import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CheckpointRef,
  RecoveryDecisionRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  CHECKPOINT_ROOT_PARENT,
  createWorkerGateway,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  checkpoints,
  events,
  executions,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

/**
 * a worker that replaces another must not silently start a new
 * engine session over turns no checkpoint covers. These drive the real
 * gateway, controls and reader over PostgreSQL through every place the
 * verdict is taken: the exit observation, the claim, resume from stopped,
 * and the start_fresh decision that lets a session go on without them.
 */
integration("context gap on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  const clock = new Date("2026-09-23T00:00:00.000Z");
  const now = () => clock;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "context_gap_it" });
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
        models: ["claude-sonnet-5"],
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: { verify: async () => ({ status: "verified" }) },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        now,
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

  type Session = { session_id: string; ownerId: string; partition: string };
  type Claimed = Awaited<ReturnType<WorkerGateway["bootstrapClaim"]>>;

  async function queuedSession(name: string): Promise<Session> {
    const partition = `${name}-${crypto.randomUUID()}`;
    const ownerId = crypto.randomUUID();
    const result = await inputs().acceptInputAtomic({
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
    return { session_id: result.response.session_id, ownerId, partition };
  }

  function launch(session: Session) {
    return launchSession(db, { sessionId: session.session_id });
  }

  function claim(l: Awaited<ReturnType<typeof launch>>) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        return {
          status: error.status,
          code: error.code,
          retryable: error.retryable,
        };
      }
      throw error;
    }
    throw new Error("expected the gateway to refuse");
  }

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

  function checkpointAt(revision: number): CheckpointRef {
    return {
      revision,
      manifest_ref: `s3://bucket/manifest-${revision}.json`,
      manifest_sha256: "a".repeat(64),
    };
  }

  /**
   * One worker from claim to observed exit: it runs the next queued turn to
   * `completed`, with `checkpoint` or without one, and goes idle; the
   * scheduler then sees its execution gone. `thenQueue` arrives while it is
   * still bound, as a message sent after the turn would.
   */
  async function runOneTurn(
    session: Session,
    options: {
      checkpoint: CheckpointRef | null;
      thenQueue?: string;
      /** Reported by the worker before it finalizes, as a failed publish is. */
      pendingReason?: "publish_failed";
    },
  ) {
    const l = await launch(session);
    const claimed = await claim(l);
    // As a worker does before its first input: a restore it never reports
    // ready counts as a failed one.
    if (claimed.restore !== null) {
      await gateway.ready(principalOf(claimed), {
        ...scopeOf(claimed),
        restored_revision: claimed.restore.revision,
      });
    }
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    const turnId = next.input?.turn_id;
    if (turnId === undefined) throw new Error("no input delivered");
    if (options.pendingReason !== undefined) {
      const { kind: _kind, ...fence } = principalOf(claimed) as Extract<
        WorkerPrincipal,
        { kind: "session" }
      >;
      await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
        fence,
        now: clock,
        pendingReason: options.pendingReason,
      });
    }
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, turnId),
      turn_id: turnId,
      finalize_key: `fin-${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: options.checkpoint,
    });
    const queued =
      options.thenQueue === undefined
        ? null
        : await append(session, options.thenQueue);
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    await confirmExecutionGone(db, l.executionId);
    return { claimed, turnId, queued };
  }

  async function append(session: Session, message: string) {
    const appended = await inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message,
    });
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    return appended.response;
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function signalled(id: string) {
    const rows = await db
      .select({ id: unassignedSessions.sessionId })
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, id));
    return rows.length === 1;
  }

  async function auditOf(id: string) {
    return (
      await db
        .select({ type: events.type, payload: events.payload })
        .from(events)
        .where(and(eq(events.sessionId, id)))
        .orderBy(asc(events.id))
    ).filter((row) => row.type === "status" || row.type === "system");
  }

  function decide(session: Session, decision: RecoveryDecisionRequest) {
    return controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision,
      now: clock,
    });
  }

  async function startFresh(session: Session) {
    const row = await sessionRow(session.session_id);
    return decide(session, {
      decision: "start_fresh",
      expected_revision: row.revision,
      reason: "continue without the lost turns",
    });
  }

  async function receiptResult(receiptId: string) {
    const [row] = await db
      .select({ result: receipts.result, status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    return row;
  }

  test("an exit after a turn no checkpoint covers hands the session to an operator and keeps its queued input", async () => {
    const session = await queuedSession("exit-gap");
    const { queued } = await runOneTurn(session, {
      checkpoint: null,
      thenQueue: "second input",
    });

    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.status).toBe("failed");
    expect(row.executionId).toBeNull();
    // Nothing is launched for it, and the input waits with its receipt open.
    expect(await signalled(session.session_id)).toBe(false);
    expect(
      await db
        .select({ sequence: turns.sequence, status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, session.session_id))
        .orderBy(asc(turns.sequence)),
    ).toEqual([
      { sequence: 1, status: "completed" },
      { sequence: 2, status: "queued" },
    ]);
    expect((await receiptResult(queued?.receipt_id ?? ""))?.status).toBe(
      "accepted",
    );

    const audit = await auditOf(session.session_id);
    expect(audit.slice(-2)).toEqual([
      {
        type: "status",
        payload: {
          phase: "failed",
          admission_state: "recovery_required",
          reason: "context_gap",
        },
      },
      {
        type: "system",
        payload: {
          type: "system",
          subtype: "context_gap_detected",
          last_ran_turn_id: "1",
          checkpointed_turn_id: null,
          checkpoint_revision: null,
          detected_at: "execution_gone",
        },
      },
    ]);
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "1",
      checkpointed_turn_id: null,
    });
    expect(detail?.durability.context_reset_turn_id).toBeNull();

    // A message is refused rather than queued behind a session that cannot run.
    expect(
      (
        await inputs().appendInputAtomic({
          limits: {
            queuedInputLimitPerSession: 1_000,
            storageLimitBytes: 1e15,
          },
          principal: { ownerId: session.ownerId },
          sessionId: session.session_id,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          message: "third input",
        })
      ).outcome,
    ).toBe("rejected");

    // Restoring the same checkpoint again would lose the same turn
    // only start_fresh or close answers a gap.
    expect(
      await decide(session, {
        decision: "retry_restore",
        expected_revision: row.revision,
        reason: "try the restore again",
      }),
    ).toEqual({
      outcome: "not_restore_failed",
      admissionState: "recovery_required",
    });
  });

  test("a turn whose publish failed is shown as it ran and is a gap when the worker goes", async () => {
    const session = await queuedSession("publish-failed-gap");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    await runOneTurn(session, {
      checkpoint: null,
      pendingReason: "publish_failed",
      thenQueue: "third input",
    });

    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.checkpointPendingReason).toBe("publish_failed");
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    // Advisory: it did not hold the turn back, and it says why the pointer
    // stopped at turn 1 when the operator is asked to decide.
    expect(detail?.durability.checkpoint_pending_reason).toBe("publish_failed");
    expect(detail?.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "2",
      checkpointed_turn_id: "1",
    });
  });

  test("a checkpoint older than the last turn is a gap too, and names the turn it covers", async () => {
    const session = await queuedSession("stale-gap");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "active",
    );
    await runOneTurn(session, { checkpoint: null, thenQueue: "third input" });

    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.checkpointRevision).toBe(0);
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "2",
      checkpointed_turn_id: "1",
    });
    expect((await auditOf(session.session_id)).at(-1)?.payload).toMatchObject({
      subtype: "context_gap_detected",
      last_ran_turn_id: "2",
      checkpointed_turn_id: "1",
      checkpoint_revision: 0,
    });
  });

  test("a covered session goes back to dispatch and its next claim restores the pointer", async () => {
    const session = await queuedSession("covered");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("active");
    expect(await signalled(session.session_id)).toBe(true);
    const claimed = await claim(await launch(session));
    expect(claimed.restore).toEqual(checkpointAt(0));
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toBeNull();
  });

  test.each([
    ["background_writer", true],
    ["tool_in_flight", true],
    ["checkpoint_lease_held", true],
    ["mirror_error", false],
  ])(
    "a covering pointer with %s pending is trusted at the claim and the exit: %p",
    async (reason, trusted) => {
      const session = await queuedSession(`reason-${reason}`);
      await runOneTurn(session, {
        checkpoint: checkpointAt(0),
        thenQueue: "second input",
      });
      await db
        .update(sessions)
        .set({
          checkpointPendingReason: reason,
          checkpointPendingAttemptId: "attempt-x",
        })
        .where(eq(sessions.id, session.session_id));

      const l = await launch(session);
      if (!trusted) {
        expect(await refusal(claim(l))).toMatchObject({
          status: 409,
          code: "RECOVERY_REQUIRED",
        });
        return;
      }
      // An advisory reason says only that a later capture was refused
      // revision 0 still covers every turn that ran.
      const claimed = await claim(l);
      expect(claimed.restore).toEqual(checkpointAt(0));
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "idle_timeout",
      });
      await confirmExecutionGone(db, l.executionId);
      expect((await sessionRow(session.session_id)).admissionState).toBe(
        "active",
      );
      expect(await signalled(session.session_id)).toBe(true);
    },
  );

  test("turns a fallback restore dropped are not a gap: that loss was reported by the fallback", async () => {
    const session = await queuedSession("fallback");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    await runOneTurn(session, {
      checkpoint: checkpointAt(1),
      thenQueue: "third input",
    });
    // Revision 1 turned out damaged and the last restore fell back to 0.
    await db
      .update(sessions)
      .set({ checkpointFallbackRevision: 0 })
      .where(eq(sessions.id, session.session_id));
    const l = await launch(session);
    const claimed = await claim(l);
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    await confirmExecutionGone(db, l.executionId);
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "active",
    );
    expect(await signalled(session.session_id)).toBe(true);
  });

  test("the claim refuses a session that reaches it with a gap, and asks the launch to go", async () => {
    // The exit check normally catches this first. A row from before it, or a
    // path that returns a session to dispatch without it, meets the claim.
    const session = await queuedSession("claim-gap");
    await runOneTurn(session, { checkpoint: null, thenQueue: "second input" });
    await db
      .update(sessions)
      .set({ admissionState: "active", status: "queued" })
      .where(eq(sessions.id, session.session_id));
    await db.insert(unassignedSessions).values({
      sessionId: session.session_id,
      partition: session.partition,
      signaledAt: clock,
    });
    const before = await sessionRow(session.session_id);

    const l = await launch(session);
    expect(await refusal(claim(l))).toEqual({
      status: 409,
      code: "RECOVERY_REQUIRED",
      retryable: false,
    });

    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.status).toBe("failed");
    // Nothing was bound: no pod, no new epoch, no attempt on the launch.
    expect(row.podId).toBeNull();
    expect(row.leaseEpoch).toBe(before.leaseEpoch);
    expect(await signalled(session.session_id)).toBe(false);
    const [launched] = await db
      .select({ claimed: workerLaunches.claimedAttemptId })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(launched?.claimed).toBeNull();
    const [execution] = await db
      .select({ desired: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desired).toBe("terminated");
    expect((await auditOf(session.session_id)).at(-1)?.payload).toMatchObject({
      subtype: "context_gap_detected",
      detected_at: "claim",
    });
    // A retry of the same claim finds nothing waiting.
    expect(await refusal(claim(l))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    // The scheduler reclaims the launch; the exit leaves the session where
    // the claim put it and launches nothing.
    await confirmExecutionGone(db, l.executionId);
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "recovery_required",
    );
    expect(await signalled(session.session_id)).toBe(false);
  });

  test("start_fresh continues on a new engine session: nothing restored, older checkpoints retired, queued input dispatched", async () => {
    const session = await queuedSession("fresh");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    await runOneTurn(session, { checkpoint: null, thenQueue: "third input" });
    const held = await sessionRow(session.session_id);
    expect(held.admissionState).toBe("recovery_required");

    // Not while the last execution might still be running.
    await db
      .update(sessions)
      .set({ executionId: "exec-still-there" })
      .where(eq(sessions.id, session.session_id));
    expect(await startFresh(session)).toEqual({
      outcome: "execution_unconfirmed",
    });
    await db
      .update(sessions)
      .set({ executionId: null })
      .where(eq(sessions.id, session.session_id));

    const decided = await startFresh(session);
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    const row = await sessionRow(session.session_id);
    expect(row).toMatchObject({
      admissionState: "active",
      status: "queued",
      revision: held.revision + 1,
      leaseEpoch: held.leaseEpoch + 1,
      contextResetTurnSequence: 2,
      contextResetCheckpointRevision: 0,
      checkpointRevision: 0,
    });
    expect(await signalled(session.session_id)).toBe(true);
    expect(await receiptResult(decided.response.receipt_id)).toEqual({
      status: "succeeded",
      result: {
        resulting_admission_state: "active",
        checkpoint_revision: null,
        resumable: false,
      },
    });
    const audit = await auditOf(session.session_id);
    expect(audit.at(-2)).toEqual({
      type: "status",
      payload: {
        phase: "queued",
        admission_state: "active",
        context_reset_turn_id: "2",
      },
    });
    expect(audit.at(-1)?.payload).toMatchObject({
      type: "system",
      subtype: "recovery_decision",
      decision: "start_fresh",
      target_turn_id: null,
      context_reset_turn_id: "2",
      retired_checkpoint_revision: 0,
      cleared_checkpoint_pending_reason: null,
    });
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toBeNull();
    expect(detail?.durability.context_reset_turn_id).toBe("2");

    // The retired revision 0 is not handed out, and the next checkpoint
    // continues the numbering and is trusted again.
    const fresh = await runOneTurn(session, {
      checkpoint: checkpointAt(1),
      thenQueue: "fourth input",
    });
    expect(fresh.claimed.restore).toBeNull();
    expect(fresh.turnId).toBe("3");
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("active");
    expect(after.checkpointRevision).toBe(1);
    // Built on no earlier state: a fallback past it stops instead of
    // restoring the retired revision 0.
    const [first] = await db
      .select({ parent: checkpoints.parentRevision })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.sessionId, session.session_id),
          eq(checkpoints.revision, 1),
        ),
      );
    expect(first?.parent).toBe(CHECKPOINT_ROOT_PARENT);
    const next = await claim(await launch(session));
    expect(next.restore).toEqual(checkpointAt(1));
  });

  test("start_fresh with nothing checkpointed after it keeps restoring nothing, and a later uncovered turn is a gap again", async () => {
    const session = await queuedSession("fresh-again");
    await runOneTurn(session, { checkpoint: null, thenQueue: "second input" });
    expect((await startFresh(session)).outcome).toBe("accepted");
    // Turn 2 runs on the new engine; its checkpoint fails as well.
    await runOneTurn(session, { checkpoint: null, thenQueue: "third input" });
    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "2",
      checkpointed_turn_id: null,
    });
    expect(detail?.durability.context_reset_turn_id).toBe("1");
  });

  test("start_fresh clears a mirror failure, whose transcript it gives up", async () => {
    const session = await queuedSession("fresh-mirror");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    await db
      .update(sessions)
      .set({
        checkpointPendingReason: "mirror_error",
        checkpointPendingAttemptId: "att-gone",
        admissionState: "recovery_required",
        status: "failed",
      })
      .where(eq(sessions.id, session.session_id));
    const decided = await startFresh(session);
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    expect(await sessionRow(session.session_id)).toMatchObject({
      checkpointPendingReason: null,
      checkpointPendingAttemptId: null,
      contextResetCheckpointRevision: 0,
    });
    expect((await auditOf(session.session_id)).at(-1)?.payload).toMatchObject({
      cleared_checkpoint_pending_reason: "mirror_error",
    });
    // Input is admitted again.
    expect((await append(session, "third input")).receipt_status).toBe(
      "accepted",
    );
  });

  test("start_fresh is refused over an unknown turn, on an active session and on a stopped session that can resume", async () => {
    const unknown = await queuedSession("fresh-unknown");
    const l = await launch(unknown);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    await confirmExecutionGone(db, l.executionId);
    expect((await sessionRow(unknown.session_id)).admissionState).toBe(
      "recovery_required",
    );
    expect(await startFresh(unknown)).toEqual({
      outcome: "unknown_turn_left",
      turnId: "1",
    });

    const active = await queuedSession("fresh-active");
    expect(await startFresh(active)).toEqual({
      outcome: "not_in_recovery",
      admissionState: "active",
    });

    const resumable = await queuedSession("fresh-resumable");
    await runOneTurn(resumable, { checkpoint: checkpointAt(0) });
    const row = await sessionRow(resumable.session_id);
    const stopped = await controls().terminateAtomic({
      principal: { ownerId: resumable.ownerId },
      sessionId: resumable.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "done for now",
      now: clock,
    });
    expect(stopped.outcome).toBe("accepted");
    expect((await sessionRow(resumable.session_id)).admissionState).toBe(
      "stopped",
    );
    expect(await startFresh(resumable)).toEqual({
      outcome: "not_in_recovery",
      admissionState: "stopped",
    });
  });

  test("a stopped session whose checkpoint predates its last turn is not resumable; start_fresh and close are the ways on", async () => {
    const session = await queuedSession("stopped-gap");
    await runOneTurn(session, {
      checkpoint: checkpointAt(0),
      thenQueue: "second input",
    });
    // Turn 2 runs uncovered while the worker is still bound, then the
    // session is terminated: the exit lands in `stopped`, not in recovery.
    const l = await launch(session);
    const claimed = await claim(l);
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(next.input?.turn_id).toBe("2");
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "2"),
      turn_id: "2",
      finalize_key: "fin-2",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const running = await sessionRow(session.session_id);
    const terminated = await controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: running.revision,
      reason: "stop",
      now: clock,
    });
    expect(terminated.outcome).toBe("accepted");
    await confirmExecutionGone(db, l.executionId);
    const stopped = await sessionRow(session.session_id);
    expect(stopped.admissionState).toBe("stopped");

    expect(
      await controls().resumeAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        expectedRevision: stopped.revision,
        now: clock,
      }),
    ).toEqual({ outcome: "checkpoint_unavailable" });
    const detail = await reader().getSession(
      session.ownerId,
      session.session_id,
    );
    expect(detail?.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "2",
      checkpointed_turn_id: "1",
    });
    // GC has claimed the stopped workspace: the reset waits for the
    // removal to settle, and takes the session off the reclaimed list after.
    await db
      .update(sessions)
      .set({ workspaceReclaimId: "reclaim-1" })
      .where(eq(sessions.id, session.session_id));
    expect(await startFresh(session)).toEqual({
      outcome: "workspace_reclaiming",
    });
    await db
      .update(sessions)
      .set({ workspaceReclaimId: null, workspaceReclaimedAt: clock })
      .where(eq(sessions.id, session.session_id));
    const decided = await startFresh(session);
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    expect(await sessionRow(session.session_id)).toMatchObject({
      workspaceReclaimedAt: null,
      admissionState: "active",
      status: "idle",
      contextResetTurnSequence: 2,
    });
  });
});
