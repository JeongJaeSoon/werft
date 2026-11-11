import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor, WorkerScope } from "@werft-ai/contracts";
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
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushIntents } from "./action/push-intents.ts";
import { createPostgresCheckpointStore } from "./checkpoints/checkpoint-store.ts";
import { createPostgresWorkerPendingStore } from "./decision/pending-control.ts";
import { createPostgresGitHubMcpStore } from "./mcp-egress.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  pushIntents,
  pushRequests,
  receipts,
  sessions,
  unassignedSessions,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};

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

// A turn's end settles the intents it left deferred, and a pinned intent
// keeps its revision out of the checkpoint collector's reach.
integration("push intents at finalize and in the keep set", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_intent_final_it" });
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

  async function runningTurn() {
    const partition = `push-intent-${crypto.randomUUID()}`;
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
      message: "commit a file and push it",
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
    const rowId = await createPostgresGitHubMcpStore(db).runningTurn({
      sessionId,
      attemptId: worker.scope.attempt_id,
    });
    if (rowId === null) throw new Error("no running turn");
    return { ownerId, sessionId, worker, turnId: next.input.turn_id, rowId };
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
      terminal: { status, reason: null, result: null, usage: null },
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

  const ask = (t: Awaited<ReturnType<typeof runningTurn>>) =>
    createPostgresPushIntents(db).createDeferred({
      ownerId: t.ownerId,
      sessionId: t.sessionId,
      turnId: t.rowId,
      attemptId: t.worker.scope.attempt_id,
      repositoryId: "sample-app",
      targetBranch: `agent/${t.sessionId}`,
      actor: ACTOR,
      pushClass: "push.primary",
      policySource: "agent",
    });

  const intentOf = async (sessionId: string) => {
    const [row] = await db
      .select()
      .from(pushIntents)
      .where(eq(pushIntents.sessionId, sessionId));
    if (!row) throw new Error("no intent");
    return row;
  };

  test("a turn that completes with a checkpoint pins that revision on its intent", async () => {
    const t = await runningTurn();
    expect((await ask(t)).outcome).toBe("created");
    await finalize(t.worker, t.turnId, 0);
    expect(await intentOf(t.sessionId)).toMatchObject({
      status: "pinned",
      pinnedRevision: 0,
      refusalCode: null,
    });
  });

  test("a failed turn cancels its intent, whatever checkpoint it left", async () => {
    const t = await runningTurn();
    await ask(t);
    await finalize(t.worker, t.turnId, 0, "failed");
    expect(await intentOf(t.sessionId)).toMatchObject({
      status: "cancelled",
      refusalCode: "turn_ended_without_checkpoint",
      pinnedRevision: null,
    });
  });

  test("a turn that completes without a checkpoint cancels its intent", async () => {
    const t = await runningTurn();
    await ask(t);
    await finalize(t.worker, t.turnId, null);
    expect(await intentOf(t.sessionId)).toMatchObject({
      status: "cancelled",
      refusalCode: "turn_ended_without_checkpoint",
    });
  });

  test("an intent asked after the turn ended is refused, not left deferred", async () => {
    const t = await runningTurn();
    await finalize(t.worker, t.turnId, 0);
    expect(await ask(t)).toEqual({ outcome: "turn_not_running" });
  });

  test("a pinned revision stays in the keep set and blocks the closed-session settle", async () => {
    const t = await runningTurn();
    await ask(t);
    await finalize(t.worker, t.turnId, 0);
    const checkpoints = createPostgresCheckpointStore(db);
    expect(await checkpoints.readPushPinnedRevisions(t.sessionId)).toEqual([0]);

    await db
      .update(sessions)
      .set({
        admissionState: "closed",
        updatedAt: sql`now() - interval '2 days'`,
      })
      .where(eq(sessions.id, t.sessionId));
    expect(await checkpoints.settleCollection(t.sessionId)).toBe(false);

    await db
      .update(pushIntents)
      .set({
        status: "cancelled",
        refusalCode: "session_closed",
        settledAt: new Date(),
      })
      .where(eq(pushIntents.sessionId, t.sessionId));
    expect(await checkpoints.readPushPinnedRevisions(t.sessionId)).toEqual([]);
    expect(await checkpoints.settleCollection(t.sessionId)).toBe(true);
  });

  test("a snapshot never misses the revision while the intent becomes a request", async () => {
    const t = await runningTurn();
    await ask(t);
    await finalize(t.worker, t.turnId, 0);
    const checkpoints = createPostgresCheckpointStore(db);
    const intent = await intentOf(t.sessionId);
    const receiptId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inTransaction: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      inTransaction = resolve;
    });
    // The transition: the request row and the intent's `requested` commit
    // together. A read in the middle sees the intent, one after sees the
    // request; neither sees nothing.
    const transition = db.transaction(async (tx) => {
      await tx.insert(receipts).values({
        id: receiptId,
        ownerId: t.ownerId,
        operation: "request_push",
        targetRef: { session_id: t.sessionId, turn_id: null, request_id: null },
        status: "succeeded",
        result: {},
        actor: ACTOR,
      });
      await tx.insert(pushRequests).values({
        id: requestId,
        ownerId: t.ownerId,
        sessionId: t.sessionId,
        repositoryId: "sample-app",
        checkpointRevision: 0,
        gitCommit: "d".repeat(40),
        targetBranch: `agent/${t.sessionId}`,
        requestedBy: ACTOR,
        requestReceiptId: receiptId,
        origin: "intent",
        flow: "actions",
      });
      await tx
        .update(pushIntents)
        .set({ status: "requested", pushRequestId: requestId })
        .where(eq(pushIntents.id, intent.id));
      inTransaction();
      await gate;
    });
    await entered;
    expect(await checkpoints.readPushPinnedRevisions(t.sessionId)).toEqual([0]);
    release();
    await transition;
    expect(await checkpoints.readPushPinnedRevisions(t.sessionId)).toEqual([0]);
    expect((await intentOf(t.sessionId)).status).toBe("requested");
  });
});
