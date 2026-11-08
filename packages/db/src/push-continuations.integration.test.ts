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
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubMcpStore } from "./mcp-egress.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { PUSH_CONTINUATION_MESSAGE } from "./push-continuations.ts";
import * as schema from "./schema.ts";
import {
  pushContinuations,
  sessions,
  turns,
  unassignedSessions,
  users,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
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
      permission_mode: "auto",
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

// 94S-1243: a turn whose request_push came before the first checkpoint gets
// one platform turn after it, without a person sending another message.
integration("push continuations on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_continuation_it" });
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

  type Worker = { principal: WorkerPrincipal; scope: WorkerScope };

  const limits = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

  async function runningTurn(): Promise<{
    ownerId: string;
    sessionId: string;
    worker: Worker;
    turnId: string;
  }> {
    const partition = `push-continuation-${crypto.randomUUID()}`;
    const ownerId = `owner-${crypto.randomUUID()}`;
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits,
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "make a file and open a pull request",
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
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
    const worker: Worker = {
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
    const next = await gateway.nextInput(worker.principal, worker.scope);
    if (!next.input) throw new Error("no input delivered");
    return { ownerId, sessionId, worker, turnId: next.input.turn_id };
  }

  function finalize(
    worker: Worker,
    turnId: string,
    checkpointRevision: number | null,
    status: "completed" | "failed" = "completed",
  ) {
    return gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: turnId,
      finalize_key: `${worker.scope.attempt_id}:${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint:
        checkpointRevision === null
          ? null
          : {
              revision: checkpointRevision,
              manifest_ref: `manifests/${worker.scope.session_id}/${checkpointRevision}`,
              manifest_sha256: "c".repeat(64),
            },
    });
  }

  const store = {
    runningTurn: (input: { sessionId: string; attemptId: string }) =>
      createPostgresGitHubMcpStore(db).runningTurn(input),
    markPushContinuation: (input: { sessionId: string; turnId: number }) =>
      createPostgresGitHubMcpStore(db).markPushContinuation(input),
  };
  const turnAtCall = async (sessionId: string, worker: Worker) => {
    const turnId = await store.runningTurn({
      sessionId,
      attemptId: worker.scope.attempt_id,
    });
    if (turnId === null) throw new Error("no running turn");
    return turnId;
  };
  const mark = async (sessionId: string, worker: Worker) => {
    const turnId = await store.runningTurn({
      sessionId,
      attemptId: worker.scope.attempt_id,
    });
    return turnId !== null && store.markPushContinuation({ sessionId, turnId });
  };

  const turnsOf = (sessionId: string) =>
    db
      .select({
        sequence: turns.sequence,
        status: turns.status,
        message: turns.message,
        actorId: turns.actorId,
        channel: turns.channel,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));

  test("a marked turn that completes with a checkpoint queues one platform turn the worker then runs", async () => {
    const { sessionId, worker, turnId } = await runningTurn();
    const [asker] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: `${crypto.randomUUID()}@example.invalid`,
        passwordHash: "x",
        displayName: "asker",
      })
      .returning({ id: users.id });
    await db
      .update(turns)
      .set({ actorId: asker?.id ?? null })
      .where(eq(turns.sessionId, sessionId));
    expect(await mark(sessionId, worker)).toBe(true);
    // A second refusal in the same turn marks nothing new.
    expect(await mark(sessionId, worker)).toBe(true);

    await finalize(worker, turnId, 0);

    expect(await turnsOf(sessionId)).toEqual([
      {
        sequence: 1,
        status: "completed",
        message: "make a file and open a pull request",
        actorId: asker?.id ?? null,
        channel: null,
      },
      {
        sequence: 2,
        status: "queued",
        message: PUSH_CONTINUATION_MESSAGE,
        actorId: asker?.id ?? null,
        channel: null,
      },
    ]);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input?.turn_id).toBe("2");
    expect(next.input?.message).toBe(PUSH_CONTINUATION_MESSAGE);

    // The continuation is never marked itself, so it cannot chain.
    expect(await mark(sessionId, worker)).toBe(false);
    await finalize(worker, "2", 1);
    expect(await turnsOf(sessionId)).toHaveLength(2);
    expect(await db.select().from(pushContinuations)).toContainEqual({
      turnId: expect.any(Number),
      continuationTurnId: expect.any(Number),
    });
  });

  test("a marked turn that ends without a checkpoint queues nothing", async () => {
    const { sessionId, worker, turnId } = await runningTurn();
    expect(await mark(sessionId, worker)).toBe(true);
    await finalize(worker, turnId, null);
    expect(await turnsOf(sessionId)).toHaveLength(1);
  });

  test("an unmarked turn queues nothing", async () => {
    const { sessionId, worker, turnId } = await runningTurn();
    await finalize(worker, turnId, 0);
    expect(await turnsOf(sessionId)).toHaveLength(1);
  });

  test("a paused session keeps the mark unused", async () => {
    const { sessionId, worker, turnId } = await runningTurn();
    expect(await mark(sessionId, worker)).toBe(true);
    await db
      .update(sessions)
      .set({ admissionState: "pausing" })
      .where(eq(sessions.id, sessionId));
    await finalize(worker, turnId, 0);
    expect(await turnsOf(sessionId)).toHaveLength(1);
  });

  test("a marked turn that fails with a checkpoint queues nothing", async () => {
    const { sessionId, worker, turnId } = await runningTurn();
    expect(await mark(sessionId, worker)).toBe(true);
    await finalize(worker, turnId, 0, "failed");
    expect(await turnsOf(sessionId)).toHaveLength(1);
  });

  test("a person's input already waiting behind the marked turn takes its place", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    expect(await mark(sessionId, worker)).toBe(true);
    const appended = await createPostgresSessionUnitOfWork(
      db,
    ).appendInputAtomic({
      principal: { ownerId },
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "switch to another branch",
      limits,
    });
    expect(appended.outcome).toBe("accepted");
    await finalize(worker, turnId, 0);
    expect((await turnsOf(sessionId)).map((turn) => turn.message)).toEqual([
      "make a file and open a pull request",
      "switch to another branch",
    ]);
  });

  test("a mark that waits on a finalizing turn finds it ended", async () => {
    const { sessionId, worker } = await runningTurn();
    const turnId = await turnAtCall(sessionId, worker);
    let marked: Promise<boolean> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      marked = store.markPushContinuation({ sessionId, turnId });
      await Bun.sleep(300);
      await tx
        .update(turns)
        .set({ status: "completed" })
        .where(eq(turns.sessionId, sessionId));
    });
    expect(await marked).toBe(false);
    expect(
      await db
        .select()
        .from(pushContinuations)
        .where(eq(pushContinuations.turnId, turnId)),
    ).toEqual([]);
  });

  test("a refusal handled after its turn ended does not mark the next one", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const first = await turnAtCall(sessionId, worker);
    await finalize(worker, turnId, 0);
    const appended = await createPostgresSessionUnitOfWork(
      db,
    ).appendInputAtomic({
      principal: { ownerId },
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "now something else",
      limits,
    });
    expect(appended.outcome).toBe("accepted");
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input?.turn_id).toBe("2");

    expect(await store.markPushContinuation({ sessionId, turnId: first })).toBe(
      false,
    );
    await finalize(worker, "2", 1);
    expect(await turnsOf(sessionId)).toHaveLength(2);
  });
});
