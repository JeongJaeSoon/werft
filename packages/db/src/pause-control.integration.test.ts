import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type SseEvent,
  sessionEventVariants,
  type WorkerScope,
} from "@werft-ai/contracts";
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
import * as schema from "./schema.ts";
import {
  attempts,
  checkpoints,
  events,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { recordEvent } from "./session-events.ts";
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

integration("pause on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pause_it" });
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

  // The turn ends with the checkpoint the worker captured at its terminal.
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

  function pause(
    session: Session,
    expectedRevision: number,
    overrides: { idempotencyKey?: string; payloadHash?: string } = {},
  ) {
    return controls().pauseAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
      payloadHash: overrides.payloadHash ?? crypto.randomUUID(),
      expectedRevision,
      reason: "save cost overnight",
      now: new Date(),
    });
  }

  async function accepted(session: Session) {
    const before = await sessionRow(session.sessionId);
    const result = await pause(session, before.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return result.response;
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

  function releaseForPause(worker: Worker, controlId: string) {
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

  // Reads the whole stream the way GET /v1/sessions/{id}/events pages it.
  async function streamed(session: Session) {
    const frames: SseEvent[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await reader().readEvents(
        session.ownerId,
        session.sessionId,
        {
          ...(after === undefined ? {} : { after }),
          limit: 2,
          maxBytes: 1 << 20,
        },
      );
      if (!page) throw new Error("session not readable");
      frames.push(...page.items);
      after = page.items.at(-1)?.id ?? after;
      if (!page.more) return frames;
    }
  }

  function pauseStatus(frames: SseEvent[]) {
    return frames.flatMap((frame) => {
      if (frame.event !== "status") return [];
      const status = sessionEventVariants.status.shape.data.parse(
        frame.data.data,
      );
      return status.reason === undefined ? [] : [status];
    });
  }

  // Backdates the pause past its drain deadline, on the clock it is read on.
  async function overdue(receiptId: string) {
    await db
      .update(receipts)
      .set({ createdAt: sql`clock_timestamp() - interval '61 seconds'` })
      .where(eq(receipts.id, receiptId));
  }

  test("drain → checkpointed finalize → pause release → gone: paused with the receipt settled at or after the observation", async () => {
    const session = await newSession("happy");
    const worker = await claim(session);
    const turn = await deliver(worker);
    const queued = await append(session, "second input stays queued");
    expect(queued.outcome).toBe("accepted");
    const before = await sessionRow(session.sessionId);

    const response = await accepted(session);
    expect(response.receipt_status).toBe("accepted");
    const pausing = await sessionRow(session.sessionId);
    expect(pausing.admissionState).toBe("pausing");
    expect(pausing.revision).toBe(before.revision + 1);
    // The worker keeps its lease through the drain.
    expect(pausing.leaseEpoch).toBe(before.leaseEpoch);

    // The worker learns of it through pendingControl, hinted by heartbeat.
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

    // Committing before the turn is finalized is refused; the lease stays.
    expect(await failure(releaseForPause(worker, response.receipt_id))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    await finalize(worker, turn, 0);
    // No new input while pausing: the queued turn is not handed over.
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input).toBeNull();

    expect(await releaseForPause(worker, response.receipt_id)).toEqual({
      released: true,
    });
    const committed = await sessionRow(session.sessionId);
    expect(committed.admissionState).toBe("pausing");
    expect(committed.leaseEpoch).toBeGreaterThan(pausing.leaseEpoch);
    expect((await executionRow(worker.executionId)).desiredState).toBe(
      "terminated",
    );
    expect((await receiptRow(response.receipt_id)).status).toBe("accepted");

    await confirmExecutionGone(db, worker.executionId);

    const paused = await sessionRow(session.sessionId);
    expect(paused.admissionState).toBe("paused");
    expect(paused.executionId).toBeNull();
    const receipt = await receiptRow(response.receipt_id);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.result).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 0,
      queued_turn_count: 1,
    });
    const execution = await executionRow(worker.executionId);
    expect(execution.observedState).toBe("terminated");
    expect(receipt.updatedAt.getTime()).toBeGreaterThanOrEqual(
      execution.observedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    // Queued input is preserved, not cancelled.
    const rows = await db
      .select({ sequence: turns.sequence, status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.sessionId))
      .orderBy(asc(turns.sequence));
    expect(rows).toEqual([
      { sequence: 1, status: "completed" },
      { sequence: 2, status: "queued" },
    ]);
    expect(
      await db
        .select({ id: queueMessages.id })
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.sessionId)),
    ).toHaveLength(1);
    // The pause left its audit trail on the event stream.
    const audit = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.sessionId, session.sessionId), eq(events.type, "status")),
      );
    expect(audit.map((row) => row.payload)).toContainEqual(
      expect.objectContaining({ admission_state: "pausing" }),
    );
    // ...and the stream still reads to its end past it. The
    // turn was draining, so the status the pause reports is running.
    expect(pauseStatus(await streamed(session))).toEqual([
      expect.objectContaining({ phase: "running", admission_state: "pausing" }),
    ]);
  });

  test("pausing and paused refuse messages with SESSION_PAUSED's state, keep answers open, and replay by key", async () => {
    const session = await newSession("messages");
    const worker = await claim(session);
    const turn = await deliver(worker);
    const requestId = `req_${crypto.randomUUID()}`;
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      turn_id: turn,
      request_id: requestId,
      input_hash: "a".repeat(64),
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
    });
    const before = await sessionRow(session.sessionId);
    const key = crypto.randomUUID();
    const first = await pause(session, before.revision, {
      idempotencyKey: key,
      payloadHash: "p1",
    });
    expect(first.outcome).toBe("accepted");
    expect(
      await pause(session, before.revision, {
        idempotencyKey: key,
        payloadHash: "p1",
      }),
    ).toEqual({
      outcome: "replayed",
      response:
        first.outcome === "accepted"
          ? first.response
          : { receipt_id: "", receipt_status: "accepted" },
    });
    expect(
      await pause(session, before.revision, {
        idempotencyKey: key,
        payloadHash: "p2",
      }),
    ).toEqual({ outcome: "conflict" });
    // A stale revision is a conflict; a fresh pause on pausing is refused.
    expect(await pause(session, before.revision)).toEqual({
      outcome: "revision_conflict",
      currentRevision: before.revision + 1,
    });
    expect(await pause(session, before.revision + 1)).toEqual({
      outcome: "rejected",
      admissionState: "pausing",
    });

    expect(await append(session, "not now")).toEqual({
      outcome: "rejected",
      admissionState: "pausing",
    });
    const answered = await createPostgresPendingRequests(db).answerAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      answer: { request_id: requestId, kind: "permission", decision: "allow" },
      approval: { surface: "api", decisionId: crypto.randomUUID() },
    });
    expect(answered.outcome).toBe("accepted");
  });

  test("PAUSE_BLOCKED appears only past the drain deadline, with the cause: long_turn, pending_request, mirror_error, checkpoint_unavailable", async () => {
    const session = await newSession("blocked");
    const worker = await claim(session);
    const turn = await deliver(worker);
    const response = await accepted(session);
    const detail = () =>
      reader().getSession(session.ownerId, session.sessionId);

    expect((await detail())?.attention).toBeNull();
    await db
      .update(receipts)
      .set({ createdAt: sql`clock_timestamp() - interval '59 seconds'` })
      .where(eq(receipts.id, response.receipt_id));
    expect((await detail())?.attention).toBeNull();
    await overdue(response.receipt_id);
    expect((await detail())?.attention).toEqual({
      code: "PAUSE_BLOCKED",
      reason: "long_turn",
    });

    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      turn_id: turn,
      request_id: `req_${crypto.randomUUID()}`,
      input_hash: "b".repeat(64),
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
    });
    expect((await detail())?.attention).toEqual({
      code: "PAUSE_BLOCKED",
      reason: "pending_request",
    });

    await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: "batch 3 dropped" },
    });
    expect((await detail())?.attention).toEqual({
      code: "PAUSE_BLOCKED",
      reason: "mirror_error",
    });
    // Still pausing, still leased: the deadline kills nothing.
    const row = await sessionRow(session.sessionId);
    expect(row.admissionState).toBe("pausing");
    expect(row.executionId).toBe(worker.executionId);

    // A turn that finished without a checkpoint leaves nothing to pause on.
    const other = await newSession("uncovered");
    const second = await claim(other);
    await finalize(second, await deliver(second), null);
    const pending = await accepted(other);
    await overdue(pending.receipt_id);
    expect(
      (await reader().getSession(other.ownerId, other.sessionId))?.attention,
    ).toEqual({ code: "PAUSE_BLOCKED", reason: "checkpoint_unavailable" });
    expect(await failure(releaseForPause(second, pending.receipt_id))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    expect((await sessionRow(other.sessionId)).leaseEpoch).toBe(
      second.scope.lease_epoch,
    );
  });

  test("a session with nothing running pauses at once onto its checkpoint, or is refused without one", async () => {
    const covered = await newSession("idle-covered");
    const worker = await claim(covered);
    await finalize(worker, await deliver(worker), 0);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    expect((await sessionRow(covered.sessionId)).executionId).toBeNull();

    const response = await accepted(covered);
    expect(response.receipt_status).toBe("succeeded");
    expect((await sessionRow(covered.sessionId)).admissionState).toBe("paused");
    expect((await receiptRow(response.receipt_id)).result).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 0,
      queued_turn_count: 0,
    });
    expect(pauseStatus(await streamed(covered))).toEqual([
      expect.objectContaining({ phase: "idle", admission_state: "paused" }),
    ]);

    // Queued and never run, no checkpoint: nothing to restore from.
    const fresh = await newSession("idle-fresh");
    const row = await sessionRow(fresh.sessionId);
    expect(await pause(fresh, row.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    expect((await sessionRow(fresh.sessionId)).admissionState).toBe("active");
  });

  test("after a fallback restore the pause rests on, and its receipt names, the revision restored", async () => {
    const fellBack = await newSession("idle-fallback");
    const worker = await claim(fellBack);
    await finalize(worker, await deliver(worker), 0);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    // A later turn-less revision 1 became the pointer and turned out damaged;
    // the session was restored from revision 0, which covers the last turn.
    await db.insert(checkpoints).values({
      sessionId: fellBack.sessionId,
      revision: 1,
      manifestRef: `manifests/${fellBack.sessionId}/1`,
      manifestSha256: MANIFEST_SHA,
      parentRevision: 0,
      turnId: null,
    });
    await db
      .update(sessions)
      .set({ checkpointRevision: 1, checkpointFallbackRevision: 0 })
      .where(eq(sessions.id, fellBack.sessionId));

    const response = await accepted(fellBack);
    expect(response.receipt_status).toBe("succeeded");
    expect((await receiptRow(response.receipt_id)).result).toEqual({
      resulting_admission_state: "paused",
      checkpoint_revision: 0,
      queued_turn_count: 0,
    });
  });

  test("an audit the event contract would not read is refused before it is stored", async () => {
    const session = await newSession("audit-contract");
    const stored = () =>
      db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.sessionId, session.sessionId));
    const before = (await stored()).length;
    const write = (payload: Record<string, unknown>) =>
      db.transaction((tx) =>
        recordEvent(tx, {
          sessionId: session.sessionId,
          type: "status",
          payload,
          turnRowId: null,
          now: new Date(),
        }),
      );

    await expect(write({ admission_state: "paused" })).rejects.toThrow();
    await expect(
      write({ phase: "paused", admission_state: "paused" }),
    ).rejects.toThrow();
    expect(await stored()).toHaveLength(before);

    await write({ phase: "idle", admission_state: "paused" });
    expect(await stored()).toHaveLength(before + 1);
  });

  test("an advisory pending reason blocks a pause only when the pointer falls short of the last turn", async () => {
    // Turn 1 checkpointed at revision 0; a second turn, when asked for,
    // ends without one.
    const idleOn = async (name: string, secondTurn: boolean) => {
      const session = await newSession(name);
      const worker = await claim(session);
      await finalize(worker, await deliver(worker), 0);
      if (secondTurn) {
        await append(session, "start the dev server");
        await finalize(worker, await deliver(worker), null);
      }
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "idle",
      });
      await confirmExecutionGone(db, worker.executionId);
      return session;
    };

    // Recorded after another checkpoint had already committed past the
    // turn: the pointer covers everything that ran.
    const covered = await idleOn("advisory-covered", false);
    await db
      .update(sessions)
      .set({ checkpointPendingReason: "checkpoint_lease_held" })
      .where(eq(sessions.id, covered.sessionId));
    const response = await accepted(covered);
    expect(response.receipt_status).toBe("succeeded");
    expect((await sessionRow(covered.sessionId)).admissionState).toBe("paused");

    // The turn's own checkpoint was refused (a dev server still running):
    // nothing covers it, whatever the reason says.
    const uncovered = await idleOn("advisory-uncovered", true);
    // The exit already hands that gap to an operator; a row from
    // before that check still meets the pause's own coverage rule.
    expect((await sessionRow(uncovered.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    await db
      .update(sessions)
      .set({
        admissionState: "active",
        status: "idle",
        checkpointPendingReason: "background_writer",
      })
      .where(eq(sessions.id, uncovered.sessionId));
    const row = await sessionRow(uncovered.sessionId);
    expect(await pause(uncovered, row.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
  });

  test("a launch reserved but not yet claimed gets its stop intent at once, and the gone observation pauses it", async () => {
    const session = await newSession("unclaimed");
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), 0);
    await gateway.release(worker.principal, {
      ...worker.scope,
      reason: "idle",
    });
    await confirmExecutionGone(db, worker.executionId);
    // The scheduler has reserved the next launch; no worker claimed it yet.
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
    const pausing = await sessionRow(session.sessionId);
    expect(pausing.admissionState).toBe("pausing");
    expect(pausing.leaseEpoch).toBe(before.leaseEpoch + 1);
    expect((await executionRow(executionId)).desiredState).toBe("terminated");
    const [launch] = await db
      .select({ replacementReason: workerLaunches.replacementReason })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, executionId));
    expect(launch?.replacementReason).toBeNull();

    await confirmExecutionGone(db, executionId);
    expect((await sessionRow(session.sessionId)).admissionState).toBe("paused");
    expect((await receiptRow(response.receipt_id)).status).toBe("succeeded");
  });

  test("the pause receipt never stays accepted: terminate supersedes it, a lost worker and an unknown finalize fail it", async () => {
    const terminated = await newSession("terminated");
    const w1 = await claim(terminated);
    await deliver(w1);
    const p1 = await accepted(terminated);
    const row = await sessionRow(terminated.sessionId);
    const killed = await controls().terminateAtomic({
      principal: { ownerId: terminated.ownerId },
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "now",
      now: new Date(),
    });
    expect(killed.outcome).toBe("accepted");
    expect(await receiptRow(p1.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "CONTROL_SUPERSEDED" },
    });
    expect((await sessionRow(terminated.sessionId)).admissionState).toBe(
      "stopping",
    );

    // The worker dies mid-drain: its turn is unknown, recovery takes over.
    const lost = await newSession("lost");
    const w2 = await claim(lost);
    await deliver(w2);
    const p2 = await accepted(lost);
    await confirmExecutionGone(db, w2.executionId);
    expect((await sessionRow(lost.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    expect(await receiptRow(p2.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "RECOVERY_REQUIRED" },
    });

    const unknown = await newSession("unknown");
    const w3 = await claim(unknown);
    const turn = await deliver(w3);
    const p3 = await accepted(unknown);
    await finalize(w3, turn, null, "outcome_unknown");
    expect((await sessionRow(unknown.sessionId)).admissionState).toBe(
      "recovery_required",
    );
    expect(await receiptRow(p3.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "RECOVERY_REQUIRED" },
    });
  });

  test("a release answering a pause that is no longer open is REQUEST_STALE, and a plain release still settles the pause when it is safe", async () => {
    const session = await newSession("stale");
    const worker = await claim(session);
    await finalize(worker, await deliver(worker), 0);
    const response = await accepted(session);

    expect(await failure(releaseForPause(worker, crypto.randomUUID()))).toBe(
      "REQUEST_STALE",
    );
    // SIGTERM or idle: the release is unconditional, the attempt goes.
    expect(
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "SIGTERM",
      }),
    ).toEqual({ released: true });
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(attempt?.state).toBe("exited");
    await confirmExecutionGone(db, worker.executionId);
    expect((await sessionRow(session.sessionId)).admissionState).toBe("paused");
    expect((await receiptRow(response.receipt_id)).status).toBe("succeeded");
  });
});
