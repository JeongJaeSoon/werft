import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  type SessionCatalog,
  WORKER_LEASE_LOST_END_REASON,
  WORKER_OWNERSHIP_LOST_REASON,
  type WorkerGateway,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { fromDbNow } from "./db-clock.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  events,
  executions,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { reconcileExpiredLeases } from "./sessions/lease-reconcile.ts";
import { createPostgresWorkerPendingStore } from "./sessions/pending-control.ts";
import { createPostgresPendingRequests } from "./sessions/pending-requests.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { launchSession } from "./testing/launches.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * A turn whose worker lost its lease (94S-2212). The turn fails with
 * `worker_ownership_lost` and the session stays, only when both halves are
 * there: the scheduler saw the worker exit as one that gave its lease up, and
 * that lease has run out. With either half missing nothing changes from
 * before: the turn is `outcome_unknown` and an operator decides.
 */

const OWNER = testCaller("00000000-0000-4000-8000-00000000000b");
const CATALOG: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { stored: "connection:test-connection" },
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
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

/** A session whose first turn a claimed worker is running. */
async function runningTurn() {
  const worker = await claimedSession(db, gateway, OWNER);
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  return { ...worker, attemptId: worker.scope.attempt_id };
}

/** Moves the lease's end on the database clock, which judges it. */
async function leaseEndsIn(attemptId: string, ms: number) {
  await db
    .update(attempts)
    .set({ leaseExpiresAt: fromDbNow(ms) })
    .where(eq(attempts.id, attemptId));
}

/** The scheduler's look at an execution it saw gone. */
function seenGone(executionId: string, endReason?: string) {
  return createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
    executionId,
    now: new Date(),
    ...(endReason === undefined ? {} : { endReason }),
  });
}

async function append(sessionId: string, message: string) {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message,
    limits: LIMITS,
  });
  expect(appended.outcome).toBe("accepted");
}

async function stateOf(sessionId: string) {
  const [session] = await db
    .select({
      admission: sessions.admissionState,
      status: sessions.status,
      executionId: sessions.executionId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const turnRows = await db
    .select({
      status: turns.status,
      reason: turns.terminalReason,
      unknown: turns.outcomeUnknown,
    })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(asc(turns.sequence));
  const [attempt] = await db
    .select({ state: attempts.state, endReason: attempts.endReason })
    .from(attempts)
    .where(eq(attempts.sessionId, sessionId));
  const [launch] = await db
    .select({ slotReleasedAt: workerLaunches.slotReleasedAt })
    .from(workerLaunches)
    .where(eq(workerLaunches.sessionId, sessionId));
  const receiptRows = await db
    .select({ status: receipts.status, error: receipts.error })
    .from(receipts);
  const queued = await db
    .select({ turnId: queueMessages.turnId })
    .from(queueMessages)
    .where(eq(queueMessages.sessionId, sessionId));
  const signals = await db
    .select({ sessionId: unassignedSessions.sessionId })
    .from(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, sessionId));
  return {
    session: {
      admission: session?.admission,
      status: session?.status,
      bound: session?.executionId != null,
    },
    turns: turnRows,
    attempt,
    slotReleased: launch?.slotReleasedAt != null,
    receipts: receiptRows.map((row) => ({
      status: row.status,
      code: (row.error as { code?: string } | null)?.code ?? null,
    })),
    queueRows: queued.length,
    signalled: signals.length > 0,
  };
}

async function statusEvents(sessionId: string) {
  const rows = await db
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.id));
  return rows
    .filter((row) => row.type === "status")
    .map((row) => row.payload as Record<string, unknown>);
}

const LOST_TURN = {
  status: "failed",
  reason: WORKER_OWNERSHIP_LOST_REASON,
  unknown: false,
};
const UNKNOWN_TURN = {
  status: "outcome_unknown",
  reason: "execution_gone",
  unknown: true,
};
const RELEASED = { sessionReleased: true, slotReleased: true };
const KEPT = { admission: "active", status: "idle", bound: false } as const;
const HELD = {
  admission: "recovery_required",
  status: "failed",
  bound: false,
} as const;

