import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  controlAcceptedResponseSchema,
  createSessionResponseSchema,
  getReceiptResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
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
} from "@werft-ai/platform";
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
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { PostgresSessionNotifier } from "../apps/control-host/src/api/session-notifier.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  allowingPolicy,
  allowRepositories,
  releaseIn,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";
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
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";
import { until } from "./until.ts";

/**
 * Interrupt flow end to end in one process: the public API
 * takes the interrupt, PostgreSQL holds it, the Worker Gateway's own HTTP
 * routes hand it to a WorkerHost polling at production cadence, and the
 * receipt and the SSE stream show what came of it. Only the engine is fake,
 * because what a real SDK does with an interrupt is runtime-claude's to prove.
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

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function result(uuid: string): EngineMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    user_message_uuid: uuid,
  };
}

/** Stands in for CheckpointService: every ready preparation commits. */
function capturing(): WorkerCheckpointPort {
  // Revisions start at 0, as the gateway's pointer does.
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
}

integration("POST /v1/sessions/{id}/interrupt end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let notifier: PostgresSessionNotifier;
  let gateway: WorkerGateway;
  let server: ReturnType<typeof Bun.serve>;
  const owner = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "interrupt_e2e" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    releaseId = await releaseIn(db, owner);
    await allowRepositories(db, owner, ["sample-app"]);
    const logger = createLogger({ sinks: [] });
    notifier = new PostgresSessionNotifier(database.url, logger);
    await notifier.start();
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
      // A session runs a release of the owner's workspace.
      body: JSON.stringify(
        path === "/v1/sessions"
          ? { agent_release_id: releaseId, ...(body as object) }
          : body,
      ),
    });
  }

  async function receipt(id: string) {
    const response = await call(`/v1/receipts/${id}`);
    expect(response.status).toBe(200);
    return getReceiptResponseSchema.parse(await response.json());
  }

  async function turnStatus(sessionId: string, sequence: number) {
    const [row] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
    return row?.status;
  }

  /** Reads the session's event stream until `match` shows up in it. */
  async function streamUntil(sessionId: string, match: string) {
    const abort = new AbortController();
    const response = await call(`/v1/sessions/${sessionId}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no event stream body");
    return {
      seen: (async () => {
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes(match)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        abort.abort();
        return text;
      })(),
      abort: () => abort.abort(),
    };
  }

  test("interrupts only the running turn within 5s, then the queued input runs", async () => {
    const created = await post("/v1/sessions", {
      repository_id: "sample-app",
      message: "long task",
    });
    expect(created.status).toBe(201);
    const sessionId = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    expect(
      (
        await post(`/v1/sessions/${sessionId}/messages`, {
          message: "follow-up",
          mode: "enqueue",
        })
      ).status,
    ).toBe(202);

    // AC4: nothing runs yet, and queued input is no interrupt target.
    const queued = await post(`/v1/sessions/${sessionId}/interrupt`, {
      target_turn_id: "1",
    });
    expect(queued.status).toBe(409);
    expect(
      ((await queued.json()) as { error: { code: string } }).error.code,
    ).toBe("TURN_NOT_STARTED");

    const partition = `interrupt-e2e-${crypto.randomUUID()}`;
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
    const steps: ScriptedStep[] = [
      { type: "await-input" },
      { type: "delay", delayMs: 60_000 },
      { type: "emit", message: result(uuid(1)) },
      { type: "await-input" },
      { type: "emit", message: result(uuid(2)) },
      { type: "await-input" },
    ];
    const runtime = fakeRuntimeFor(SCRIPTED_KIND, steps);
    const host = new WorkerHost({
      checkpoints: capturing(),
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
      logger: silent,
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
    const loop = host.runLoop();
    await until(
      async () =>
        runtime.inputs.length === 1 &&
        (await turnStatus(sessionId, 1)) === "running"
          ? true
          : undefined,
      "turn 1 running",
    );
    const stream = await streamUntil(sessionId, '"phase":"engine_stopped"');

    // AC1 + AC2: 202 with a receipt, settled within 5s of the request.
    const asked = performance.now();
    const response = await post(`/v1/sessions/${sessionId}/interrupt`, {
      target_turn_id: "1",
    });
    expect(response.status).toBe(202);
    const { receipt_id } = controlAcceptedResponseSchema.parse(
      await response.json(),
    );
    const settled = await until(async () => {
      const current = await receipt(receipt_id);
      return current.status === "accepted" ? undefined : current;
    }, "the interrupt receipt to settle");
    const observedMs = performance.now() - asked;
    expect(observedMs).toBeLessThan(5_000);
    expect(settled.status).toBe("succeeded");
    expect(settled.operation).toBe("interrupt");
    expect(settled.result).toEqual({
      turn_id: "1",
      terminal: "interrupted",
      no_op: false,
    });
    expect(await turnStatus(sessionId, 1)).toBe("interrupted");
    const streamed = await stream.seen;
    expect(streamed).toContain('"phase":"interrupting"');
    // The effect is stored as its own event, named by the intent.
    expect(streamed.indexOf('"phase":"interrupting"')).toBeLessThan(
      streamed.indexOf('"phase":"engine_stopped"'),
    );

    // AC5: the input behind it is untouched and runs on the same engine.
    const summary = await loop;
    expect(summary.turns).toEqual([
      { turnId: "1", status: "interrupted", reason: "error_during_execution" },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "long task",
      "follow-up",
    ]);

    // AC3: an interrupt for a turn already over is a no-op, settled at once.
    const late = await post(`/v1/sessions/${sessionId}/interrupt`, {
      target_turn_id: "2",
    });
    expect(late.status).toBe(202);
    const noOp = await receipt(
      controlAcceptedResponseSchema.parse(await late.json()).receipt_id,
    );
    expect(noOp.status).toBe("succeeded");
    expect(noOp.result).toEqual({
      turn_id: "2",
      terminal: "completed",
      no_op: true,
    });
  }, 30_000);
});
