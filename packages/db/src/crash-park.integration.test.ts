import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  createWorkerGateway,
  type SessionCatalog,
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
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readPointerRuntime } from "./checkpoints/checkpoint-runtime.ts";
import { createPostgresWorkerPendingStore } from "./decision/pending-control.ts";
import { createPostgresPendingRequests } from "./decision/pending-requests.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  achievementJudgments,
  approvalCheckpoints,
  checkpoints,
  pendingRequests,
  permissionGrants,
  sessions,
  turnContinuations,
  turns,
  unassignedSessions,
  workspaces,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUNTIME = {
  cliVersion: "2.1.270",
  engine: "claude-agent-sdk",
  profileSha256: "c".repeat(64),
  sdkVersion: "0.3.270",
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

type Worker = {
  principal: WorkerPrincipal;
  scope: WorkerScope & { turn_id: string };
  executionId: string;
};

// A worker killed while its turn waits on an approval (design §6.2 E2): no
// finalize, no release; only the execution observed gone.
integration("crash park on an approval-wait checkpoint", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let service: ReturnType<typeof createPendingRequestService>;
  let rejectCheckpoints = false;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "crash_park_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return rejectCheckpoints
            ? { status: "rejected", reason: "manifest missing" }
            : { status: "verified", transcriptBytes: 10, runtime: RUNTIME };
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

  async function runningSession(ownerId = `owner-${crypto.randomUUID()}`) {
    const partition = `crash-park-${crypto.randomUUID()}`;
    const owner = testCaller(ownerId);
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
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
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    return { owner, sessionId, worker: await claim(sessionId) };
  }

  async function claim(sessionId: string): Promise<Worker> {
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
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
    const next = await gateway.nextInput(principal, scope);
    if (!next.input) throw new Error("no input delivered");
    return {
      principal,
      scope: { ...scope, turn_id: next.input.turn_id },
      executionId,
    };
  }

  function checkpointOf(
    worker: Worker,
    options: { revision?: number; answersThrough?: number } = {},
  ): NonNullable<RegisterPendingRequest["checkpoint"]> {
    const revision = options.revision ?? 0;
    return {
      revision,
      manifest_ref: `sessions/${worker.scope.session_id}/checkpoints/${String(revision).padStart(10, "0")}/${worker.scope.attempt_id}/${crypto.randomUUID().replaceAll("-", "")}/manifest.json`,
      manifest_sha256: "c".repeat(64),
      answers_through: options.answersThrough ?? 0,
    };
  }

  async function register(
    worker: Worker,
    options: {
      inputHash?: string;
      checkpoint?: RegisterPendingRequest["checkpoint"];
      requestId?: string;
    } = {},
  ) {
    const requestId = options.requestId ?? `req_${crypto.randomUUID()}`;
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      request_id: requestId,
      input_hash: options.inputHash ?? HASH_A,
      request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
      announce: { tool_use_id: `toolu_${requestId}`, tool: "Bash" },
      ...(options.checkpoint === undefined
        ? {}
        : { checkpoint: options.checkpoint }),
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

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw new Error(`no session ${sessionId}`);
    return row;
  }

  async function turnRow(worker: Worker) {
    const [row] = await db
      .select()
      .from(turns)
      .where(eq(turns.attemptId, worker.scope.attempt_id));
    if (!row) throw new Error("no turn");
    return row;
  }

  async function continuation(parkedTurnId: number) {
    const [row] = await db
      .select({ id: turns.id, status: turns.status, message: turns.message })
      .from(turnContinuations)
      .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
      .where(eq(turnContinuations.parkedTurnId, parkedTurnId));
    return row;
  }

  async function expectUnknown(sessionId: string, worker: Worker) {
    expect((await turnRow(worker)).status).toBe("outcome_unknown");
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "recovery_required",
      checkpointRevision: null,
    });
  }

  test("the killed worker's wait parks on its checkpoint, which becomes the pointer", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const checkpoint = checkpointOf(worker);
    const requestId = await register(worker, { checkpoint });
    expect((await request(requestId)).checkpointRef).toBe(
      checkpoint.manifest_ref,
    );

    await executionGone(worker);

    const turn = await turnRow(worker);
    expect(turn).toMatchObject({
      status: "interrupted",
      terminalReason: "input_wait_parked",
      outcomeUnknown: false,
    });
    expect(await request(requestId)).toMatchObject({
      resolvedAt: null,
      settledAt: null,
    });
    expect((await request(requestId)).parkedAt).not.toBeNull();
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "active",
      status: "idle",
      checkpointRevision: 0,
    });
    expect(
      await db
        .select({
          manifestRef: checkpoints.manifestRef,
          turnId: checkpoints.turnId,
          transcriptBytes: checkpoints.transcriptBytes,
        })
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId)),
    ).toEqual([
      {
        manifestRef: checkpoint.manifest_ref,
        turnId: turn.id,
        transcriptBytes: 10,
      },
    ]);
    // The runtime verified at registration travels with the promotion.
    expect(await readPointerRuntime(db, sessionId)).toEqual(RUNTIME);
    expect(await sessionRow(sessionId)).toMatchObject({
      runtimeEngine: RUNTIME.engine,
      runtimeSdkVersion: RUNTIME.sdkVersion,
      runtimeCliVersion: RUNTIME.cliVersion,
      runtimeProfileSha256: RUNTIME.profileSha256,
    });
    const [stored] = await db
      .select()
      .from(approvalCheckpoints)
      .where(eq(approvalCheckpoints.manifestRef, checkpoint.manifest_ref));
    expect(stored?.promotedAt).not.toBeNull();
    // What clients read: the turn names the revision it parked on, and the
    // request is still there to answer.
    const reader = createPostgresSessionReader(db);
    expect(
      (await reader.getTurn(owner.ownerId, sessionId, String(turn.sequence)))
        ?.checkpoint_revision,
    ).toBe(0);
    expect((await reader.getSession(owner.ownerId, sessionId))?.status).toBe(
      "needs_input",
    );

    const answered = await answer(owner, sessionId, requestId);
    expect(answered).toMatchObject({ resumed: true, waiting_for: 0 });
    expect((await continuation(turn.id))?.message).toContain(
      "Bash call: allowed",
    );
    expect(
      await db
        .select({ requestId: permissionGrants.requestId })
        .from(permissionGrants)
        .where(eq(permissionGrants.sessionId, sessionId)),
    ).toEqual([{ requestId }]);
    // The next worker restores the promoted checkpoint.
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
    expect(claimed.restore?.manifest_ref).toBe(checkpoint.manifest_ref);
  });

  test("the promotion queues an achievement judgment, as a finalize's checkpoint does", async () => {
    const workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `crash-park-${workspaceId.slice(0, 8)}`,
      name: "crash park",
    });
    const { sessionId, worker } = await runningSession(workspaceId);
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, sessionId));
    await register(worker, { checkpoint: checkpointOf(worker) });
    const queued = () =>
      db
        .select({ status: achievementJudgments.status })
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId));
    expect(await queued()).toEqual([]);

    await executionGone(worker);

    expect((await sessionRow(sessionId)).checkpointRevision).toBe(0);
    expect(await queued()).toEqual([{ status: "queued" }]);
  });

  test("an answer given but never delivered parks with the request and carries the turn on", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker, {
      checkpoint: checkpointOf(worker),
    });
    const answered = await answer(owner, sessionId, requestId);

    await executionGone(worker);

    const turn = await turnRow(worker);
    expect(turn.status).toBe("interrupted");
    const row = await request(requestId);
    expect(row.parkedAt).not.toBeNull();
    expect(row.settledOutcome).toBeNull();
    expect(row.answer).toMatchObject({ decision: "allow" });
    expect(answered.receipt_id).toBeDefined();
    expect((await continuation(turn.id))?.status).toBe("queued");
    expect(
      await db
        .select({ sessionId: unassignedSessions.sessionId })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toEqual([{ sessionId }]);
  });

  test("a later checkpoint of the turn takes over every request still waiting", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await register(worker, {
      checkpoint: checkpointOf(worker),
      inputHash: HASH_A,
    });
    const later = checkpointOf(worker);
    const second = await register(worker, {
      checkpoint: later,
      inputHash: HASH_B,
    });
    expect((await request(first)).checkpointRef).toBe(later.manifest_ref);
    // A lost response's retry is still the same registration.
    await register(worker, {
      requestId: first,
      checkpoint: checkpointOf(worker),
      inputHash: HASH_A,
    });

    await executionGone(worker);

    expect((await request(first)).parkedAt).not.toBeNull();
    expect((await request(second)).parkedAt).not.toBeNull();
    const [pointer] = await db
      .select({ manifestRef: checkpoints.manifestRef })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId));
    expect(pointer?.manifestRef).toBe(later.manifest_ref);
  });

  test("a tool admitted after the checkpoint leaves the turn unknown", async () => {
    const { sessionId, worker } = await runningSession();
    const checkpoint = checkpointOf(worker);
    await register(worker, { checkpoint });
    expect(
      await gateway.invalidateApprovalCheckpoint(worker.principal, {
        ...worker.scope,
        manifest_ref: checkpoint.manifest_ref,
      }),
    ).toEqual({ invalidated: true });
    expect(
      await gateway.invalidateApprovalCheckpoint(worker.principal, {
        ...worker.scope,
        manifest_ref: "sessions/none/manifest.json",
      }),
    ).toEqual({ invalidated: false });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("an invalidation that lands before its registration still voids the checkpoint", async () => {
    const { sessionId, worker } = await runningSession();
    const checkpoint = checkpointOf(worker);
    // The registration's first send failed in flight; the next tool was
    // admitted, and only then did a retry of it commit.
    expect(
      await gateway.invalidateApprovalCheckpoint(worker.principal, {
        ...worker.scope,
        manifest_ref: checkpoint.manifest_ref,
      }),
    ).toEqual({ invalidated: false });
    await register(worker, { checkpoint });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("another session's invalidation of the same ref does not stand in for this one's", async () => {
    const other = await runningSession();
    const { sessionId, worker } = await runningSession();
    const checkpoint = checkpointOf(worker);
    for (const caller of [other.worker, worker]) {
      await gateway.invalidateApprovalCheckpoint(caller.principal, {
        ...caller.scope,
        manifest_ref: checkpoint.manifest_ref,
      });
    }
    await register(worker, { checkpoint });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("an answer delivered past what the worker had applied at the capture leaves the turn unknown", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker, {
      checkpoint: checkpointOf(worker, { answersThrough: 0 }),
    });
    await answer(owner, sessionId, requestId);
    const polled = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled: [],
    });
    expect(polled.answers).toHaveLength(1);
    expect((await request(requestId)).deliveredAt).not.toBeNull();

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("an answer delivered and applied after the capture leaves the turn unknown", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker, {
      checkpoint: checkpointOf(worker),
      inputHash: HASH_A,
    });
    await register(worker, {
      checkpoint: checkpointOf(worker, { answersThrough: 0 }),
      inputHash: HASH_B,
    });
    await answer(owner, sessionId, first);
    const polled = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled: [],
    });
    const [delivered] = polled.answers;
    if (delivered === undefined) throw new Error("no answer delivered");
    await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: delivered.sequence,
      settled: [{ request_id: first, outcome: "answered" }],
    });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("a delivered answer the worker never settled leaves the turn unknown", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const applied = await register(worker, { inputHash: HASH_A });
    await answer(owner, sessionId, applied);
    const polled = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled: [],
    });
    const [delivered] = polled.answers;
    if (delivered === undefined) throw new Error("no answer delivered");
    await register(worker, {
      checkpoint: checkpointOf(worker, { answersThrough: delivered.sequence }),
      inputHash: HASH_B,
    });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("a delivery the checkpoint already accounts for does not hold it back", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const applied = await register(worker, { inputHash: HASH_A });
    await answer(owner, sessionId, applied);
    const polled = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled: [],
    });
    const [delivered] = polled.answers;
    if (delivered === undefined) throw new Error("no answer delivered");
    await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: delivered.sequence,
      settled: [{ request_id: applied, outcome: "answered" }],
    });
    const waiting = await register(worker, {
      checkpoint: checkpointOf(worker, { answersThrough: delivered.sequence }),
      inputHash: HASH_B,
    });

    await executionGone(worker);

    expect((await turnRow(worker)).status).toBe("interrupted");
    expect((await request(waiting)).parkedAt).not.toBeNull();
    expect((await request(applied)).parkedAt).toBeNull();
  });

  test("a request registered without a checkpoint leaves the turn unknown", async () => {
    const { sessionId, worker } = await runningSession();
    await register(worker, { checkpoint: checkpointOf(worker) });
    // Its capture ran past the deadline: no checkpoint covers this one.
    await register(worker, { inputHash: HASH_B });

    await executionGone(worker);
    await expectUnknown(sessionId, worker);
  });

  test("a checkpoint the pointer has moved past leaves the turn unknown", async () => {
    const { sessionId, worker } = await runningSession();
    await register(worker, { checkpoint: checkpointOf(worker) });
    // A commit after the capture took the revision it was taken for.
    const turn = await turnRow(worker);
    await db.insert(checkpoints).values({
      sessionId,
      revision: 0,
      manifestRef: `sessions/${sessionId}/turn-end/manifest.json`,
      manifestSha256: "d".repeat(64),
      turnId: turn.id,
    });
    await db
      .update(sessions)
      .set({ checkpointRevision: 0 })
      .where(eq(sessions.id, sessionId));

    await executionGone(worker);

    expect((await turnRow(worker)).status).toBe("outcome_unknown");
    expect((await sessionRow(sessionId)).checkpointRevision).toBe(0);
  });

  test("a checkpoint that does not verify is refused and nothing is registered", async () => {
    const { worker } = await runningSession();
    rejectCheckpoints = true;
    try {
      const requestId = `req_${crypto.randomUUID()}`;
      const refused = await register(worker, {
        requestId,
        checkpoint: checkpointOf(worker),
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(WorkerGatewayError);
      expect((refused as WorkerGatewayError).code).toBe(
        "CHECKPOINT_UNAVAILABLE",
      );
      expect(
        await db
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.requestId, requestId)),
      ).toEqual([]);
    } finally {
      rejectCheckpoints = false;
    }
  });
});