describe("a running turn whose execution is seen gone: the worker's word x its lease", () => {
  // Every combination of the two halves. Only the first takes the new path.
  const TABLE = [
    {
      word: true,
      lease: "expired",
      result: RELEASED,
      turn: LOST_TURN,
      session: KEPT,
      receipt: { status: "failed", code: "WORKER_OWNERSHIP_LOST" },
      attempt: { state: "lost", endReason: WORKER_LEASE_LOST_END_REASON },
    },
    {
      word: false,
      lease: "expired",
      result: RELEASED,
      turn: UNKNOWN_TURN,
      session: HELD,
      receipt: { status: "unknown", code: "RECOVERY_REQUIRED" },
      attempt: { state: "lost", endReason: "execution_gone" },
    },
    {
      word: false,
      lease: "live",
      result: RELEASED,
      turn: UNKNOWN_TURN,
      session: HELD,
      receipt: { status: "unknown", code: "RECOVERY_REQUIRED" },
      attempt: { state: "lost", endReason: "execution_gone" },
    },
  ] as const;

  for (const row of TABLE) {
    test(`word ${row.word ? "kept" : "absent"}, lease ${row.lease}: turn ${row.turn.status}, session ${row.session.admission}`, async () => {
      const worker = await runningTurn();
      await leaseEndsIn(
        worker.attemptId,
        row.lease === "expired" ? -1_000 : 60_000,
      );

      expect(
        await seenGone(
          worker.executionId,
          row.word ? WORKER_LEASE_LOST_END_REASON : undefined,
        ),
      ).toEqual(row.result);

      const after = await stateOf(worker.sessionId);
      expect(after.turns).toEqual([row.turn]);
      expect(after.session).toEqual(row.session);
      expect(after.receipts).toEqual([row.receipt]);
      expect(after.attempt).toEqual(row.attempt);
      expect(after.slotReleased).toBe(true);
      // A lost turn leaves the queue; an unknown one keeps its head.
      expect(after.queueRows).toBe(row.turn === LOST_TURN ? 0 : 1);
      // Nothing runs either turn again by itself.
      expect(after.signalled).toBe(false);
    });
  }

  test("word kept, lease live: nothing is settled, the word is recorded and the look is asked again", async () => {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, 60_000);
    const before = await stateOf(worker.sessionId);

    expect(
      await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON),
    ).toEqual({
      leasePending: true,
      sessionReleased: false,
      slotReleased: false,
    });

    const after = await stateOf(worker.sessionId);
    expect(after.attempt?.endReason).toBe(WORKER_LEASE_LOST_END_REASON);
    // Still an open attempt: only the word was added.
    expect(after.attempt?.state).toBe(before.attempt?.state);
    expect({ ...after, attempt: before.attempt }).toEqual(before);
    expect(after.session.bound).toBe(true);
    expect(after.slotReleased).toBe(false);
    expect(after.turns[0]?.status).not.toBe("failed");
    expect(after.turns[0]?.status).not.toBe("outcome_unknown");
  });
});

describe("after the word is recorded", () => {
  async function waiting() {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, 60_000);
    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);
    return worker;
  }

  test("a later look that no longer sees the exit code still waits while the lease is live", async () => {
    const worker = await waiting();
    expect(await seenGone(worker.executionId)).toEqual({
      leasePending: true,
      sessionReleased: false,
      slotReleased: false,
    });
    expect((await stateOf(worker.sessionId)).session.bound).toBe(true);
  });

  test("the look after the lease runs out fails the turn and keeps the session, from the record alone", async () => {
    const worker = await waiting();
    await leaseEndsIn(worker.attemptId, -1_000);

    expect(await seenGone(worker.executionId)).toEqual(RELEASED);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
    expect(after.attempt).toEqual({
      state: "lost",
      endReason: WORKER_LEASE_LOST_END_REASON,
    });
    expect(await statusEvents(worker.sessionId)).toContainEqual({
      phase: "idle",
      admission_state: "active",
      code: "WORKER_OWNERSHIP_LOST",
      message: expect.any(String),
      failed_turn_count: 1,
    });
  });

  test("the lease sweep ends the attempt without overwriting the word, and the kill's look takes the new path", async () => {
    const worker = await waiting();
    await leaseEndsIn(worker.attemptId, -1_000);

    const swept = await reconcileExpiredLeases(db, {});
    expect(swept.map((lease) => lease.action)).toEqual(["fenced"]);
    expect((await stateOf(worker.sessionId)).attempt).toEqual({
      state: "lost",
      endReason: WORKER_LEASE_LOST_END_REASON,
    });

    expect(await seenGone(worker.executionId)).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
  });

  test("a second look after the settle changes nothing and says nothing twice", async () => {
    const worker = await waiting();
    await leaseEndsIn(worker.attemptId, -1_000);
    await seenGone(worker.executionId);
    const settled = await stateOf(worker.sessionId);
    const said = await statusEvents(worker.sessionId);

    expect(await seenGone(worker.executionId)).toEqual({
      sessionReleased: false,
      slotReleased: false,
    });
    expect(await stateOf(worker.sessionId)).toEqual(settled);
    expect(await statusEvents(worker.sessionId)).toEqual(said);
  });
});

