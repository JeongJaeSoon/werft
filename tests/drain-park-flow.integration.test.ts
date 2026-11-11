import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  createSessionResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  events,
  pendingRequests,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createInterruptService,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  approvalInputHash,
  type WorkerCheckpointState,
} from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerEventRoutes } from "../apps/control-host/src/api/routes/sessions/events.ts";
import { registerInterruptRoutes } from "../apps/control-host/src/api/routes/sessions/interrupt.ts";
import { registerReceiptRoutes } from "../apps/control-host/src/api/routes/sessions/receipts.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { PostgresSessionNotifier } from "../apps/control-host/src/api/session-notifier.ts";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import { drainOnSignals } from "../apps/worker/src/main.ts";
import {
  SCRIPTED_KIND,
  startScripted,
} from "../apps/worker/src/testing/scripted-engine.ts";
import {
  inputUuid,
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";
import { until } from "./until.ts";

/**
 * A drain park end to end in one process: the public API opens a session,
 * the Worker Gateway's own HTTP routes serve a WorkerHost whose engine waits
 * on an approval, and a real SIGTERM through the worker's own signal wiring
 * parks it in PostgreSQL. Only the engine is fake; what a real SDK does with
 * the park's interrupt is runtime-claude's to prove.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const PROFILE_ID = "claude-coding-v1";
const RAW_MARKER = "raw-park-marker-5d2c";

const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    [PROFILE_ID]: {
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
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    },
  },
});

function result(uuid: string): EngineMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    user_message_uuid: uuid,
  };
}

/**
 * Stands in for CheckpointService: every ready preparation commits, and the
 * worker state each manifest would carry is kept.
 */
function capturing(
  states: Array<WorkerCheckpointState | undefined>,
): WorkerCheckpointPort {
  // Revisions start at 0, as the gateway's pointer does.
  let revision = -1;
  return {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation, context): Promise<CheckpointRef | null> => {
      if (preparation.status !== "ready") return null;
      states.push(context.workerState);
      revision += 1;
      return {
        revision,
        manifest_ref: `manifests/${revision}.json`,
        manifest_sha256: "c".repeat(64),
      };
    },
  };
}

