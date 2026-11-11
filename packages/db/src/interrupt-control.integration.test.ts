import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CheckpointRef,
  FinalizeRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createInterruptService,
  createPendingRequestService,
  createWorkerGateway,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresWorkerPendingStore } from "./decision/pending-control.ts";
import { createPostgresPendingRequests } from "./decision/pending-requests.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  controlIntents,
  executions,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { createPostgresTurnInterrupts } from "./sessions/interrupt-control.ts";
import { reconcileOverdueInterrupts } from "./sessions/lease-reconcile.ts";
import { expireOverdueInterrupts } from "./sessions/turn-interrupts.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

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

integration("turn interrupts on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let interrupts: ReturnType<typeof createInterruptService>;
  let answers: ReturnType<typeof createPendingRequestService>;
  const resultSink = new MemoryLogSink();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "interrupt_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db, {
        logger: new StructuredLogger({ sinks: [resultSink] }),
      }),
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
    interrupts = createInterruptService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresTurnInterrupts(db),
    });
    answers = createPendingRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPendingRequests(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope;
    executionId: string;
  };

  async function claim(sessionId: string): Promise<Worker> {
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
    return {
      executionId,
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
    };
  }

  async function next(worker: Worker) {
    const delivered = await gateway.nextInput(worker.principal, worker.scope);
    return delivered.input?.turn_id ?? null;
  }

  /** A session with `queued` extra inputs behind a first turn that is running. */
  async function runningSession(queued = 0) {
    const partition = `interrupt-${crypto.randomUUID()}`;
    const owner = testCaller(`owner-${crypto.randomUUID()}`);
    const inputs = createPostgresSessionUnitOfWork(db);
    const accepted = await inputs.acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
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
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    for (let index = 0; index < queued; index += 1) {
      const appended = await inputs.appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: owner,
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message: `input ${index + 2}`,
      });
      if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    }
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const worker = await claim(sessionId);
    expect(await next(worker)).toBe("1");
    return { owner, sessionId, worker };
  }

  function interrupt(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
    turnId: string,
    key = crypto.randomUUID(),
  ) {
    return interrupts.interrupt(owner, sessionId, {
      idempotencyKey: key,
      body: { target_turn_id: turnId },
    });
  }

  function finalize(
    worker: Worker,
    turnId: string,
    terminal: FinalizeRequest["terminal"]["status"],
    checkpoint: CheckpointRef | null = null,
  ) {
    return gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: turnId,
      finalize_key: `${worker.scope.attempt_id}:${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status: terminal,
        reason: terminal === "completed" ? null : terminal,
        result: null,
        usage: null,
      },
      checkpoint,
    });
  }

  function poll(worker: Worker) {
    return gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
    });
  }

  async function receiptOf(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) return error.code;
      if (error instanceof WorkerGatewayError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  const checkpoint = (revision: number): CheckpointRef => ({
    revision,
    manifest_ref: `manifests/${revision}.json`,
    manifest_sha256: "c".repeat(64),
  });

  test("a running turn's interrupt is handed to its attempt and settled by the interrupted terminal", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const key = crypto.randomUUID();
    const accepted = await interrupt(owner, sessionId, "1", key);
    expect(accepted.receipt_status).toBe("accepted");
    expect((await receiptOf(accepted.receipt_id))?.targetRef).toEqual({
      session_id: sessionId,
      turn_id: "1",
      request_id: null,
    });
    // The same key and body replay the receipt; a different body is refused.
    expect(await interrupt(owner, sessionId, "1", key)).toEqual(accepted);
    expect(await failure(interrupt(owner, sessionId, "2", key))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    const beat = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(true);
    const handed = await poll(worker);
    expect(handed.control).toMatchObject({
      kind: "interrupt",
      target_turn_id: "1",
    });
    // Until the terminal, every poll hands it out again.
    expect((await poll(worker)).control?.control_id).toBe(
      handed.control?.control_id ?? "",
    );

    // Interrupted without a checkpoint is refused: nothing commits.
    expect(await failure(finalize(worker, "1", "interrupted", null))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");

    // A checkpoint that is not the next revision cannot commit either, and
    // is refused the same way, not as a revision conflict to retry.
    expect(
      await failure(finalize(worker, "1", "interrupted", checkpoint(3))),
    ).toBe("CHECKPOINT_UNAVAILABLE");

    await finalize(worker, "1", "interrupted", checkpoint(0));
    expect(await receiptOf(accepted.receipt_id)).toMatchObject({
      status: "succeeded",
      result: { turn_id: "1", terminal: "interrupted", no_op: false },
      error: null,
    });
    expect((await poll(worker)).control).toBeNull();
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.admissionState).toBe("active");
    expect(session?.checkpointRevision).toBe(0);
    expect(resultSink.records).toContainEqual(
      expect.objectContaining({
        event: "control.result",
        fields: expect.objectContaining({
          operation: "interrupt",
          outcome: "interrupted",
          reason_code: "interrupted",
          control_id: handed.control?.control_id,
          duration_ms: expect.any(Number),
          effect_ms: expect.any(Number),
        }),
      }),
    );

    // Asked again after the terminal, it did nothing, whatever the turn says.
    const late = await interrupt(owner, sessionId, "1");
    expect(await receiptOf(late.receipt_id)).toMatchObject({
      status: "succeeded",
      result: { turn_id: "1", terminal: "interrupted", no_op: true },
    });
  });

  test("an interrupt without a checkpoint ends outcome_unknown, the receipt unknown, the session awaiting recovery", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const accepted = await interrupt(owner, sessionId, "1");
    await finalize(worker, "1", "outcome_unknown");

    expect(await receiptOf(accepted.receipt_id)).toMatchObject({
      status: "unknown",
      result: { turn_id: "1", terminal: "outcome_unknown", no_op: false },
      error: { code: "RECOVERY_REQUIRED" },
    });
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.admissionState).toBe("recovery_required");

    const late = await interrupt(owner, sessionId, "1");
    expect(await receiptOf(late.receipt_id)).toMatchObject({
      status: "succeeded",
      result: { turn_id: "1", terminal: "outcome_unknown", no_op: true },
      error: null,
    });
  });

  test("a terminal turn answers at once with a no-op receipt naming its terminal", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await finalize(worker, "1", "completed");
    const sink = new MemoryLogSink();
    const instrumented = createInterruptService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresTurnInterrupts(db, {
        logger: new StructuredLogger({ sinks: [sink] }),
      }),
    });

    const accepted = await instrumented.interrupt(owner, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body: { target_turn_id: "1" },
    });

    expect(accepted.receipt_status).toBe("succeeded");
    expect(await receiptOf(accepted.receipt_id)).toMatchObject({
      operation: "interrupt",
      status: "succeeded",
      result: { turn_id: "1", terminal: "completed", no_op: true },
    });
    const intents = await db
      .select()
      .from(controlIntents)
      .where(eq(controlIntents.sessionId, sessionId));
    expect(intents).toHaveLength(0);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        event: "control.result",
        message: "Control result recorded",
        fields: expect.objectContaining({
          operation: "interrupt",
          outcome: "completed",
          reason_code: "no_op",
          control_id: accepted.receipt_id,
          session_id: sessionId,
          duration_ms: 0,
          effect_ms: 0,
        }),
      }),
    );
  });

  test("a queued turn is refused, and unknown turns or sessions are not found", async () => {
    const { owner, sessionId } = await runningSession(1);
    expect(await failure(interrupt(owner, sessionId, "2"))).toBe(
      "TURN_NOT_STARTED",
    );
    expect(await failure(interrupt(owner, sessionId, "9"))).toBe("NOT_FOUND");
    expect(await failure(interrupt(owner, sessionId, "not-a-turn"))).toBe(
      "NOT_FOUND",
    );
    expect(
      await failure(interrupt(testCaller("someone-else"), sessionId, "1")),
    ).toBe("NOT_FOUND");
    // A refusal stores nothing: the queued turn is still queued.
    const [queued] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 2)));
    expect(queued?.status).toBe("queued");
  });

  test("open requests close with the interrupt, and the turn takes no new ones", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = `req_${crypto.randomUUID()}`;
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      turn_id: "1",
      request_id: requestId,
      input_hash: "a".repeat(64),
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
    });
    await interrupt(owner, sessionId, "1");

    expect(
      await failure(
        answers.answer(owner, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          body: {
            request_id: requestId,
            kind: "permission",
            decision: "allow",
          },
        }),
      ),
    ).toBe("REQUEST_EXPIRED");
    expect(
      await failure(
        gateway.registerPending(worker.principal, {
          ...worker.scope,
          turn_id: "1",
          request_id: `req_${crypto.randomUUID()}`,
          input_hash: "b".repeat(64),
          request: {
            kind: "permission",
            tool: "Bash",
            input: { command: "pwd" },
          },
        }),
      ),
    ).toBe("REQUEST_STALE");
  });

  test("an execution that goes away first leaves the interrupt receipt unknown", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const accepted = await interrupt(owner, sessionId, "1");

    await confirmExecutionGone(db, worker.executionId);

    expect(await receiptOf(accepted.receipt_id)).toMatchObject({
      status: "unknown",
      result: { turn_id: "1", terminal: "outcome_unknown", no_op: false },
      error: { code: "RECOVERY_REQUIRED" },
    });
  });

  test("an interrupt racing the next turn's start reaches only its own turn, and no input is lost", async () => {
    for (let round = 0; round < 12; round += 1) {
      const { owner, sessionId, worker } = await runningSession(1);
      // Turn 1 ends on its own and turn 2 is handed out while the interrupt
      // for turn 1 is being stored.
      const [accepted] = await Promise.all([
        interrupt(owner, sessionId, "1"),
        (async () => {
          await finalize(worker, "1", "completed");
          expect(await next(worker)).toBe("2");
        })(),
      ]);

      // Whichever committed first, turn 1's receipt is a settled no-op.
      expect(await receiptOf(accepted.receipt_id)).toMatchObject({
        status: "succeeded",
        result: { turn_id: "1", terminal: "completed", no_op: true },
      });
      // Nothing reaches turn 2.
      expect((await poll(worker)).control).toBeNull();
      const rows = await db
        .select({ sequence: turns.sequence, status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, sessionId));
      expect(
        rows.sort((a, b) => a.sequence - b.sequence).map((row) => row.status),
      ).toEqual(["completed", "running"]);
    }
  });

  describe("an interrupt left unsettled past its deadline", () => {
    const DEADLINE_MS = 60_000;

    const RECEIPT_DEADLINE_MS = DEADLINE_MS * 3;

    function sweep(sessionId: string, dryRun = false, now?: Date) {
      return reconcileOverdueInterrupts(db, {
        deadlineMs: DEADLINE_MS,
        dryRun,
        ...(now === undefined ? {} : { now }),
      }).then((rows) => rows.filter((row) => row.sessionId === sessionId));
    }

    // issued_at is the database clock's stamp; moving it back stands in for
    // a worker that kept heartbeating past the deadline.
    async function overdue(receiptId: string, byMs = DEADLINE_MS * 2) {
      await db
        .update(controlIntents)
        .set({
          issuedAt: sql`clock_timestamp() - ${byMs}::double precision * interval '1 millisecond'`,
        })
        .where(eq(controlIntents.receiptId, receiptId));
    }

    async function desiredState(executionId: string) {
      const [row] = await db
        .select({ desiredState: executions.desiredState })
        .from(executions)
        .where(eq(executions.id, executionId));
      return row?.desiredState;
    }

    function heartbeat(worker: Worker) {
      return gateway.heartbeat(worker.principal, {
        ...worker.scope,
        attempt_state: "running",
      });
    }

    test("sends a heartbeating attempt down the terminate path, and the confirmed exit settles the receipt unknown", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const accepted = await interrupt(owner, sessionId, "1");
      const running = await desiredState(worker.executionId);

      // Inside the deadline nothing happens, however often the pass runs.
      expect(await sweep(sessionId)).toEqual([]);

      await overdue(accepted.receipt_id);
      await heartbeat(worker);

      // A dry run reports the attempt and writes nothing.
      expect(await sweep(sessionId, true)).toEqual([
        {
          attemptId: worker.scope.attempt_id,
          dryRun: true,
          executionId: worker.executionId,
          sessionId,
        },
      ]);
      expect(await desiredState(worker.executionId)).toBe(running);
      await heartbeat(worker);

      expect(await sweep(sessionId)).toEqual([
        {
          attemptId: worker.scope.attempt_id,
          dryRun: false,
          executionId: worker.executionId,
          sessionId,
        },
      ]);
      expect(await desiredState(worker.executionId)).toBe("terminated");
      const [fenced] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(fenced?.leaseEpoch).toBe(worker.scope.lease_epoch + 1);
      expect(fenced?.executionId).toBe(worker.executionId);
      // The worker that kept the lease is fenced out, finalize included.
      await expect(heartbeat(worker)).rejects.toMatchObject({
        status: 409,
        code: "STALE_EPOCH",
      });
      expect(await failure(finalize(worker, "1", "completed"))).toBe(
        "STALE_EPOCH",
      );
      expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");
      // The kill is asked for once; later passes wait on the scheduler.
      expect(await sweep(sessionId)).toEqual([]);

      await confirmExecutionGone(db, worker.executionId);
      expect(await receiptOf(accepted.receipt_id)).toMatchObject({
        status: "unknown",
        result: { turn_id: "1", terminal: "outcome_unknown", no_op: false },
        error: { code: "RECOVERY_REQUIRED" },
      });
      const [turn] = await db
        .select({ status: turns.status })
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
      expect(turn?.status).toBe("outcome_unknown");
      expect(await sweep(sessionId)).toEqual([]);
    });

    test("an interrupt its terminal already settled is left alone", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const accepted = await interrupt(owner, sessionId, "1");
      await overdue(accepted.receipt_id);
      await finalize(worker, "1", "interrupted", checkpoint(0));

      expect(await sweep(sessionId)).toEqual([]);
      expect(await desiredState(worker.executionId)).not.toBe("terminated");
      await heartbeat(worker);
    });

    test("the deadline is read on the database clock, not the caller's", async () => {
      const { owner, sessionId, worker } = await runningSession();
      await interrupt(owner, sessionId, "1");

      expect(
        await sweep(sessionId, false, new Date("2100-01-01T00:00:00Z")),
      ).toEqual([]);
      expect(await desiredState(worker.executionId)).not.toBe("terminated");
    });

    test("an attempt whose kill is already asked for is skipped, and does not take a batch slot", async () => {
      const first = await runningSession();
      const firstReceipt = await interrupt(first.owner, first.sessionId, "1");
      await overdue(firstReceipt.receipt_id);
      await db
        .update(executions)
        .set({ desiredState: "terminated" })
        .where(eq(executions.id, first.worker.executionId));
      const second = await runningSession();
      const secondReceipt = await interrupt(
        second.owner,
        second.sessionId,
        "1",
      );
      await overdue(secondReceipt.receipt_id);

      const swept = await reconcileOverdueInterrupts(db, {
        deadlineMs: DEADLINE_MS,
        limit: 1,
      });
      expect(swept.map((row) => row.sessionId)).toEqual([second.sessionId]);
      const [session] = await db
        .select({ leaseEpoch: sessions.leaseEpoch })
        .from(sessions)
        .where(eq(sessions.id, first.sessionId));
      expect(session?.leaseEpoch).toBe(first.worker.scope.lease_epoch);
    });

    test("a kill nobody confirms leaves the receipt unknown past the later deadline, and the confirmed exit still settles it", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const accepted = await interrupt(owner, sessionId, "1");
      await overdue(accepted.receipt_id, DEADLINE_MS * 2);
      expect(await sweep(sessionId)).toHaveLength(1);

      // Before the receipt's own deadline it stays accepted.
      await expireOverdueInterrupts(db, {
        deadlineMs: RECEIPT_DEADLINE_MS,
        limit: 100,
        now: new Date(),
      });
      expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");

      await overdue(accepted.receipt_id, RECEIPT_DEADLINE_MS * 2);
      expect(
        await expireOverdueInterrupts(db, {
          deadlineMs: RECEIPT_DEADLINE_MS,
          limit: 100,
          now: new Date(),
          dryRun: true,
        }),
      ).toBeGreaterThanOrEqual(1);
      expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");

      expect(
        await expireOverdueInterrupts(db, {
          deadlineMs: RECEIPT_DEADLINE_MS,
          limit: 100,
          now: new Date(),
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(await receiptOf(accepted.receipt_id)).toMatchObject({
        status: "unknown",
        result: null,
        error: { code: "BACKEND_UNAVAILABLE" },
      });

      await confirmExecutionGone(db, worker.executionId);
      expect(await receiptOf(accepted.receipt_id)).toMatchObject({
        status: "unknown",
        result: { turn_id: "1", terminal: "outcome_unknown", no_op: false },
        error: { code: "RECOVERY_REQUIRED" },
      });
    });

    test("a receipt reported unknown is still upgraded by the turn's own terminal", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const accepted = await interrupt(owner, sessionId, "1");
      await overdue(accepted.receipt_id, RECEIPT_DEADLINE_MS * 2);
      await expireOverdueInterrupts(db, {
        deadlineMs: RECEIPT_DEADLINE_MS,
        limit: 100,
        now: new Date(),
      });
      expect((await receiptOf(accepted.receipt_id))?.status).toBe("unknown");

      await finalize(worker, "1", "interrupted", checkpoint(0));
      expect(await receiptOf(accepted.receipt_id)).toMatchObject({
        status: "succeeded",
        result: { turn_id: "1", terminal: "interrupted", no_op: false },
        error: null,
      });
    });
  });
});
