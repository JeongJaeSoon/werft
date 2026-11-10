import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { holdPushFollowUp } from "./push-follow-ups.ts";
import * as schema from "./schema.ts";
import {
  pullRequests,
  pushFollowUps,
  pushIntents,
  pushRequests,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  users,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

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

// 94S-1269: a Slack push approval that lands while a turn runs waits for the
// turn to end, and becomes a turn only if no pull request was opened by then.
integration("push follow-ups on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_follow_up_it" });
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
    const partition = `push-follow-up-${crypto.randomUUID()}`;
    const ownerId = crypto.randomUUID();
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits,
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

  const MESSAGE = "Platform note: a person approved push request in Slack.";

  async function pushRequest(
    ownerId: string,
    sessionId: string,
    branch = `agent/${sessionId}`,
  ) {
    const receiptId = crypto.randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId,
      operation: "create_push_request",
      targetRef: { session_id: sessionId },
    });
    const id = crypto.randomUUID();
    await db.insert(pushRequests).values({
      id,
      ownerId,
      sessionId,
      repositoryId: "sample-app",
      checkpointRevision: 0,
      gitCommit: "a".repeat(40),
      targetBranch: branch,
      state: "requested",
      requestedBy: { kind: "user", id: "u" },
      requestReceiptId: receiptId,
    });
    return id;
  }

  const recordPullRequest = (
    ownerId: string,
    sessionId: string,
    pushRequestId: string | null,
    head = `agent/${sessionId}`,
  ) =>
    db.insert(pullRequests).values({
      sessionId,
      url: `https://github.invalid/pr/${crypto.randomUUID()}`,
      pushRequestId,
      ownerId,
      repositoryId: "sample-app",
      number: 1,
      head,
      base: "main",
    });

  const hold = (sessionId: string, pushRequestId: string) =>
    holdPushFollowUp(db, { sessionId, pushRequestId, message: MESSAGE });

  test("an approval while a turn runs waits for it, then queues one turn when no pull request was opened", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("held");
    expect(await hold(sessionId, push)).toBe("held");
    expect(await turnsOf(sessionId)).toHaveLength(1);

    await finalize(worker, turnId, 0);

    expect(
      (await turnsOf(sessionId)).map((t) => [t.status, t.message]),
    ).toEqual([
      ["completed", "make a file and open a pull request"],
      ["queued", MESSAGE],
    ]);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    expect(next.input?.message).toBe(MESSAGE);
    expect(await db.select().from(pushFollowUps)).toEqual([]);
  });

  test("the follow-up turn keeps the person who asked for the push as its actor", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
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
    const push = await pushRequest(ownerId, sessionId);
    const [asked] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    await db.insert(pushIntents).values({
      id: crypto.randomUUID(),
      ownerId,
      sessionId,
      turnId: asked?.id ?? 0,
      attemptId: worker.scope.attempt_id,
      repositoryId: "sample-app",
      targetBranch: `agent/${sessionId}`,
      status: "requested",
      pinnedRevision: 0,
      pushRequestId: push,
      actor: { kind: "user", id: "u" },
    });
    expect(await hold(sessionId, push)).toBe("held");

    await finalize(worker, turnId, 0);

    expect((await turnsOf(sessionId)).map((t) => t.actorId)).toEqual([
      asker?.id ?? null,
      asker?.id ?? null,
    ]);
  });

  test("a running turn that opens the pull request leaves no follow-up turn", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("held");
    await recordPullRequest(ownerId, sessionId, push);
    await finalize(worker, turnId, 0);
    expect(await turnsOf(sessionId)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(pushFollowUps)
        .where(eq(pushFollowUps.sessionId, sessionId)),
    ).toEqual([]);
  });

  test("one session, two pushes on two branches: each push is decided on its own, so two pull requests stay possible", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const first = await pushRequest(
      ownerId,
      sessionId,
      `agent/${sessionId}-first`,
    );
    const second = await pushRequest(
      ownerId,
      sessionId,
      `agent/${sessionId}-second`,
    );
    expect(await hold(sessionId, first)).toBe("held");
    const secondMessage = `${MESSAGE} (second)`;
    expect(
      await holdPushFollowUp(db, {
        sessionId,
        pushRequestId: second,
        message: secondMessage,
      }),
    ).toBe("held");
    // The running turn opens the first push's pull request only.
    await recordPullRequest(
      ownerId,
      sessionId,
      first,
      `agent/${sessionId}-first`,
    );
    expect(await hold(sessionId, first)).toBe("pull_request");
    await finalize(worker, turnId, 0);
    expect(
      (await turnsOf(sessionId)).slice(1).map((t) => [t.status, t.message]),
    ).toEqual([["queued", secondMessage]]);
    // The follow-up turn may open the second pull request; neither push
    // asks again after that.
    await recordPullRequest(
      ownerId,
      sessionId,
      second,
      `agent/${sessionId}-second`,
    );
    expect(await hold(sessionId, second)).toBe("pull_request");
    expect(
      await db
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.sessionId, sessionId)),
    ).toHaveLength(2);
  });

  test("a failed turn still decides the held follow-up", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("held");
    await finalize(worker, turnId, null, "failed");
    expect((await turnsOf(sessionId)).map((t) => t.message)).toContain(MESSAGE);
  });

  test("with no turn running the caller queues it now; a recorded pull request on the branch drops it", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    await finalize(worker, turnId, 0);
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("now");
    // An earlier push's pull request on the same branch is the one this
    // push updates.
    await recordPullRequest(ownerId, sessionId, null);
    expect(await hold(sessionId, push)).toBe("pull_request");
    expect(await turnsOf(sessionId)).toHaveLength(1);
  });

  test("an unknown outcome sends the session to recovery and keeps the hold", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("held");
    await gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: turnId,
      finalize_key: `${worker.scope.attempt_id}:${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status: "outcome_unknown",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    expect(
      await db
        .select({ state: sessions.admissionState })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toEqual([{ state: "recovery_required" }]);
    expect(await turnsOf(sessionId)).toHaveLength(1);
    expect(
      await db
        .select({ id: pushFollowUps.pushRequestId })
        .from(pushFollowUps)
        .where(eq(pushFollowUps.sessionId, sessionId)),
    ).toEqual([{ id: push }]);
  });

  test("a pull request row of this push counts without branch fields; one on another branch does not", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    await finalize(worker, turnId, 0);
    const push = await pushRequest(ownerId, sessionId);
    await db.insert(pullRequests).values({
      sessionId,
      url: `https://github.invalid/pr/${crypto.randomUUID()}`,
      ownerId,
      repositoryId: "sample-app",
      number: 2,
      head: `agent/${sessionId}-other`,
      base: "main",
    });
    expect(await hold(sessionId, push)).toBe("now");
    await db.insert(pullRequests).values({
      sessionId,
      url: `https://github.invalid/pr/${crypto.randomUUID()}`,
      pushRequestId: push,
    });
    expect(await hold(sessionId, push)).toBe("pull_request");
  });

  test("a paused session keeps the hold for a later turn end", async () => {
    const { ownerId, sessionId, worker, turnId } = await runningTurn();
    const push = await pushRequest(ownerId, sessionId);
    expect(await hold(sessionId, push)).toBe("held");
    await db
      .update(sessions)
      .set({ admissionState: "pausing" })
      .where(eq(sessions.id, sessionId));
    await finalize(worker, turnId, 0);
    expect(await turnsOf(sessionId)).toHaveLength(1);
    expect(
      await db
        .select({ id: pushFollowUps.pushRequestId })
        .from(pushFollowUps)
        .where(eq(pushFollowUps.sessionId, sessionId)),
    ).toEqual([{ id: push }]);
  });
});
