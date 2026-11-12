import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionEventVariants, type WorkerScope } from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
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
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  executions,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
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

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 2_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("session terminate on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  const clock = new Date("2026-09-23T00:00:00.000Z");
  const now = () => clock;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "terminate_it" });
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

  const controls = () => createPostgresSessionControl(db);
  const inputs = () => createPostgresSessionUnitOfWork(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });

  async function queuedSession(partition: string) {
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
    return { ...result.response, ownerId };
  }

  function claim(l: TestLaunch) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  function scopeOf(
    claimed: Awaited<ReturnType<typeof claim>>,
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

  function principalOf(
    claimed: Awaited<ReturnType<typeof claim>>,
  ): WorkerPrincipal {
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
  async function bound(name: string) {
    const partition = `${name}-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launchSession(db, { sessionId: session.session_id });
    const claimed = await claim(l);
    return { session, launch: l, claimed };
  }

  async function deliver(claimed: Awaited<ReturnType<typeof claim>>) {
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    if (!next.input) throw new Error("no input delivered");
    return next.input;
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

  function terminate(
    session: { session_id: string; ownerId: string },
    expectedRevision: number,
    overrides: { idempotencyKey?: string; payloadHash?: string } = {},
  ) {
    return controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
      payloadHash: overrides.payloadHash ?? "hash-a",
      expectedRevision,
      reason: "operator",
      now: clock,
    });
  }

  function finishTurn(
    claimed: Awaited<ReturnType<typeof claim>>,
    checkpointRevision: number | null = null,
  ) {
    return gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      // No events were appended in these tests.
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint:
        checkpointRevision === null
          ? null
          : {
              revision: checkpointRevision,
              manifest_ref: `manifests/${claimed.session_id}/${checkpointRevision}`,
              manifest_sha256: "a".repeat(64),
            },
    });
  }

  // The status events a client reads from GET /v1/sessions/{id}/events.
  async function statusFrames(session: {
    session_id: string;
    ownerId: string;
  }) {
    const page = await createPostgresSessionReader(db).readEvents(
      session.ownerId,
      session.session_id,
      { limit: 100, maxBytes: 1 << 20 },
    );
    if (!page) throw new Error("session not readable");
    return page.items.flatMap((frame) =>
      frame.event === "status"
        ? [sessionEventVariants.status.shape.data.parse(frame.data.data)]
        : [],
    );
  }

  // What GET /v1/sessions/{id} says, in the shape of a status event.
  async function readsAs(session: { session_id: string; ownerId: string }) {
    const detail = await createPostgresSessionReader(db).getSession(
      session.ownerId,
      session.session_id,
    );
    return { phase: detail?.status, admission_state: detail?.admission_state };
  }

  test("one transaction blocks dispatch, discards the epoch, cancels queued input, invalidates pending requests and records the kill", async () => {
    const { session, launch: l, claimed } = await bound("tx");
    await deliver(claimed);
    const appended = await inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    const [running] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    if (!running) throw new Error("turn 1 missing");
    await db.insert(pendingRequests).values({
      requestId: `req-${crypto.randomUUID()}`,
      sessionId: session.session_id,
      turnId: running.id,
      attemptId: claimed.attempt_id,
      kind: "permission",
      payload: {},
      inputHash: "h",
      expiresAt: new Date(clock.getTime() + 60_000),
    });

    const before = await sessionRow(session.session_id);
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("accepted");

    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("stopping");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.leaseEpoch).toBe(before.leaseEpoch + 1);
    // The binding stays until the kill is confirmed: no new claim yet.
    expect(after.executionId).toBe(l.executionId);

    const turnRows = await db
      .select({ sequence: turns.sequence, status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id))
      .orderBy(turns.sequence);
    expect(turnRows).toEqual([
      { sequence: 1, status: "running" },
      { sequence: 2, status: "cancelled" },
    ]);
    const queue = await db
      .select({ turnId: queueMessages.turnId })
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(queue).toEqual([{ turnId: running.id }]);
    expect(await receiptRow(appended.response.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "SESSION_STOPPED" },
      // The acceptance response stays so the same-key retry still replays.
      result: { receipt_id: appended.response.receipt_id },
    });
    const [pending] = await db
      .select({ resolvedAt: pendingRequests.resolvedAt })
      .from(pendingRequests)
      .where(eq(pendingRequests.sessionId, session.session_id));
    expect(pending?.resolvedAt?.getTime()).toBeGreaterThanOrEqual(
      clock.getTime(),
    );
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desiredState).toBe("terminated");
    const [launchRow] = await db
      .select({ slotReleasedAt: workerLaunches.slotReleasedAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(launchRow?.slotReleasedAt).toBeNull();
    const receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.operation).toBe("terminate");
    expect(receipt.status).toBe("accepted");
    expect(receipt.targetRef).toEqual({
      session_id: session.session_id,
      turn_id: null,
      request_id: null,
    });
    // The store hands the intent to the scheduler as a kill.
    const active = await store().listActiveExecutions("local_docker");
    expect(
      active.find((row) => row.executionId === l.executionId)?.desiredState,
    ).toBe("terminated");
  });

  test("records checkout, lock, SQL, commit, and total timings under the request id", async () => {
    const { session, claimed } = await bound("timings");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const requestId = crypto.randomUUID();

    const result = await logger.withContext({ request_id: requestId }, () =>
      createPostgresSessionControl(db, {
        connect: () => pool.connect(),
        logger,
      }).terminateAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "timed-hash",
        expectedRevision: before.revision,
        reason: "timing probe",
        now: clock,
      }),
    );

    expect(result.outcome).toBe("accepted");
    const record = sink.records.find(
      ({ message }) => message === "Terminate control transaction completed",
    );
    expect(record?.request_id).toBe(requestId);
    expect(record?.fields).toMatchObject({
      session_id: session.session_id,
      outcome: "accepted",
      attempts: 1,
    });
    const timingFields = [
      "duration_ms",
      "pool_checkout_ms",
      "transaction_begin_ms",
      "idempotency_lock_ms",
      "idempotency_lookup_ms",
      "session_binding_peek_ms",
      "launch_lock_ms",
      "session_lock_ms",
      "cancel_queued_turns_ms",
      "database_clock_ms",
      "wait_before_stop_ms",
      "resolve_pending_requests_ms",
      "execution_stop_intent_ms",
      "update_session_ms",
      "insert_status_event_ms",
      "notify_status_event_ms",
      "update_wait_announcement_ms",
      "insert_receipt_ms",
      "insert_idempotency_key_ms",
      "commit_ms",
    ];
    for (const field of timingFields) {
      expect(typeof record?.fields?.[field]).toBe("number");
    }
  });

  test("after terminate the old worker's heartbeat, appendEvents and finalize are 409 STALE_EPOCH", async () => {
    const { session, claimed } = await bound("fence");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    expect((await terminate(session, before.revision)).outcome).toBe(
      "accepted",
    );

    expect(
      await failure(
        gateway.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b1",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 1,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          turn_id: "1",
          finalize_key: "fin",
          // No events were appended in these tests.
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: null,
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    expect(
      await failure(gateway.nextInput(principalOf(claimed), scopeOf(claimed))),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
  });

  test("terminate cancels a pending replacement so the kill's exit is confirmable", async () => {
    const partition = `replace-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launchSession(db, { sessionId: session.session_id });
    // The scheduler decided to rebuild this unclaimed launch.
    await db
      .update(workerLaunches)
      .set({ replacementReason: "stale_isolation", replacementCount: 1 })
      .where(eq(workerLaunches.executionId, l.executionId));

    const before = await sessionRow(session.session_id);
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("accepted");
    const [launchRow] = await db
      .select({
        replacementCount: workerLaunches.replacementCount,
        replacementReason: workerLaunches.replacementReason,
      })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(launchRow).toEqual({ replacementCount: 1, replacementReason: null });

    // Without the cancellation confirmExecutionGone would refuse this.
    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "stopped",
    );
    expect((await receiptRow(result.response.receipt_id)).status).toBe(
      "succeeded",
    );
  });

  test("execution confirmed gone with a safe terminal: session stopped, receipt succeeded", async () => {
    const { session, launch: l, claimed } = await bound("safe");
    await deliver(claimed);
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      // No events were appended in these tests.
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const before = await sessionRow(session.session_id);
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);

    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("stopped");
    expect(after.status).toBe("stopped");
    expect(after.executionId).toBeNull();
    const receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.result).toEqual({
      execution_gone: true,
      checkpoint_revision: null,
      unconfirmed_turn_id: null,
      external_effects_reverted: false,
    });
    // Stopped is not eligible for dispatch.
    const signal = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signal).toEqual([]);
  });

  test("execution confirmed gone mid-turn: turn outcome_unknown, admission recovery_required, receipt names the turn", async () => {
    const { session, launch: l, claimed } = await bound("unknown");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);

    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("recovery_required");
    // The operator asked for this stop: the session did not fail. The unknown
    // turn still holds it for a recovery decision.
    expect(after.status).toBe("stopped");
    const [turn] = await db
      .select({ status: turns.status, outcomeUnknown: turns.outcomeUnknown })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn).toEqual({ status: "outcome_unknown", outcomeUnknown: true });
    // The input receipt goes unknown but keeps its acceptance response.
    const { ownerId: _ownerId, ...accepted } = session;
    expect(await receiptRow(session.receipt_id)).toMatchObject({
      status: "unknown",
      error: { code: "RECOVERY_REQUIRED" },
      result: accepted,
    });
    const receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.result).toMatchObject({
      execution_gone: true,
      unconfirmed_turn_id: "1",
      external_effects_reverted: false,
    });
  });

  test("a kill not observed within the deadline leaves the receipt unknown; a later confirmation upgrades it", async () => {
    const { session, launch: l, claimed } = await bound("late");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);

    // The receipt is stamped and judged by the database clock, so the
    // deadline itself is what the test moves, not a clock.
    await store().markOverdueTerminations({
      now: new Date(),
      deadlineMs: 60_000,
    });
    let receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.status).toBe("accepted");
    // Other tests leave their own overdue receipts behind, so the count is
    // at least this one.
    expect(
      await store().markOverdueTerminations({
        now: new Date(),
        deadlineMs: 0,
      }),
    ).toBeGreaterThanOrEqual(1);
    receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.status).toBe("unknown");
    expect(receipt.error).toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    // The intent is still there for the next pass.
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desiredState).toBe("terminated");
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "stopping",
    );

    const sink = new MemoryLogSink();
    await createPostgresWorkerUnitOfWork(db, {
      logger: new StructuredLogger({ sinks: [sink] }),
    }).confirmExecutionGoneAtomic({ executionId: l.executionId, now: clock });
    receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.error).toBeNull();
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        event: "control.result",
        message: "Control result recorded",
        fields: expect.objectContaining({
          operation: "terminate",
          outcome: "succeeded",
          reason_code: "execution_gone",
          control_id: result.response.receipt_id,
          session_id: session.session_id,
          duration_ms: expect.any(Number),
          effect_ms: expect.any(Number),
        }),
      }),
    );
  });

  test("the slot returns exactly once however often the exit is observed", async () => {
    const { session, launch: l, claimed } = await bound("slot");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    expect((await terminate(session, before.revision)).outcome).toBe(
      "accepted",
    );
    let released = 0;
    for (let i = 0; i < 30; i += 1) {
      const outcome = await confirmExecutionGone(db, l.executionId);
      if (outcome.slotReleased) released += 1;
    }
    expect(released).toBe(1);
  });

  test("a session with no execution is stopped and its receipt succeeds at once", async () => {
    const session = await queuedSession(`idle-${crypto.randomUUID()}`);
    const before = await sessionRow(session.session_id);
    const sink = new MemoryLogSink();
    const result = await createPostgresSessionControl(db, {
      logger: new StructuredLogger({ sinks: [sink] }),
    }).terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "immediate-result",
      expectedRevision: before.revision,
      reason: "operator",
      now: clock,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("succeeded");
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("stopped");
    expect(after.revision).toBe(before.revision + 1);
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("cancelled");
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      execution_gone: true,
      checkpoint_revision: null,
      unconfirmed_turn_id: null,
      external_effects_reverted: false,
    });
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        event: "control.result",
        fields: expect.objectContaining({
          operation: "terminate",
          outcome: "succeeded",
          reason_code: "already_absent",
          control_id: result.response.receipt_id,
          duration_ms: 0,
          effect_ms: 0,
        }),
      }),
    );
  });

  test("a legacy pod-bound session is refused, not accepted on a kill nobody can deliver", async () => {
    const session = await queuedSession(`legacy-${crypto.randomUUID()}`);
    await db
      .update(sessions)
      .set({ podId: `pod-${crypto.randomUUID()}`, status: "running" })
      .where(eq(sessions.id, session.session_id));
    const before = await sessionRow(session.session_id);
    expect(await terminate(session, before.revision)).toEqual({
      outcome: "unsupported",
    });
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("active");
    expect(after.revision).toBe(before.revision);
  });

  test("the deadline counts from durable acceptance, not from the caller's clock", async () => {
    const { session, claimed } = await bound("clock");
    await deliver(claimed);
    const before = await sessionRow(session.session_id);
    // A caller whose clock (and lock wait) is far behind wall time.
    const stale = new Date(Date.now() - 60_000);
    const result = await controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "hash-a",
      expectedRevision: before.revision,
      reason: "slow",
      now: stale,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    await store().markOverdueTerminations({
      now: new Date(),
      deadlineMs: 30_000,
    });
    expect((await receiptRow(result.response.receipt_id)).status).toBe(
      "accepted",
    );
  });

  test("replay, payload conflict, revision conflict, closed session and foreign owner", async () => {
    const session = await queuedSession(`guard-${crypto.randomUUID()}`);
    const before = await sessionRow(session.session_id);
    expect(await terminate(session, before.revision + 5)).toEqual({
      outcome: "revision_conflict",
      currentRevision: before.revision,
    });
    expect(
      await terminate(
        { session_id: session.session_id, ownerId: "someone-else" },
        before.revision,
      ),
    ).toEqual({ outcome: "not_found" });

    const key = crypto.randomUUID();
    const first = await terminate(session, before.revision, {
      idempotencyKey: key,
    });
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    // Same key, same payload: same receipt, whatever the revision is now.
    expect(
      await terminate(session, before.revision, { idempotencyKey: key }),
    ).toEqual({ outcome: "replayed", response: first.response });
    expect(
      await terminate(session, before.revision, {
        idempotencyKey: key,
        payloadHash: "hash-b",
      }),
    ).toEqual({ outcome: "conflict" });

    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, session.session_id));
    const closed = await sessionRow(session.session_id);
    expect(await terminate(session, closed.revision)).toEqual({
      outcome: "rejected",
      admissionState: "closed",
    });
  });

  test("two terminates waiting on one kill both succeed when it is confirmed", async () => {
    const { session, launch: l, claimed } = await bound("twice");
    await deliver(claimed);
    const first = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    const second = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (second.outcome !== "accepted") throw new Error(second.outcome);
    expect((await receiptRow(first.response.receipt_id)).status).toBe(
      "accepted",
    );
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    // The attempt is ended by the confirmed exit, not by the command.
    expect(attempt?.state).toBe("running");

    await confirmExecutionGone(db, l.executionId);
    expect((await receiptRow(first.response.receipt_id)).status).toBe(
      "succeeded",
    );
    expect((await receiptRow(second.response.receipt_id)).status).toBe(
      "succeeded",
    );
  });

  test("a session already waiting on recovery keeps that barrier through a terminate", async () => {
    const { session, launch: l, claimed } = await bound("recovery");
    await deliver(claimed);
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      // No events were appended in these tests.
      final_source_sequence: 0,
      terminal: {
        status: "outcome_unknown",
        reason: "sdk crashed mid tool call",
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "recovery_required",
    );
    const result = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("accepted");
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "recovery_required",
    );
    await confirmExecutionGone(db, l.executionId);
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("recovery_required");
    expect(after.executionId).toBeNull();
    // The turn it is recovering from was unknown before this terminate; the
    // receipt still names it rather than claiming nothing is unconfirmed.
    expect(await receiptRow(result.response.receipt_id)).toMatchObject({
      status: "succeeded",
      result: { unconfirmed_turn_id: "1" },
    });

    // Terminating again, now with no execution, completes at once and keeps
    // naming that turn.
    const again = await terminate(session, after.revision);
    if (again.outcome !== "accepted") throw new Error(again.outcome);
    expect(again.response.receipt_status).toBe("succeeded");
    expect(await receiptRow(again.response.receipt_id)).toMatchObject({
      status: "succeeded",
      result: { unconfirmed_turn_id: "1" },
    });
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "recovery_required",
    );
  });

  test("terminate and the exit it waits on each put the admission they reach on the stream, in step with the receipt", async () => {
    const { session, launch: l, claimed } = await bound("stream");
    await deliver(claimed);
    await finishTurn(claimed);
    const result = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("accepted");
    const stopping = await statusFrames(session);
    expect(stopping.at(-1)).toEqual({
      phase: "idle",
      admission_state: "stopping",
      reason: "operator",
      actor: { owner_id: session.ownerId },
    });
    expect(stopping.at(-1)).toMatchObject(await readsAs(session));
    // Nothing says stopped while the kill is still unconfirmed.
    expect(stopping.map((frame) => frame.admission_state)).not.toContain(
      "stopped",
    );

    await confirmExecutionGone(db, l.executionId);
    expect((await receiptRow(result.response.receipt_id)).status).toBe(
      "succeeded",
    );
    const stopped = await statusFrames(session);
    expect(stopped.slice(stopping.length)).toEqual([
      { phase: "stopped", admission_state: "stopped" },
    ]);
    expect(stopped.at(-1)).toMatchObject(await readsAs(session));
    // Seeing the same exit again settles nothing and says nothing.
    await confirmExecutionGone(db, l.executionId);
    expect(await statusFrames(session)).toHaveLength(stopped.length);
  });

  test("an exit that leaves the turn unknown puts recovery_required on the stream", async () => {
    const { session, launch: l, claimed } = await bound("stream-unknown");
    await deliver(claimed);
    await confirmExecutionGone(db, l.executionId);
    const frames = await statusFrames(session);
    expect(frames).toEqual([
      { phase: "running" },
      { phase: "failed", admission_state: "recovery_required" },
    ]);
    expect(frames.at(-1)).toMatchObject(await readsAs(session));
  });

  test("a terminate that cuts a running turn puts stopped, not failed, on the stream with recovery_required", async () => {
    const { session, launch: l, claimed } = await bound("stream-cut");
    await deliver(claimed);
    const result = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    const stopping = await statusFrames(session);
    expect(stopping.at(-1)).toMatchObject({
      phase: "running",
      admission_state: "stopping",
    });

    await confirmExecutionGone(db, l.executionId);
    const frames = await statusFrames(session);
    expect(frames.slice(stopping.length)).toEqual([
      { phase: "stopped", admission_state: "recovery_required" },
    ]);
    expect(frames.at(-1)).toMatchObject(await readsAs(session));
  });

  test("a terminate with nothing to kill reports stopped at once, with its succeeded receipt", async () => {
    const session = await queuedSession(`stream-idle-${crypto.randomUUID()}`);
    const result = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("succeeded");
    expect(await statusFrames(session)).toEqual([
      {
        phase: "stopped",
        admission_state: "stopped",
        reason: "operator",
        actor: { owner_id: session.ownerId },
      },
    ]);
  });

  test("terminate on a stopped session changes nothing on it, so the revision a client holds stays good", async () => {
    const { session, launch: l, claimed } = await bound("restop");
    await deliver(claimed);
    await finishTurn(claimed, 0);
    const first = await terminate(
      session,
      (await sessionRow(session.session_id)).revision,
    );
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    await confirmExecutionGone(db, l.executionId);
    const stopped = await sessionRow(session.session_id);
    expect(stopped.admissionState).toBe("stopped");
    const framesBefore = await statusFrames(session);

    const key = crypto.randomUUID();
    const again = await terminate(session, stopped.revision, {
      idempotencyKey: key,
    });
    if (again.outcome !== "accepted") throw new Error(again.outcome);
    expect(again.response.receipt_status).toBe("succeeded");
    const after = await sessionRow(session.session_id);
    expect({
      revision: after.revision,
      leaseEpoch: after.leaseEpoch,
      updatedAt: after.updatedAt,
      admissionState: after.admissionState,
    }).toEqual({
      revision: stopped.revision,
      leaseEpoch: stopped.leaseEpoch,
      updatedAt: stopped.updatedAt,
      admissionState: "stopped",
    });
    expect((await receiptRow(again.response.receipt_id)).result).toEqual({
      execution_gone: true,
      checkpoint_revision: 0,
      unconfirmed_turn_id: null,
      external_effects_reverted: false,
    });
    // No transition, so nothing new on the stream either.
    expect(await statusFrames(session)).toEqual(framesBefore);
    expect(
      await terminate(session, stopped.revision, { idempotencyKey: key }),
    ).toEqual({ outcome: "replayed", response: again.response });

    // The revision read before the second terminate still resumes.
    const resumed = await controls().resumeAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "hash-resume",
      expectedRevision: stopped.revision,
      now: clock,
    });
    expect(resumed.outcome).toBe("accepted");
  });

  test("a claim that reaches the session after its terminate committed binds nothing", async () => {
    const partition = `late-claim-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launchSession(db, { sessionId: session.session_id });
    const before = await sessionRow(session.session_id);
    // Terminate while the container is still booting: the row is `stopping`
    // and the launch's kill is recorded.
    const result = await terminate(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(await failure(claim(l))).toEqual({ status: 404, code: "NOT_FOUND" });
    expect((await sessionRow(session.session_id)).podId).toBeNull();
  });
});
