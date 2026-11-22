import { afterAll, beforeAll } from "bun:test";
import * as schema from "@werft-ai/db";
import {
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createInterruptService,
  createPendingRequestService,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerEventRoutes } from "../apps/control-host/src/api/routes/sessions/events.ts";
import { registerInterruptRoutes } from "../apps/control-host/src/api/routes/sessions/interrupt.ts";
import { registerPendingRoutes } from "../apps/control-host/src/api/routes/sessions/pending.ts";
import { registerReceiptRoutes } from "../apps/control-host/src/api/routes/sessions/receipts.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { PostgresSessionNotifier } from "../apps/control-host/src/api/session-notifier.ts";
import {
  allowingPolicy,
  allowRepositories,
  releaseIn,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";

type GatewayDeps = Parameters<typeof createWorkerGateway>[0];

export interface FlowHarnessOptions {
  prefix: string;
  catalog: SessionCatalog;
  pendingRoutes?: boolean;
  interruptRoutes?: boolean;
  checkpointProtocol?: GatewayDeps["checkpointProtocol"];
}

export interface FlowHarness {
  readonly db: NodePgDatabase<typeof schema>;
  readonly gateway: WorkerGateway;
  readonly owner: string;
  readonly releaseId: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

/**
 * The public API and the Worker Gateway's HTTP routes over a temporary
 * database, served in this process. Call it inside a describe: it registers
 * that describe's beforeAll and afterAll.
 */
export function flowHarness(options: FlowHarnessOptions): FlowHarness {
  const { catalog } = options;
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let notifier: PostgresSessionNotifier;
  let gateway: WorkerGateway;
  let server: ReturnType<typeof Bun.serve>;
  const owner = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: options.prefix });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    releaseId = await releaseIn(db, owner);
    await allowRepositories(db, owner, ["sample-app"]);
    const logger = createLogger({ sinks: [] });
    notifier = new PostgresSessionNotifier(database.url, logger);
    await notifier.start();
    const limits = {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    };
    const sessions = startingInWorkspace(
      createSessionService({
        authorization: createAuthorizationPolicy(),
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
        limits,
        releases: sessionReleases(db, catalog),
      }),
      createSessionService({
        authorization: allowingPolicy,
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
        limits,
        releases: sessionReleases(db, catalog),
      }),
    );
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: { verify: async () => ({ status: "verified" }) },
      ...(options.checkpointProtocol
        ? { checkpointProtocol: options.checkpointProtocol }
        : {}),
      pending: createPostgresWorkerPendingStore(db),
      options: {
        leaseTtlMs: 30_000,
        sessionBudget: { costUsd: 1_000, tokens: null },
      },
    });
    const app = createApiApp({
      authMode: "none",
      logger,
      registerRoutes: (router) => {
        registerSessionRoutes(router, sessions);
        if (options.pendingRoutes) {
          registerPendingRoutes(
            router,
            createPendingRequestService({
              authorization: createAuthorizationPolicy(),
              store: createPostgresPendingRequests(db),
            }),
          );
        }
        registerReceiptRoutes(router, sessions);
        if (options.interruptRoutes ?? true) {
          registerInterruptRoutes(
            router,
            createInterruptService({
              authorization: createAuthorizationPolicy(),
              store: createPostgresTurnInterrupts(db),
            }),
          );
        }
        registerEventRoutes(router, sessions, {
          wakeup: notifier,
          keepaliveMs: 500,
          logger,
        });
      },
      registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
    });
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  }, 60_000);

  afterAll(async () => {
    server?.stop(true);
    await notifier?.close();
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const base = () => `http://127.0.0.1:${server.port}`;

  function call(path: string, init: RequestInit = {}) {
    return fetch(`${base()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": owner,
        ...init.headers,
      },
    });
  }

  function post(path: string, body: unknown) {
    return call(path, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      // A session runs a release of the owner's workspace.
      body: JSON.stringify(
        path === "/v1/sessions"
          ? { agent_release_id: releaseId, ...(body as object) }
          : body,
      ),
    });
  }

  return {
    get db() {
      return db;
    },
    get gateway() {
      return gateway;
    },
    owner,
    get releaseId() {
      return releaseId;
    },
    call,
    post,
  };
}
