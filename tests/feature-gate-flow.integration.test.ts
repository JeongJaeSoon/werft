import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createSessionResponseSchema,
  getSessionResponseSchema,
  listTurnsResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSchedulerStore,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import {
  TEST_MODEL,
  TEST_RUNTIME_VERSION,
  testSpecSource,
} from "@werft-ai/db/testing/spec-pins";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionObservation,
  type ExecutionRef,
  type LaunchIntent,
  type ManagedExecution,
  runScheduler,
  type SessionCatalog,
  type TerminateExecutionResult,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  allowingPolicy,
  releaseOnConnection,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";
import { unwiredCheckpoints } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import { ScriptedRun } from "../apps/worker/src/testing/scripted-run.ts";
import {
  WorkerHost,
  type WorkerRunSummary,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";

/**
 * A release the control plane let through, run by a worker whose engine
 * cannot serve it: the catalog names auto mode, the started run offers no
 * classifier. A real WorkerHost refuses it at the Worker Gateway's own HTTP
 * routes before taking the queued input, and the public API says why. Only
 * the container runtime and the engine are fake.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

const CATALOG: SessionCatalog = testCatalog({
  repositories: {},
  auto_mode: "supported",
});
const REASON = `Runtime claude_agent_sdk ${TEST_RUNTIME_VERSION} cannot run this session's settings: it does not support classifier_review`;

/** Runs a real WorkerHost over a run with no classifier for each container started. */
class WorkerBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  readonly running = new Map<string, ManagedExecution>();
  readonly runs: ScriptedRun[] = [];
  private starting: Array<{ intent: LaunchIntent; nonce: string }> = [];

  constructor(private readonly gatewayUrl: () => string) {}

  capabilities() {
    return { suspend: false };
  }

  async resolveImage(reference: string): Promise<string> {
    return reference;
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const nonce = await intent.issueBootstrapNonce();
    const providerRef = `ctr-${intent.executionId}`;
    this.running.set(intent.executionId, {
      executionId: intent.executionId,
      generation: intent.generation,
      providerRef,
      sessionId: intent.sessionId,
      state: "running",
    });
    this.starting.push({ intent, nonce });
    return { created: true, providerRef, state: "running" };
  }

  async startWorkers(): Promise<WorkerRunSummary[]> {
    const started = this.starting;
    this.starting = [];
    return Promise.all(
      started.map(async ({ intent, nonce }) => {
        const run = new ScriptedRun();
        this.runs.push(run);
        const host = new WorkerHost({
          checkpoints: unwiredCheckpoints,
          execution: {
            bootstrapNonce: nonce,
            generation: intent.generation,
            id: intent.executionId,
          },
          gateway: new HttpWorkerGatewayClient({
            baseUrl: this.gatewayUrl(),
            credential: nonce,
            requestTimeoutMs: 5_000,
          }),
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          runtimes: { launcherFor: () => ({ start: () => run }) },
          timeouts: {
            answerPollIntervalMs: 1_000,
            claimTimeoutMs: 30_000,
            drainTimeoutMs: 5_000,
            heartbeatIntervalMs: 10_000,
            idleTimeoutMs: 300,
            maxTurnMs: 60_000,
            nextInputWaitMs: 100,
            questionTimeoutMs: 5_000,
            requestTimeoutMs: 5_000,
          },
          workspace: noWorkspace,
        });
        const summary = await host.runLoop();
        const found = this.running.get(intent.executionId);
        if (found) {
          this.running.set(intent.executionId, {
            ...found,
            state: "terminated",
          });
        }
        return summary;
      }),
    );
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const found = this.running.get(ref.executionId);
    return found
      ? {
          found: true,
          observedAt: new Date(),
          providerRef: found.providerRef,
          state: found.state,
          exitCode: found.state === "terminated" ? 1 : null,
        }
      : {
          found: false,
          observedAt: new Date(),
          providerRef: null,
          state: "unknown",
        };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    return [...this.running.values()];
  }

  async terminate(ref: ExecutionRef): Promise<TerminateExecutionResult> {
    const found = this.running.get(ref.executionId);
    if (!found) return { outcome: "absent" };
    this.running.delete(ref.executionId);
    return { outcome: "terminated", providerRef: found.providerRef };
  }
}

let database: TempDatabase;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let server: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApiApp>;
const owner = crypto.randomUUID();
let releaseId = "";

beforeAll(async () => {
  if (!databaseUrl) return;
  database = await createTempDatabase({ prefix: "feature_gate_e2e" });
  pool = new Pool({ connectionString: database.url, max: 16 });
  db = drizzle(pool, { schema });
  // A release whose spec runs auto mode, with no repository.
  releaseId = await releaseOnConnection(db, {
    workspaceId: owner,
    model: TEST_MODEL,
    connection: testSpecSource().connection,
    spec: { permission_mode: "auto", repository_mode: "none" },
  });
  const sessions = startingInWorkspace(
    createSessionService({
      authorization: createAuthorizationPolicy(),
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog: CATALOG,
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      releases: sessionReleases(db, CATALOG),
    }),
    createSessionService({
      authorization: allowingPolicy,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog: CATALOG,
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      releases: sessionReleases(db, CATALOG),
    }),
  );
  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: CATALOG,
    checkpoints: { verify: async () => ({ status: "verified" }) },
    pending: createPostgresWorkerPendingStore(db),
    options: {
      leaseTtlMs: 30_000,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });
  app = createApiApp({
    authMode: "none",
    logger: createLogger({ sinks: [] }),
    registerRoutes: (router) => registerSessionRoutes(router, sessions),
    registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
  });
  server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
}, 60_000);

afterAll(async () => {
  server?.stop(true);
  await pool?.end();
  await database?.drop();
}, 60_000);

async function read(path: string) {
  const response = await app.request(path, {
    headers: { "X-Owner-Id": owner },
  });
  expect(response.status).toBe(200);
  return response.json();
}

integration(
  "a session whose spec needs a feature the engine lacks fails before its first input, saying which",
  async () => {
    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Owner-Id": owner,
      },
      body: JSON.stringify({ agent_release_id: releaseId, message: "hello" }),
    });
    expect(response.status).toBe(201);
    const created = createSessionResponseSchema.parse(await response.json());

    const backend = new WorkerBackend(() => `http://127.0.0.1:${server.port}`);
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });
    const pass = () =>
      runScheduler({
        backend,
        image: "worker:test",
        logger: { error: () => {}, info: () => {}, warn: () => {} },
        resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 64 },
        slotLimit: 1,
        store,
      });

    expect((await pass()).launched).toHaveLength(1);
    const [summary] = await backend.startWorkers();
    expect(summary).toEqual({ outcome: "failed", reason: REASON, turns: [] });
    expect(backend.runs.map((run) => run.inputs)).toEqual([[]]);

    // The next pass sees the container gone and counts the failed startup.
    await pass();
    const detail = getSessionResponseSchema.parse(
      await read(`/v1/sessions/${created.session_id}`),
    );
    expect(detail.attention).toMatchObject({
      code: "STARTUP_FAILED",
      reason: REASON,
      failures: 1,
    });
    const turns = listTurnsResponseSchema.parse(
      await read(`/v1/sessions/${created.session_id}/turns`),
    );
    expect(turns.items.map((turn) => turn.status)).toEqual(["queued"]);
  },
  60_000,
);
