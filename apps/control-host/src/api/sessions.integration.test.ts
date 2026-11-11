import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ADMISSION_STATE_VALUES,
  createSessionResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  listSessionsResponseSchema,
  listTurnsResponseSchema,
  postSessionMessageResponseSchema,
  readyResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  checkpointOutputs,
  checkpoints,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  events,
  idempotencyKeys,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import { createLogger } from "@werft-ai/observability";
import {
  type CatalogProfile,
  createAuthorizationPolicy,
  createSessionService,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import { asc, count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp, isStorageUnavailable } from "./app.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

const coding: CatalogProfile = {
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
};
const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    "claude-coding-v1": coding,
    "claude-coding-optional": { ...coding, repository: "optional" },
    general: { ...coding, tools: ["Read", "Write"], repository: "none" },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1", "claude-coding-optional"],
      auth: { kind: "github_app", registered: true } as const,
    },
  },
});

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("sessions API on PostgreSQL", () => {
  let pool: Pool;
  let probePool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let tight: ReturnType<typeof createApiApp>;
  const owner = `owner-${crypto.randomUUID()}`;
  const stranger = `owner-${crypto.randomUUID()}`;
  const body = {
    profile_id: "claude-coding-v1",
    repository_id: "sample-app",
    message: "Inspect the failing unit test and propose a fix.",
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    db = drizzle(pool, { schema });
    const state = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (state.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
    }
    const serviceWith = (limits: {
      queuedInputLimitPerSession: number;
      storageLimitBytes: number;
      sessionCostLimitUsd: number;
      sessionTokenLimit: number | null;
    }) =>
      createSessionService({
        limits,
        authorization: createAuthorizationPolicy(),
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
      });
    const service = serviceWith({
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });
    // One queued input per session, room for no message at all, and a one
    // dollar or 100 token budget.
    const tightService = serviceWith({
      queuedInputLimitPerSession: 1,
      storageLimitBytes: 1,
      sessionCostLimitUsd: 1,
      sessionTokenLimit: 100,
    });
    tight = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerSessionRoutes(router, tightService),
    });
    probePool = createProbePool(databaseUrl ?? "", createLogger(), 500);
    app = createApiApp({
      authMode: "none",
      registerRoutes: (router) => {
        registerSessionRoutes(router, service);
        registerReceiptRoutes(router, service);
      },
      readiness: createReadinessProbe({
        db: probePool,
        requiredEnv: ["QUEUE_DATABASE_URL"],
      }),
    });
  }, 60_000);

  afterAll(async () => {
    for (const ownerId of [owner, stranger]) {
      const owned = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, ownerId));
      for (const { id } of owned) {
        await db.delete(queueMessages).where(eq(queueMessages.sessionId, id));
        await db
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, id));
        await db
          .delete(checkpointOutputs)
          .where(eq(checkpointOutputs.sessionId, id));
        await db.delete(checkpoints).where(eq(checkpoints.sessionId, id));
        await db.delete(events).where(eq(events.sessionId, id));
        await db.delete(turns).where(eq(turns.sessionId, id));
      }
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.principal, ownerId));
      await db.delete(receipts).where(eq(receipts.ownerId, ownerId));
      await db.delete(sessions).where(eq(sessions.ownerId, ownerId));
    }
    await probePool.end();
    await pool.end();
  }, 60_000);

  function append(
    sessionId: string,
    key: string,
    payload: unknown = { message: "Apply the proposed fix.", mode: "enqueue" },
    ownerId = owner,
  ) {
    return app.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": ownerId,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });
  }

  async function createdSession(key: string) {
    return createSessionResponseSchema.parse(await (await create(key)).json())
      .session_id;
  }

  async function queueOrder(sessionId: string) {
    const rows = await db
      .select({ sequence: turns.sequence })
      .from(queueMessages)
      .innerJoin(turns, eq(turns.id, queueMessages.turnId))
      .where(eq(queueMessages.sessionId, sessionId))
      .orderBy(asc(queueMessages.id));
    return rows.map((row) => row.sequence);
  }

  function create(key: string, payload: unknown = body, ownerId = owner) {
    return app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": ownerId,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });
  }

  async function rowsFor(sessionId: string) {
    const [[s], [t], [q], [u]] = await Promise.all([
      db
        .select({ n: count() })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
      db
        .select({ n: count() })
        .from(turns)
        .where(eq(turns.sessionId, sessionId)),
      db
        .select({ n: count() })
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
      db
        .select({ n: count() })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ]);
    return { sessions: s?.n, turns: t?.n, queue: q?.n, unassigned: u?.n };
  }

  test("accepts session, first turn, queue row, receipt and idempotency key atomically", async () => {
    const response = await create("create-1");
    expect(response.status).toBe(201);
    const created = createSessionResponseSchema.parse(await response.json());
    expect(created).toMatchObject({
      turn_id: "1",
      receipt_status: "accepted",
      status: "queued",
    });
    expect(await rowsFor(created.session_id)).toEqual({
      sessions: 1,
      turns: 1,
      queue: 1,
      unassigned: 1,
    });
    const [partitions] = await db
      .select({
        session: sessions.partition,
        signal: unassignedSessions.partition,
      })
      .from(sessions)
      .innerJoin(
        unassignedSessions,
        eq(unassignedSessions.sessionId, sessions.id),
      )
      .where(eq(sessions.id, created.session_id));
    expect(partitions).toEqual({ session: "default", signal: "default" });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.receipt_id));
    expect(receipt).toMatchObject({
      ownerId: owner,
      operation: "create_session",
      status: "accepted",
      targetRef: {
        session_id: created.session_id,
        turn_id: "1",
        request_id: null,
      },
    });

    const replay = await create("create-1");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const conflict = await create("create-1", {
      ...body,
      message: "different",
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await db
          .select({ n: count() })
          .from(receipts)
          .where(eq(receipts.ownerId, owner))
      )[0]?.n,
    ).toBe(1);
  }, 60_000);

  test("serves the create and append receipts to their owner only", async () => {
    const created = createSessionResponseSchema.parse(
      await (await create("receipt-1")).json(),
    );
    const appended = postSessionMessageResponseSchema.parse(
      await (await append(created.session_id, "receipt-msg-1")).json(),
    );
    for (const [receiptId, operation, turnId] of [
      [created.receipt_id, "create_session", "1"],
      [appended.receipt_id, "append_message", "2"],
    ] as const) {
      const response = await app.request(`/v1/receipts/${receiptId}`, {
        headers: { "X-Owner-Id": owner },
      });
      expect(response.status).toBe(200);
      const receipt = getReceiptResponseSchema.parse(await response.json());
      expect(receipt).toMatchObject({
        id: receiptId,
        operation,
        status: "accepted",
        target_ref: {
          session_id: created.session_id,
          turn_id: turnId,
          request_id: null,
        },
        error: null,
      });
      expect(receipt.created_at).toBe(receipt.updated_at);
    }
    expect(
      getReceiptResponseSchema.parse(
        await (
          await app.request(`/v1/receipts/${created.receipt_id}`, {
            headers: { "X-Owner-Id": owner },
          })
        ).json(),
      ).result,
    ).toEqual(created);

    const foreign = await app.request(`/v1/receipts/${created.receipt_id}`, {
      headers: { "X-Owner-Id": stranger },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.details).toBeNull();
    const unknown = await app.request(`/v1/receipts/${crypto.randomUUID()}`, {
      headers: { "X-Owner-Id": owner },
    });
    expect(unknown.status).toBe(404);
  }, 60_000);

  test("readiness passes against the migrated database without touching any backend", async () => {
    const response = await app.request("/readyz");
    expect(response.status).toBe(200);
    expect(readyResponseSchema.parse(await response.json()).status).toBe(
      "ready",
    );
    expect((await app.request("/healthz")).status).toBe(200);
  }, 60_000);

  test("probe pool cancels a statement that outlives the timeout and stays usable", async () => {
    const started = Date.now();
    // The sleep is 60x the 500ms limit so the gap between "the timeout fired"
    // and "the query simply finished" is far wider than a loaded runner's
    // scheduling jitter. At 5s it was not: this read 4524ms against a 3000ms
    // bound on a loaded CI runner while the cancel itself had worked.
    await expect(probePool.query("SELECT pg_sleep(30)")).rejects.toMatchObject({
      // 57014 query_canceled: the server killed it, not just the client.
      code: "57014",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await app.request("/readyz")).status).toBe(200);
    expect(probePool.waitingCount).toBe(0);
  }, 60_000);

  test("api pool cancels a statement that outlives statement_timeout and maps it to 503", async () => {
    // The URL tries to switch both limits off; the pool must not let it.
    const overriding = `${databaseUrl ?? ""}${databaseUrl?.includes("?") ? "&" : "?"}statement_timeout=0&query_timeout=0`;
    const apiPool = createApiPool(overriding, createLogger(), {
      connectMs: 1_000,
      statementMs: 500,
      queryMs: 1_000,
    });
    try {
      const started = Date.now();
      const failure = await apiPool
        .query("SELECT pg_sleep(30)")
        .then(() => null)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "57014" });
      expect(Date.now() - started).toBeLessThan(10_000);
      // The classifier in app.onError / mapped() must turn it into 503.
      expect(isStorageUnavailable(failure)).toBe(true);
      expect((await apiPool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await apiPool.end();
    }
  }, 60_000);

  test("api pool evicts a client whose query_timeout fired instead of returning it busy", async () => {
    // statement_timeout high so only the client-side read timeout can fire,
    // as it does when the server is frozen and never sends the cancel reply.
    const apiPool = createApiPool(databaseUrl ?? "", createLogger(), {
      connectMs: 1_000,
      statementMs: 30_000,
      queryMs: 500,
    });
    const db = drizzle(apiPool, { schema });
    try {
      const failure = await db
        .transaction(async (tx) => {
          await tx.execute("SELECT pg_sleep(30)");
        })
        .then(() => null)
        .catch((error: unknown) => error);
      expect(isStorageUnavailable(failure)).toBe(true);
      await Bun.sleep(50);
      // drizzle's ROLLBACK after the failure must not wait another queryMs on
      // the same dead socket. An empty pool is that, measured directly: a
      // client that was returned would still be in it. The wall-clock version
      // of this assertion could not tell a second 500ms round from a loaded
      // runner's jitter.
      expect(apiPool.totalCount).toBe(0);
      expect((await apiPool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await apiPool.end();
    }
  }, 60_000);

  test("api pool frees the slot when a checked-out client times out before the caller releases it", async () => {
    // drizzle executes BEGIN outside the try/finally that releases the
    // client, so a BEGIN that times out never reaches release(); with max 1
    // the pool would then be exhausted for the life of the process.
    const apiPool = createApiPool(databaseUrl ?? "", createLogger(), {
      connectMs: 1_000,
      statementMs: 30_000,
      queryMs: 500,
    });
    try {
      const client = await apiPool.connect();
      const failure = await client
        .query("SELECT pg_sleep(5)")
        .then(() => null)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: "Query read timeout" });
      // No release() by the caller, and yet the slot is free again.
      expect(apiPool.totalCount).toBe(0);
      // A late release() from a caller that does reach its finally is harmless.
      expect(() => client.release()).not.toThrow();
      const next = await apiPool.connect();
      expect((await next.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      next.release();
    } finally {
      await apiPool.end();
    }
  }, 60_000);

  test("a request whose statements each finish just inside their timeout still answers 503 at its deadline and drops its client", async () => {
    // Every statement ends well inside statement_timeout, so no pool timeout
    // ever fires; only the request deadline bounds the sum.
    const apiPool = createApiPool(databaseUrl ?? "", createLogger(), {
      connectMs: 1_000,
      statementMs: 1_000,
      queryMs: 2_000,
    });
    const apiDb = drizzle(apiPool, { schema });
    const table = `deadline_app_${crypto.randomUUID().replaceAll("-", "")}`;
    let statements = 0;
    const slowApp = createApiApp({
      authMode: "none",
      requestDeadlineMs: 1_500,
      registerRoutes: (router) => {
        router.post("/slow", async (context) => {
          await apiDb.transaction(async (tx) => {
            await tx.execute(`INSERT INTO ${table} VALUES (1)`);
            for (let i = 0; i < 5; i += 1) {
              await tx.execute("SELECT pg_sleep(0.8)");
              statements += 1;
            }
          });
          return context.json({ ok: true });
        });
      },
    });
    try {
      await pool.query(`CREATE TABLE ${table} (id int)`);
      const started = performance.now();
      const response = await slowApp.request("/v1/slow", {
        method: "POST",
        headers: { "X-Owner-Id": owner, "Content-Type": "application/json" },
        body: "{}",
      });
      const elapsed = performance.now() - started;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "BACKEND_UNAVAILABLE", retryable: true },
      });
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(2_500);
      // The one checkout was evicted, not parked in the pool with its open
      // transaction.
      await Bun.sleep(100);
      expect(apiPool.totalCount).toBe(0);
      expect(statements).toBeLessThan(5);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      expect(rows).toEqual([{ n: 0 }]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await apiPool.end();
    }
  }, 60_000);

  test("survives the backend of an idle probe connection being terminated", async () => {
    expect((await app.request("/readyz")).status).toBe(200);
    expect(probePool.idleCount).toBe(1);
    const pid = (
      await probePool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    // From another connection, kill the backend the idle probe client holds.
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await Bun.sleep(100);
    // pg-pool has emitted "error" for the idle client by now; the process is
    // still here and the next probe simply reconnects.
    expect((await app.request("/readyz")).status).toBe(200);
  }, 60_000);

  test("10 concurrent creates with one key produce one session, turn and receipt", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => create("race-1")),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    const sessionId = createSessionResponseSchema.parse(bodies[0]).session_id;
    expect(await rowsFor(sessionId)).toMatchObject({
      sessions: 1,
      turns: 1,
      queue: 1,
    });
    const [keyed] = await db
      .select({ n: count() })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "race-1"));
    expect(keyed?.n).toBe(1);
  }, 60_000);

  test("detail matches the contract and hides other owners' sessions", async () => {
    const created = createSessionResponseSchema.parse(
      await (await create("detail-1")).json(),
    );
    const response = await app.request(`/v1/sessions/${created.session_id}`, {
      headers: { "X-Owner-Id": owner },
    });
    expect(response.status).toBe(200);
    const detail = getSessionResponseSchema.parse(await response.json());
    expect(detail).toMatchObject({
      id: created.session_id,
      admission_state: "active",
      status: "queued",
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        profile_id: "claude-coding-v1",
        model: "claude-sonnet-5",
        permission_mode: "default",
      },
      model: "claude-sonnet-5",
      repository_id: "sample-app",
      current_turn_id: null,
      queued_turn_count: 1,
      execution: null,
      pending_request_count: 0,
      durability: { checkpoint_revision: null, last_completed_turn_id: null },
    });
    expect(JSON.stringify(detail)).not.toContain("example.invalid");

    const foreign = await app.request(`/v1/sessions/${created.session_id}`, {
      headers: { "X-Owner-Id": stranger },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.details).toBeNull();
  }, 60_000);

  test("detail carries the durability the rows record, and a mirror failure closes input", async () => {
    const sessionId = await createdSession("durability-1");
    const persistedAt = new Date("2026-09-23T01:02:03.000Z");
    await db
      .update(sessions)
      .set({
        checkpointPendingAttemptId: "attempt-x",
        checkpointPendingReason: "mirror_error",
        lastTranscriptPersistedAt: persistedAt,
      })
      .where(eq(sessions.id, sessionId));
    const response = await app.request(`/v1/sessions/${sessionId}`, {
      headers: { "X-Owner-Id": owner },
    });
    expect(response.status).toBe(200);
    expect(
      getSessionResponseSchema.parse(await response.json()).durability,
    ).toEqual({
      checkpoint_committed_at: null,
      checkpoint_fallback_revision: null,
      checkpoint_pending_reason: "mirror_error",
      checkpoint_revision: null,
      context_reset_turn_id: null,
      last_checkpointed_turn_id: null,
      last_completed_turn_id: null,
      last_transcript_persisted_at: persistedAt.toISOString(),
    });
    // The turn could never be reported complete, so it is not accepted.
    const refused = await append(sessionId, "durability-1-append");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("CHECKPOINT_UNAVAILABLE");
    // A stranger still sees nothing, not the refusal.
    const foreign = await append(
      sessionId,
      "durability-1-foreign",
      undefined,
      stranger,
    );
    expect(foreign.status).toBe(404);
  }, 60_000);

  test("a pending reason a newer build recorded still gives the detail, and holds input back", async () => {
    const sessionId = await createdSession("future-reason");
    await db
      .update(sessions)
      .set({
        checkpointPendingAttemptId: "attempt-x",
        checkpointPendingReason: "future_reason",
      })
      .where(eq(sessions.id, sessionId));
    const response = await app.request(`/v1/sessions/${sessionId}`, {
      headers: { "X-Owner-Id": owner },
    });
    expect(response.status).toBe(200);
    expect(
      getSessionResponseSchema.parse(await response.json()).durability
        .checkpoint_pending_reason,
    ).toBe("unknown");
    const refused = await append(sessionId, "future-reason-append");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("CHECKPOINT_UNAVAILABLE");
  }, 60_000);

  test("a stopped session resumes with 202 over an advisory pending reason, and is refused over a mirror failure", async () => {
    const resumeWith = async (key: string, pendingReason: string) => {
      const sessionId = await createdSession(key);
      await db.insert(checkpoints).values({
        sessionId,
        revision: 0,
        manifestRef: `manifests/${sessionId}/0`,
        manifestSha256: "0".repeat(64),
      });
      const [row] = await db
        .update(sessions)
        .set({
          admissionState: "stopped",
          status: "stopped",
          checkpointRevision: 0,
          checkpointCommittedAt: new Date(),
          checkpointPendingReason: pendingReason,
          checkpointPendingAttemptId: "attempt-x",
        })
        .where(eq(sessions.id, sessionId))
        .returning({ revision: sessions.revision });
      return app.request(`/v1/sessions/${sessionId}/resume`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Id": owner,
          "Idempotency-Key": `${key}-resume`,
        },
        body: JSON.stringify({ expected_revision: row?.revision }),
      });
    };

    // The run left a dev server going, so its last checkpoint was refused;
    // the one before it is still the one to resume from.
    const resumed = await resumeWith("advisory-resume", "background_writer");
    expect(resumed.status).toBe(202);
    const refused = await resumeWith("mirror-resume", "mirror_error");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("CHECKPOINT_UNAVAILABLE");
  }, 60_000);

  test("legacy rows without a catalog key expose repository_id null and never the repo URL", async () => {
    // An M0 row: the client sent the URL directly, so it may embed
    // credentials. It has no profile/repository catalog keys.
    const legacyOwner = `owner-${crypto.randomUUID()}`;
    const legacyId = crypto.randomUUID();
    const secret = "legacy-basic-auth-password";
    const repoUrl = `https://deploy:${secret}@legacy.invalid/team/app.git`;
    await db.insert(sessions).values({
      id: legacyId,
      ownerId: legacyOwner,
      repoUrl,
      branch: "main",
      profileId: null,
      repositoryId: null,
    });
    try {
      const detailResponse = await app.request(`/v1/sessions/${legacyId}`, {
        headers: { "X-Owner-Id": legacyOwner },
      });
      expect(detailResponse.status).toBe(200);
      const detailText = await detailResponse.text();
      const detail = getSessionResponseSchema.parse(JSON.parse(detailText));
      expect(detail).toMatchObject({
        id: legacyId,
        repository_id: null,
        runtime: null,
        current_turn_id: null,
        queued_turn_count: 0,
        // No catalog key, so no worker of this host will take it.
        attention: { code: "CATALOG_MISMATCH" },
      });
      expect(detailText).not.toContain(secret);
      expect(detailText).not.toContain("legacy.invalid");

      const listResponse = await app.request("/v1/sessions", {
        headers: { "X-Owner-Id": legacyOwner },
      });
      expect(listResponse.status).toBe(200);
      const listText = await listResponse.text();
      const page = listSessionsResponseSchema.parse(JSON.parse(listText));
      expect(
        page.items.map((item) => [item.id, item.repository_id, item.runtime]),
      ).toEqual([[legacyId, null, null]]);
      expect(listText).not.toContain(secret);
      expect(listText).not.toContain("legacy.invalid");
    } finally {
      await db.delete(sessions).where(eq(sessions.id, legacyId));
    }
  }, 60_000);

  test("a profile key the catalog no longer has surfaces runtime null, not a guess", async () => {
    const retiredOwner = `owner-${crypto.randomUUID()}`;
    const retiredId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: retiredId,
      ownerId: retiredOwner,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      profileId: "retired-profile",
      repositoryId: "sample-app",
    });
    try {
      const detail = getSessionResponseSchema.parse(
        await (
          await app.request(`/v1/sessions/${retiredId}`, {
            headers: { "X-Owner-Id": retiredOwner },
          })
        ).json(),
      );
      expect(detail).toMatchObject({
        repository_id: "sample-app",
        runtime: null,
        attention: { code: "CATALOG_MISMATCH" },
      });
      const page = listSessionsResponseSchema.parse(
        await (
          await app.request("/v1/sessions", {
            headers: { "X-Owner-Id": retiredOwner },
          })
        ).json(),
      );
      expect(page.items.map((item) => item.runtime)).toEqual([null]);
    } finally {
      await db.delete(sessions).where(eq(sessions.id, retiredId));
    }
  }, 60_000);

  test("lists 150 sessions through stable cursors without duplicates or gaps", async () => {
    const listOwner = `owner-${crypto.randomUUID()}`;
    const ids = new Set<string>();
    for (let index = 0; index < 150; index += 1) {
      const response = await create(`list-${index}`, body, listOwner);
      ids.add(
        createSessionResponseSchema.parse(await response.json()).session_id,
      );
    }
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url = `/v1/sessions?status=queued&limit=40${cursor ? `&cursor=${cursor}` : ""}`;
        const page = listSessionsResponseSchema.parse(
          await (
            await app.request(url, { headers: { "X-Owner-Id": listOwner } })
          ).json(),
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(4);
      expect(new Set(seen).size).toBe(150);
      expect(new Set(seen)).toEqual(ids);

      const defaults = listSessionsResponseSchema.parse(
        await (
          await app.request("/v1/sessions", {
            headers: { "X-Owner-Id": listOwner },
          })
        ).json(),
      );
      expect(defaults.items).toHaveLength(50);
      const forged = (created_at: string, id: string = crypto.randomUUID()) =>
        Buffer.from(JSON.stringify({ created_at, id })).toString("base64url");
      for (const cursor of [
        "nope",
        forged("2026-01-01T00:00:00Z", "not-a-uuid"),
        forged("0"),
        forged("2026-13-45 99:00:00+00"),
      ]) {
        const bad = await app.request(`/v1/sessions?cursor=${cursor}`, {
          headers: { "X-Owner-Id": listOwner },
        });
        expect(bad.status).toBe(400);
      }
    } finally {
      for (const id of ids) {
        await db.delete(queueMessages).where(eq(queueMessages.sessionId, id));
        await db
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, id));
        await db.delete(turns).where(eq(turns.sessionId, id));
      }
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.principal, listOwner));
      await db.delete(receipts).where(eq(receipts.ownerId, listOwner));
      await db.delete(sessions).where(eq(sessions.ownerId, listOwner));
    }
  }, 60_000);

  test("appends a message as the next turn with its own receipt and idempotency scope", async () => {
    const sessionId = await createdSession("append-1");
    const response = await append(sessionId, "msg-1");
    expect(response.status).toBe(202);
    const accepted = postSessionMessageResponseSchema.parse(
      await response.json(),
    );
    expect(accepted).toMatchObject({
      turn_id: "2",
      receipt_status: "accepted",
    });
    expect(await rowsFor(sessionId)).toEqual({
      sessions: 1,
      turns: 2,
      queue: 2,
      unassigned: 1,
    });
    expect(await queueOrder(sessionId)).toEqual([1, 2]);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, accepted.receipt_id));
    expect(receipt).toMatchObject({
      ownerId: owner,
      operation: "append_message",
      status: "accepted",
      targetRef: { session_id: sessionId, turn_id: "2", request_id: null },
    });

    const replay = await append(sessionId, "msg-1");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(accepted);
    // mode is defaulted before hashing, so omitting it is the same payload.
    const implicit = await append(sessionId, "msg-1", {
      message: "Apply the proposed fix.",
    });
    expect(implicit.status).toBe(202);
    expect(await implicit.json()).toEqual(accepted);
    // Session ids are uuids: a differently-cased path is the same scope.
    const upper = await append(sessionId.toUpperCase(), "msg-1");
    expect(upper.status).toBe(202);
    expect(await upper.json()).toEqual(accepted);
    const conflict = await append(sessionId, "msg-1", { message: "other" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await rowsFor(sessionId)).toMatchObject({ turns: 2, queue: 2 });

    // The create key and the append key live in different scopes, and so do
    // append keys of different sessions.
    const other = await createdSession("append-2");
    const reused = await append(other, "msg-1");
    expect(reused.status).toBe(202);
    expect(
      postSessionMessageResponseSchema.parse(await reused.json()).turn_id,
    ).toBe("2");
    const sameAsCreate = await append(sessionId, "append-1");
    expect(sameAsCreate.status).toBe(202);
    expect(
      postSessionMessageResponseSchema.parse(await sameAsCreate.json()).turn_id,
    ).toBe("3");
  }, 60_000);

  test("3 concurrent messages get turn ids 2,3,4 without gaps in queue order", async () => {
    const sessionId = await createdSession("race-append");
    const responses = await Promise.all(
      [1, 2, 3].map((n) =>
        append(sessionId, `race-${n}`, { message: `message ${n}` }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
    const turnIds = await Promise.all(
      responses.map(
        async (r) =>
          postSessionMessageResponseSchema.parse(await r.json()).turn_id,
      ),
    );
    expect([...turnIds].sort()).toEqual(["2", "3", "4"]);
    const stored = await db
      .select({
        sequence: turns.sequence,
        message: turns.message,
        createdAt: turns.createdAt,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));
    expect(stored.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
    // created_at follows the sequence, not the transaction start.
    for (let index = 1; index < stored.length; index += 1) {
      expect(stored[index]?.createdAt.getTime() ?? 0).toBeGreaterThanOrEqual(
        stored[index - 1]?.createdAt.getTime() ?? 0,
      );
    }
    expect(await queueOrder(sessionId)).toEqual([1, 2, 3, 4]);
    // Each response's turn_id names the row that holds its message.
    for (const [index, turnId] of turnIds.entries()) {
      expect(stored[Number(turnId) - 1]?.message).toBe(`message ${index + 1}`);
    }
    const [keyed] = await db
      .select({ n: count() })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.resource, sessionId));
    expect(keyed?.n).toBe(3);
  }, 60_000);

  test("rejects messages by admission state and keeps the turn count", async () => {
    const sessionId = await createdSession("admission-1");
    const expected: Record<string, [number, string | null]> = {
      active: [202, null],
      pausing: [409, "SESSION_PAUSED"],
      paused: [409, "SESSION_PAUSED"],
      resuming: [409, "SESSION_RESUMING"],
      stopping: [409, "SESSION_STOPPED"],
      stopped: [409, "SESSION_STOPPED"],
      recovery_required: [409, "RECOVERY_REQUIRED"],
      closing: [409, "SESSION_CLOSING"],
      closed: [409, "SESSION_CLOSED"],
    };
    expect(Object.keys(expected).sort()).toEqual(
      [...ADMISSION_STATE_VALUES].sort(),
    );
    for (const state of ADMISSION_STATE_VALUES) {
      await db
        .update(sessions)
        .set({ admissionState: state })
        .where(eq(sessions.id, sessionId));
      const response = await append(sessionId, `admission-${state}`);
      const [status, code] = expected[state] ?? [0, null];
      expect(response.status, state).toBe(status);
      if (code) {
        const body = await response.json();
        expect(body.error.code, state).toBe(code);
        expect(body.error.retryable).toBe(false);
      }
    }
    expect(await rowsFor(sessionId)).toMatchObject({ turns: 2, queue: 2 });
    await db
      .update(sessions)
      .set({ admissionState: "active" })
      .where(eq(sessions.id, sessionId));
  }, 60_000);

  test("hides other owners' sessions from messages and turns", async () => {
    const sessionId = await createdSession("foreign-1");
    const foreignAppend = await append(
      sessionId,
      "foreign",
      undefined,
      stranger,
    );
    expect(foreignAppend.status).toBe(404);
    expect((await foreignAppend.json()).error.details).toBeNull();
    expect(await rowsFor(sessionId)).toMatchObject({ turns: 1 });
    for (const path of [
      `/v1/sessions/${sessionId}/turns`,
      `/v1/sessions/${sessionId}/turns/1`,
    ]) {
      const response = await app.request(path, {
        headers: { "X-Owner-Id": stranger },
      });
      expect(response.status, path).toBe(404);
    }
    const missing = await append(crypto.randomUUID(), "missing");
    expect(missing.status).toBe(404);
  }, 60_000);

  test("lists turns in FIFO order through cursors and serves the detail projection", async () => {
    const sessionId = await createdSession("turns-1");
    for (let n = 2; n <= 7; n += 1) {
      expect(
        (await append(sessionId, `turns-${n}`, { message: `m${n}` })).status,
      ).toBe(202);
    }
    const headers = { "X-Owner-Id": owner };
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/v1/sessions/${sessionId}/turns?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const response = await app.request(url, { headers });
      expect(response.status).toBe(200);
      const page = listTurnsResponseSchema.parse(await response.json());
      seen.push(...page.items.map((item) => item.turn_id));
      for (const item of page.items) {
        expect(item).toMatchObject({
          session_id: sessionId,
          status: "queued",
          terminal_reason: null,
          checkpoint_revision: null,
          started_at: null,
          ended_at: null,
        });
      }
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const bad of [
      "nope",
      Buffer.from('{"sequence":0}').toString("base64url"),
    ]) {
      const response = await app.request(
        `/v1/sessions/${sessionId}/turns?cursor=${bad}`,
        { headers },
      );
      expect(response.status, bad).toBe(400);
    }

    // Simulate a finished turn the way the worker records it.
    const [second] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence))
      .offset(1)
      .limit(1);
    if (!second) throw new Error("turn 2 missing");
    const startedAt = new Date("2026-09-22T01:00:00.000Z");
    const endedAt = new Date("2026-09-22T01:00:05.000Z");
    await db
      .update(turns)
      .set({
        status: "completed",
        terminalReason: "end_turn",
        attemptId: "attempt-1",
        startedAt,
        endedAt,
        resultJson: {
          result: "Fixed the failing test.",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      })
      .where(eq(turns.id, second.id));
    await db.insert(checkpoints).values({
      sessionId,
      revision: 3,
      manifestRef: "s3://claude-sessions/manifest",
      manifestSha256: "0".repeat(64),
      turnId: second.id,
    });

    const detail = await app.request(`/v1/sessions/${sessionId}/turns/2`, {
      headers,
    });
    expect(detail.status).toBe(200);
    expect(getTurnResponseSchema.parse(await detail.json())).toMatchObject({
      turn_id: "2",
      session_id: sessionId,
      status: "completed",
      message: "m2",
      terminal_reason: "end_turn",
      checkpoint_revision: 3,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      result: "Fixed the failing test.",
      usage: { input_tokens: 10, output_tokens: 20 },
      // Attempts stay empty until they are persisted per attempt.
      attempts: [],
    });
    const queued = getTurnResponseSchema.parse(
      await (
        await app.request(`/v1/sessions/${sessionId}/turns/3`, { headers })
      ).json(),
    );
    expect(queued).toMatchObject({
      status: "queued",
      result: null,
      usage: null,
      attempts: [],
    });
    const listed = listTurnsResponseSchema.parse(
      await (
        await app.request(`/v1/sessions/${sessionId}/turns?limit=2`, {
          headers,
        })
      ).json(),
    );
    expect(listed.items[1]).toMatchObject({
      turn_id: "2",
      status: "completed",
      checkpoint_revision: 3,
    });
    for (const turnId of [
      "0",
      "8",
      "02",
      "abc",
      "1e1",
      "2147483648",
      "9999999999",
      "99999999999",
    ]) {
      const response = await app.request(
        `/v1/sessions/${sessionId}/turns/${turnId}`,
        { headers },
      );
      expect(response.status, turnId).toBe(404);
    }
  }, 60_000);

  test("answers 429 with Retry-After once the session holds its limit of queued input", async () => {
    const sessionId = await createdSession("limit-queue-1");
    const response = await tight.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": owner,
        "Idempotency-Key": "limit-queue-2",
      },
      body: JSON.stringify({ message: "one more" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect((await response.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect((await rowsFor(sessionId)).turns).toBe(1);
  }, 60_000);

  test("answers 413 STORAGE_LIMIT_EXCEEDED past the installation's storage, and writes nothing", async () => {
    const response = await tight.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": owner,
        "Idempotency-Key": "limit-storage-1",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect((await response.json()).error).toMatchObject({
      code: "STORAGE_LIMIT_EXCEEDED",
      retryable: false,
    });
    const [keys] = await db
      .select({ n: count() })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "limit-storage-1"));
    expect(keys?.n).toBe(0);
  }, 60_000);

  const reasonOf = (detail: { attention: unknown }) =>
    (detail.attention as { reason?: string } | null)?.reason ?? "";

  test("detail raises BUDGET_EXCEEDED once the session's cost reaches the limit", async () => {
    const sessionId = await createdSession("limit-budget-1");
    const detail = async () => {
      const response = await tight.request(`/v1/sessions/${sessionId}`, {
        headers: { "X-Owner-Id": owner },
      });
      expect(response.status).toBe(200);
      return getSessionResponseSchema.parse(await response.json());
    };
    await db
      .update(sessions)
      .set({ costUsd: 0.99 })
      .where(eq(sessions.id, sessionId));
    expect((await detail()).attention).toBeNull();

    await db
      .update(sessions)
      .set({ costUsd: 1 })
      .where(eq(sessions.id, sessionId));
    const spent = await detail();
    expect(spent.attention?.code).toBe("BUDGET_EXCEEDED");
    expect(reasonOf(spent)).toContain("its 1 USD cost limit;");
    expect(reasonOf(spent)).not.toContain("token");
    expect(JSON.stringify(spent)).not.toContain("cost_usd");
  }, 60_000);

  test("detail raises BUDGET_EXCEEDED once an unmetered session's tokens reach the limit, naming no dollar limit", async () => {
    const sessionId = await createdSession("limit-budget-tokens-1");
    await db
      .update(sessions)
      .set({ unmetered: true })
      .where(eq(sessions.id, sessionId));
    const detail = async (on: typeof tight) => {
      const response = await on.request(`/v1/sessions/${sessionId}`, {
        headers: { "X-Owner-Id": owner },
      });
      expect(response.status).toBe(200);
      return getSessionResponseSchema.parse(await response.json());
    };
    await db
      .update(sessions)
      .set({ providerTokens: 99 })
      .where(eq(sessions.id, sessionId));
    expect((await detail(tight)).attention).toBeNull();

    await db
      .update(sessions)
      .set({ providerTokens: 100 })
      .where(eq(sessions.id, sessionId));
    const spent = await detail(tight);
    expect(spent.attention?.code).toBe("BUDGET_EXCEEDED");
    expect(reasonOf(spent)).toContain("its 100 token limit;");
    expect(reasonOf(spent)).not.toContain("USD");
    expect(JSON.stringify(spent)).not.toContain("provider_tokens");

    await db
      .update(sessions)
      .set({ costUsd: 1 })
      .where(eq(sessions.id, sessionId));
    expect(reasonOf(await detail(tight))).toContain(
      "its 1 USD cost limit and its 100 token limit;",
    );
    // The installation with no token limit says nothing about the count.
    expect((await detail(app)).attention).toBeNull();
  }, 60_000);

  test("detail raises CATALOG_MISMATCH while the catalog does not allow the session's pair, and drops it once restored", async () => {
    const sessionId = await createdSession("catalog-mismatch-1");
    const detail = async () => {
      const read = await app.request(`/v1/sessions/${sessionId}`, {
        headers: { "X-Owner-Id": owner },
      });
      expect(read.status).toBe(200);
      const text = await read.text();
      return { text, detail: getSessionResponseSchema.parse(JSON.parse(text)) };
    };
    expect((await detail()).detail.attention).toBeNull();

    // What an operator pointing sample-app at another URL looks like from
    // the session's side: the row keeps the URL it was created against.
    const movedFrom = "https://moved.invalid/elsewhere.git";
    await db
      .update(sessions)
      .set({ repoUrl: movedFrom })
      .where(eq(sessions.id, sessionId));
    const moved = await detail();
    expect(moved.detail.attention).toMatchObject({ code: "CATALOG_MISMATCH" });
    expect(moved.text).not.toContain("moved.invalid");

    await db
      .update(sessions)
      .set({ branch: "release" })
      .where(eq(sessions.id, sessionId));
    await db
      .update(sessions)
      .set({ repoUrl: catalog.repositories["sample-app"]?.url })
      .where(eq(sessions.id, sessionId));
    expect((await detail()).detail.attention).toMatchObject({
      code: "CATALOG_MISMATCH",
    });

    await db
      .update(sessions)
      .set({ branch: "main" })
      .where(eq(sessions.id, sessionId));
    expect((await detail()).detail.attention).toBeNull();
  }, 60_000);

  test("repository_id follows the profile's repository mode: required needs it, none refuses it, optional takes either", async () => {
    const message = "Summarize the meeting notes.";
    const refusal = async (payload: unknown) => {
      const response = await create(crypto.randomUUID(), payload);
      expect(response.status).toBe(422);
      return ((await response.json()) as { error: unknown }).error;
    };
    expect(
      await refusal({ profile_id: "claude-coding-v1", message }),
    ).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message:
        "Profile claude-coding-v1 needs a repository: send repository_id",
    });
    expect(
      await refusal({
        profile_id: "general",
        repository_id: "sample-app",
        message,
      }),
    ).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message: "Profile general runs without a repository: omit repository_id",
    });
    const nulled = await create(crypto.randomUUID(), {
      profile_id: "general",
      repository_id: null,
      message,
    });
    expect(nulled.status).toBe(400);

    const rowOf = async (sessionId: string) => {
      const [row] = await db
        .select({
          repositoryMode: sessions.repositoryMode,
          repositoryId: sessions.repositoryId,
          repoUrl: sessions.repoUrl,
          branch: sessions.branch,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return row;
    };
    const without = {
      repositoryMode: "none" as const,
      repositoryId: null,
      repoUrl: null,
      branch: null,
    };
    const created = async (payload: unknown) => {
      const response = await create(crypto.randomUUID(), payload);
      expect(response.status).toBe(201);
      return createSessionResponseSchema.parse(await response.json())
        .session_id;
    };
    const general = await created({ profile_id: "general", message });
    expect(await rowOf(general)).toEqual(without);
    expect(
      await rowOf(
        await created({ profile_id: "claude-coding-optional", message }),
      ),
    ).toEqual(without);
    expect(
      await rowOf(
        await created({
          profile_id: "claude-coding-optional",
          repository_id: "sample-app",
          message,
        }),
      ),
    ).toEqual({
      repositoryMode: "repository",
      repositoryId: "sample-app",
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
    });

    const read = await app.request(`/v1/sessions/${general}`, {
      headers: { "X-Owner-Id": owner },
    });
    const text = await read.text();
    const detail = getSessionResponseSchema.parse(JSON.parse(text));
    expect(detail.repository_id).toBeNull();
    expect(detail.attention).toBeNull();
    expect(text).not.toContain("repository_mode");
  }, 60_000);

  test("a create without a repository replays, even after the catalog stops allowing it", async () => {
    const message = "Summarize the meeting notes.";
    const narrowed = createApiApp({
      authMode: "none",
      registerRoutes: (router) =>
        registerSessionRoutes(
          router,
          createSessionService({
            limits: {
              queuedInputLimitPerSession: 1_000,
              storageLimitBytes: 1e15,
              sessionCostLimitUsd: 1_000,
              sessionTokenLimit: null,
            },
            authorization: createAuthorizationPolicy(),
            inputs: createPostgresSessionUnitOfWork(db),
            controls: createPostgresSessionControl(db),
            reader: createPostgresSessionReader(db),
            catalog: withSeededInstallation({
              profiles: {
                "claude-coding-v1": coding,
                "claude-coding-optional": coding,
              },
              repositories: catalog.repositories,
            }),
          }),
        ),
    });
    const receiptCount = async () =>
      (
        await db
          .select({ n: count() })
          .from(receipts)
          .where(eq(receipts.ownerId, owner))
      )[0]?.n;

    for (const profileId of ["general", "claude-coding-optional"]) {
      const key = crypto.randomUUID();
      const payload = { profile_id: profileId, message };
      const first = await create(key, payload);
      expect(first.status).toBe(201);
      const created = createSessionResponseSchema.parse(await first.json());
      const receiptsBefore = await receiptCount();

      const replay = await create(key, payload);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(created);

      const later = await narrowed.request("/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Id": owner,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
      });
      expect(later.status).toBe(201);
      expect(await later.json()).toEqual(created);

      const conflict = await create(key, {
        ...payload,
        repository_id: "sample-app",
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");

      expect(await rowsFor(created.session_id)).toEqual({
        sessions: 1,
        turns: 1,
        queue: 1,
        unassigned: 1,
      });
      expect(await receiptCount()).toBe(receiptsBefore);
    }
  }, 60_000);

  test("a session without a repository is judged by its profile alone: CATALOG_MISMATCH and profile changes", async () => {
    const response = await create(crypto.randomUUID(), {
      profile_id: "general",
      message: "Draft the weekly report.",
    });
    expect(response.status).toBe(201);
    const { session_id: sessionId } = createSessionResponseSchema.parse(
      await response.json(),
    );
    const detail = async () => {
      const read = await app.request(`/v1/sessions/${sessionId}`, {
        headers: { "X-Owner-Id": owner },
      });
      expect(read.status).toBe(200);
      return getSessionResponseSchema.parse(await read.json());
    };
    const changeTo = (profileId: string, expectedRevision: number) =>
      app.request(`/v1/sessions/${sessionId}/profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Id": owner,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          profile_id: profileId,
          expected_revision: expectedRevision,
        }),
      });

    expect((await detail()).attention).toBeNull();
    const refused = await changeTo(
      "claude-coding-v1",
      (await detail()).revision,
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "UNSUPPORTED_CAPABILITY",
        message:
          "Profile claude-coding-v1 is not in this host's catalog or needs a repository, which the session has none of",
      },
    });
    const moved = await changeTo(
      "claude-coding-optional",
      (await detail()).revision,
    );
    expect(moved.status).toBe(200);
    const [row] = await db
      .select({
        profileId: sessions.profileId,
        repositoryMode: sessions.repositoryMode,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row).toEqual({
      profileId: "claude-coding-optional",
      repositoryMode: "none",
    });
    expect((await detail()).attention).toBeNull();

    await db
      .update(sessions)
      .set({ profileFingerprint: "0".repeat(64) })
      .where(eq(sessions.id, sessionId));
    expect((await detail()).attention).toMatchObject({
      code: "CATALOG_MISMATCH",
    });
  }, 60_000);
});