describe("a kill asked of the execution", () => {
  const killAsked = (executionId: string) =>
    db
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, executionId));

  test("is not held up by a live lease: the exit settles at once, the turn unknown as before", async () => {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, 60_000);
    await killAsked(worker.executionId);

    expect(
      await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON),
    ).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([UNKNOWN_TURN]);
    expect(after.session).toEqual(HELD);
  });

  test("by the lease sweep still takes the new path when its look carries the worker's word", async () => {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, -1_000);
    // The sweep ran before any pass saw the exit: no word on the attempt.
    await reconcileExpiredLeases(db, {});
    expect((await stateOf(worker.sessionId)).attempt).toEqual({
      state: "lost",
      endReason: "lease_expired",
    });

    expect(
      await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON),
    ).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
  });
});

describe("the word kept before the exited resource is removed", () => {
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionBudget: { costUsd: 1_000, tokens: null },
      connectForLock: async () => {
        throw new Error("not used");
      },
    });
  const kept = (worker: { executionId: string }) =>
    store().recordLeaseGivenUp({
      executionId: worker.executionId,
      generation: 1,
    });

  test("is enough for a later look that never saw the exit code", async () => {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, 60_000);
    await kept(worker);
    expect((await stateOf(worker.sessionId)).attempt?.endReason).toBe(
      WORKER_LEASE_LOST_END_REASON,
    );

    // The pass died after the removal: the next one has only the record.
    expect(await seenGone(worker.executionId)).toEqual({
      leasePending: true,
      sessionReleased: false,
      slotReleased: false,
    });
    await leaseEndsIn(worker.attemptId, -1_000);
    expect(await seenGone(worker.executionId)).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
  });

  test("goes over the sweep's lease_expired, and over nothing else", async () => {
    const swept = await runningTurn();
    await leaseEndsIn(swept.attemptId, -1_000);
    await reconcileExpiredLeases(db, {});
    await kept(swept);
    expect((await stateOf(swept.sessionId)).attempt).toEqual({
      state: "lost",
      endReason: WORKER_LEASE_LOST_END_REASON,
    });

    // An attempt that ended saying something else keeps what it said.
    const gone = await runningTurn();
    await seenGone(gone.executionId);
    await kept(gone);
    expect((await stateOf(gone.sessionId)).attempt).toEqual({
      state: "lost",
      endReason: "execution_gone",
    });
  });
});

describe("a lease that ran out with no word from the worker", () => {
  test("the sweep records lease_expired and the turn is unknown, as before", async () => {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, -1_000);

    await reconcileExpiredLeases(db, {});
    expect((await stateOf(worker.sessionId)).attempt).toEqual({
      state: "lost",
      endReason: "lease_expired",
    });

    expect(await seenGone(worker.executionId)).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([UNKNOWN_TURN]);
    expect(after.session).toEqual(HELD);
  });
});

