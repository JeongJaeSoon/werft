import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSessionResponseSchema } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  unassignedSessions,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import {
  MemoryLogSink,
  parseTraceparent,
  StructuredLogger,
} from "@werft-ai/observability";
import { createOtelTracer } from "@werft-ai/observability/otel";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  allowingPolicy,
  allowRepositories,
  releaseIn,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";

/**
 * The traceparent of the request that queued a turn travels through the
 * turns row to the worker's nextInput answer (94S-731).
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const catalog: SessionCatalog = testCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
    },
  },
});

integration("turn trace context end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let server: ReturnType<typeof Bun.serve>;
  let tracer: ReturnType<typeof createOtelTracer>;
  const spanIds: string[] = [];
  const logs = new MemoryLogSink();
  const owner = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "turn_trace_context_e2e" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    releaseId = await releaseIn(db, owner);
    await allowRepositories(db, owner, ["sample-app"]);
    tracer = createOtelTracer({
      serviceName: "werft-api-test",
      sampler: { kind: "always_on", ratio: 1 },
      headers: {},
      tenantHeaders: () => ({}),
      exporter: {
        export(batch, done) {
          for (const span of batch) spanIds.push(span.spanContext().spanId);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    const sessions = startingInWorkspace(
      createSessionService({
        authorization: createAuthorizationPolicy(),
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
        limits: {
          queuedInputLimitPerSession: 1_000,
          storageLimitBytes: 1e15,
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
        },
        releases: sessionReleases(db, catalog),
      }),
      createSessionService({
        authorization: allowingPolicy,
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
        limits: {
          queuedInputLimitPerSession: 1_000,
          storageLimitBytes: 1e15,
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
        },
        releases: sessionReleases(db, catalog),
      }),
    );
    const workers = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: { verify: async () => ({ status: "verified" }) },
      pending: createPostgresWorkerPendingStore(db),
      options: {
        leaseTtlMs: 10_000,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
    });
    const app = createApiApp({
      authMode: "none",
      logger: new StructuredLogger({ sinks: [logs] }),
      tracer,
      registerRoutes: (router) => registerSessionRoutes(router, sessions),
      registerInternalRoutes: (router) => registerWorkerRoutes(router, workers),
    });
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  }, 90_000);

  afterAll(async () => {
    server?.stop(true);
    await pool?.end();
    await database?.drop();
  }, 90_000);

  async function createSession(): Promise<string> {
    const created = await fetch(`http://127.0.0.1:${server.port}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Owner-Id": owner,
      },
      body: JSON.stringify({
        agent_release_id: releaseId,
        repository_id: "sample-app",
        message: "first turn",
      }),
    });
    expect(created.status).toBe(201);
    return createSessionResponseSchema.parse(await created.json()).session_id;
  }

  async function firstInput(sessionId: string) {
    const partition = `turn-trace-${crypto.randomUUID()}`;
    await db
      .update(schema.sessions)
      .set({ partition })
      .where(eq(schema.sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const launch = await launchSession(db, { sessionId });
    const client = new HttpWorkerGatewayClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      credential: launch.nonce,
      requestTimeoutMs: 5_000,
    });
    const claim = await client.bootstrapClaim({
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    });
    client.useCredential(claim.session_credential);
    return client.nextInput({
      session_id: claim.session_id,
      turn_id: null,
      attempt_id: claim.attempt_id,
      lease_epoch: claim.lease_epoch,
      execution_generation: claim.execution_generation,
      auth_revision: claim.auth_revision,
      wait_ms: 0,
    });
  }

  test("the first turn carries the creating request's span to the worker", async () => {
    const sessionId = await createSession();
    const [turn] = await db
      .select({ traceContext: schema.turns.traceContext })
      .from(schema.turns)
      .where(eq(schema.turns.sessionId, sessionId));
    const stored = parseTraceparent(turn?.traceContext ?? "");
    expect(stored).toBeDefined();
    await tracer.shutdown();
    // The stored span is the request span the tracer exported, not an
    // id the database made up.
    expect(spanIds).toContain(stored?.spanId ?? "");
    // The completion log line of that same request names the same span.
    const completed = logs.records.find(
      (record) =>
        record.event === "api.request.completed" &&
        record.span_id === stored?.spanId,
    );
    expect(completed?.trace_id).toBe(stored?.traceId);

    const answer = await firstInput(sessionId);
    expect(answer.input?.trace_context).toBe(turn?.traceContext ?? "");
  }, 60_000);

  test("a follow-up stores its own request span, never the client's traceparent", async () => {
    const sessionId = await createSession();
    const client = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const posted = await fetch(
      `http://127.0.0.1:${server.port}/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-Owner-Id": owner,
          traceparent: client,
        },
        body: JSON.stringify({ message: "second turn" }),
      },
    );
    expect(posted.status).toBe(202);
    const rows = await db
      .select({
        sequence: schema.turns.sequence,
        traceContext: schema.turns.traceContext,
      })
      .from(schema.turns)
      .where(eq(schema.turns.sessionId, sessionId));
    const first = rows.find((row) => row.sequence === 1);
    const second = rows.find((row) => row.sequence === 2);
    const stored = parseTraceparent(second?.traceContext ?? "");
    expect(stored).toBeDefined();
    expect(stored?.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    // Its own request span, not the context turn 1 was queued under.
    expect(second?.traceContext).not.toBe(first?.traceContext);
  }, 60_000);
});
