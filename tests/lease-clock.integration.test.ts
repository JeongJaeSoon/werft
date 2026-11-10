import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createSessionResponseSchema,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  attempts,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  unassignedSessions,
} from "@werft-ai/db";
import {
  confirmExecutionGone,
  launchSession,
  type TestLaunch,
} from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  DEFAULT_LEASE_TTL_MS,
  type SessionCatalog,
} from "@werft-ai/platform";
import type { ScriptedRuntime } from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/worker.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  allowingPolicy,
  allowRepositories,
  releaseIn,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import {
  type FetchLike,
  HttpWorkerGatewayClient,
} from "../apps/worker/src/gateway-client.ts";
import {
  SCRIPTED_KIND,
  startScripted,
} from "../apps/worker/src/testing/scripted-engine.ts";
import {
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";

/** PostgreSQL lock, fencing and delayed-heartbeat contracts through HTTP. */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const PROFILE_ID = "claude-coding-v1";
const LEASE_TTL_MS = 10_000;
const MARGIN_MS = 3_000;
const HEARTBEAT_MS = 300;

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

const noCheckpoints: WorkerCheckpointPort = {
  restorePlan: async () => ({ mode: "new" }),
  capture: async () => null,
};

async function until(
  done: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

integration("worker lease on the monotonic clock end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let server: ReturnType<typeof Bun.serve>;
  let production: ReturnType<typeof Bun.serve>;
  const owner = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "lease_clock_e2e" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    releaseId = await releaseIn(db, owner);
    await allowRepositories(db, owner, ["sample-app"]);
    const logger = createLogger({ sinks: [] });
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
    const serve = (leaseTtlMs: number) => {
      const workers = createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog,
        checkpoints: { verify: async () => ({ status: "verified" }) },
        pending: createPostgresWorkerPendingStore(db),
        options: {
          leaseTtlMs,
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
        },
      });
      const app = createApiApp({
        authMode: "none",
        logger,
        registerRoutes: (router) => registerSessionRoutes(router, sessions),
        registerInternalRoutes: (router) =>
          registerWorkerRoutes(router, workers),
      });
      return Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
    };
    server = serve(LEASE_TTL_MS);
    // The lease the API hands out by default, for the worker's own defaults.
    production = serve(DEFAULT_LEASE_TTL_MS);
  }, 90_000);

  afterAll(async () => {
    server?.stop(true);
    production?.stop(true);
    await pool?.end();
    await database?.drop();
  }, 90_000);

  async function dbNowMs(): Promise<number> {
    const [row] = await db
      .select({
        ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
      })
      .from(sql`(SELECT 1) AS one`);
    return Number(row?.ms);
  }

  async function leaseOf(attemptId: string): Promise<number> {
    const [row] = await db
      .select({ leaseExpiresAt: attempts.leaseExpiresAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    if (row === undefined) throw new Error(`no attempt ${attemptId}`);
    return row.leaseExpiresAt.getTime();
  }

  /** A session waiting in a partition of its own, and the launch to claim it. */
  async function queuedLaunch(): Promise<TestLaunch & { sessionId: string }> {
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
        message: "long task",
      }),
    });
    expect(created.status).toBe(201);
    const sessionId = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    const partition = `lease-clock-${crypto.randomUUID()}`;
    await db
      .update(schema.sessions)
      .set({ partition })
      .where(eq(schema.sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    return { ...(await launchSession(db, { sessionId })), sessionId };
  }

  function workerHost(input: {
    executionId: string;
    nonce: string;
    runtime: ScriptedRuntime;
    logger: WorkerLogger;
    fetch: FetchLike;
    requestTimeoutMs: number;
    /** The API on the default lease, with the worker's default lease clock. */
    production?: boolean;
  }): WorkerHost {
    const { runtime } = input;
    const port = input.production ? production.port : server.port;
    return new WorkerHost({
      checkpoints: noCheckpoints,
      execution: {
        bootstrapNonce: input.nonce,
        generation: 1,
        id: input.executionId,
      },
      gateway: new HttpWorkerGatewayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        credential: input.nonce,
        requestTimeoutMs: input.requestTimeoutMs,
        fetch: input.fetch,
      }),
      logger: input.logger,
      runtimes: {
        launcherFor: () => ({
          start: (launch) => startScripted(runtime, launch),
        }),
      },
      timeouts: {
        answerPollIntervalMs: 1_000,
        claimTimeoutMs: 5_000,
        drainTimeoutMs: 5_000,
        heartbeatIntervalMs: input.production
          ? WORKER_HEARTBEAT_INTERVAL_MS
          : HEARTBEAT_MS,
        idleTimeoutMs: 60_000,
        leaseSafetyMarginMs: input.production
          ? WORKER_LEASE_SAFETY_MARGIN_MS
          : MARGIN_MS,
        maxTurnMs: 60_000,
        nextInputRetryTimeoutMs: 60_000,
        nextInputWaitMs: 100,
        questionTimeoutMs: 5_000,
        requestTimeoutMs: input.requestTimeoutMs,
        startupTimeoutMs: 60_000,
      },
      workspace: noWorkspace,
    });
  }

  test("beats sent while the API is down and delivered after it is back cost no lease; one delivered after the exit is 401", async () => {
    const { executionId, nonce } = await queuedLaunch();
    const runtime = fakeRuntimeFor(SCRIPTED_KIND, [
      { type: "await-input" },
      { type: "delay", delayMs: 60_000 },
    ]);
    // What the API's SIGKILL leaves in the network: a request sent while
    // it is down waits in the connect's retries and reaches whichever API
    // is listening when it finally gets through. The test decides when.
    let down = false;
    const held: {
      sentAt: number;
      deliver: () => Promise<{ status: number; body: string }>;
    }[] = [];
    let attemptId: string | undefined;
    let lostReason: string | undefined;
    const logger: WorkerLogger = {
      info: (event, fields) => {
        if (event === "worker.claimed") attemptId = String(fields?.attempt_id);
        if (event === "worker.stopping" && fields?.kind === "lost") {
          lostReason = String(fields?.reason);
        }
      },
      warn: () => {},
      error: () => {},
    };
    const host = workerHost({
      executionId,
      nonce,
      runtime,
      logger,
      // As in production: longer than what a lease has left between beats.
      requestTimeoutMs: 30_000,
      fetch: (input, init) => {
        if (!down) return globalThis.fetch(input, init);
        if (!input.endsWith("/heartbeat")) {
          return Promise.reject(new TypeError("connect ECONNREFUSED"));
        }
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
          held.push({
            sentAt: performance.now(),
            deliver: async () => {
              const { signal: _, ...rest } = init;
              const response = await globalThis.fetch(input, rest);
              const body = await response.text();
              resolve(new Response(body, { status: response.status }));
              return { status: response.status, body };
            },
          });
        });
      },
    });
    const loop = host.runLoop();
    await until(() => runtime.inputs.length === 1, "turn 1 running", 30_000);
    const id = attemptId;
    if (id === undefined) throw new Error("the claim was not logged");

    // Down for a few beats, then back; what was sent meanwhile stays held
    // past the point this attempt's last renewal gives the lease up at.
    const leaseAtKill = await leaseOf(id);
    down = true;
    await until(() => held.length > 0, "a beat sent while down");
    await Bun.sleep(2_000);
    down = false;
    await Bun.sleep(LEASE_TTL_MS);

    expect(lostReason).toBeUndefined();
    expect(await leaseOf(id)).toBeGreaterThan(leaseAtKill + LEASE_TTL_MS / 2);

    // Delivered late to an attempt still alive, the same token is good.
    const [first] = held;
    const last = held.at(-1);
    if (first === undefined || last === undefined || first === last) {
      throw new Error("expected several beats held while the API was down");
    }
    expect((await first.deliver()).status).toBe(200);

    // The scheduler observes the execution gone and ends the attempt, which
    // revokes its token; a beat the network only now lets through is
    // answered 401, proving the late beat cannot revive the attempt.
    await confirmExecutionGone(db, executionId);
    const late = await last.deliver();
    expect(late.status).toBe(401);
    expect(late.body).toContain("Worker token is missing, expired or revoked");

    const summary = await loop;
    expect(summary.outcome).toBe("lease_lost");
  }, 90_000);
  /**
   * Takes the session row the way a slow terminate or reconciler pass does,
   * and gives it back `ms` later; resolves once the lock is held.
   */
  async function holdSessionRow(
    sessionId: string,
    ms: number,
    whileHeld?: () => Promise<unknown>,
  ): Promise<{ released: Promise<number> }> {
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [
      sessionId,
    ]);
    const pending = whileHeld?.();
    const released = (async () => {
      await Bun.sleep(ms);
      await holder.query("COMMIT");
      holder.release();
      const at = performance.now();
      await pending;
      return at;
    })();
    return { released };
  }

  type Beat = { sentAt: number; answeredAt: number; status: number };

  /** A worker on the default lease clock whose beats are recorded. */
  function productionWorker(
    launch: TestLaunch,
    onBeat: (sentAt: number) => Promise<void>,
  ) {
    const runtime = fakeRuntimeFor(SCRIPTED_KIND, [
      { type: "await-input" },
      { type: "delay", delayMs: 120_000 },
    ]);
    const beats: Beat[] = [];
    const seen: { attemptId?: string; lostReason?: string; lostAt?: number } =
      {};
    const host = workerHost({
      executionId: launch.executionId,
      nonce: launch.nonce,
      runtime,
      production: true,
      logger: {
        info: (event, fields) => {
          if (event === "worker.claimed") {
            seen.attemptId = String(fields?.attempt_id);
          }
          if (event === "worker.stopping" && fields?.kind === "lost") {
            seen.lostReason = String(fields?.reason);
            seen.lostAt = performance.now();
          }
        },
        warn: () => {},
        error: () => {},
      },
      requestTimeoutMs: 30_000,
      fetch: async (input, init) => {
        if (!input.endsWith("/heartbeat")) return globalThis.fetch(input, init);
        const sentAt = performance.now();
        await onBeat(sentAt);
        const response = await globalThis.fetch(input, init);
        beats.push({
          sentAt,
          answeredAt: performance.now(),
          status: response.status,
        });
        return response;
      },
    });
    return { beats, host, runtime, seen };
  }

  test("on the default lease clock, a session row held for 12s from just before a beat costs no lease", async () => {
    const launch = await queuedLaunch();
    let arm = false;
    let hold: Promise<{ released: Promise<number> }> | undefined;
    const worker = productionWorker(launch, async () => {
      if (!arm) return;
      arm = false;
      hold = holdSessionRow(launch.sessionId, 12_000);
      await hold;
    });
    const loop = worker.host.runLoop();
    try {
      await until(
        () => worker.runtime.inputs.length === 1,
        "turn 1 running",
        30_000,
      );
      const id = worker.seen.attemptId;
      if (id === undefined) throw new Error("the claim was not logged");
      arm = true;
      await until(() => hold !== undefined, "a beat behind the lock", 15_000);
      const releasedAt = await (await (hold as NonNullable<typeof hold>))
        .released;
      await until(
        () =>
          worker.beats.some(
            (b) =>
              b.sentAt >= releasedAt - 2_000 &&
              b.status === 200 &&
              b.answeredAt >= releasedAt,
          ),
        "a renewal once the row is free",
        15_000,
      );

      expect(worker.seen.lostReason).toBeUndefined();
      const refused = worker.beats.filter((b) => b.status !== 200);
      // Each beat behind the lock was answered retryably and soon, not after
      // the whole wait.
      expect(refused.length).toBeGreaterThan(0);
      for (const beat of refused) {
        expect(beat.status).toBe(503);
        expect(beat.answeredAt - beat.sentAt).toBeLessThan(5_000);
      }
      // Nothing for the reconciler to fence: the lease runs well past now.
      expect(await leaseOf(id)).toBeGreaterThan((await dbNowMs()) + 15_000);
      const [attempt] = await db
        .select({ state: attempts.state })
        .from(attempts)
        .where(eq(attempts.id, id));
      expect(attempt?.state).not.toBe("lost");
    } finally {
      worker.host.drain("test over");
      await loop;
    }
  }, 90_000);

  test("on the default lease clock, a fence that commits behind a held session row stops the worker and no beat renews it", async () => {
    const launch = await queuedLaunch();
    let arm = false;
    let hold: Promise<{ released: Promise<number> }> | undefined;
    const worker = productionWorker(launch, async () => {
      if (!arm) return;
      arm = false;
      // The fence queues on the row behind the holder, ahead of every beat
      // that retries meanwhile, and commits the moment the row is free.
      hold = holdSessionRow(launch.sessionId, 12_000, () =>
        confirmExecutionGone(db, launch.executionId),
      );
      await hold;
    });
    const loop = worker.host.runLoop();
    await until(
      () => worker.runtime.inputs.length === 1,
      "turn 1 running",
      30_000,
    );
    const id = worker.seen.attemptId;
    if (id === undefined) throw new Error("the claim was not logged");
    arm = true;
    await until(() => hold !== undefined, "a beat behind the lock", 15_000);
    const fencedAt = await (await (hold as NonNullable<typeof hold>)).released;
    const leaseAtFence = await leaseOf(id);

    const summary = await loop;

    expect(summary.outcome).toBe("lease_lost");
    const lostAt = worker.seen.lostAt;
    if (lostAt === undefined) throw new Error("the loss was not logged");
    expect(lostAt).toBeGreaterThan(fencedAt - 1_000);
    // Stopped on the fence, not by waiting out its own lease budget.
    expect(lostAt - fencedAt).toBeLessThan(10_000);
    expect(worker.seen.lostReason).not.toContain("lease given up");
    expect(
      worker.beats.filter((b) => b.answeredAt > fencedAt && b.status === 200),
    ).toEqual([]);
    expect(await leaseOf(id)).toBe(leaseAtFence);
    const [attempt] = await db
      .select({ state: attempts.state, endReason: attempts.endReason })
      .from(attempts)
      .where(eq(attempts.id, id));
    expect(attempt).toEqual({ state: "lost", endReason: "execution_gone" });
  }, 90_000);
});