describe("going on from a lost turn", () => {
  const goOn = (sessionId: string, turnId: number) =>
    createPostgresSessionUnitOfWork(db).appendInputAtomic({
      principal: { ...OWNER, requestId: crypto.randomUUID() },
      sessionId,
      // What the session service sends for the turn, whoever asks.
      idempotencyKey: `continue:${turnId}`,
      payloadHash: `continue:${turnId}`,
      message: "",
      continueTurn: turnId,
      limits: LIMITS,
    });

  async function lostTurn() {
    const worker = await runningTurn();
    await leaseEndsIn(worker.attemptId, -1_000);
    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);
    return worker;
  }

  test("asked twice, one queued turn with the lost turn's input is made, and the session is signalled", async () => {
    const worker = await lostTurn();

    const first = await goOn(worker.sessionId, 1);
    const second = await goOn(worker.sessionId, 1);

    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("replayed");
    expect(second).toMatchObject({
      response: (first as { response: unknown }).response,
    });
    const rows = await db
      .select({ sequence: turns.sequence, message: turns.message })
      .from(turns)
      .where(eq(turns.sessionId, worker.sessionId))
      .orderBy(asc(turns.sequence));
    expect(rows).toEqual([
      { sequence: 1, message: "first input" },
      { sequence: 2, message: "first input" },
    ]);
    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([
      LOST_TURN,
      { status: "queued", reason: null, unknown: false },
    ]);
    expect(after.signalled).toBe(true);
    expect(after.session.admission).toBe("active");
  });

  test("a turn that did not end as a lost one has nothing to go on from", async () => {
    // Running: not a lost turn. Unknown: the session waits on an operator
    // and takes no input at all.
    const worker = await runningTurn();
    expect((await goOn(worker.sessionId, 1)).outcome).toBe("not_found");
    await seenGone(worker.executionId);
    expect((await goOn(worker.sessionId, 1)).outcome).toBe("rejected");
    // Nor a turn the session never had.
    const lost = await lostTurn();
    expect((await goOn(lost.sessionId, 7)).outcome).toBe("not_found");
    expect((await stateOf(lost.sessionId)).turns).toEqual([LOST_TURN]);
  });
});

describe("a turn waiting on a person when its worker gives the lease up", () => {
  const RUNTIME = {
    cliVersion: "2.1.270",
    engine: "claude-agent-sdk",
    profileSha256: "c".repeat(64),
    sdkVersion: "0.3.270",
  };

  /** A turn with one open permission request bound to an approval-wait checkpoint. */
  async function waitingOnPerson() {
    const parking = testWorkerGateway(db, CATALOG, {
      pending: createPostgresWorkerPendingStore(db),
      checkpoints: {
        async verify() {
          return { status: "verified", transcriptBytes: 10, runtime: RUNTIME };
        },
      },
    });
    const worker = await claimedSession(db, parking, OWNER);
    const next = await parking.nextInput(worker.principal, worker.scope);
    if (!next.input) throw new Error("no input delivered");
    const scope = { ...worker.scope, turn_id: next.input.turn_id };
    const manifestRef = `sessions/${worker.sessionId}/checkpoints/0000000000/${scope.attempt_id}/${crypto.randomUUID().replaceAll("-", "")}/manifest.json`;
    const requestId = `req_${crypto.randomUUID()}`;
    await parking.registerPending(worker.principal, {
      ...scope,
      request_id: requestId,
      input_hash: "a".repeat(64),
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
      announce: { tool_use_id: `toolu_${requestId}`, tool: "Bash" },
      checkpoint: {
        revision: 0,
        manifest_ref: manifestRef,
        manifest_sha256: "c".repeat(64),
        answers_through: 0,
      },
    });
    return {
      ...worker,
      attemptId: scope.attempt_id,
      scope,
      parking,
      manifestRef,
      requestId,
    };
  }

  async function requestOf(requestId: string) {
    const [row] = await db
      .select({
        parkedAt: pendingRequests.parkedAt,
        resolvedAt: pendingRequests.resolvedAt,
      })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    return {
      parked: row?.parkedAt != null,
      closed: row?.resolvedAt != null,
    };
  }

  const PARKED_TURN = {
    status: "interrupted",
    reason: "input_wait_parked",
    unknown: false,
  };

  test("a checkpoint that still holds parks the turn, as before: nothing ran after it, and the answer goes on", async () => {
    const worker = await waitingOnPerson();
    await leaseEndsIn(worker.attemptId, -1_000);

    expect(
      await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON),
    ).toEqual(RELEASED);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([PARKED_TURN]);
    expect(after.session).toEqual(KEPT);
    // The card stays answerable; no receipt says the input failed.
    expect(await requestOf(worker.requestId)).toEqual({
      parked: true,
      closed: false,
    });
    expect(after.receipts.map((receipt) => receipt.code)).not.toContain(
      "WORKER_OWNERSHIP_LOST",
    );
  });

  test("a tool admitted after the checkpoint breaks it: the turn fails as lost and its request closes", async () => {
    const worker = await waitingOnPerson();
    await worker.parking.invalidateApprovalCheckpoint(worker.principal, {
      ...worker.scope,
      manifest_ref: worker.manifestRef,
    });
    await leaseEndsIn(worker.attemptId, -1_000);

    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
    expect(await requestOf(worker.requestId)).toEqual({
      parked: false,
      closed: true,
    });
  });

  test("an answer the worker took after the capture breaks it: the turn fails as lost", async () => {
    const worker = await waitingOnPerson();
    const answers = createPendingRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPendingRequests(db),
    });
    await answers.answer(OWNER, worker.sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body: {
        request_id: worker.requestId,
        kind: "permission",
        decision: "allow",
      },
    });
    const polled = await worker.parking.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled: [],
    });
    expect(polled.answers).toHaveLength(1);
    await leaseEndsIn(worker.attemptId, -1_000);

    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
  });

  test("an attempt the lease sweep already ended has no checkpoint to park on: the turn fails as lost", async () => {
    const worker = await waitingOnPerson();
    await leaseEndsIn(worker.attemptId, -1_000);
    await reconcileExpiredLeases(db, {});

    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([LOST_TURN]);
    expect(after.session).toEqual(KEPT);
  });
});

