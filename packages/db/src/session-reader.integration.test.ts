import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReceiptResourceTarget } from "@werft-ai/contracts";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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
  receipts,
  sessionEventArchives,
  sessions,
  turns,
  users,
} from "./schema.ts";
import { encodeArchiveChunk } from "./sessions/session-event-archives.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "00000000-0000-4000-8000-0000000000aa";

integration("session reader on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sink = new MemoryLogSink();
  const logger = createLogger({ sinks: [sink] });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_reader_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function queuedSession() {
    const [session] = await db
      .insert(sessions)
      .values({
        id: crypto.randomUUID(),
        ownerId: OWNER,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("no session");
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId: session.id,
        sequence: 1,
        message: "hello",
        status: "queued",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    return { sessionId: session.id, turnId: turn.id };
  }

  test("a pending reason this build does not know reads as unknown and still holds input back", async () => {
    const { sessionId } = await queuedSession();
    await db
      .update(sessions)
      .set({ checkpointPendingReason: "future_reason" })
      .where(eq(sessions.id, sessionId));

    const detail = await createPostgresSessionReader(db, {
      logger,
    }).getSession(OWNER, sessionId);
    expect(detail?.durability.checkpoint_pending_reason).toBe("unknown");
    expect(
      sink.records.map(({ level, message, fields }) => ({
        level,
        message,
        fields,
      })),
    ).toEqual([
      {
        level: "warn",
        message: "Stored checkpoint pending reason is unknown",
        fields: {
          session_id: sessionId,
          checkpoint_pending_reason: "future_reason",
        },
      },
    ]);

    const appended = await createPostgresSessionUnitOfWork(
      db,
    ).appendInputAtomic({
      principal: { ownerId: OWNER },
      sessionId,
      idempotencyKey: "future-reason-append",
      payloadHash: "hash",
      message: "more",
      limits: {
        queuedInputLimitPerSession: 100,
        storageLimitBytes: 1e15,
      },
    });
    expect(appended).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "future_reason",
    });
  });

  test("each turn reads back where its input came from and who sent it", async () => {
    const { sessionId } = await queuedSession();
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      displayName: "Mina Park",
    });
    const uow = createPostgresSessionUnitOfWork(db);
    const append = (
      key: string,
      kind: "user" | "api_key" | "installation",
      channel: "web" | "api" | "slack",
      actorUserId: string | null,
    ) =>
      uow.appendInputAtomic({
        principal: {
          ownerId: OWNER,
          actor: {
            principal: { kind, id: key },
            userId: actorUserId,
            workspaceId: null,
            apiKeyId: kind === "api_key" ? key : null,
          },
        },
        sessionId,
        idempotencyKey: key,
        payloadHash: key,
        message: key,
        limits: { queuedInputLimitPerSession: 100, storageLimitBytes: 1e15 },
        channel,
      });
    await append("from-web", "user", "web", userId);
    await append("from-key", "api_key", "api", null);
    await append("from-slack", "installation", "slack", userId);

    const listed = await createPostgresSessionReader(db).listTurns(
      OWNER,
      sessionId,
      { limit: 10 },
    );
    const mina = { user_id: userId, display_name: "Mina Park" };
    expect(
      listed?.items.map(({ channel, created_by }) => [channel, created_by]),
    ).toEqual([
      [null, null],
      ["web", mina],
      ["api", null],
      ["slack", mina],
    ]);

    // The first turn is written by acceptance, not append.
    const accepted = await uow.acceptInputAtomic({
      principal: {
        ownerId: OWNER,
        actor: {
          principal: { kind: "installation", id: "first" },
          userId,
          workspaceId: null,
          apiKeyId: null,
        },
      },
      idempotencyKey: "first",
      payloadHash: "first",
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: "none",
      channel: "slack",
      message: "first",
      limits: { queuedInputLimitPerSession: 100, storageLimitBytes: 1e15 },
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const first = await createPostgresSessionReader(db).listTurns(
      OWNER,
      accepted.response.session_id,
      { limit: 1 },
    );
    expect(
      first?.items.map(({ channel, created_by }) => [channel, created_by]),
    ).toEqual([["slack", mina]]);
  });

  test("last_event_at is the time of the newest event in stream order, in list and detail", async () => {
    const { sessionId } = await queuedSession();
    const reader = createPostgresSessionReader(db);
    expect((await reader.getSession(OWNER, sessionId))?.last_event_at).toBe(
      null,
    );
    // The later row carries the earlier time, as a transaction that
    // started first but took the session lock second would write it.
    const at = new Date("2026-09-26T01:02:03.456Z");
    await db.insert(events).values([
      {
        sessionId,
        type: "status",
        payload: {},
        createdAt: new Date(at.getTime() + 60_000),
      },
      { sessionId, type: "status", payload: {}, createdAt: at },
    ]);
    expect((await reader.getSession(OWNER, sessionId))?.last_event_at).toBe(
      at.toISOString(),
    );
    const listed = await reader.listSessions(
      OWNER,
      { limit: 100 },
      { userId: null, apiKeyId: null },
    );
    expect(
      listed.items.find((item) => item.id === sessionId)?.last_event_at,
    ).toBe(at.toISOString());
  });

  test("a detail read in a caller's read committed transaction is refused", async () => {
    const { sessionId } = await queuedSession();
    await db.transaction(async (tx) => {
      await expect(
        createPostgresSessionReader(tx).getSession(OWNER, sessionId),
      ).rejects.toThrow("Session detail needs a snapshot transaction");
    });
  });

  test("detail shows the execution that claimed last, not the highest generation", async () => {
    const { sessionId } = await queuedSession();
    // Pool launches: the later claim carries the lower generation.
    const earlier = `exec-early-${sessionId}`;
    const later = `exec-late-${sessionId}`;
    await db.insert(executions).values([
      {
        id: earlier,
        sessionId,
        backend: "local_docker",
        generation: 5,
        desiredState: "terminated",
        observedState: "terminated",
      },
      {
        id: later,
        sessionId,
        backend: "local_docker",
        generation: 2,
        desiredState: "running",
        observedState: "running",
      },
    ]);
    const attempt = (id: string, executionId: string, leaseEpoch: number) => ({
      id: `${id}-${sessionId}`,
      sessionId,
      executionId,
      leaseEpoch,
      executionGeneration: executionId === earlier ? 5 : 2,
      authRevision: 0,
      state: "exited",
      leaseExpiresAt: new Date(),
    });
    await db
      .insert(attempts)
      .values([attempt("first", earlier, 1), attempt("second", later, 3)]);
    const mode = {
      type: "system",
      subtype: "workspace_limit_mode",
      bytes: "hard",
      inodes: "unknown",
      reason: "storage_declaration_and_capacity",
    };
    const [stored] = await db
      .insert(events)
      .values({
        sessionId,
        attemptId: `second-${sessionId}`,
        type: "system",
        payload: mode,
      })
      .returning();
    if (!stored) throw new Error("Classification was not stored");
    await db
      .update(sessions)
      .set({ executionId: later, leaseEpoch: 3, executionGeneration: 2 })
      .where(eq(sessions.id, sessionId));
    const reader = createPostgresSessionReader(db);
    expect(
      (await reader.getSession(OWNER, sessionId))?.workspace_limit_mode,
    ).toEqual({
      bytes: "hard",
      inodes: "unknown",
      reason: "storage_declaration_and_capacity",
    });
    expect(await reader.getSession("other-owner", sessionId)).toBeNull();
    expect((await reader.getSession(OWNER, sessionId))?.execution?.state).toBe(
      "running",
    );

    // Released: the session no longer names one, its last attempt does.
    await db
      .update(sessions)
      .set({ executionId: null, leaseEpoch: 4 })
      .where(eq(sessions.id, sessionId));
    await db
      .update(executions)
      .set({ observedState: "suspended" })
      .where(eq(executions.id, later));
    expect((await reader.getSession(OWNER, sessionId))?.execution?.state).toBe(
      "suspended",
    );
    const body = encodeArchiveChunk([
      JSON.stringify({
        id: stored.id,
        type: stored.type,
        payload: stored.payload,
        attempt_id: stored.attemptId,
        turn_id: null,
        source_sequence: null,
        created_at: stored.createdAt.toISOString(),
        occurred_at: null,
        neutral: null,
      }),
    ]);
    await db.insert(sessionEventArchives).values({
      sessionId,
      fromId: stored.id,
      throughId: stored.id,
      objectKey: `session-archive/${sessionId}/classification`,
      versionId: "v1",
      sha256: createHash("sha256").update(body).digest("hex"),
      eventCount: 1,
      bytes: body.length,
      lastCreatedAt: stored.createdAt,
      lastOccurredAt: stored.createdAt,
      activity: {},
      activityThrough: stored.id,
    });
    await db.delete(events).where(eq(events.id, stored.id));
    expect(
      (await reader.getSession(OWNER, sessionId))?.workspace_limit_mode,
    ).toBeUndefined();
    const unavailableReader = createPostgresSessionReader(db, {
      archivedEvents: {
        get: async () => {
          throw new Error("Object store unavailable");
        },
      },
    });
    expect(
      (await unavailableReader.getSession(OWNER, sessionId))
        ?.workspace_limit_mode,
    ).toBeUndefined();
    let downloads = 0;
    const archivedReader = createPostgresSessionReader(db, {
      archivedEvents: {
        get: async () => {
          downloads++;
          return body;
        },
      },
    });
    expect(
      (await archivedReader.getSession(OWNER, sessionId))?.workspace_limit_mode,
    ).toMatchObject({ bytes: "hard", inodes: "unknown" });
    await db.insert(attempts).values({
      ...attempt("new-without-classification", later, 5),
      startedAt: new Date(stored.createdAt.getTime() + 1000),
    });
    let oldDownloads = 0;
    const newAttemptReader = createPostgresSessionReader(db, {
      archivedEvents: {
        get: async () => {
          oldDownloads++;
          return body;
        },
      },
    });
    expect(
      (await newAttemptReader.getSession(OWNER, sessionId))
        ?.workspace_limit_mode,
    ).toBeUndefined();
    expect(downloads).toBe(1);
    expect(oldDownloads).toBe(0);
  });

  test("a turn does not report a checkpoint revision a restore can no longer reach", async () => {
    const { sessionId, turnId } = await queuedSession();
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.id, turnId));
    const checkpoint = (revision: number) => ({
      sessionId,
      revision,
      manifestRef: `manifests/${sessionId}/${revision}.json`,
      manifestSha256: "0".repeat(64),
      turnId,
    });
    await db.insert(checkpoints).values([checkpoint(1), checkpoint(2)]);
    const reader = createPostgresSessionReader(db);
    const revisionOfTurn = async () => {
      const listed = await reader.listTurns(OWNER, sessionId, { limit: 10 });
      const detail = await reader.getTurn(OWNER, sessionId, "1");
      expect(listed?.items[0]?.checkpoint_revision).toBe(
        detail?.checkpoint_revision ?? null,
      );
      return detail?.checkpoint_revision;
    };
    expect(await revisionOfTurn()).toBe(2);

    await db
      .update(checkpoints)
      .set({ collectedAt: new Date() })
      .where(
        and(eq(checkpoints.sessionId, sessionId), eq(checkpoints.revision, 2)),
      );
    expect(await revisionOfTurn()).toBe(1);

    // start_fresh retired everything up to revision 1.
    await db
      .update(sessions)
      .set({ contextResetCheckpointRevision: 1 })
      .where(eq(sessions.id, sessionId));
    expect(await revisionOfTurn()).toBeNull();
  });

  test("a receipt with a resource target reads back as stored", async () => {
    const id = crypto.randomUUID();
    const target: ReceiptResourceTarget = {
      resource: { kind: "agent", id: "agent-1" },
      workspace_id: null,
    };
    await db.insert(receipts).values({
      id,
      ownerId: OWNER,
      operation: "revoke_execution",
      targetRef: target,
      status: "succeeded",
    });
    const receipt = await createPostgresSessionReader(db).getReceipt(OWNER, id);
    expect(receipt?.target_ref).toEqual(target);
  });

  test("a receipt reads back with the actor that made it", async () => {
    const id = crypto.randomUUID();
    const actor = {
      principal: { kind: "api_key" as const, id: "key-1" },
      actor_user_id: null,
      agent_id: null,
    };
    await db.insert(receipts).values({
      id,
      ownerId: OWNER,
      operation: "request_push",
      targetRef: {
        session_id: crypto.randomUUID(),
        turn_id: null,
        request_id: null,
      },
      actor,
      status: "succeeded",
    });
    const reader = createPostgresSessionReader(db);
    expect((await reader.getReceipt(OWNER, id))?.actor).toEqual(actor);
  });

  test("every detail field comes from one snapshot", async () => {
    const { sessionId, turnId } = await queuedSession();
    const reader = createPostgresSessionReader(db);
    const before = await reader.getSession(OWNER, sessionId);
    expect(before?.execution).toBeNull();
    expect(before?.durability.last_completed_turn_id).toBeNull();

    // The writer holds executions so the detail stops on it after its
    // first reads, then changes what the reads after it would see.
    const writer = await pool.connect();
    let committed = false;
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE executions IN ACCESS EXCLUSIVE MODE");
      const during = reader.getSession(OWNER, sessionId);
      await waitForLockWait(pool, "executions");
      await writer.query(
        "UPDATE turns SET status = 'completed', started_at = now(), ended_at = now() WHERE id = $1",
        [turnId],
      );
      await writer.query(
        `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
         VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
        [`exec-${sessionId}`, sessionId],
      );
      await writer.query("COMMIT");
      committed = true;
      expect(await during).toEqual(before);
    } finally {
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
    }

    const after = await reader.getSession(OWNER, sessionId);
    expect(after?.execution?.state).toBe("running");
    expect(after?.durability.last_completed_turn_id).toBe("1");
    expect(
      await db
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});

async function waitForLockWait(pool: Pool, table: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_locks WHERE relation = $1::regclass AND NOT granted",
      [table],
    );
    if (rows.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`nothing waited on ${table}`);
}
