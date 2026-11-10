import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  installationLimitsResponseSchema,
  sessionUsageResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresUsageReader,
  sessions,
  storageUsage,
  turns,
  workerLaunches,
} from "@werft-ai/db";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createUsageService,
  type InputLimits,
  type InstallationLimits,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { releaseIn } from "../test-support/releases.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const limits: InstallationLimits = {
  executionSlotLimit: 10,
  queuedInputLimitPerSession: 20,
  storageLimitBytes: 1_073_741_824,
  maxTurnSeconds: 3600,
  sessionCostLimitUsd: 2.5,
  sessionTokenLimit: null,
  providerMaxRetries: 2,
};
const roomy: InputLimits = {
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
};

integration("usage API on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "usage_it" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    db = drizzle(pool, { schema });
    const service = createUsageService({
      authorization: createAuthorizationPolicy(),
      reader: createPostgresUsageReader(db),
      limits,
    });
    app = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerUsageRoutes(router, service),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const inputs = () => createPostgresSessionUnitOfWork(db);

  // The installation's figures are the signed-in owner's alone.
  function installationOwner(): Caller {
    const workspaceId = crypto.randomUUID();
    return callerFor(
      {
        kind: "user",
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        role: "owner",
        scopes: ["sessions:read"],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  function get(path: string, owner: string) {
    return app.request(`http://localhost${path}`, {
      headers: { "X-Owner-Id": owner },
    });
  }

  async function session(ownerId: string, messages: string[]) {
    const [first, ...rest] = messages;
    const created = await inputs().acceptInputAtomic({
      limits: roomy,
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await releaseIn(db, ownerId),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: first ?? "first",
    });
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const sessionId = created.response.session_id;
    for (const message of rest) {
      const appended = await inputs().appendInputAtomic({
        limits: roomy,
        principal: { ownerId },
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
      if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    }
    return sessionId;
  }

  // Puts a turn in the state a finalize, a reconciler or an operator would
  // leave it in, without running any of them.
  function setTurn(
    sessionId: string,
    sequence: number,
    values: Partial<typeof turns.$inferInsert>,
  ) {
    return db
      .update(turns)
      .set(values)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
  }

  const ran = {
    startedAt: new Date("2026-09-23T00:00:00Z"),
    endedAt: new Date("2026-09-23T00:01:00Z"),
    attemptId: "attempt-1",
  };

  async function usageOf(sessionId: string, owner: string) {
    const response = await get(`/v1/sessions/${sessionId}/usage`, owner);
    expect(response.status).toBe(200);
    return sessionUsageResponseSchema.parse(await response.json());
  }

  test("every turn that reported a cost, zero included, makes the estimate complete", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["one", "two"]);
    await setTurn(id, 1, {
      ...ran,
      status: "completed",
      resultJson: { finalize_key: "k1", cost_usd: 0.75 },
    });
    await setTurn(id, 2, {
      ...ran,
      status: "failed",
      resultJson: { finalize_key: "k2", cost_usd: 0 },
    });
    await db.update(sessions).set({ costUsd: 0.75 }).where(eq(sessions.id, id));

    const usage = await usageOf(id, owner);

    expect(usage).toMatchObject({
      session_id: id,
      period: "session_lifetime",
      cost: {
        amount_usd: "0.750000",
        kind: "estimated",
        source: "provider_usage",
        completeness_scope: "turn_reports",
        complete: true,
        reported_turn_count: 2,
        unreported_turn_count: 0,
        open_turn_count: 0,
      },
      cost_limit_usd: "2.5",
      budget_exceeded: false,
      queued_input_count: 0,
      queued_input_limit: 20,
    });
  });

  test("a turn that ended without a cost makes it incomplete, whatever it ended as", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["a", "b", "c", "d", "e", "f"]);
    await setTurn(id, 1, {
      ...ran,
      status: "completed",
      resultJson: { cost_usd: 1 },
    });
    // Unknown outcome without a figure: the worker never said.
    await setTurn(id, 2, {
      ...ran,
      status: "outcome_unknown",
      outcomeUnknown: true,
      resultJson: { finalize_key: "k2", usage: null },
    });
    // Ended by the reconciler: no finalize, no result at all.
    await setTurn(id, 3, { ...ran, status: "failed", resultJson: null });
    // An explicit JSON null is no report either.
    await setTurn(id, 4, {
      ...ran,
      status: "interrupted",
      resultJson: { cost_usd: null },
    });
    // Abandoned by an operator after running: cancelled, but it spent.
    await setTurn(id, 5, {
      ...ran,
      status: "cancelled",
      outcomeUnknown: true,
      terminalReason: "operator_abandoned",
      resultJson: { operator_decision: { decision: "abandon" } },
    });
    // A row from before timestamps were written still counts.
    await setTurn(id, 6, {
      status: "completed",
      startedAt: null,
      attemptId: null,
      resultJson: null,
    });

    const usage = await usageOf(id, owner);

    expect(usage.cost).toMatchObject({
      complete: false,
      reported_turn_count: 1,
      unreported_turn_count: 5,
      open_turn_count: 0,
    });
  });

  test("an unknown outcome that did report its cost is not unreported", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["only"]);
    await setTurn(id, 1, {
      ...ran,
      status: "outcome_unknown",
      outcomeUnknown: true,
      resultJson: { cost_usd: 0.1 },
    });

    expect((await usageOf(id, owner)).cost).toMatchObject({
      complete: true,
      reported_turn_count: 1,
      unreported_turn_count: 0,
    });
  });

  test("queued input cancelled before it ran is neither reported nor missing", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["ran", "never ran"]);
    await setTurn(id, 1, {
      ...ran,
      status: "completed",
      resultJson: { cost_usd: 0.2 },
    });
    await setTurn(id, 2, {
      status: "cancelled",
      endedAt: new Date(),
      terminalReason: "terminated",
    });

    expect((await usageOf(id, owner)).cost).toMatchObject({
      complete: true,
      reported_turn_count: 1,
      unreported_turn_count: 0,
    });
  });

  test("a running turn keeps it incomplete; queued input does not", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["running", "queued", "queued too"]);
    await setTurn(id, 1, { ...ran, endedAt: null, status: "running" });

    const running = await usageOf(id, owner);
    expect(running.cost).toMatchObject({
      complete: false,
      open_turn_count: 1,
      unreported_turn_count: 0,
    });
    expect(running.queued_input_count).toBe(2);

    await setTurn(id, 1, { ...ran, status: "needs_input" });
    expect((await usageOf(id, owner)).cost.open_turn_count).toBe(1);

    await setTurn(id, 1, {
      ...ran,
      status: "completed",
      resultJson: { cost_usd: 0.3 },
    });
    expect((await usageOf(id, owner)).cost.complete).toBe(true);
  });

  test("a session that has not run anything is complete at zero", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["waiting"]);

    expect(await usageOf(id, owner)).toMatchObject({
      cost: {
        amount_usd: "0.000000",
        complete: true,
        reported_turn_count: 0,
        unreported_turn_count: 0,
        open_turn_count: 0,
      },
      queued_input_count: 1,
    });
  });

  test("budget_exceeded uses the gate's own comparison", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["spent"]);
    await db
      .update(sessions)
      .set({ costUsd: limits.sessionCostLimitUsd })
      .where(eq(sessions.id, id));

    const usage = await usageOf(id, owner);

    expect(usage.cost.amount_usd).toBe("2.500000");
    expect(usage.budget_exceeded).toBe(true);
  });

  test("budget_exceeded also counts tokens once a token limit is set, whatever they cost", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["many tokens"]);
    await db
      .update(sessions)
      .set({ providerTokens: 1_000 })
      .where(eq(sessions.id, id));

    const unlimited = await usageOf(id, owner);
    expect(unlimited).toMatchObject({
      token_count: 1_000,
      token_limit: null,
      budget_exceeded: false,
    });

    const tokenLimited = createUsageService({
      authorization: createAuthorizationPolicy(),
      reader: createPostgresUsageReader(db),
      limits: { ...limits, sessionTokenLimit: 1_000 },
    });
    const usage = sessionUsageResponseSchema.parse(
      await tokenLimited.getSessionUsage(testCaller(owner), id),
    );
    expect(usage).toMatchObject({
      cost: { amount_usd: "0.000000" },
      token_count: 1_000,
      token_limit: 1_000,
      budget_exceeded: true,
    });
    expect(
      (await tokenLimited.getInstallationLimits(installationOwner())).limits
        .session_token_limit,
    ).toBe(1_000);
  });

  test("the token count stops at the largest safe integer however much is recorded", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["huge usage"]);
    const executionId = `exec-${crypto.randomUUID()}`;
    const attemptId = `att-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
       VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
      [executionId, id],
    );
    await pool.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
       VALUES ($1, $2, $3, 1, 1, 1, 'exited', now())`,
      [attemptId, id, executionId],
    );
    // bigint's own maximum: one call's four counts overflow a bigint sum.
    const huge = "9223372036854775807";
    for (let call = 0; call < 3; call++) {
      await pool.query(
        `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated, cost_usd, priced_by)
         VALUES ($1, $2, $3, 'claude-sonnet-4-5', $4, $4, $4, $4, $4, false, 0.5, 'table')`,
        [crypto.randomUUID(), id, attemptId, huge],
      );
    }

    const usage = await usageOf(id, owner);
    expect(usage.token_count).toBe(Number.MAX_SAFE_INTEGER);
    const ledger = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_usage WHERE session_id = $1",
      [id],
    );
    expect(ledger.rows[0]?.count).toBe("3");
  });

  test("another owner's session, a missing one and a malformed id all answer 404", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["mine"]);

    for (const [path, caller] of [
      [`/v1/sessions/${id}/usage`, crypto.randomUUID()],
      [`/v1/sessions/${crypto.randomUUID()}/usage`, owner],
      ["/v1/sessions/not-a-uuid/usage", owner],
    ] as const) {
      const response = await get(path, caller);
      expect(response.status, path).toBe(404);
      expect(
        apiErrorResponseSchema.parse(await response.json()).error.code,
      ).toBe("NOT_FOUND");
    }
    expect((await get(`/v1/sessions/${id}/usage`, owner)).status).toBe(200);
  });

  test("an unauthenticated caller gets 401 from every route", async () => {
    for (const path of [
      "/v1/limits",
      "/v1/usage/summary?scope=me&since=2026-10-01",
      `/v1/sessions/${crypto.randomUUID()}/usage`,
    ]) {
      const response = await app.request(`http://localhost${path}`);
      expect(response.status, path).toBe(401);
    }
  });

  test("GET /v1/limits reports the configured limits and installation-wide usage", async () => {
    const owner = crypto.randomUUID();
    const id = await session(owner, ["queued input"]);
    await db.insert(workerLaunches).values([
      // Held, whether or not a worker ever came up for it.
      {
        executionId: `exec-${crypto.randomUUID()}`,
        generation: 1,
        backend: "local-docker",
        sessionId: id,
      },
      {
        executionId: `exec-${crypto.randomUUID()}`,
        generation: 1,
        backend: "local-docker",
      },
      {
        executionId: `exec-${crypto.randomUUID()}`,
        generation: 1,
        backend: "local-docker",
        slotReleasedAt: new Date(),
      },
    ]);
    const queued = await db.$count(turns, eq(turns.status, "queued"));
    const [storage] = await db
      .select({ bytes: storageUsage.bytes })
      .from(storageUsage)
      .where(eq(storageUsage.scope, "installation"));

    const body = installationLimitsResponseSchema.parse(
      await createUsageService({
        authorization: createAuthorizationPolicy(),
        reader: createPostgresUsageReader(db),
        limits,
      }).getInstallationLimits(installationOwner()),
    );

    expect(body).toMatchObject({
      scope: "installation",
      limits: {
        execution_slot_limit: 10,
        queued_input_limit_per_session: 20,
        storage_limit_bytes: 1_073_741_824,
        max_turn_seconds: 3600,
        session_cost_limit_usd: "2.5",
        provider_max_retries: 2,
      },
      usage: {
        execution_slots_used: 2,
        queued_input_count: queued,
        storage: {
          used_bytes: storage?.bytes,
          accounted_content: ["input_messages"],
        },
      },
    });
    // Charged by the turns trigger for every input these tests wrote.
    expect(body.usage.storage.used_bytes).toBeGreaterThan(0);
    expect(body.usage.storage.updated_at).not.toBeNull();
    // Outputs sit beside storage, never inside it: see
    // packages/db/src/output-usage.integration.test.ts for the counting.
    expect(Object.keys(body.usage.outputs).sort()).toEqual([
      "complete",
      "updated_at",
      "used_bytes",
    ]);
  });
});