describe("the session after a lost turn", () => {
  test("input queued behind the lost turn is signalled, and the next worker gets it, never the lost turn", async () => {
    const worker = await runningTurn();
    await append(worker.sessionId, "second input");
    await leaseEndsIn(worker.attemptId, -1_000);

    await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON);

    const after = await stateOf(worker.sessionId);
    expect(after.turns).toEqual([
      LOST_TURN,
      { status: "queued", reason: null, unknown: false },
    ]);
    expect(after.session).toEqual({
      admission: "active",
      status: "queued",
      bound: false,
    });
    expect(after.signalled).toBe(true);

    // The claim's own context check passes: the lost turn is not a gap.
    const next = await launchSession(db, { sessionId: worker.sessionId });
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: next.executionId,
        execution_generation: next.generation,
        credential: { kind: "launch_nonce", nonce: next.nonce },
      },
    );
    const delivered = await gateway.nextInput(
      {
        kind: "session",
        attemptId: claimed.attempt_id,
        sessionId: claimed.session_id,
        leaseEpoch: claimed.lease_epoch,
        executionGeneration: claimed.execution_generation,
        authRevision: claimed.auth_revision,
      },
      {
        session_id: claimed.session_id,
        turn_id: null,
        attempt_id: claimed.attempt_id,
        lease_epoch: claimed.lease_epoch,
        execution_generation: claimed.execution_generation,
        auth_revision: claimed.auth_revision,
      },
    );
    expect(delivered.input?.turn_id).toBe("2");
    expect(delivered.input?.message).toBe("second input");
    expect((await stateOf(worker.sessionId)).session.admission).toBe("active");
  });

  test("a worker with no open turn that gave its lease up settles at once, lease live or not", async () => {
    const worker = await claimedSession(db, gateway, OWNER);
    await leaseEndsIn(worker.scope.attempt_id, 60_000);

    expect(
      await seenGone(worker.executionId, WORKER_LEASE_LOST_END_REASON),
    ).toEqual(RELEASED);
    const after = await stateOf(worker.sessionId);
    expect(after.session.bound).toBe(false);
    expect(after.session.admission).toBe("active");
    expect(after.turns).toEqual([
      { status: "queued", reason: null, unknown: false },
    ]);
  });
});
