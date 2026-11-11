import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  createSessionResponseSchema,
  getReceiptResponseSchema,
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
  queueMessages,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  type CatalogProfile,
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
  withSeededInstallation,
} from "@werft-ai/platform";
import type { ScriptedStep } from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerReceiptRoutes } from "../apps/control-host/src/api/routes/sessions/receipts.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import {
  SCRIPTED_KIND,
  startScripted,
} from "../apps/worker/src/testing/scripted-engine.ts";
import {
  inputUuid,
  WorkerHost,
  type WorkerLogger,
  type WorkerRunSummary,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";

/**
 * Catalog mismatch end to end in one process: an operator
 * re-points a repository id at another URL while a session created against
 * the old one is queued. With one execution slot, the scheduler launches
 * that session first; a real WorkerHost trades the launch nonce at the
 * Worker Gateway's own HTTP route, is refused with CATALOG_MISMATCH at once
 * rather than after its claim timeout, and the next pass hands the slot to
 * the session that can run. The public API then says what happened. Only the
 * container runtime and the engine are fake.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const PROFILE_ID = "claude-coding-v1";
const OLD_URL = "https://old.invalid/app.git";
const NEW_URL = "https://example.invalid/app.git";
const CLAIM_TIMEOUT_MS = 30_000;

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: [],
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

function catalogAt(url: string): SessionCatalog {
  return withSeededInstallation({
    // Ahead of every write here: a host behind its settings fails nothing.
    settings_generation: Number.MAX_SAFE_INTEGER,
    profiles: {
      [PROFILE_ID]: PROFILE,
      general: { ...PROFILE, tools: ["Read", "Write"], repository: "none" },
    },
    repositories: {
      "sample-app": { url, branch: "main", profiles: [PROFILE_ID] },
    },
  });
}

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const committing = (): WorkerCheckpointPort => {
  let revision = -1;
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation): Promise<CheckpointRef | null> => {
      if (preparation.status !== "ready") return null;
      revision += 1;
      return {
        revision,
        manifest_ref: `manifests/${revision}.json`,
        manifest_sha256: "c".repeat(64),
      };
    },
  };
};

/**
 * A daemon that records what it was asked to run; `startWorkers` then runs a
 * real WorkerHost for each container started since, as the container would.
 */
class WorkerBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  readonly running = new Map<string, ManagedExecution>();
  private starting: Array<{ intent: LaunchIntent; nonce: string }> = [];

  constructor(
    private readonly gatewayUrl: () => string,
    /** The queued input's id, which the engine's result must name. */
    private readonly inputIdOf: (sessionId: string) => Promise<string>,
  ) {}

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

  async startWorkers(): Promise<
    Array<{ sessionId: string; summary: WorkerRunSummary; elapsedMs: number }>
  > {
    const started = this.starting;
    this.starting = [];
    return Promise.all(
      started.map(async ({ intent, nonce }) => {
        const uuid = inputUuid(
          intent.sessionId,
          "1",
          await this.inputIdOf(intent.sessionId),
        );
        const steps: ScriptedStep[] = [
          { type: "await-input" },
          {
            type: "emit",
            message: {
              type: "result",
              subtype: "success",
              session_id: "fake-session",
              is_error: false,
              user_message_uuid: uuid,
            },
          },
          { type: "await-input" },
        ];
        const runtime = fakeRuntimeFor(SCRIPTED_KIND, steps);
        const host = new WorkerHost({
          checkpoints: committing(),
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
          logger: silent,
          runtimes: {
            launcherFor: () => ({
              start: (launch) => startScripted(runtime, launch),
            }),
          },
          timeouts: {
            answerPollIntervalMs: 1_000,
            claimTimeoutMs: CLAIM_TIMEOUT_MS,
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
        const began = performance.now();
        const summary = await host.runLoop();
        // The container is gone once its process is.
        const found = this.running.get(intent.executionId);
        if (found) {
          this.running.set(intent.executionId, {
            ...found,
            state: "terminated",
          });
        }
        return {
          sessionId: intent.sessionId,
          summary,
          elapsedMs: performance.now() - began,
        };
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
          exitCode: found.state === "terminated" ? 0 : null,
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

integration("a session whose pair left the catalog, end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let server: ReturnType<typeof Bun.serve>;
  let before: ReturnType<typeof createApiApp>;
  let after: ReturnType<typeof createApiApp>;
  const owner = `owner-${crypto.randomUUID()}`;

  const serviceFor = (catalog: SessionCatalog) =>
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
    });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "catalog_mismatch_e2e" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    // The API as it ran before the operator re-pointed sample-app.
    before = createApiApp({
      authMode: "none",
      logger: createLogger({ sinks: [] }),
      registerRoutes: (router) =>
        registerSessionRoutes(router, serviceFor(catalogAt(OLD_URL))),
    });
  }, 60_000);

  afterAll(async () => {
    server?.stop(true);
    await pool?.end();
    await database?.drop();
  }, 60_000);

  /** The API restarted with the new catalog, gateway routes included. */
  function restartWithNewCatalog() {
    const catalog = catalogAt(NEW_URL);
    const sessions = serviceFor(catalog);
    const gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: { verify: async () => ({ status: "verified" }) },
      pending: createPostgresWorkerPendingStore(db),
      options: {
        leaseTtlMs: 30_000,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
    });
    after = createApiApp({
      authMode: "none",
      logger: createLogger({ sinks: [] }),
      registerRoutes: (router) => {
        registerSessionRoutes(router, sessions);
        registerReceiptRoutes(router, sessions);
      },
      registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
    });
    server = Bun.serve({ port: 0, fetch: (request) => after.fetch(request) });
  }

  async function create(
    app: ReturnType<typeof createApiApp>,
    message: string,
    run: { profile_id: string; repository_id?: string } = {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
    },
  ) {
    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Owner-Id": owner,
      },
      body: JSON.stringify({ ...run, message }),
    });
    expect(response.status).toBe(201);
    return createSessionResponseSchema.parse(await response.json());
  }

  async function read(path: string) {
    const response = await after.request(path, {
      headers: { "X-Owner-Id": owner },
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  test("slot 1: the dropped session is failed at its first claim and the next pass launches the other", async () => {
    const dropped = await create(before, "queued before the move");
    restartWithNewCatalog();
    const healthy = await create(after, "queued after the move");

    const backend = new WorkerBackend(
      () => `http://127.0.0.1:${server.port}`,
      async (sessionId) => {
        const [queued] = await db
          .select({ id: queueMessages.id })
          .from(queueMessages)
          .where(eq(queueMessages.sessionId, sessionId));
        return String(queued?.id ?? "none");
      },
    );
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

    // The dropped session was signalled first, so it takes the only slot.
    const first = await pass();
    expect(first.launched).toHaveLength(1);
    const [refused] = await backend.startWorkers();
    expect(refused?.sessionId).toBe(dropped.session_id);
    expect(refused?.summary.outcome).toBe("unclaimed");
    // Refused at the first claim, not retried until the claim timeout.
    expect(refused?.elapsedMs).toBeLessThan(5_000);

    const second = await pass();
    expect(second.launched).toHaveLength(1);
    expect(second.activeAfter).toBe(1);
    const [ran] = await backend.startWorkers();
    expect(ran?.sessionId).toBe(healthy.session_id);
    expect(ran?.summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);

    // What the client sees of the dropped session.
    const detail = getSessionResponseSchema.parse(
      await read(`/v1/sessions/${dropped.session_id}`),
    );
    expect(detail.status).toBe("failed");
    expect(detail.attention).toMatchObject({ code: "CATALOG_MISMATCH" });
    const receipt = getReceiptResponseSchema.parse(
      await read(`/v1/receipts/${dropped.receipt_id}`),
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.error).toMatchObject({ code: "CATALOG_MISMATCH" });
    const turns = listTurnsResponseSchema.parse(
      await read(`/v1/sessions/${dropped.session_id}/turns`),
    );
    expect(turns.items.map((t) => [t.status, t.terminal_reason])).toEqual([
      ["failed", "catalog_mismatch"],
    ]);
    // The old URL is never shown back.
    expect(JSON.stringify([detail, receipt, turns])).not.toContain(
      "old.invalid",
    );

    const other = getSessionResponseSchema.parse(
      await read(`/v1/sessions/${healthy.session_id}`),
    );
    expect(other.attention).toBeNull();
  }, 60_000);

  test("a session without a repository runs on its profile alone, and is failed once the profile it was pinned to is gone", async () => {
    const general = { profile_id: "general" };
    const runs = await create(after, "no repository", general);
    const stale = await create(after, "no repository, edited since", general);
    await db
      .update(schema.sessions)
      .set({ profileFingerprint: "0".repeat(64) })
      .where(eq(schema.sessions.id, stale.session_id));

    const backend = new WorkerBackend(
      () => `http://127.0.0.1:${server.port}`,
      async (sessionId) => {
        const [queued] = await db
          .select({ id: queueMessages.id })
          .from(queueMessages)
          .where(eq(queueMessages.sessionId, sessionId));
        return String(queued?.id ?? "none");
      },
    );
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
    const [ran] = await backend.startWorkers();
    expect(ran?.sessionId).toBe(runs.session_id);
    expect(ran?.summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    const issued = await db
      .select({ purpose: schema.workerCredentials.purpose })
      .from(schema.workerCredentials)
      .innerJoin(
        schema.attempts,
        eq(schema.attempts.id, schema.workerCredentials.attemptId),
      )
      .where(eq(schema.attempts.sessionId, runs.session_id));
    expect(issued.map((row) => row.purpose)).not.toContain("repository");

    expect((await pass()).launched).toHaveLength(1);
    const [refused] = await backend.startWorkers();
    expect(refused?.sessionId).toBe(stale.session_id);
    expect(refused?.summary.outcome).toBe("unclaimed");
    expect(refused?.elapsedMs).toBeLessThan(5_000);

    const detail = getSessionResponseSchema.parse(
      await read(`/v1/sessions/${stale.session_id}`),
    );
    expect(detail.status).toBe("failed");
    expect(detail.attention).toMatchObject({ code: "CATALOG_MISMATCH" });
    const ok = getSessionResponseSchema.parse(
      await read(`/v1/sessions/${runs.session_id}`),
    );
    expect(ok.attention).toBeNull();
  }, 60_000);
});
