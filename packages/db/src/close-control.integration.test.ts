import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor, SseEvent, WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  executions,
  queueMessages,
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
const MANIFEST_SHA = "c".repeat(64);

const catalog: SessionCatalog = testSessionCatalog({
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
});

integration("close on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "close_it" });
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

  async function claim(session: Session): Promise<Worker> {
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId: session.sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
    expect(claimed.session_id).toBe(session.sessionId);
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

  async function deliver(worker: Worker): Promise<string> {
    const next = await gateway.nextInput(worker.principal, worker.scope);
    if (!next.input) throw new Error("no input delivered");
    return next.input.turn_id;
  }

  async function finalize(
    worker: Worker,
    turnId: string,
    checkpointRevision: number | null,
    status: "completed" | "outcome_unknown" = "completed",
  ) {
    return gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: turnId,
      finalize_key: `${worker.scope.attempt_id}:${turnId}`,
      final_source_sequence: 0,
      terminal: { status, reason: null, result: null, usage: null },
      checkpoint:
        checkpointRevision === null
          ? null
          : {
              revision: checkpointRevision,
              manifest_ref: `manifests/${worker.scope.session_id}/${checkpointRevision}`,
              manifest_sha256: MANIFEST_SHA,
            },
    });
  }

  // A session whose one turn ran and checkpointed, with no worker left.
  async function idleCovered(name: string): Promise<Session> {
    const session = await newSession(name);
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), 0);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    return session;
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

  async function executionRow(id: string) {
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, id));
    if (!row) throw new Error("execution vanished");
    return row;
  }

  async function turnRows(sessionId: string) {
    return db
      .select({
        sequence: turns.sequence,
        status: turns.status,
        terminalReason: turns.terminalReason,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));
  }

  function close(
    session: Session,
    expectedRevision: number,
    overrides: { idempotencyKey?: string; payloadHash?: string } = {},
  ) {
    return controls().closeAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
      payloadHash: overrides.payloadHash ?? crypto.randomUUID(),
      expectedRevision,
      reason: "work is done",
      now: new Date(),
    });
  }

  async function accepted(session: Session) {
    const before = await sessionRow(session.sessionId);
    const result = await close(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return result.response;
  }

  async function revision(session: Session) {
    return (await sessionRow(session.sessionId)).revision;
  }

  async function append(session: Session, message: string) {
    return inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message,
    });
  }

  async function pause(session: Session) {
    return controls().pauseAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: await revision(session),
      reason: null,
      now: new Date(),
    });
  }

  async function resume(session: Session) {
    return controls().resumeAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: await revision(session),
      now: new Date(),
    });
  }

  async function terminate(session: Session) {
    return controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: await revision(session),
      reason: null,
      now: new Date(),
    });
  }

  async function recoveryClose(session: Session) {
    return controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "close",
        expected_revision: await revision(session),
        reason: "operator",
      },
      now: new Date(),
    });
  }

  function releaseForDrain(worker: Worker, controlId: string) {
    return gateway.release(worker.principal, {
      ...worker.scope,
      reason: "pause",
      pause_control_id: controlId,
    });
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof WorkerGatewayError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  async function streamed(session: Session) {
    const frames: SseEvent[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await reader().readEvents(
        session.ownerId,
        session.sessionId,
        {
          ...(after === undefined ? {} : { after }),
          limit: 50,
          maxBytes: 1 << 20,
        },
      );
      if (!page) throw new Error("session not readable");
      frames.push(...page.items);
      after = page.items.at(-1)?.id ?? after;
      if (!page.more) return frames;
    }
  }

  function admissionSteps(frames: SseEvent[]) {
    return frames.flatMap((frame) => {
      if (frame.event !== "status") return [];
      const data = frame.data.data as Record<string, unknown>;
      return data.admission_state === undefined ? [] : [data];
    });
  }

  function closedRecords(frames: SseEvent[]) {
    return frames.flatMap((frame) => {
      if (frame.event !== "system") return [];
      const data = frame.data.data as Record<string, unknown>;
      return data.subtype === "session_closed" ? [data] : [];
    });
  }

  async function overdue(receiptId: string) {
    await db
      .update(receipts)
      .set({ createdAt: sql`clock_timestamp() - interval '61 seconds'` })
      .where(eq(receipts.id, receiptId));
  }

  async function expectClosedToEverything(session: Session) {
    const closed = { outcome: "rejected", admissionState: "closed" } as const;
    expect(await append(session, "after the close")).toEqual(closed);
    expect(await pause(session)).toEqual(closed);
    expect(await resume(session)).toEqual(closed);
    expect(await terminate(session)).toEqual(closed);
    expect(await recoveryClose(session)).toEqual(closed);
    // A new key on a closed session, whatever the revision.
    expect(await close(session, 0)).toEqual(closed);
  }

  test("active with a worker: closing → drain → checkpointed finalize → release → gone, then closed with the receipt, events and queued input settled", async () => {
    const session = await newSession("happy");
    const worker = await claim(session);
    const turn = await deliver(worker);
    expect((await append(session, "queued, never runs")).outcome).toBe(
      "accepted",
    );
    const queuedReceipt = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          eq(receipts.operation, "append_message"),
          sql`${receipts.targetRef}->>'session_id' = ${session.sessionId}`,
        ),
      );
    expect(queuedReceipt).toHaveLength(1);
    const before = await sessionRow(session.sessionId);

    const response = await accepted(session);
    expect(response.receipt_status).toBe("accepted");
    const closing = await sessionRow(session.sessionId);
    expect(closing.admissionState).toBe("closing");
    expect(closing.revision).toBe(before.revision + 1);
    expect(closing.leaseEpoch).toBe(before.leaseEpoch);

    // The worker drains it as a pause: the same control kind and id.
    const beat = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(true);
    const control = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
    });
    expect(control.control).toMatchObject({
      control_id: response.receipt_id,
      kind: "pause",
      target_turn_id: null,
    });
    expect(await failure(releaseForDrain(worker, response.receipt_id))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    await finalize(worker, turn, 0);
    expect(
      (await gateway.nextInput(worker.principal, worker.scope)).input,
    ).toBeNull();
    expect(await releaseForDrain(worker, response.receipt_id)).toEqual({
      released: true,
    });
    expect((await sessionRow(session.sessionId)).admissionState).toBe(
      "closing",
    );
    expect((await receiptRow(response.receipt_id)).status).toBe("accepted");

    await confirmExecutionGone(db, worker.executionId);

    const closed = await sessionRow(session.sessionId);
    expect(closed.admissionState).toBe("closed");
    expect(closed.status).toBe("stopped");
    expect(closed.executionId).toBeNull();
    const receipt = await receiptRow(response.receipt_id);
    expect(receipt.operation).toBe("close");
    expect(receipt.status).toBe("succeeded");
    expect(receipt.result).toEqual({
      resulting_admission_state: "closed",
      checkpoint_revision: 0,
      cancelled_turn_count: 1,
    });
    expect(closed.checkpointRevision).toBe(0);
    const execution = await executionRow(worker.executionId);
    expect(receipt.updatedAt.getTime()).toBeGreaterThanOrEqual(
      execution.observedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    // The turn in flight completed; the queued one was cancelled by the close.
    expect(await turnRows(session.sessionId)).toEqual([
      { sequence: 1, status: "completed", terminalReason: null },
      { sequence: 2, status: "cancelled", terminalReason: "closed" },
    ]);
    expect(await receiptRow(queuedReceipt[0]?.id ?? "")).toMatchObject({
      status: "failed",
      error: { code: "SESSION_CLOSED" },
    });
    expect(
      await db
        .select({ id: queueMessages.id })
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.sessionId)),
    ).toHaveLength(0);

    const frames = await streamed(session);
    expect(admissionSteps(frames)).toEqual([
      expect.objectContaining({
        admission_state: "closing",
        reason: "work is done",
      }),
      expect.objectContaining({ phase: "stopped", admission_state: "closed" }),
    ]);
    expect(closedRecords(frames)).toEqual([
      {
        type: "system",
        subtype: "session_closed",
        closed_by: "close",
        close_receipt_id: response.receipt_id,
        checkpoint_revision: 0,
        cancelled_turn_count: 1,
      },
    ]);

    await expectClosedToEverything(session);
  });

  test("closing refuses messages and controls with SESSION_CLOSING's state, lets terminate overtake it, and replays by key", async () => {
    const session = await newSession("closing");
    const worker = await claim(session);
    await deliver(worker);
    const before = await sessionRow(session.sessionId);
    const key = crypto.randomUUID();
    const first = await close(session, before.revision, {
      idempotencyKey: key,
      payloadHash: "c1",
    });
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    expect(
      await close(session, before.revision, {
        idempotencyKey: key,
        payloadHash: "c1",
      }),
    ).toEqual({ outcome: "replayed", response: first.response });
    expect(
      await close(session, before.revision, {
        idempotencyKey: key,
        payloadHash: "c2",
      }),
    ).toEqual({ outcome: "conflict" });
    expect(await close(session, before.revision)).toEqual({
      outcome: "revision_conflict",
      currentRevision: before.revision + 1,
    });

    const closing = { outcome: "rejected", admissionState: "closing" } as const;
    expect(await close(session, before.revision + 1)).toEqual(closing);
    expect(await append(session, "not now")).toEqual(closing);
    expect(await pause(session)).toEqual(closing);
    expect(await resume(session)).toEqual(closing);
    expect(await recoveryClose(session)).toEqual({
      outcome: "not_in_recovery",
      admissionState: "closing",
    });

    // Terminate is the way out of a close that cannot finish.
    expect((await terminate(session)).outcome).toBe("accepted");
    expect(await receiptRow(first.response.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "CONTROL_SUPERSEDED" },
    });
    expect((await sessionRow(session.sessionId)).admissionState).toBe(
      "stopping",
    );
  });

  test("an open question holds the close, CLOSE_BLOCKED names it past the deadline, and the close completes once it is answered", async () => {
    const session = await newSession("question");
    const worker = await claim(session);
    const turn = await deliver(worker);
    const requestId = `req_${crypto.randomUUID()}`;
    const response = await accepted(session);
    const detail = async () =>
      (await reader().getSession(session.ownerId, session.sessionId))
        ?.attention;

    expect(await detail()).toBeNull();
    await overdue(response.receipt_id);
    expect(await detail()).toEqual({
      code: "CLOSE_BLOCKED",
      reason: "long_turn",
    });
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      turn_id: turn,
      request_id: requestId,
      input_hash: "a".repeat(64),
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
    });
    expect(await detail()).toEqual({
      code: "CLOSE_BLOCKED",
      reason: "pending_request",
    });
    // Blocked is not killed: the worker keeps its execution and lease.
    const held = await sessionRow(session.sessionId);
    expect(held.admissionState).toBe("closing");
    expect((await executionRow(worker.executionId)).desiredState).not.toBe(
      "terminated",
    );

    const answered = await createPostgresPendingRequests(db).answerAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      answer: { request_id: requestId, kind: "permission", decision: "allow" },
      approval: { surface: "api", decisionId: crypto.randomUUID() },
    });
    expect(answered.outcome).toBe("accepted");
    await finalize(worker, turn, 0);
    expect(await releaseForDrain(worker, response.receipt_id)).toEqual({
      released: true,
    });
    // Released, not yet seen gone: only the absence is still awaited.
    expect(await detail()).toEqual({
      code: "CLOSE_BLOCKED",
      reason: "execution_pending",
    });
    await confirmExecutionGone(db, worker.executionId);
    expect((await sessionRow(session.sessionId)).admissionState).toBe("closed");
    expect((await receiptRow(response.receipt_id)).status).toBe("succeeded");
    expect(await detail()).toBeNull();
  });

  test("a drain that cannot commit fails the close back to active with queued input intact; an unknown turn hands it to recovery", async () => {
    const session = await newSession("uncovered");
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), null);
    await append(session, "still queued");
    const response = await accepted(session);
    expect(await failure(releaseForDrain(worker, response.receipt_id))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "SIGTERM",
    });
    await confirmExecutionGone(db, worker.executionId);
    const back = await sessionRow(session.sessionId);
    expect(back.admissionState).not.toBe("closed");
    expect(back.admissionState).not.toBe("closing");
    expect(await receiptRow(response.receipt_id)).toMatchObject({
      status: "failed",
      error: {
        code: expect.stringMatching(/CHECKPOINT_UNAVAILABLE|RECOVERY_REQUIRED/),
      },
    });
    expect((await turnRows(session.sessionId)).at(-1)?.status).toBe("queued");
    // The close fails back to active; the uncovered turn then holds the
    // session for an operator, as after any lost worker.
    expect(admissionSteps(await streamed(session)).slice(-2)).toEqual([
      expect.objectContaining({
        admission_state: "active",
        close_failed: "checkpoint_unavailable",
      }),
      expect.objectContaining({
        admission_state: "recovery_required",
        reason: "context_gap",
      }),
    ]);

    const unknown = await newSession("unknown");
    const w2 = await claim(unknown);
    const turn = await deliver(w2);
    const r2 = await accepted(unknown);
    await finalize(w2, turn, null, "outcome_unknown");
    expect((await sessionRow(unknown.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    expect(await receiptRow(r2.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "RECOVERY_REQUIRED" },
    });
  });

  // A session whose first turn checkpointed and whose second ran past the
  // transcript limits; the worker that ran it is still bound.
  async function exhausted(
    name: string,
    reason: "transcript_too_large" | "transcript_part_too_large",
  ) {
    const session = await newSession(name);
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), 0);
    expect((await append(session, "second input")).outcome).toBe("accepted");
    const turn = await deliver(worker);
    const { kind: _kind, ...fence } = worker.principal as Extract<
      WorkerPrincipal,
      { kind: "session" }
    >;
    const state = await createPostgresWorkerUnitOfWork(
      db,
    ).checkpointStateAtomic({ fence, now: new Date(), pendingReason: reason });
    expect(state).toMatchObject({ outcome: "ok", pendingReason: reason });
    return { session, worker, turn };
  }

  async function closeReceipts(session: Session) {
    return db
      .select({ status: receipts.status, error: receipts.error })
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, session.ownerId),
          eq(receipts.operation, "close"),
        ),
      );
  }

  test("a transcript past the limits refuses the close as checkpoint_unavailable, with its worker bound or gone, and leaves the session active", async () => {
    for (const reason of [
      "transcript_too_large",
      "transcript_part_too_large",
    ] as const) {
      const live = await exhausted(`live-${reason}`, reason);
      await finalize(live.worker, live.turn, null);
      const before = await sessionRow(live.session.sessionId);
      expect(await close(live.session, before.revision)).toEqual({
        outcome: "checkpoint_unavailable",
      });
      const after = await sessionRow(live.session.sessionId);
      expect(after.admissionState).toBe("active");
      expect(after.revision).toBe(before.revision);
      expect(await closeReceipts(live.session)).toEqual([]);
      // The way out the guide names: terminate, then recovery close.
      expect((await terminate(live.session)).outcome).toBe("accepted");
      await confirmExecutionGone(db, live.worker.executionId);
      const stopped = await sessionRow(live.session.sessionId);
      expect(stopped.admissionState).toBe("stopped");
      expect(await close(live.session, stopped.revision)).toEqual({
        outcome: "recovery_required",
      });
      expect((await recoveryClose(live.session)).outcome).toBe("accepted");
      expect((await sessionRow(live.session.sessionId)).admissionState).toBe(
        "closed",
      );

      const gone = await exhausted(`gone-${reason}`, reason);
      await finalize(gone.worker, gone.turn, null);
      await gateway.release(gone.worker.principal, {
        ...gone.worker.scope,
        reason: "idle",
      });
      // Released, so no drainer, but the execution is not seen gone yet.
      const released = await sessionRow(gone.session.sessionId);
      expect(released.admissionState).toBe("active");
      expect(await close(gone.session, released.revision)).toEqual({
        outcome: "checkpoint_unavailable",
      });
      expect(await closeReceipts(gone.session)).toEqual([]);
      // Once it is, the uncovered turn hands the session to recovery.
      await confirmExecutionGone(db, gone.worker.executionId);
      const idle = await sessionRow(gone.session.sessionId);
      expect(idle.admissionState).toBe("recovery_required");
      expect(await close(gone.session, idle.revision)).toEqual({
        outcome: "recovery_required",
      });
      expect(await closeReceipts(gone.session)).toEqual([]);
    }
  });

  test("a turn that runs past the transcript limits after the close was accepted fails the close to recovery once its execution is gone", async () => {
    const session = await newSession("exhausts-closing");
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), 0);
    expect((await append(session, "second input")).outcome).toBe("accepted");
    const turn = await deliver(worker);
    const response = await accepted(session);
    expect((await sessionRow(session.sessionId)).admissionState).toBe(
      "closing",
    );
    const { kind: _kind, ...fence } = worker.principal as Extract<
      WorkerPrincipal,
      { kind: "session" }
    >;
    await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
      fence,
      now: new Date(),
      pendingReason: "transcript_too_large",
    });
    await finalize(worker, turn, null);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "SIGTERM",
    });
    await confirmExecutionGone(db, worker.executionId);
    expect((await sessionRow(session.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    expect(await receiptRow(response.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "RECOVERY_REQUIRED" },
    });
  });

  test("paused, a resumable stopped and an idle active close at once; recovery states and a session with nothing to show are refused", async () => {
    const paused = await idleCovered("paused");
    expect((await pause(paused)).outcome).toBe("accepted");
    expect((await sessionRow(paused.sessionId)).admissionState).toBe("paused");
    const p = await accepted(paused);
    expect(p.receipt_status).toBe("succeeded");
    expect((await sessionRow(paused.sessionId)).admissionState).toBe("closed");
    expect((await receiptRow(p.receipt_id)).result).toEqual({
      resulting_admission_state: "closed",
      checkpoint_revision: 0,
      cancelled_turn_count: 0,
    });
    expect(admissionSteps(await streamed(paused)).at(-1)).toMatchObject({
      phase: "stopped",
      admission_state: "closed",
      reason: "work is done",
    });
    expect(closedRecords(await streamed(paused))).toHaveLength(1);
    await expectClosedToEverything(paused);

    const stopped = await idleCovered("stopped");
    expect((await terminate(stopped)).outcome).toBe("accepted");
    expect((await sessionRow(stopped.sessionId)).admissionState).toBe(
      "stopped",
    );
    expect((await accepted(stopped)).receipt_status).toBe("succeeded");
    expect((await sessionRow(stopped.sessionId)).admissionState).toBe("closed");

    const idle = await idleCovered("idle");
    expect((await accepted(idle)).receipt_status).toBe("succeeded");
    expect((await sessionRow(idle.sessionId)).admissionState).toBe("closed");

    // Never ran a turn: nothing to restore, nothing lost; the queued first
    // input is cancelled and the receipt names no checkpoint.
    const fresh = await newSession("fresh");
    const f = await accepted(fresh);
    expect(f.receipt_status).toBe("succeeded");
    expect((await receiptRow(f.receipt_id)).result).toEqual({
      resulting_admission_state: "closed",
      checkpoint_revision: null,
      cancelled_turn_count: 1,
    });

    // A transcript mirror lost entries and no worker is left to drain: the
    // checkpoint does not show the work.
    const untrusted = await idleCovered("untrusted");
    await db
      .update(sessions)
      .set({ checkpointPendingReason: "mirror_error" })
      .where(eq(sessions.id, untrusted.sessionId));
    expect(await close(untrusted, await revision(untrusted))).toEqual({
      outcome: "checkpoint_unavailable",
    });
    expect((await sessionRow(untrusted.sessionId)).admissionState).toBe(
      "active",
    );

    const recovering = await newSession("recovering");
    const w3 = await claim(recovering);
    await deliver(w3);
    await confirmExecutionGone(db, w3.executionId);
    expect((await sessionRow(recovering.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    expect(await close(recovering, await revision(recovering))).toEqual({
      outcome: "recovery_required",
    });

    // Stopped with no restore point: the recovery close is the way out.
    const stuck = await newSession("stuck");
    expect((await terminate(stuck)).outcome).toBe("accepted");
    expect((await sessionRow(stuck.sessionId)).admissionState).toBe("stopped");
    expect(await close(stuck, await revision(stuck))).toEqual({
      outcome: "recovery_required",
    });
  });

  test("a close that deadlocks with a claim's signal-then-session locks is retried and succeeds", async () => {
    const session = await newSession("deadlock");
    // Plays the worker claim's order: the signal first, then the session.
    // The long timeout makes the close, which waits first, the victim.
    const claimer = await pool.connect();
    try {
      await claimer.query("BEGIN");
      await claimer.query("SET LOCAL deadlock_timeout = '30s'");
      await claimer.query(
        "SELECT session_id FROM unassigned_sessions WHERE session_id = $1 FOR UPDATE",
        [session.sessionId],
      );
      const closing = accepted(session);
      // The close must already hold the session and wait on the signal, or
      // the claimer below takes the session first and no deadlock happens.
      let waiting = false;
      for (let i = 0; i < 250 && !waiting; i += 1) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
             AND wait_event_type = 'Lock' AND query ILIKE 'delete from "unassigned_sessions"%'`,
        );
        waiting = rows.length > 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await claimer.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        session.sessionId,
      ]);
      await claimer.query("COMMIT");
      expect((await closing).receipt_status).toBe("succeeded");
    } finally {
      claimer.release();
    }
    expect((await sessionRow(session.sessionId)).admissionState).toBe("closed");
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.sessionId)),
    ).toEqual([]);
  });

  test("a bound session with no drainer closes at once with the kill intent, and its receipt succeeds on the gone observation", async () => {
    const session = await idleCovered("unclaimed");
    await append(session, "queued behind");
    const { executionId } = await launchSession(db, {
      sessionId: session.sessionId,
    });
    await db
      .update(workerLaunches)
      .set({ replacementReason: "nonce_expired" })
      .where(eq(workerLaunches.executionId, executionId));
    const before = await sessionRow(session.sessionId);

    const response = await accepted(session);
    expect(response.receipt_status).toBe("accepted");
    const closed = await sessionRow(session.sessionId);
    expect(closed.admissionState).toBe("closed");
    expect(closed.leaseEpoch).toBe(before.leaseEpoch + 1);
    expect((await executionRow(executionId)).desiredState).toBe("terminated");
    const [launch] = await db
      .select({ replacementReason: workerLaunches.replacementReason })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, executionId));
    expect(launch?.replacementReason).toBeNull();
    expect(await receiptRow(response.receipt_id)).toMatchObject({
      status: "accepted",
      result: {
        resulting_admission_state: "closed",
        checkpoint_revision: 0,
        cancelled_turn_count: 1,
      },
    });

    await confirmExecutionGone(db, executionId);
    expect((await sessionRow(session.sessionId)).admissionState).toBe("closed");
    expect((await receiptRow(response.receipt_id)).status).toBe("succeeded");
  });

  test("close leaves push requests alone: one on the final checkpoint is approved after it, one from inside the last turn meets checkpoint_moved", async () => {
    const pushes = createPostgresPushRequests(db);
    const requester: ReceiptActor = {
      principal: { kind: "api_key", id: "key-writer" },
      actor_user_id: null,
      agent_id: null,
    };
    const request = (session: Session, revision: number) =>
      pushes.create({
        ownerId: session.ownerId,
        sessionId: session.sessionId,
        actor: requester,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "h-create",
        repositoryId: "sample-app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: revision,
        gitCommit: "b".repeat(40),
        policyApproval: null,
        policyFields: {},
      });
    const approve = (session: Session, pushRequestId: string) =>
      pushes.decide({
        ownerId: session.ownerId,
        sessionId: session.sessionId,
        pushRequestId,
        actor: requester,
        decision: "approve",
        gitCommit: "b".repeat(40),
        reason: null,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "h-decide",
      });

    const done = await idleCovered("push-after");
    const pinned = await request(done, 0);
    if (pinned.outcome !== "written") throw new Error(pinned.outcome);
    expect((await accepted(done)).receipt_status).toBe("succeeded");
    expect((await approve(done, pinned.request.id)).outcome).toBe("written");

    const inside = await newSession("push-inside");
    const worker = await claim(inside);
    await finalize(worker, await deliver(worker), 0);
    await append(inside, "last turn");
    const last = await deliver(worker);
    const early = await request(inside, 0);
    if (early.outcome !== "written") throw new Error(early.outcome);
    const response = await accepted(inside);
    await finalize(worker, last, 1);
    await releaseForDrain(worker, response.receipt_id);
    await confirmExecutionGone(db, worker.executionId);
    expect((await receiptRow(response.receipt_id)).result).toMatchObject({
      checkpoint_revision: 1,
    });
    expect(await approve(inside, early.request.id)).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
  });

  test("recovery close and terminate stay distinct from close on the stream and the receipt", async () => {
    const recovering = await newSession("recovery-close");
    const w = await claim(recovering);
    await deliver(w);
    await confirmExecutionGone(db, w.executionId);
    const decided = await recoveryClose(recovering);
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    expect((await receiptRow(decided.response.receipt_id)).operation).toBe(
      "recovery_decision",
    );
    expect(closedRecords(await streamed(recovering))).toEqual([]);

    const stopped = await idleCovered("terminate");
    const killed = await terminate(stopped);
    if (killed.outcome !== "accepted") throw new Error(killed.outcome);
    expect((await receiptRow(killed.response.receipt_id)).operation).toBe(
      "terminate",
    );
    expect(closedRecords(await streamed(stopped))).toEqual([]);
  });
});
