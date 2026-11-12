import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  PendingSettlement,
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  createWorkerGateway,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushIntents } from "./action/push-intents.ts";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresWorkerPendingStore } from "./decision/pending-control.ts";
import {
  cancelParkedRequests,
  createPostgresPendingRequests,
  readInputWaits,
} from "./decision/pending-requests.ts";
import { createPostgresGitHubMcpStore } from "./github/mcp-egress.ts";
import { launchFailedCause, quarantineLaunch } from "./launch-quarantine.ts";
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
  pendingRequests,
  permissionGrants,
  pushIntents,
  queueMessages,
  receipts,
  sessions,
  turnContinuations,
  turns,
  unassignedSessions,
  users,
} from "./schema.ts";
import {
  restoreExecutionAtomic,
  revokeExecutionAtomic,
} from "./sessions/execution-revocation.ts";
import { createPostgresTurnInterrupts } from "./sessions/interrupt-control.ts";
import { expireParkedGroups } from "./sessions/parked-group.ts";
import { pauseBlocker } from "./sessions/pause-control.ts";
import { announceLapsedInputWaits } from "./sessions/session-events.ts";
import { launchSession } from "./testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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

async function until(
  check: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function permission(command = "ls"): RegisterPendingRequest["request"] {
  return { kind: "permission", tool: "Bash", input: { command } };
}

// A park as the worker will commit it (94S-858): the turn ends interrupted
// with its open requests marked parked, the worker releases, the execution
// goes, and the session settles paused for input. Most tests write it row by
// row; the finalize tests go through the worker's own path.
integration("parked pending requests on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let service: ReturnType<typeof createPendingRequestService>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "parked_it" });
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
    service = createPendingRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPendingRequests(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const controls = () => createPostgresSessionControl(db);
  const reader = () => createPostgresSessionReader(db);

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope & { turn_id: string };
    executionId: string;
  };

  async function runningSession() {
    const partition = `parked-${crypto.randomUUID()}`;
    const owner = testCaller(crypto.randomUUID());
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
    const { worker } = await claim(sessionId);
    return { owner, sessionId, worker };
  }

  // A new worker for the session, handed its next input.
  async function claim(
    sessionId: string,
    capabilities?: { approval_remember: true },
  ) {
    const { principal, scope, executionId, claimed } = await claimOnly(
      sessionId,
      capabilities,
    );
    const next = await gateway.nextInput(principal, scope);
    if (!next.input) throw new Error("no input delivered");
    const worker: Worker = {
      principal,
      scope: { ...scope, turn_id: next.input.turn_id },
      executionId,
    };
    return { worker, claimed, input: next.input };
  }

  // A worker for the session that has claimed it and asked for nothing yet.
  async function claimOnly(
    sessionId: string,
    capabilities?: { approval_remember: true },
  ) {
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      ...(capabilities === undefined ? {} : { capabilities }),
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
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
    if (claimed.restore !== null) {
      await gateway.ready(principal, {
        ...scope,
        restored_revision: claimed.restore.revision,
      });
    }
    return { principal, scope, executionId, claimed };
  }

  async function register(worker: Worker, inputHash = HASH_A) {
    const requestId = `req_${crypto.randomUUID()}`;
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      request_id: requestId,
      input_hash: inputHash,
      request: permission(),
    });
    return requestId;
  }

  function answer(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
    requestId: string,
  ) {
    const body: PostSessionAnswerRequest = {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    };
    return service.answer(owner, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body,
    });
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  function poll(worker: Worker, settled: PendingSettlement[] = []) {
    return gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled,
    });
  }

  function executionGone(worker: Worker) {
    return createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
      executionId: worker.executionId,
      now: new Date(),
    });
  }

  async function request(requestId: string) {
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    if (!row) throw new Error(`no request ${requestId}`);
    return row;
  }

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw new Error(`no session ${sessionId}`);
    return row;
  }

  // The finalize half of a park: the worker's turn interrupted, the given
  // requests parked. The execution is left for the caller to end.
  async function parkRows(worker: Worker, requestIds: string[]) {
    const sequence = Number(worker.scope.turn_id);
    const revision = sequence - 1;
    const [turn] = await db
      .update(turns)
      .set({
        status: "interrupted",
        endedAt: sql`now()`,
        terminalReason: "input_wait_parked",
      })
      .where(
        and(
          eq(turns.sessionId, worker.scope.session_id),
          eq(turns.sequence, sequence),
        ),
      )
      .returning({ id: turns.id });
    for (const requestId of requestIds) {
      await db
        .update(pendingRequests)
        .set({ parkedAt: sql`now()` })
        .where(eq(pendingRequests.requestId, requestId));
    }
    if (!turn) throw new Error(`no turn ${sequence}`);
    // As finalize does for any outcome it knows.
    await db.delete(queueMessages).where(eq(queueMessages.turnId, turn.id));
    // A park always commits the turn_end checkpoint it resumes from.
    await db.insert(checkpoints).values({
      sessionId: worker.scope.session_id,
      revision,
      manifestRef: `manifests/${worker.scope.session_id}/${revision}`,
      manifestSha256: "c".repeat(64),
      parentRevision: revision === 0 ? null : revision - 1,
      turnId: turn.id,
    });
    await db
      .update(sessions)
      .set({ checkpointRevision: revision })
      .where(eq(sessions.id, worker.scope.session_id));
    return turn.id;
  }

  // The whole park, ending paused as confirmExecutionGone will leave it.
  async function parked(count = 1) {
    const running = await runningSession();
    const requestIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      requestIds.push(await register(running.worker, String(i).repeat(64)));
    }
    const [requestId = ""] = requestIds;
    const turnRowId = await parkRows(running.worker, requestIds);
    await executionGone(running.worker);
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        status: "idle",
        pauseReason: "awaiting_input",
      })
      .where(eq(sessions.id, running.sessionId));
    return { ...running, requestId, requestIds, turnRowId };
  }

  async function reads(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
  ) {
    const viewer = { userId: null, apiKeyId: null };
    const detail = await reader().getSession(owner.ownerId, sessionId);
    const filtered = async (status: "needs_input" | "idle") =>
      (
        await reader().listSessions(
          owner.ownerId,
          { limit: 10, status },
          viewer,
        )
      ).items.length;
    const counted = await reader().countSessions(owner.ownerId, {}, viewer);
    return {
      status: detail?.status,
      count: detail?.pending_request_count,
      listed: (await service.listPendingRequests(owner, sessionId)).items.map(
        (item) => item.request_id,
      ),
      filteredNeedsInput: await filtered("needs_input"),
      filteredIdle: await filtered("idle"),
      countedNeedsInput: counted.counts.needs_input,
      countedIdle: counted.counts.idle,
    };
  }

  test("a parked request stays listed, counted and needs_input after its attempt is gone", async () => {
    const { owner, sessionId, worker, requestId } = await parked();
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(attempt?.state).toBe("lost");
    expect((await request(requestId)).resolvedAt).toBeNull();
    expect(await reads(owner, sessionId)).toEqual({
      status: "needs_input",
      count: 1,
      listed: [requestId],
      filteredNeedsInput: 1,
      filteredIdle: 0,
      countedNeedsInput: 1,
      countedIdle: 0,
    });

    // Expired, it is answerable no more and the session reads idle again.
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    expect(await reads(owner, sessionId)).toEqual({
      status: "idle",
      count: 0,
      listed: [],
      filteredNeedsInput: 0,
      filteredIdle: 1,
      countedNeedsInput: 0,
      countedIdle: 1,
    });
    expect(await failure(answer(owner, sessionId, requestId))).toBe(
      "REQUEST_EXPIRED",
    );
  });

  test("execution-gone closes the waiting request and keeps the parked one", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const kept = await register(worker, HASH_A);
    const lost = await register(worker, HASH_B);
    await parkRows(worker, [kept]);
    await executionGone(worker);

    expect((await request(kept)).resolvedAt).toBeNull();
    expect((await request(lost)).resolvedAt).not.toBeNull();
    expect((await reads(owner, sessionId)).listed).toEqual([kept]);
    // Its asker is gone: an answer to the request that was not parked is
    // stale, one to the parked request is taken.
    expect(await failure(answer(owner, sessionId, lost))).toBe("REQUEST_STALE");
    const accepted = await answer(owner, sessionId, kept);
    expect(accepted.receipt_status).toBe("accepted");
    expect((await receipt(accepted.receipt_id))?.targetRef).toEqual({
      session_id: sessionId,
      turn_id: "1",
      request_id: kept,
    });
    expect((await request(kept)).resolvedAt).not.toBeNull();
    expect((await reads(owner, sessionId)).count).toBe(0);
  });

  test("an answered parked request is not lost when the execution goes", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const parkedId = await register(worker, HASH_A);
    const waitingId = await register(worker, HASH_B);
    const parkedAnswer = await answer(owner, sessionId, parkedId);
    const waitingAnswer = await answer(owner, sessionId, waitingId);
    await parkRows(worker, [parkedId]);
    await executionGone(worker);

    expect(await request(parkedId)).toMatchObject({
      settledAt: null,
      settledOutcome: null,
    });
    expect((await receipt(parkedAnswer.receipt_id))?.status).toBe("accepted");
    expect((await request(waitingId)).settledOutcome).toBe("lost");
    expect((await receipt(waitingAnswer.receipt_id))?.status).toBe("unknown");
  });

  test("the worker cannot settle a parked request", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const accepted = await answer(owner, sessionId, requestId);
    await db
      .update(pendingRequests)
      .set({ parkedAt: sql`now()` })
      .where(eq(pendingRequests.requestId, requestId));
    // Nor is its answer handed to the attempt that asked, which may still
    // be up between the park's finalize and its release.
    const polled = await poll(worker, [
      { request_id: requestId, outcome: "cancelled" },
    ]);
    expect(polled.answers).toEqual([]);
    expect(await request(requestId)).toMatchObject({
      settledAt: null,
      settledOutcome: null,
      deliveredAt: null,
    });
    expect((await receipt(accepted.receipt_id))?.status).toBe("accepted");
  });

  test("a park that settles paused reports the session waiting for input", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await parkRows(worker, [requestId]);
    await db
      .update(sessions)
      .set({
        admissionState: "pausing",
        pauseReason: "awaiting_input",
        status: "idle",
      })
      .where(eq(sessions.id, sessionId));
    await db.insert(receipts).values({
      id: crypto.randomUUID(),
      ownerId: owner.ownerId,
      actor: { kind: "system" },
      requestId: null,
      operation: "pause",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "accepted",
      result: null,
    });
    await executionGone(worker);

    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: "awaiting_input",
      inputAnnounced: true,
    });
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({
      phase: "needs_input",
      admission_state: "paused",
    });
    expect((await reads(owner, sessionId)).status).toBe("needs_input");
  });

  function finalizeParked(worker: Worker, reason: string) {
    return gateway.finalize(worker.principal, {
      ...worker.scope,
      finalize_key: `${worker.scope.attempt_id}:${worker.scope.turn_id}`,
      final_source_sequence: 0,
      terminal: { status: "interrupted", reason, result: null, usage: null },
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${worker.scope.session_id}/0`,
        manifest_sha256: "c".repeat(64),
      },
    });
  }

  test("a parking finalize parks what its worker left unsettled, expiring together, and leaves the session idle on it", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const settled = await register(worker);
    const open = await register(worker, HASH_B);
    const answeredAfterCut = await register(worker);
    await answer(owner, sessionId, settled);
    await poll(worker, [{ request_id: settled, outcome: "answered" }]);
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() + interval '2 hours'` })
      .where(eq(pendingRequests.requestId, open));
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() + interval '1 hour'` })
      .where(eq(pendingRequests.requestId, answeredAfterCut));
    // The worker cut the turn before this answer reached it.
    await answer(owner, sessionId, answeredAfterCut);

    await finalizeParked(worker, "input_wait_parked");

    const rows = await Promise.all(
      [settled, open, answeredAfterCut].map(request),
    );
    expect(rows.map((row) => row.parkedAt !== null)).toEqual([
      false,
      true,
      true,
    ]);
    expect(rows[1]?.expiresAt.getTime()).toBe(rows[2]?.expiresAt.getTime());
    expect((await sessionRow(sessionId)).status).toBe("idle");
    expect((await reads(owner, sessionId)).status).toBe("needs_input");
    const stages = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(events.id);
    const tail = stages.slice(-2);
    expect(tail[0]?.payload).toEqual({
      type: "system",
      subtype: "input_wait",
      stage: "parked",
      request_ids: [open, answeredAfterCut].sort(),
    });
    expect(tail[1]?.payload).toMatchObject({ phase: "needs_input" });

    // The drain release and the execution going leave the parked rows open.
    await gateway.release(worker.principal, {
      ...worker.scope,
      turn_id: null,
      reason: "received SIGTERM",
      stop_kind: "drain",
    });
    await executionGone(worker);
    expect((await request(open)).resolvedAt).toBeNull();
    expect((await reads(owner, sessionId)).status).toBe("needs_input");
  });

  test("an interrupted finalize for any other reason parks nothing", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);

    await finalizeParked(worker, "interrupted");

    expect((await request(requestId)).parkedAt).toBeNull();
    expect((await sessionRow(sessionId)).status).toBe("stopped");
    expect((await reads(owner, sessionId)).status).toBe("stopped");
  });

  test("pendingControl stamps delivered_at once, when it first hands an answer over", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await answer(owner, sessionId, requestId);
    expect((await request(requestId)).deliveredAt).toBeNull();

    expect((await poll(worker)).answers).toHaveLength(1);
    const first = (await request(requestId)).deliveredAt;
    expect(first).toBeInstanceOf(Date);
    // Redelivered until settled; the first hand-over is what it records.
    expect((await poll(worker)).answers).toHaveLength(1);
    expect((await request(requestId)).deliveredAt).toEqual(first);

    // A request nobody answered is never delivered.
    const unanswered = await register(worker, HASH_B);
    await poll(worker);
    expect((await request(unanswered)).deliveredAt).toBeNull();
  });

  test("a revocation before the park's execution is gone still reports the wait", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await parkRows(worker, [requestId]);
    await db
      .update(sessions)
      .set({
        admissionState: "pausing",
        pauseReason: "awaiting_input",
        status: "idle",
      })
      .where(eq(sessions.id, sessionId));
    expect(
      (
        await revokeExecutionAtomic(db, {
          sessionId,
          reason: "grant revoked",
          now: new Date(),
        })
      ).outcome,
    ).toBe("revoked");

    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "stopping",
      inputAnnounced: true,
    });
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({
      phase: "needs_input",
      admission_state: "stopping",
    });
    expect(await reads(owner, sessionId)).toMatchObject({
      status: "needs_input",
      count: 1,
    });
  });

  test("an execution revocation keeps a parked request; a terminate cancels it", async () => {
    const revoked = await parked();
    expect(
      (
        await revokeExecutionAtomic(db, {
          sessionId: revoked.sessionId,
          reason: "grant revoked",
          now: new Date(),
        })
      ).outcome,
    ).toBe("revoked");
    expect(await request(revoked.requestId)).toMatchObject({
      resolvedAt: null,
      settledAt: null,
    });

    const terminated = await parked();
    const accepted = await answer(
      terminated.owner,
      terminated.sessionId,
      terminated.requestId,
    );
    const row = await sessionRow(terminated.sessionId);
    const killed = await controls().terminateAtomic({
      principal: terminated.owner,
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "done",
      now: new Date(),
    });
    expect(killed.outcome).toBe("accepted");
    expect(await request(terminated.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect((await receipt(accepted.receipt_id))?.status).toBe("failed");
    expect(await sessionRow(terminated.sessionId)).toMatchObject({
      admissionState: "stopped",
      pauseReason: null,
    });
  });

  test("a revoked and restored session carries its parked turn on when resumed from stopped", async () => {
    const stop = async (sessionId: string) => {
      const now = new Date();
      await revokeExecutionAtomic(db, {
        sessionId,
        reason: "grant revoked",
        now,
      });
      await restoreExecutionAtomic(db, {
        sessionId,
        reason: "grant reissued",
        now,
      });
      expect((await sessionRow(sessionId)).admissionState).toBe("stopped");
    };

    // Answered first: the revocation cancels the queued turn carrying it,
    // which leaves the group open again.
    const before = await parked();
    await answer(before.owner, before.sessionId, before.requestId);
    await stop(before.sessionId);
    expect(await continuations(before.turnRowId)).toEqual([]);
    // Answered while stopped: kept until the resume.
    const after = await parked();
    await stop(after.sessionId);
    await answer(after.owner, after.sessionId, after.requestId);

    for (const { owner, sessionId, requestId, turnRowId } of [before, after]) {
      expect((await resumeBy(owner, sessionId)).outcome).toBe("accepted");
      const queued = (await continuations(turnRowId)).filter(
        (turn) => turn.status === "queued",
      );
      expect(queued).toHaveLength(1);
      const [grant] = await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.requestId, requestId));
      expect(grant?.turnId).toBe(queued[0]?.id);
    }
  });

  test("an answer is refused while the stopped session's checkpoint misses a turn that ran", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    await followUp(owner, sessionId);
    const later = await claim(sessionId);
    // Turn 2 ends with no checkpoint, as a background writer can leave it.
    await gateway.finalize(later.worker.principal, {
      ...later.worker.scope,
      finalize_key: `${later.worker.scope.attempt_id}:2`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const now = new Date();
    await revokeExecutionAtomic(db, {
      sessionId,
      reason: "grant revoked",
      now,
    });
    await executionGone(later.worker);
    await restoreExecutionAtomic(db, {
      sessionId,
      reason: "grant reissued",
      now,
    });
    expect((await sessionRow(sessionId)).admissionState).toBe("stopped");

    expect(await failure(answer(owner, sessionId, requestId))).toBe(
      "CHECKPOINT_UNAVAILABLE",
    );
    expect((await request(requestId)).answeredAt).toBeNull();
  });

  test("a close, an interrupt or a recovery close or start_fresh cancels the parked requests", async () => {
    const closed = await parked();
    const row = await sessionRow(closed.sessionId);
    const close = await controls().closeAtomic({
      principal: closed.owner,
      sessionId: closed.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "work is done",
      now: new Date(),
    });
    expect(close.outcome).toBe("accepted");
    expect(await request(closed.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect(await sessionRow(closed.sessionId)).toMatchObject({
      admissionState: "closed",
      pauseReason: null,
    });

    const interrupted = await parked();
    const interrupt = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: interrupted.owner,
      sessionId: interrupted.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "1",
    });
    expect(interrupt.outcome).toBe("accepted");
    expect(await request(interrupted.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect((await reads(interrupted.owner, interrupted.sessionId)).status).toBe(
      "idle",
    );

    const recovered = await parked();
    await db
      .update(sessions)
      .set({ admissionState: "recovery_required", status: "failed" })
      .where(eq(sessions.id, recovered.sessionId));
    const before = await sessionRow(recovered.sessionId);
    const decided = await controls().decideRecoveryAtomic({
      principal: recovered.owner,
      sessionId: recovered.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "close",
        expected_revision: before.revision,
        reason: "give up",
      },
      now: new Date(),
    });
    expect(decided.outcome).toBe("accepted");
    expect(await request(recovered.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });

    // start_fresh retires the checkpoint the park would resume from; an
    // answer already given goes with it.
    const fresh = await parked();
    const given = await answer(fresh.owner, fresh.sessionId, fresh.requestId);
    await db
      .update(sessions)
      .set({ admissionState: "recovery_required", status: "failed" })
      .where(eq(sessions.id, fresh.sessionId));
    const freshBefore = await sessionRow(fresh.sessionId);
    const started = await controls().decideRecoveryAtomic({
      principal: fresh.owner,
      sessionId: fresh.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "start_fresh",
        expected_revision: freshBefore.revision,
        reason: "start over",
      },
      now: new Date(),
    });
    expect(started.outcome).toBe("accepted");
    expect(await request(fresh.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect((await receipt(given.receipt_id))?.status).toBe("failed");
  });

  test("the reconciler does not report a parked wait as ended", async () => {
    const { sessionId } = await parked();
    await db
      .update(sessions)
      .set({ inputAnnounced: true })
      .where(eq(sessions.id, sessionId));
    const announced = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: true,
    });
    expect(announced.map((item) => item.sessionId)).not.toContain(sessionId);
  });

  test("pause_reason holds only while pausing or paused", async () => {
    const { sessionId } = await parked();
    // Leaving paused by any write clears it.
    await db
      .update(sessions)
      .set({ admissionState: "active" })
      .where(eq(sessions.id, sessionId));
    expect((await sessionRow(sessionId)).pauseReason).toBeNull();
    // Set outside a pause, it does not stick.
    await db
      .update(sessions)
      .set({ pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    expect((await sessionRow(sessionId)).pauseReason).toBeNull();
    // No trigger runs on an insert: the check refuses it outright.
    const refused = await db
      .insert(sessions)
      .values({
        id: crypto.randomUUID(),
        ownerId: "owner-check",
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        pauseReason: "awaiting_input",
      })
      .then(
        () => null,
        (error: { cause?: { constraint?: string } }) => error.cause?.constraint,
      );
    expect(refused).toBe("sessions_pause_reason_check");
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, sessionId));
    await expect(
      db
        .update(sessions)
        .set({ pauseReason: "parked" })
        .where(eq(sessions.id, sessionId))
        .execute(),
    ).rejects.toThrow();
  });

  test("a person's pause takes over a park, paused or still pausing", async () => {
    const paused = await parked();
    const before = await sessionRow(paused.sessionId);
    const taken = await controls().pauseAtomic({
      principal: paused.owner,
      sessionId: paused.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: before.revision,
      reason: "mine now",
      now: new Date(),
    });
    expect(taken.outcome).toBe("accepted");
    if (taken.outcome !== "accepted") return;
    expect(taken.response.receipt_status).toBe("succeeded");
    expect(await sessionRow(paused.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: null,
      revision: before.revision + 1,
    });
    // The parked request is still the person's to answer.
    expect((await reads(paused.owner, paused.sessionId)).count).toBe(1);

    // Pausing: the park's receipt is superseded and the worker is handed
    // the person's pause as a new control.
    const { owner, sessionId, worker } = await runningSession();
    await register(worker);
    const parkReceipt = crypto.randomUUID();
    await db.insert(receipts).values({
      id: parkReceipt,
      ownerId: owner.ownerId,
      actor: { kind: "system" },
      requestId: null,
      operation: "pause",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "accepted",
      result: null,
    });
    await db
      .update(sessions)
      .set({ admissionState: "pausing", pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    expect((await poll(worker)).control).toMatchObject({
      control_id: parkReceipt,
      kind: "park",
    });
    const pausing = await sessionRow(sessionId);
    // A park waits on its open requests by design; only the turn holds it.
    expect(await pauseBlocker(db, pausing)).toBe("long_turn");
    expect(await pauseBlocker(db, { ...pausing, pauseReason: null })).toBe(
      "pending_request",
    );

    const takeover = await controls().pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: pausing.revision,
      reason: "mine now",
      now: new Date(),
    });
    expect(takeover.outcome).toBe("accepted");
    if (takeover.outcome !== "accepted") return;
    expect(takeover.response.receipt_status).toBe("accepted");
    expect(await receipt(parkReceipt)).toMatchObject({
      status: "failed",
      error: { code: "CONTROL_SUPERSEDED" },
    });
    expect((await poll(worker)).control).toMatchObject({
      control_id: takeover.response.receipt_id,
      kind: "pause",
    });
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: null,
    });
  });

  test("a grant goes with its session and its request", async () => {
    const result = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'permission_grants'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    expect(result.rows).toEqual([
      {
        conname: "permission_grants_attempt_id_attempts_id_fk",
        confdeltype: "a",
      },
      {
        conname: "permission_grants_request_id_pending_requests_request_id_fk",
        confdeltype: "c",
      },
      {
        conname: "permission_grants_session_id_sessions_id_fk",
        confdeltype: "c",
      },
      { conname: "permission_grants_turn_id_turns_id_fk", confdeltype: "a" },
    ]);

    const { sessionId, requestId, turnRowId } = await parked();
    await db.insert(permissionGrants).values({
      requestId,
      sessionId,
      turnId: turnRowId,
    });
    await db
      .delete(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(
      await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.sessionId, sessionId)),
    ).toEqual([]);
  });

  // The system pause a timed park opens (94S-860): a pause receipt with no
  // person behind it, and the session pausing for input.
  async function openPark(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
  ) {
    const parkReceipt = crypto.randomUUID();
    await db.insert(receipts).values({
      id: parkReceipt,
      ownerId: owner.ownerId,
      actor: { kind: "system" },
      requestId: null,
      operation: "pause",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "accepted",
      result: null,
    });
    await db
      .update(sessions)
      .set({ admissionState: "pausing", pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    return parkReceipt;
  }

  function declinePark(worker: Worker, pauseControlId: string) {
    return gateway.parkDeclined(worker.principal, {
      ...worker.scope,
      pause_control_id: pauseControlId,
      reason: "answer_applied",
    });
  }

  async function systemEvents(sessionId: string) {
    const rows = await db
      .select({ payload: events.payload, turnId: events.turnId })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "system")))
      .orderBy(events.id);
    return rows.filter(
      (row) => (row.payload as { subtype?: string }).subtype === "input_wait",
    );
  }

  test("a declined park puts the session back to active with its requests waiting", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const parkReceipt = await openPark(owner, sessionId);
    const before = await sessionRow(sessionId);

    expect(await declinePark(worker, parkReceipt)).toEqual({ reverted: true });
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "active",
      pauseReason: null,
      revision: before.revision + 1,
      leaseEpoch: before.leaseEpoch,
    });
    expect(await receipt(parkReceipt)).toMatchObject({
      status: "failed",
      error: { code: "PAUSE_CANCELLED" },
    });
    expect((await poll(worker)).control).toBeNull();
    expect(await reads(owner, sessionId)).toMatchObject({
      status: "needs_input",
      listed: [requestId],
    });
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({
      phase: "needs_input",
      admission_state: "active",
      park_declined: {
        pause_control_id: parkReceipt,
        reason: "answer_applied",
      },
    });
    // Said again, it finds no park to undo.
    expect(await declinePark(worker, parkReceipt)).toEqual({ reverted: false });
  });

  test("a declined park leaves a person's pause, another pause and a fenced worker alone", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker);
    const parkReceipt = await openPark(owner, sessionId);
    expect(await declinePark(worker, crypto.randomUUID())).toEqual({
      reverted: false,
    });
    expect((await sessionRow(sessionId)).admissionState).toBe("pausing");

    const pausing = await sessionRow(sessionId);
    const takeover = await controls().pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: pausing.revision,
      reason: "mine now",
      now: new Date(),
    });
    if (takeover.outcome !== "accepted") throw new Error(takeover.outcome);
    // The park was superseded by the person's pause, which the worker's
    // late word does not undo.
    expect(await declinePark(worker, parkReceipt)).toEqual({ reverted: false });
    expect(await declinePark(worker, takeover.response.receipt_id)).toEqual({
      reverted: false,
    });
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: null,
    });
    expect((await receipt(takeover.response.receipt_id))?.status).toBe(
      "accepted",
    );

    const fenced = await runningSession();
    await register(fenced.worker);
    const fencedPark = await openPark(fenced.owner, fenced.sessionId);
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, fenced.sessionId));
    const refused = await declinePark(fenced.worker, fencedPark).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WorkerGatewayError);
    expect((refused as WorkerGatewayError).code).toBe("STALE_EPOCH");
    expect((await sessionRow(fenced.sessionId)).admissionState).toBe("pausing");
  });

  test("a declined park and a person's pause racing never undo the person's pause", async () => {
    for (let round = 0; round < 6; round++) {
      const { owner, sessionId, worker } = await runningSession();
      await register(worker);
      const parkReceipt = await openPark(owner, sessionId);
      const pausing = await sessionRow(sessionId);
      const [declined, paused] = await Promise.all([
        declinePark(worker, parkReceipt),
        controls().pauseAtomic({
          principal: owner,
          sessionId,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          // A takeover keeps the revision the park left; after a decline the
          // person's pause meets the one the decline wrote.
          expectedRevision: pausing.revision,
          reason: "mine now",
          now: new Date(),
        }),
      ]);
      const row = await sessionRow(sessionId);
      expect(row.pauseReason).toBeNull();
      if (declined.reverted) {
        // The decline went first: the pause met a newer revision.
        expect(paused.outcome).toBe("revision_conflict");
        expect(row.admissionState).toBe("active");
      } else {
        expect(paused.outcome).toBe("accepted");
        if (paused.outcome !== "accepted") continue;
        expect(row.admissionState).toBe("pausing");
        expect((await receipt(paused.response.receipt_id))?.status).toBe(
          "accepted",
        );
      }
    }
  });

  test("a declined park whose lease ends while it waits on the receipt changes nothing", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker);
    const parkReceipt = await openPark(owner, sessionId);
    await db
      .update(attempts)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + interval '300 milliseconds'`,
      })
      .where(eq(attempts.id, worker.scope.attempt_id));
    let release = () => {};
    let locked = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.id, parkReceipt))
        .for("update");
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await holding;
    const declined = declinePark(worker, parkReceipt).then(
      () => null,
      (error: unknown) => error,
    );
    // The decline must be queued behind the lock, and its lease over, by the
    // time the lock is let go.
    await until(async () => {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock'`,
      );
      return rows.length > 0;
    }, "the decline to wait on the receipt lock");
    await until(async () => {
      const { rows } = await pool.query(
        "SELECT lease_expires_at < clock_timestamp() AS lapsed FROM attempts WHERE id = $1",
        [worker.scope.attempt_id],
      );
      return rows[0]?.lapsed === true;
    }, "the lease to end");
    release();
    await holder;
    const error = await declined;
    expect(error).toBeInstanceOf(WorkerGatewayError);
    expect((error as WorkerGatewayError).code).toBe("LEASE_EXPIRED");
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: "awaiting_input",
    });
    expect((await receipt(parkReceipt))?.status).toBe("accepted");
  });

  test("execution-gone and a revocation report the waits they lose; a terminate does not", async () => {
    const gone = await runningSession();
    const lost = await register(gone.worker, HASH_A);
    const kept = await register(gone.worker, HASH_B);
    const lapsed = await register(gone.worker, "c".repeat(64));
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, lapsed));
    const turnRowId = await parkRows(gone.worker, [kept]);
    await executionGone(gone.worker);
    expect(await systemEvents(gone.sessionId)).toEqual([
      {
        payload: {
          type: "system",
          subtype: "input_wait",
          stage: "lost",
          request_ids: [lost],
        },
        turnId: turnRowId,
      },
    ]);

    const revoked = await runningSession();
    const revokedId = await register(revoked.worker);
    await revokeExecutionAtomic(db, {
      sessionId: revoked.sessionId,
      reason: "grant revoked",
      now: new Date(),
    });
    expect(
      (await systemEvents(revoked.sessionId)).map((row) => row.payload),
    ).toEqual([
      {
        type: "system",
        subtype: "input_wait",
        stage: "lost",
        request_ids: [revokedId],
      },
    ]);
    // Nothing more once it is gone: the requests were closed already.
    await executionGone(revoked.worker);
    expect(await systemEvents(revoked.sessionId)).toHaveLength(1);

    const terminated = await runningSession();
    await register(terminated.worker);
    const row = await sessionRow(terminated.sessionId);
    const killed = await controls().terminateAtomic({
      principal: terminated.owner,
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "done",
      now: new Date(),
    });
    expect(killed.outcome).toBe("accepted");
    await executionGone(terminated.worker);
    expect(await systemEvents(terminated.sessionId)).toEqual([]);
  });

  test("detail, list and pending items say which stage the wait is in", async () => {
    const viewer = { userId: null, apiKeyId: null };
    const listed = async (owner: ReturnType<typeof testCaller>) =>
      (await reader().listSessions(owner.ownerId, { limit: 10 }, viewer))
        .items[0]?.input_wait;

    const { owner, sessionId, worker } = await runningSession();
    const none = await reader().getSession(owner.ownerId, sessionId);
    expect(none).toMatchObject({ input_wait: null, pause_reason: null });
    expect(await listed(owner)).toBeNull();

    const first = await register(worker, HASH_A);
    await db
      .update(pendingRequests)
      .set({ parkAt: sql`created_at + interval '30 minutes'` })
      .where(eq(pendingRequests.requestId, first));
    const second = await register(worker, HASH_B);
    const [a, b] = [await request(first), await request(second)];
    const waiting = await reader().getSession(owner.ownerId, sessionId);
    expect(waiting?.input_wait).toEqual({
      state: "waiting",
      since: a.createdAt.toISOString(),
      kinds: ["permission"],
      request_ids: [first, second],
      park_at: a.parkAt?.toISOString() ?? null,
      expires_at: (a.expiresAt < b.expiresAt ? a : b).expiresAt.toISOString(),
    });
    expect(await listed(owner)).toEqual({ state: "waiting" });
    const items = (await service.listPendingRequests(owner, sessionId)).items;
    expect(
      items.map(({ state, park_at, group }) => ({ state, park_at, group })),
    ).toEqual([
      { state: "waiting", park_at: a.parkAt?.toISOString(), group: "1" },
      { state: "waiting", park_at: null, group: "1" },
    ]);

    await openPark(owner, sessionId);
    expect(
      (await reader().getSession(owner.ownerId, sessionId))?.input_wait?.state,
    ).toBe("parking");
    expect(
      (await reader().getSession(owner.ownerId, sessionId))?.pause_reason,
    ).toBe("awaiting_input");

    const p = await parked();
    const parkedDetail = await reader().getSession(
      p.owner.ownerId,
      p.sessionId,
    );
    expect(parkedDetail).toMatchObject({
      status: "needs_input",
      pause_reason: "awaiting_input",
      input_wait: { state: "parked", request_ids: [p.requestId] },
    });
    expect(
      (await service.listPendingRequests(p.owner, p.sessionId)).items[0]?.state,
    ).toBe("parked");

    // The group expired unanswered: the wait reads expired until a resume.
    await db
      .update(pendingRequests)
      .set({
        expiresAt: sql`now() - interval '1 second'`,
        resolvedAt: sql`now()`,
        settledAt: sql`now()`,
        settledOutcome: "expired",
      })
      .where(eq(pendingRequests.requestId, p.requestId));
    const expired = await reader().getSession(p.owner.ownerId, p.sessionId);
    expect(expired).toMatchObject({
      status: "idle",
      pause_reason: "awaiting_input",
      input_wait: { state: "expired", request_ids: [p.requestId] },
    });
    expect(await listed(p.owner)).toEqual({ state: "expired" });

    // An answered group is not expired, whatever the session still says.
    const answered = await parked();
    await answer(answered.owner, answered.sessionId, answered.requestId);
    expect(
      (await reader().getSession(answered.owner.ownerId, answered.sessionId))
        ?.input_wait,
    ).toBeNull();
  });

  test("a wait is judged at the instant its session's status was", async () => {
    const { sessionId, worker } = await runningSession();
    const requestId = await register(worker, HASH_A);
    // Inside the asker's lease, so only the expiry decides.
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw new Error("session row missing");
    const waitAt = async (at: string) =>
      (await readInputWaits(db, [row], at)).get(sessionId) ?? null;
    // Microseconds kept: a row expiring 1µs after the read still counted.
    const [bounds] = await db
      .select({
        before: sql<string>`(${pendingRequests.expiresAt} - interval '1 microsecond')::text`,
        after: sql<string>`${pendingRequests.expiresAt}::text`,
      })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    if (!bounds) throw new Error("request row missing");
    const { before, after } = bounds;
    expect((await waitAt(before))?.request_ids).toEqual([requestId]);
    expect(await waitAt(after)).toBeNull();
  });

  test("a session keeps the waits it was created with", async () => {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: testCaller(crypto.randomUUID()),
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: "none",
      permissionWait: { park_after_seconds: 0 },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    expect(
      (await sessionRow(accepted.response.session_id)).permissionWaitOverride,
    ).toEqual({ park_after_seconds: 0 });
  });

  function answerWith(
    owner: Parameters<typeof service.answer>[0],
    sessionId: string,
    body: PostSessionAnswerRequest,
  ) {
    return service.answer(owner, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body,
    });
  }

  function continuations(parkedTurnRowId: number) {
    return db
      .select({ turn: turns })
      .from(turnContinuations)
      .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
      .where(eq(turnContinuations.parkedTurnId, parkedTurnRowId))
      .then((rows) => rows.map((row) => row.turn));
  }

  async function resumeBy(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
  ) {
    return controls().resumeAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: (await sessionRow(sessionId)).revision,
      now: new Date(),
    });
  }

  function followUp(owner: ReturnType<typeof testCaller>, sessionId: string) {
    return createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "and then this",
    });
  }

  function completed(worker: Worker) {
    return gateway.finalize(worker.principal, {
      ...worker.scope,
      finalize_key: `${worker.scope.attempt_id}:${worker.scope.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: Number(worker.scope.turn_id) - 1,
        manifest_ref: `manifests/${worker.scope.session_id}/${worker.scope.turn_id}`,
        manifest_sha256: "c".repeat(64),
      },
    });
  }

  test("an answer the parked turn could not resume on is refused and not stored", async () => {
    // The first answer of the group is the one refused.
    const bare = await parked(2);
    await db
      .update(sessions)
      .set({ checkpointRevision: null })
      .where(eq(sessions.id, bare.sessionId));
    expect(
      await failure(answer(bare.owner, bare.sessionId, bare.requestId)),
    ).toBe("CHECKPOINT_UNAVAILABLE");
    expect((await request(bare.requestId)).answeredAt).toBeNull();

    const unknown = await parked();
    await db
      .update(turns)
      .set({ status: "outcome_unknown" })
      .where(eq(turns.id, unknown.turnRowId));
    expect(
      await failure(
        answer(unknown.owner, unknown.sessionId, unknown.requestId),
      ),
    ).toBe("RECOVERY_REQUIRED");
    expect((await request(unknown.requestId)).answeredAt).toBeNull();
    expect(await continuations(unknown.turnRowId)).toEqual([]);

    // Held for an operator with no turn of unknown outcome, as restores
    // that kept failing leave it.
    const held = await parked();
    await db
      .update(sessions)
      .set({ admissionState: "recovery_required", status: "failed" })
      .where(eq(sessions.id, held.sessionId));
    expect(
      await failure(answer(held.owner, held.sessionId, held.requestId)),
    ).toBe("RECOVERY_REQUIRED");
    expect((await request(held.requestId)).answeredAt).toBeNull();
  });

  test("a parked allow kept for the session reaches the resumed worker as grant rules, only if it announces approval_remember", async () => {
    const offer = [{ tool_name: "Bash", rule_content: "git status:*" }];
    const kept = async () => {
      const running = await parked();
      await db
        .update(pendingRequests)
        .set({
          payload: sql`${pendingRequests.payload} || ${JSON.stringify({ remember_offer: offer })}::jsonb`,
        })
        .where(eq(pendingRequests.requestId, running.requestId));
      await answerWith(running.owner, running.sessionId, {
        request_id: running.requestId,
        kind: "permission",
        decision: "allow",
        remember: "session",
      });
      return running;
    };

    const capable = await kept();
    const withRules = await claim(capable.sessionId, {
      approval_remember: true,
    });
    expect(withRules.claimed.grants).toEqual([
      expect.objectContaining({
        request_id: capable.requestId,
        remember_offer: offer,
      }),
    ]);

    const older = await kept();
    const plain = await claim(older.sessionId);
    expect(plain.claimed.grants).toEqual([
      expect.objectContaining({ request_id: older.requestId }),
    ]);
    expect(plain.claimed.grants?.[0]).not.toHaveProperty("remember_offer");
  });

  test("answers that would not fit the turn carrying them on are refused", async () => {
    const { owner, sessionId, requestIds, turnRowId } = await parked(2);
    const [first = "", second = ""] = requestIds;
    const deny = (requestId: string) =>
      answerWith(owner, sessionId, {
        request_id: requestId,
        kind: "permission",
        decision: "deny",
        reason: "x".repeat(20 * 1024),
      });
    expect((await deny(first)).receipt_status).toBe("accepted");
    expect(await failure(deny(second))).toBe("BAD_REQUEST");
    expect((await request(second)).answeredAt).toBeNull();
    expect(await continuations(turnRowId)).toEqual([]);
  });

  test("the last answer of a paused park resumes it, its allows granted to the turn that carries it on", async () => {
    const { owner, sessionId, requestIds, turnRowId } = await parked(2);
    const [allowed = "", denied = ""] = requestIds;
    const first = await answerWith(owner, sessionId, {
      request_id: allowed,
      kind: "permission",
      decision: "allow",
    });
    expect(first).toMatchObject({ resumed: false, waiting_for: 1 });
    expect(await continuations(turnRowId)).toEqual([]);
    expect((await sessionRow(sessionId)).admissionState).toBe("paused");
    const [requester] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: `${crypto.randomUUID()}@example.invalid`,
        passwordHash: "x",
        displayName: "requester",
      })
      .returning({ id: users.id });
    await db
      .update(turns)
      .set({ actorId: requester?.id ?? null })
      .where(eq(turns.id, turnRowId));

    // Answered through a stored key, which a receipt names.
    const byKey = {
      ...owner,
      actor: {
        principal: { kind: "api_key" as const, id: crypto.randomUUID() },
        userId: null,
        workspaceId: null,
        apiKeyId: null,
      },
    };
    const last = await answerWith(byKey, sessionId, {
      request_id: denied,
      kind: "permission",
      decision: "deny",
      reason: "not that one",
    });
    expect(last).toMatchObject({ resumed: true, waiting_for: 0 });
    const [carried] = await continuations(turnRowId);
    expect(carried?.message).toContain("Bash call: allowed");
    expect(carried?.message).toContain(
      "Bash call: denied. Reason: not that one",
    );
    // The answer came through a key with no user, yet the turn that carries
    // the parked one on stays the requester's.
    expect(carried?.actorId).toBe(requester?.id ?? null);
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "resuming",
      pauseReason: null,
    });
    const resumeReceipts = await db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.operation, "resume"),
          sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
        ),
      );
    expect(resumeReceipts).toHaveLength(1);
    expect(resumeReceipts[0]?.status).toBe("accepted");
    expect(resumeReceipts[0]?.actor).toEqual({
      principal: byKey.actor.principal,
      actor_user_id: null,
      agent_id: null,
    });
    expect(
      await db
        .select({
          requestId: permissionGrants.requestId,
          turnId: permissionGrants.turnId,
        })
        .from(permissionGrants)
        .where(eq(permissionGrants.sessionId, sessionId)),
    ).toEqual([{ requestId: allowed, turnId: carried?.id ?? -1 }]);

    // The new worker gets the grant and the carrying turn first. Handing
    // that turn over delivers the denial; the allow waits on its grant.
    const next = await claim(sessionId);
    expect(next.input.turn_id).toBe(String(carried?.sequence));
    expect(next.claimed.grants).toEqual([
      {
        request_id: allowed,
        turn_id: String(carried?.sequence),
        tool: "Bash",
        input_hash: "0".repeat(64),
      },
    ]);
    expect((await receipt(last.receipt_id))?.status).toBe("succeeded");
    expect((await receipt(first.receipt_id))?.status).toBe("accepted");

    // The turn ended without making the allowed call again.
    await gateway.pendingControl(next.worker.principal, {
      ...next.worker.scope,
      answers_after: 0,
      settled: [],
      delivered: [{ request_id: allowed, outcome: "grant_unused" }],
    });
    expect(await receipt(first.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "REQUEST_STALE" },
    });
    expect(await request(allowed)).toMatchObject({
      settledOutcome: "answered",
      settledAnswerResult: null,
    });
    const [grant] = await db
      .select()
      .from(permissionGrants)
      .where(eq(permissionGrants.requestId, allowed));
    expect(grant?.consumedAt).toBeNull();
  });

  test("answers kept before their turn parked still carry it on, cut to fit one message", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker);
    const second = await register(worker, HASH_B);
    for (const requestId of [first, second]) {
      await answerWith(owner, sessionId, {
        request_id: requestId,
        kind: "permission",
        decision: "deny",
        reason: "x".repeat(20 * 1024),
      });
    }
    const turnRowId = await parkRows(worker, [first, second]);
    await executionGone(worker);

    const [carried] = await continuations(turnRowId);
    expect(carried?.message).toContain("[cut to fit]");
    expect(
      new TextEncoder().encode(carried?.message ?? "").length,
    ).toBeLessThanOrEqual(32 * 1024);
  });

  test("a group of thousands of answers still carries on, the lines past one message counted", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker);
    await answerWith(owner, sessionId, {
      request_id: first,
      kind: "permission",
      decision: "deny",
      reason: "r",
    });
    // Copies of the answered request, as many as no equal share could fit.
    await db.execute(sql`
      INSERT INTO pending_requests (
        request_id, session_id, turn_id, attempt_id, kind, payload,
        input_hash, expires_at, resolved_at, answer, answered_at,
        answer_receipt_id, answered_by, answer_surface, answer_decision_id,
        tool
      )
      SELECT 'req_copy_' || n, session_id, turn_id, attempt_id, kind, payload,
        input_hash, expires_at, resolved_at, answer, answered_at,
        answer_receipt_id, answered_by, answer_surface, answer_decision_id,
        tool
      FROM pending_requests, generate_series(1, 3000) AS n
      WHERE request_id = ${first}
    `);
    const copies = (
      await db
        .select({ requestId: pendingRequests.requestId })
        .from(pendingRequests)
        .where(eq(pendingRequests.sessionId, sessionId))
    ).map((row) => row.requestId);
    expect(copies).toHaveLength(3001);
    const turnRowId = await parkRows(worker, copies);
    await executionGone(worker);

    const [carried] = await continuations(turnRowId);
    const message = carried?.message ?? "";
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(message).not.toContain("[cut to fit]");
    const lines = message.split("\n");
    const shown = lines.filter((line) =>
      line.startsWith("- Your Bash call: denied. Reason: r"),
    ).length;
    expect(shown).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe(`… ${3001 - shown} more answers cut`);
  });

  test("an interrupt of a parked turn already carried on cancels nothing a worker may hold", async () => {
    const { owner, sessionId, requestId } = await parked();
    expect(await answer(owner, sessionId, requestId)).toMatchObject({
      resumed: true,
    });
    // The claim carries the grant before the interrupt arrives.
    const early = await claimOnly(sessionId);
    expect(early.claimed.grants).toEqual([
      expect.objectContaining({ request_id: requestId }),
    ]);
    const interrupt = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "1",
    });
    expect(interrupt.outcome).toBe("accepted");
    const row = await request(requestId);
    expect(row.settledOutcome).toBeNull();
    expect((await receipt(row.answerReceiptId ?? ""))?.status).toBe("accepted");

    const next = await gateway.nextInput(early.principal, early.scope);
    expect(next.input?.turn_id).toBe("2");
  });

  test("after a drain park the turn that carries it on runs after input already queued", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const turnRowId = await parkRows(worker, [requestId]);
    await executionGone(worker);
    expect((await sessionRow(sessionId)).admissionState).toBe("active");
    expect((await followUp(owner, sessionId)).outcome).toBe("accepted");

    expect(await answer(owner, sessionId, requestId)).toMatchObject({
      resumed: true,
      waiting_for: 0,
    });
    const [carried] = await continuations(turnRowId);
    // Turns run in sequence order: a checkpoint of the later one never
    // stands for a turn that ran after it.
    const next = await claim(sessionId);
    expect(next.input.turn_id).toBe("2");
    await completed(next.worker);
    const after = await gateway.nextInput(
      next.worker.principal,
      next.worker.scope,
    );
    expect(after.input?.turn_id).toBe(String(carried?.sequence));
    expect(carried?.sequence).toBe(3);
    await completed({
      ...next.worker,
      scope: { ...next.worker.scope, turn_id: "3" },
    });
    await executionGone(next.worker);
    expect((await sessionRow(sessionId)).admissionState).toBe("active");
  });

  // A push the turn asked for with waits_for turn_end, still deferred.
  async function deferPush(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
    worker: Worker,
  ) {
    const rowId = await createPostgresGitHubMcpStore(db).runningTurn({
      sessionId,
      attemptId: worker.scope.attempt_id,
    });
    if (rowId === null) throw new Error("no running turn");
    const created = await createPostgresPushIntents(db).createDeferred({
      ownerId: owner.ownerId,
      sessionId,
      turnId: rowId,
      attemptId: worker.scope.attempt_id,
      repositoryId: "sample-app",
      targetBranch: `agent/${sessionId}`,
      actor: {
        principal: { kind: "api_key", id: "key-writer" },
        actor_user_id: null,
        agent_id: null,
      },
      pushClass: "push.primary",
      policySource: "agent",
    });
    expect(created.outcome).toBe("created");
    return rowId;
  }

  async function intentOf(sessionId: string) {
    const [row] = await db
      .select()
      .from(pushIntents)
      .where(eq(pushIntents.sessionId, sessionId));
    if (!row) throw new Error("no intent");
    return row;
  }

  test("a push the parked turn deferred is carried to the turn that resumes it and pinned at its end", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const parkedRowId = await deferPush(owner, sessionId, worker);
    await finalizeParked(worker, "input_wait_parked");
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: parkedRowId,
      refusalCode: null,
    });
    await executionGone(worker);
    expect(await createPostgresPushIntents(db).settleStale()).toBe(0);

    await answer(owner, sessionId, requestId);
    const [carried] = await continuations(parkedRowId);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: carried?.id,
    });

    const next = await claim(sessionId);
    await completed(next.worker);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "pinned",
      pinnedRevision: Number(next.worker.scope.turn_id) - 1,
      turnId: carried?.id,
    });
  });

  test("a push survives a park that did not go through finalize, and a cancelled group still ends it", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await deferPush(owner, sessionId, worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    const intents = createPostgresPushIntents(db);
    expect(await intents.settleStale()).toBe(0);
    expect((await intentOf(sessionId)).status).toBe("deferred");

    await cancelParkedRequests(db, { sessionId }, new Date());
    expect(await intents.settleStale()).toBe(1);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "cancelled",
      refusalCode: "turn_finalized_without_pin",
    });
  });

  test("a push is cancelled as superseded when another turn ran between the park and its resume", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await deferPush(owner, sessionId, worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    expect((await followUp(owner, sessionId)).outcome).toBe("accepted");

    await answer(owner, sessionId, requestId);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "cancelled",
      refusalCode: "superseded_by_turn",
    });
  });

  test("a settleStale running alongside the resume never cancels a carried push", async () => {
    // Both start at once on separate connections; which statement wins the
    // session lock first is up to Postgres, and both outcomes must hold.
    for (let round = 0; round < 3; round += 1) {
      const { owner, sessionId, worker } = await runningSession();
      const requestId = await register(worker);
      const parkedRowId = await deferPush(owner, sessionId, worker);
      await parkRows(worker, [requestId]);
      await executionGone(worker);
      await Promise.all([
        createPostgresPushIntents(db).settleStale(),
        answer(owner, sessionId, requestId),
      ]);
      const [carried] = await continuations(parkedRowId);
      expect(await intentOf(sessionId)).toMatchObject({
        status: "deferred",
        turnId: carried?.id,
      });
    }
  });

  test("a group whose requests all expired keeps its push until a person resumes it, then pins it", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const parkedRowId = await deferPush(owner, sessionId, worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        status: "idle",
        pauseReason: "awaiting_input",
      })
      .where(eq(sessions.id, sessionId));
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    await expireParkedGroups(db, { limit: 1_000, dryRun: false });
    expect((await request(requestId)).settledOutcome).toBe("expired");

    // The group is still there for a person to resume.
    expect(await createPostgresPushIntents(db).settleStale()).toBe(0);
    expect((await intentOf(sessionId)).status).toBe("deferred");

    expect((await resumeBy(owner, sessionId)).outcome).toBe("accepted");
    const [carried] = await continuations(parkedRowId);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: carried?.id,
    });
    const next = await claim(sessionId);
    await completed(next.worker);
    expect((await intentOf(sessionId)).status).toBe("pinned");
  });

  test("a revocation that cancels the carrying turn gives the push back to the parked turn, and a resume carries it again", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const parkedRowId = await deferPush(owner, sessionId, worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    await answer(owner, sessionId, requestId);
    const [first] = await continuations(parkedRowId);
    expect((await intentOf(sessionId)).turnId === first?.id).toBe(true);

    const now = new Date();
    await revokeExecutionAtomic(db, {
      sessionId,
      reason: "grant revoked",
      now,
    });
    await restoreExecutionAtomic(db, {
      sessionId,
      reason: "grant reissued",
      now,
    });
    expect(await continuations(parkedRowId)).toEqual([]);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: parkedRowId,
    });
    expect(await createPostgresPushIntents(db).settleStale()).toBe(0);

    expect((await resumeBy(owner, sessionId)).outcome).toBe("accepted");
    const [second] = await continuations(parkedRowId);
    expect(second?.id).not.toBe(first?.id);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: second?.id,
    });
    const next = await claim(sessionId);
    // The first carrying turn never ran, so the pointer still stands at the
    // park's revision 0 and the turn that carries on saves revision 1.
    await gateway.finalize(next.worker.principal, {
      ...next.worker.scope,
      finalize_key: `${next.worker.scope.attempt_id}:${next.worker.scope.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 1,
        manifest_ref: `manifests/${sessionId}/1`,
        manifest_sha256: "c".repeat(64),
      },
    });
    expect(await intentOf(sessionId)).toMatchObject({
      status: "pinned",
      pinnedRevision: 1,
    });
  });

  /** The parked turn carried on by an answer, its worker gone. */
  async function carriedPush(paused = false) {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const parkedRowId = await deferPush(owner, sessionId, worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    if (paused) {
      // Paused while it waited, as a drain park leaves it: the answer then
      // resumes the session.
      await db
        .update(sessions)
        .set({
          admissionState: "paused",
          status: "idle",
          pauseReason: "awaiting_input",
        })
        .where(eq(sessions.id, sessionId));
    }
    await answer(owner, sessionId, requestId);
    const [carried] = await continuations(parkedRowId);
    if (carried === undefined) throw new Error("not carried on");
    return { sessionId, worker, carriedId: carried.id };
  }

  /**
   * Reserves the launch that would carry the turn on, as the scheduler does,
   * and gives that launch up: the execution the quarantine marks is the one
   * reserved for this session now, not the worker already gone.
   */
  async function giveUpLaunch(sessionId: string) {
    const launch = await launchSession(db, { sessionId });
    await db.transaction((tx) =>
      quarantineLaunch(
        tx,
        { executionId: launch.executionId, generation: launch.generation },
        sessionId,
        launchFailedCause("no worker could start"),
      ),
    );
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, launch.executionId));
    // The given-up launch is marked for the pass to kill.
    expect(execution?.desiredState).toBe("terminated");
  }

  test("a launch given up on fails the carrying turn, and the push ends with a reason, as its group is carried on and cannot reopen", async () => {
    const { sessionId, carriedId } = await carriedPush();
    expect((await sessionRow(sessionId)).admissionState).toBe("active");
    await giveUpLaunch(sessionId);
    const [carried] = await db
      .select({ status: turns.status, reason: turns.terminalReason })
      .from(turns)
      .where(eq(turns.id, carriedId));
    expect(carried).toEqual({ status: "failed", reason: "launch_failed" });

    expect(await createPostgresPushIntents(db).settleStale()).toBe(1);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "cancelled",
      refusalCode: "turn_finalized_without_pin",
    });
  });

  test("a resume whose launch is given up keeps the carrying turn queued, and the push waits with it", async () => {
    const { sessionId, carriedId } = await carriedPush(true);
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
    await giveUpLaunch(sessionId);
    // The resume failed for an operator to decide; the input it would run
    // is kept for whatever that decision resumes.
    expect((await sessionRow(sessionId)).admissionState).not.toBe("resuming");
    const [carried] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.id, carriedId));
    expect(carried?.status).toBe("queued");

    expect(await createPostgresPushIntents(db).settleStale()).toBe(0);
    expect(await intentOf(sessionId)).toMatchObject({
      status: "deferred",
      turnId: carriedId,
      refusalCode: null,
    });
  });

  // Turn 1 drain-parked and left open, then turn 2 parked behind it by the
  // system, both groups waiting.
  async function twoParks() {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker);
    const firstTurn = await parkRows(worker, [first]);
    await executionGone(worker);
    await followUp(owner, sessionId);
    const later = await claim(sessionId);
    const second = await register(later.worker, HASH_B);
    const secondTurn = await parkRows(later.worker, [second]);
    await executionGone(later.worker);
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        status: "idle",
        pauseReason: "awaiting_input",
      })
      .where(eq(sessions.id, sessionId));
    return { owner, sessionId, first, firstTurn, second, secondTurn };
  }

  test("an answer to an earlier drain park carries it on while a later park still waits", async () => {
    const { owner, sessionId, first, firstTurn, second, secondTurn } =
      await twoParks();

    expect(await answer(owner, sessionId, first)).toMatchObject({
      resumed: false,
      waiting_for: 1,
    });
    expect(await continuations(firstTurn)).toHaveLength(1);
    expect((await sessionRow(sessionId)).admissionState).toBe("paused");

    expect(await answer(owner, sessionId, second)).toMatchObject({
      resumed: true,
      waiting_for: 0,
    });
    expect(await continuations(secondTurn)).toHaveLength(1);
    expect(await continuations(firstTurn)).toHaveLength(1);
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
  });

  test("interrupting the park still waiting lifts the pause for the one already carried on", async () => {
    const { owner, sessionId, first, firstTurn } = await twoParks();
    await answer(owner, sessionId, first);
    expect((await sessionRow(sessionId)).admissionState).toBe("paused");

    const interrupt = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "2",
    });
    expect(interrupt.outcome).toBe("accepted");
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
    const [carried] = await continuations(firstTurn);
    expect((await claim(sessionId)).input.turn_id).toBe(
      String(carried?.sequence),
    );
  });

  test("interrupting a park that already expired still lifts the pause", async () => {
    const { owner, sessionId, first, firstTurn, second } = await twoParks();
    await answer(owner, sessionId, first);
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(pendingRequests.requestId, second));
    await expireParkedGroups(db, { limit: 1_000, dryRun: false });
    expect((await request(second)).settledOutcome).toBe("expired");
    expect((await sessionRow(sessionId)).admissionState).toBe("paused");

    const interrupt = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "2",
    });
    expect(interrupt.outcome).toBe("accepted");
    expect((await request(second)).settledOutcome).toBe("cancelled");
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
    expect(await continuations(firstTurn)).toHaveLength(1);
  });

  test("a drain park whose requests all expired carries on with the denials", async () => {
    const { sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const turnRowId = await parkRows(worker, [requestId]);
    await executionGone(worker);
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(pendingRequests.requestId, requestId));

    await expireParkedGroups(db, { limit: 1_000, dryRun: false });
    const [carried] = await continuations(turnRowId);
    expect(carried?.message).toContain("nobody answered");
    expect((await sessionRow(sessionId)).admissionState).toBe("active");
  });

  test("an answer while the park drains is only stored; the drain's end carries the turn on", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await openPark(owner, sessionId);
    const turnRowId = await parkRows(worker, [requestId]);
    expect(await answer(owner, sessionId, requestId)).toMatchObject({
      resumed: false,
      waiting_for: 0,
    });
    expect(await continuations(turnRowId)).toEqual([]);

    await executionGone(worker);
    expect(await continuations(turnRowId)).toHaveLength(1);
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
  });

  test("under a person's pause an answer is only stored, and their resume waits for every answer", async () => {
    const { owner, sessionId, requestIds, turnRowId } = await parked(2);
    const [first = "", second = ""] = requestIds;
    const taken = await controls().pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: (await sessionRow(sessionId)).revision,
      reason: "mine now",
      now: new Date(),
    });
    expect(taken.outcome).toBe("accepted");

    expect(await answer(owner, sessionId, first)).toMatchObject({
      resumed: false,
      waiting_for: 1,
    });
    expect(await resumeBy(owner, sessionId)).toEqual({
      outcome: "pending_requests_open",
      waitingFor: 1,
    });
    expect(await answer(owner, sessionId, second)).toMatchObject({
      resumed: false,
      waiting_for: 0,
    });
    expect(await continuations(turnRowId)).toEqual([]);
    expect((await sessionRow(sessionId)).admissionState).toBe("paused");

    expect((await resumeBy(owner, sessionId)).outcome).toBe("accepted");
    expect(await continuations(turnRowId)).toHaveLength(1);
    expect((await sessionRow(sessionId)).admissionState).toBe("resuming");
  });

  test("expiry carries a group on when another of its requests was answered, and leaves an all-expired one paused", async () => {
    const lapse = (requestId: string) =>
      db
        .update(pendingRequests)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(pendingRequests.requestId, requestId));

    const mixed = await parked(2);
    const [answered = "", lapsed = ""] = mixed.requestIds;
    await answer(mixed.owner, mixed.sessionId, answered);
    await lapse(lapsed);
    expect(
      await expireParkedGroups(db, { limit: 1_000, dryRun: false }),
    ).toContain(mixed.sessionId);
    expect((await request(lapsed)).settledOutcome).toBe("expired");
    const [carried] = await continuations(mixed.turnRowId);
    expect(carried?.message).toContain("Bash call: allowed");
    expect(carried?.message).toContain(
      "Bash call: nobody answered before it expired, so it is denied.",
    );
    expect((await sessionRow(mixed.sessionId)).admissionState).toBe("resuming");

    const silent = await parked();
    await lapse(silent.requestId);
    expect(
      await expireParkedGroups(db, { limit: 1_000, dryRun: true }),
    ).toContain(silent.sessionId);
    expect((await request(silent.requestId)).settledOutcome).toBeNull();
    await expireParkedGroups(db, { limit: 1_000, dryRun: false });
    expect((await request(silent.requestId)).settledOutcome).toBe("expired");
    expect(await continuations(silent.turnRowId)).toEqual([]);
    expect(await sessionRow(silent.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: "awaiting_input",
    });
    expect((await systemEvents(silent.sessionId)).at(-1)?.payload).toEqual({
      type: "system",
      subtype: "input_wait",
      stage: "expired",
      request_ids: [silent.requestId],
    });
    // A person carries it on, the turn told nobody answered.
    expect((await resumeBy(silent.owner, silent.sessionId)).outcome).toBe(
      "accepted",
    );
    const [told] = await continuations(silent.turnRowId);
    expect(told?.message).toContain("nobody answered before it expired");
    expect(
      await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.sessionId, silent.sessionId)),
    ).toEqual([]);
  });

  test("request_park pauses the session for input once, and only for a turn a person must end", async () => {
    const { sessionId, worker } = await runningSession();
    const parkOf = (who: Worker, turnId = who.scope.turn_id) =>
      gateway.requestPark(who.principal, { ...who.scope, turn_id: turnId });
    const status = (work: Promise<unknown>) =>
      work.then(
        () => null,
        (error) =>
          error instanceof WorkerGatewayError ? error.status : Number.NaN,
      );

    // Nothing open to wait on.
    expect(await status(parkOf(worker))).toBe(409);
    expect(await status(parkOf(worker, "99"))).toBe(404);

    await register(worker);
    const opened = await parkOf(worker);
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: "awaiting_input",
    });
    expect(await receipt(opened.pause_control_id)).toMatchObject({
      operation: "pause",
      status: "accepted",
      actor: null,
    });
    // A resent request is the same park.
    expect(await parkOf(worker)).toEqual(opened);
    expect((await poll(worker)).control).toMatchObject({
      control_id: opened.pause_control_id,
      kind: "park",
    });
  });

  test("retry_restore of a parked session reports it waiting for input", async () => {
    const { owner, sessionId, requestId } = await parked();
    // Its restores kept failing.
    await db
      .update(sessions)
      .set({
        admissionState: "recovery_required",
        status: "failed",
        restoreFailureCount: 100,
      })
      .where(eq(sessions.id, sessionId));
    const decided = await controls().decideRecoveryAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "retry_restore",
        expected_revision: (await sessionRow(sessionId)).revision,
        reason: "try again",
      },
      now: new Date(),
    });
    expect(decided.outcome).toBe("accepted");
    expect((await request(requestId)).resolvedAt).toBeNull();
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({ phase: "needs_input" });
    expect((await reads(owner, sessionId)).status).toBe("needs_input");
  });
  test("an attempt that claimed before a grant existed goes, and the next claim carries it", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const turnRowId = await parkRows(worker, [requestId]);
    await executionGone(worker);
    // Another worker is already up on the drain-parked session when the
    // answer comes, launched for a follow-up message.
    expect((await followUp(owner, sessionId)).outcome).toBe("accepted");
    const early = await claimOnly(sessionId);
    expect(early.claimed.grants).toBeUndefined();
    expect(await answer(owner, sessionId, requestId)).toMatchObject({
      resumed: true,
    });
    const [carried] = await continuations(turnRowId);
    const followed = await gateway.nextInput(early.principal, early.scope);
    expect(followed.input?.turn_id).toBe("2");
    await completed({
      principal: early.principal,
      scope: { ...early.scope, turn_id: "2" },
      executionId: early.executionId,
    });

    expect(await gateway.nextInput(early.principal, early.scope)).toMatchObject(
      { input: null, draining: true },
    );
    // Nothing was handed over: the carrying turn waits.
    const [waiting] = await continuations(turnRowId);
    expect(waiting?.status).toBe("queued");
    await executionGone({ ...worker, executionId: early.executionId });

    const next = await claim(sessionId);
    expect(next.claimed.grants).toEqual([
      expect.objectContaining({
        request_id: requestId,
        turn_id: String(carried?.sequence),
      }),
    ]);
    expect(next.input.turn_id).toBe(String(carried?.sequence));
  });

  test("an allow the gone execution never reported on ends unknown", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await parkRows(worker, [requestId]);
    await executionGone(worker);
    const answered = await answer(owner, sessionId, requestId);
    const next = await claim(sessionId);

    await executionGone(next.worker);
    expect(await request(requestId)).toMatchObject({
      settledOutcome: "lost",
    });
    expect(await receipt(answered.receipt_id)).toMatchObject({
      status: "unknown",
      error: { code: "REQUEST_STALE" },
    });
  });
});