integration("a drain parks a turn waiting on a person, end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let notifier: PostgresSessionNotifier;
  let gateway: WorkerGateway;
  let server: ReturnType<typeof Bun.serve>;
  const owner = `owner-${crypto.randomUUID()}`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "drain_park_e2e" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    const logger = createLogger({ sinks: [] });
    notifier = new PostgresSessionNotifier(database.url, logger);
    await notifier.start();
    const sessions = createSessionService({
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
    gateway = createWorkerGateway({
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
    const app = createApiApp({
      authMode: "none",
      logger,
      registerRoutes: (router) => {
        registerSessionRoutes(router, sessions);
        registerReceiptRoutes(router, sessions);
        registerInterruptRoutes(
          router,
          createInterruptService({
            authorization: createAuthorizationPolicy(),
            store: createPostgresTurnInterrupts(db),
          }),
        );
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
      body: JSON.stringify(body),
    });
  }

  async function turnStatus(sessionId: string, sequence: number) {
    const [row] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
    return row?.status;
  }

  test("SIGTERM parks the waiting turn: the row stays open and parked, the session waits on it, and the raw arguments live only in the manifest", async () => {
    const created = await post("/v1/sessions", {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
      message: "deploy it",
    });
    expect(created.status).toBe(201);
    const sessionId = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    const partition = `drain-park-e2e-${crypto.randomUUID()}`;
    await db
      .update(schema.sessions)
      .set({ partition })
      .where(eq(schema.sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const launch = await launchSession(db, { sessionId });

    const uuid = (turn: number) =>
      inputUuid(sessionId, String(turn), String(turn));
    // The display copy hides this key's value; the engine acts on it as is.
    const input = { command: "deploy", credential: RAW_MARKER };
    const steps: ScriptedStep[] = [
      { type: "await-input" },
      {
        type: "permissions",
        requests: [
          {
            input,
            requestId: "sdk-deploy",
            tool: "Bash",
            toolUseId: "toolu_deploy",
          },
        ],
      },
      { type: "emit", message: result(uuid(1)) },
      { type: "await-input" },
    ];
    const runtime = fakeRuntimeFor(SCRIPTED_KIND, steps);
    const states: Array<WorkerCheckpointState | undefined> = [];
    const logged: unknown[] = [];
    const logger: WorkerLogger = {
      info: (...entry) => logged.push(entry),
      warn: (...entry) => logged.push(entry),
      error: (...entry) => logged.push(entry),
    };
    const host = new WorkerHost({
      checkpoints: capturing(states),
      execution: {
        bootstrapNonce: launch.nonce,
        generation: launch.generation,
        id: launch.executionId,
      },
      gateway: new HttpWorkerGatewayClient({
        baseUrl: base(),
        credential: launch.nonce,
        requestTimeoutMs: 5_000,
      }),
      logger,
      runtimes: {
        launcherFor: () => ({
          start: (launch) => startScripted(runtime, launch),
        }),
      },
      // Production cadences: the heartbeat alone would take 10s to say anything.
      timeouts: {
        answerPollIntervalMs: 1_000,
        claimTimeoutMs: 5_000,
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
    const release = drainOnSignals(host);
    try {
      const loop = host.runLoop();
      const requestId = await until(async () => {
        const [row] = await db
          .select({ requestId: pendingRequests.requestId })
          .from(pendingRequests)
          .where(eq(pendingRequests.sessionId, sessionId));
        return row?.requestId;
      }, "the approval to be registered");
      await until(async () => {
        const response = await call(`/v1/sessions/${sessionId}`);
        const body = (await response.json()) as { status: string };
        return body.status === "needs_input" ? true : undefined;
      }, "the session to wait on the approval");

      process.kill(process.pid, "SIGTERM");
      const summary = await loop;

      expect(summary.outcome).toBe("drained");
      expect(summary.turns).toEqual([
        { turnId: "1", status: "interrupted", reason: "input_wait_parked" },
      ]);
      // Not denied: the engine was stopped, and nobody answered for the person.
      expect(runtime.permissionDecisions).toEqual([
        expect.objectContaining({ behavior: "deny", interrupt: true }),
      ]);
      const [row] = await db
        .select()
        .from(pendingRequests)
        .where(eq(pendingRequests.requestId, requestId));
      expect(row?.parkedAt).not.toBeNull();
      expect(row?.settledAt).toBeNull();
      expect(row?.resolvedAt).toBeNull();
      const [session] = await db
        .select({ status: schema.sessions.status })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
      expect(session?.status).toBe("idle");
      const shown = await call(`/v1/sessions/${sessionId}`);
      expect(((await shown.json()) as { status: string }).status).toBe(
        "needs_input",
      );
      expect(await turnStatus(sessionId, 1)).toBe("interrupted");

      expect(states).toEqual([
        {
          pendingApprovals: [
            {
              input,
              inputHash: approvalInputHash("Bash", input),
              kind: "permission",
              requestId,
              tool: "Bash",
              toolCallId: "toolu_deploy",
            },
          ],
        },
      ]);
      // The manifest is the only place the raw value went.
      const stored = JSON.stringify([
        await db
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.sessionId, sessionId)),
        await db.select().from(events).where(eq(events.sessionId, sessionId)),
        await db.select().from(turns).where(eq(turns.sessionId, sessionId)),
      ]);
      expect(stored).toContain("input_wait");
      expect(stored).not.toContain(RAW_MARKER);
      const listed = await call(`/v1/sessions/${sessionId}/pending-requests`);
      expect(await listed.text()).not.toContain(RAW_MARKER);
      expect(JSON.stringify(logged)).not.toContain(RAW_MARKER);
    } finally {
      release();
    }
  }, 30_000);
});
