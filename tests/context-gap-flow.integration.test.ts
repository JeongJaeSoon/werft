import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  controlAcceptedResponseSchema,
  createSessionResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  type SessionDetail,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  attempts,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  queueMessages,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import {
  confirmExecutionGone,
  launchSession,
} from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  withSeededInstallation,
} from "@werft-ai/platform";
import type { CheckpointPreparation } from "@werft-ai/runtime-core";
import type { EngineMessage } from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerEventRoutes } from "../apps/control-host/src/api/routes/sessions/events.ts";
import { registerReceiptRoutes } from "../apps/control-host/src/api/routes/sessions/receipts.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { PostgresSessionNotifier } from "../apps/control-host/src/api/session-notifier.ts";
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

/**
 * The context-gap recovery path end to end: a session finishes
 * turn 1, its worker goes idle and exits without a checkpoint covering the
 * turn, and the user sends another message. Before this ticket the next
 * worker started a new engine session with nothing restored and no one was
 * told. Now the exit hands the session to an operator, the detail and the
 * SSE stream say why, and only an explicit start_fresh lets it go on — on a
 * new engine session that the durability block keeps naming.
 *
 * Everything real but the engine and the scheduler: the public API and the
 * Worker Gateway's HTTP routes over PostgreSQL, WorkerHosts polling at
 * production cadence. The scheduler's part — observing the exit — is the
 * gateway call it makes.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const PROFILE_ID = "claude-coding-v1";

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

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The worker's checkpoint port with what it was asked recorded. `commits`
 * decides whether a ready preparation turns into a checkpoint: false is the
 * publisher failing or being unavailable. A restored
 * checkpoint resumes the engine session it was captured from, as the real
 * port does, so a run that ignores the checkpoint shows up as a `new` launch.
 */
function checkpointPort(
  commits: boolean,
  firstRevision = 0,
  engineOf: (revision: number) => string = () => {
    throw new Error("no engine session was captured into a checkpoint");
  },
) {
  const restores: Array<CheckpointRef | null> = [];
  const captures: CheckpointPreparation[] = [];
  let revision = firstRevision - 1;
  const port: WorkerCheckpointPort = {
    restorePlan: async ({ restore }) => {
      restores.push(restore);
      return restore === null
        ? { mode: "new" }
        : { mode: "resume", resume: engineOf(restore.revision) };
    },
    capture: async (preparation) => {
      captures.push(preparation);
      if (!commits || preparation.status !== "ready") return null;
      revision += 1;
      return {
        revision,
        manifest_ref: `manifests/${revision}.json`,
        manifest_sha256: "c".repeat(64),
      };
    },
  };
  return { port, restores, captures };
}

/**
 * A port whose publish fails the way SessionCheckpoints reports it: the
 * ready capture yields no ref, and `publish_failed` reaches the gateway
 * under the turn's scope through the worker's own client.
 */
function failingPublishPort(
  gateway: HttpWorkerGatewayClient,
  engineOf: (revision: number) => string,
) {
  const restores: Array<CheckpointRef | null> = [];
  const captures: CheckpointPreparation[] = [];
  const port: WorkerCheckpointPort = {
    restorePlan: async ({ restore }) => {
      restores.push(restore);
      return restore === null
        ? { mode: "new" }
        : { mode: "resume", resume: engineOf(restore.revision) };
    },
    capture: async (preparation, context) => {
      captures.push(preparation);
      if (preparation.status === "ready") {
        await gateway.requestCheckpoint({
          ...context.scope,
          preparation: {
            status: "rejected",
            reason: "publish_failed",
            detail: "publish: store unavailable",
          },
        });
      }
      return null;
    },
  };
  return { port, restores, captures };
}

integration(
  "a replaced worker without a covering checkpoint never silently drops the conversation",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let notifier: PostgresSessionNotifier;
    let gateway: WorkerGateway;
    let server: ReturnType<typeof Bun.serve>;
    const owner = `owner-${crypto.randomUUID()}`;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "context_gap_e2e" });
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
        // The gateway records a rejected capture only when a store is
        // configured; the ports here never ask it for a key.
        checkpointProtocol: {
          async requestCheckpoint() {
            throw new Error("no checkpoint store in these tests");
          },
          async getRestorePlan() {
            throw new Error("no checkpoint store in these tests");
          },
        },
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
          registerEventRoutes(router, sessions, {
            wakeup: notifier,
            keepaliveMs: 500,
            logger,
          });
        },
        registerInternalRoutes: (router) =>
          registerWorkerRoutes(router, gateway),
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

    async function detail(sessionId: string): Promise<SessionDetail> {
      const response = await call(`/v1/sessions/${sessionId}`);
      expect(response.status).toBe(200);
      return getSessionResponseSchema.parse(await response.json());
    }

    /** Reads the session's event stream from the start until `match` shows up. */
    async function streamUntil(sessionId: string, match: string) {
      const abort = new AbortController();
      const response = await call(`/v1/sessions/${sessionId}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("no event stream body");
      const timer = setTimeout(() => abort.abort(), 10_000);
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes(match)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
      return text;
    }

    /** The `data:` payloads of every frame of the given event name. */
    function framesOf(text: string, event: string) {
      return text
        .split("\n\n")
        .filter((frame) => frame.includes(`event: ${event}\n`))
        .map((frame) => {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          return JSON.parse(line?.slice("data: ".length) ?? "null") as {
            data: Record<string, unknown>;
          };
        })
        .map((envelope) => envelope.data);
    }

    async function queueIdOf(sessionId: string, sequence: number) {
      const [row] = await db
        .select({ id: queueMessages.id })
        .from(queueMessages)
        .innerJoin(turns, eq(turns.id, queueMessages.turnId))
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        )
        .limit(1);
      if (!row) throw new Error(`turn ${sequence} has no queue row`);
      return String(row.id);
    }

    function result(uuid: string, engineSession: string): EngineMessage {
      return {
        type: "result",
        subtype: "success",
        session_id: engineSession,
        is_error: false,
        user_message_uuid: uuid,
      };
    }

    /**
     * One worker, launched the way the scheduler registers it, that answers
     * the turn it is given and then goes idle and exits. Returns once it has.
     */
    async function runWorker(input: {
      sessionId: string;
      turn: number;
      engineSession: string;
      checkpoints:
        | WorkerCheckpointPort
        | ((gateway: HttpWorkerGatewayClient) => WorkerCheckpointPort);
    }) {
      const launch = await launchSession(db, { sessionId: input.sessionId });
      const executionId = launch.executionId;
      const runtime = fakeRuntimeFor(SCRIPTED_KIND, [
        { type: "await-input" },
        {
          type: "emit",
          message: result(
            inputUuid(
              input.sessionId,
              String(input.turn),
              await queueIdOf(input.sessionId, input.turn),
            ),
            input.engineSession,
          ),
        },
        { type: "await-input" },
      ]);
      const launches: Array<{ mode: string; resume: string | null }> = [];
      const client = new HttpWorkerGatewayClient({
        baseUrl: base(),
        credential: launch.nonce,
        requestTimeoutMs: 5_000,
      });
      const host = new WorkerHost({
        checkpoints:
          typeof input.checkpoints === "function"
            ? input.checkpoints(client)
            : input.checkpoints,
        execution: {
          bootstrapNonce: launch.nonce,
          generation: launch.generation,
          id: executionId,
        },
        gateway: client,
        logger: silent,
        runtimes: {
          launcherFor: () => ({
            start: (launch) => {
              launches.push({
                mode: launch.mode,
                resume: launch.mode === "resume" ? launch.resume : null,
              });
              return startScripted(runtime, launch);
            },
          }),
        },
        timeouts: {
          answerPollIntervalMs: 1_000,
          claimTimeoutMs: 5_000,
          drainTimeoutMs: 5_000,
          heartbeatIntervalMs: 10_000,
          idleTimeoutMs: 300,
          maxTurnMs: 60_000,
          nextInputRetryTimeoutMs: 60_000,
          nextInputWaitMs: 100,
          questionTimeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          startupTimeoutMs: 60_000,
        },
        workspace: noWorkspace,
      });
      const summary = await host.runLoop();
      return { summary, executionId, runtime, launches };
    }

    test("an idle exit without a covering checkpoint waits on an operator, and start_fresh continues visibly on a new engine session", async () => {
      // 1. A session and its first turn.
      const created = await post("/v1/sessions", {
        profile_id: PROFILE_ID,
        repository_id: "sample-app",
        message: "first",
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `context-gap-e2e-${crypto.randomUUID()}`;
      await db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));

      // The worker finishes turn 1, tries to checkpoint it, fails, idles out.
      const firstPort = checkpointPort(false);
      const first = await runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-9b81",
        checkpoints: firstPort.port,
      });
      expect(first.summary.outcome).toBe("idle");
      expect(first.summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
      ]);
      expect(first.launches).toEqual([{ mode: "new", resume: null }]);
      // AC2: the checkpoint was attempted for the finished turn before the
      // worker went idle — a ready preparation reached the publisher.
      expect(firstPort.captures.map((p) => p.status)).toEqual(["ready"]);
      const [released] = await db
        .select({ endReason: attempts.endReason })
        .from(attempts)
        .where(eq(attempts.sessionId, sessionId));
      expect(released?.endReason).toMatch(/^No input for/);

      // 2. The user's next message is accepted while the exit is unobserved.
      const second = await post(`/v1/sessions/${sessionId}/messages`, {
        message: "second",
        mode: "enqueue",
      });
      expect(second.status).toBe(202);

      // 3. The scheduler observes the exit. The session is not handed to a
      // new worker: it waits on an operator and says why.
      await confirmExecutionGone(db, first.executionId);
      const held = await detail(sessionId);
      expect(held).toMatchObject({
        admission_state: "recovery_required",
        status: "failed",
        queued_turn_count: 1,
        attention: {
          code: "CONTEXT_GAP",
          last_ran_turn_id: "1",
          checkpointed_turn_id: null,
        },
        durability: {
          last_completed_turn_id: "1",
          last_checkpointed_turn_id: null,
          context_reset_turn_id: null,
        },
      });
      const gapStream = await streamUntil(sessionId, "context_gap_detected");
      expect(framesOf(gapStream, "status")).toContainEqual({
        phase: "failed",
        admission_state: "recovery_required",
        reason: "context_gap",
      });
      expect(framesOf(gapStream, "system")).toContainEqual({
        type: "system",
        subtype: "context_gap_detected",
        last_ran_turn_id: "1",
        checkpointed_turn_id: null,
        checkpoint_revision: null,
        detected_at: "execution_gone",
      });

      // More input is refused, and nothing is launched for it: no engine
      // session starts without the conversation.
      const refused = await post(`/v1/sessions/${sessionId}/messages`, {
        message: "third",
        mode: "enqueue",
      });
      expect(refused.status).toBe(409);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
      ).toBe("RECOVERY_REQUIRED");
      await expect(launchSession(db, { sessionId })).rejects.toThrow(
        "not launchable",
      );

      // 4. The operator decides to go on without it.
      const decided = await post(
        `/v1/sessions/${sessionId}/recovery-decisions`,
        {
          decision: "start_fresh",
          expected_revision: held.revision,
          reason: "turn 1 cannot be restored; continue without it",
        },
      );
      expect(decided.status).toBe(202);
      const { receipt_id } = controlAcceptedResponseSchema.parse(
        await decided.json(),
      );
      const receiptResponse = await call(`/v1/receipts/${receipt_id}`);
      const receipt = getReceiptResponseSchema.parse(
        await receiptResponse.json(),
      );
      expect(receipt.status).toBe("succeeded");
      expect(receipt.result).toEqual({
        resulting_admission_state: "active",
        checkpoint_revision: null,
        resumable: false,
      });
      // AC3: the reset stays visible after the session is running again.
      const reset = await detail(sessionId);
      expect(reset).toMatchObject({
        admission_state: "active",
        status: "queued",
        attention: null,
        durability: { context_reset_turn_id: "1" },
      });

      // 5. The next worker restores nothing and runs the queued message on a
      // new engine session; this time the checkpoint commits.
      const freshPort = checkpointPort(true);
      const fresh = await runWorker({
        sessionId,
        turn: 2,
        engineSession: "engine-7d25",
        checkpoints: freshPort.port,
      });
      expect(freshPort.restores).toEqual([null]);
      expect(fresh.launches).toEqual([{ mode: "new", resume: null }]);
      expect(fresh.summary.turns).toEqual([
        { turnId: "2", status: "completed", reason: null },
      ]);
      expect(fresh.runtime.inputs.map((i) => i.message)).toEqual(["second"]);
      await confirmExecutionGone(db, fresh.executionId);
      const covered = await detail(sessionId);
      expect(covered).toMatchObject({
        admission_state: "active",
        status: "idle",
        attention: null,
        durability: {
          last_checkpointed_turn_id: "2",
          checkpoint_revision: 0,
          context_reset_turn_id: "1",
        },
      });
      const decisionStream = await streamUntil(sessionId, "engine-7d25");
      expect(framesOf(decisionStream, "system")).toContainEqual(
        expect.objectContaining({
          subtype: "recovery_decision",
          decision: "start_fresh",
          context_reset_turn_id: "1",
        }),
      );
      // The engine session did change — and the stream said so before it did.
      const results = framesOf(decisionStream, "result");
      expect(results.map((r) => r.session_id)).toEqual([
        "engine-9b81",
        "engine-7d25",
      ]);

      // 6. With turn 2 covered, a later replacement restores it: no gap.
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "fourth",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);
      const restoredPort = checkpointPort(true, 1, (revision) =>
        revision === 0 ? "engine-7d25" : "unknown",
      );
      const restored = await runWorker({
        sessionId,
        turn: 3,
        engineSession: "engine-7d25",
        checkpoints: restoredPort.port,
      });
      expect(restoredPort.restores.map((r) => r?.revision ?? null)).toEqual([
        0,
      ]);
      expect(restored.launches).toEqual([
        { mode: "resume", resume: "engine-7d25" },
      ]);
      expect(restored.summary.turns).toEqual([
        { turnId: "3", status: "completed", reason: null },
      ]);
    }, 60_000);

    // 94S-668 pins today's path; the option it adopts flips the marked
    // expectations (retry: one more capture; hold: the 202; show: attention).
    test("a completed turn whose publish failed leaves an unannounced gap that becomes CONTEXT_GAP once its worker is replaced", async () => {
      const created = await post("/v1/sessions", {
        profile_id: PROFILE_ID,
        repository_id: "sample-app",
        message: "first",
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `publish-failed-gap-${crypto.randomUUID()}`;
      await db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));

      // Turn 1 is covered by revision 0.
      const first = await runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-4c1e",
        checkpoints: checkpointPort(true).port,
      });
      await confirmExecutionGone(db, first.executionId);
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "second",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);

      // 1. The next worker resumes it and completes turn 2, but the publish
      // fails: only the advisory publish_failed is reported, and nothing
      // tries again while the worker idles out.
      let failing: ReturnType<typeof failingPublishPort> | undefined;
      const second = await runWorker({
        sessionId,
        turn: 2,
        engineSession: "engine-4c1e",
        checkpoints: (client) => {
          failing = failingPublishPort(client, () => "engine-4c1e");
          return failing.port;
        },
      });
      expect(failing?.restores.map((r) => r?.revision ?? null)).toEqual([0]);
      expect(second.launches).toEqual([
        { mode: "resume", resume: "engine-4c1e" },
      ]);
      expect(second.summary).toMatchObject({
        outcome: "idle",
        turns: [{ turnId: "2", status: "completed", reason: null }],
      });
      // retry within this 300ms idle window would add captures here; one on
      // a longer timer needs a longer window to show.
      expect(failing?.captures.map((p) => p.status)).toEqual(["ready"]);

      // 2. Until the exit is observed nothing calls the gap out: the session
      // is active with no attention, only the durability block differs, the
      // stream carries no system event, and the next message is accepted.
      const gap = await detail(sessionId);
      expect(gap).toMatchObject({
        admission_state: "active",
        // show would put an attention here.
        attention: null,
        durability: {
          checkpoint_pending_reason: "publish_failed",
          checkpoint_revision: 0,
          last_completed_turn_id: "2",
          last_checkpointed_turn_id: "1",
        },
      });
      // The backlog is replayed before the first keepalive.
      const quiet = await streamUntil(sessionId, ": keepalive");
      expect(
        new Set([...quiet.matchAll(/^event: (\S+)$/gm)].map((m) => m[1])),
      ).toEqual(new Set(["status", "result"]));
      expect(framesOf(quiet, "result")).toHaveLength(2);
      // hold would refuse this.
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "third",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);

      // 3. The worker is gone before any later publish succeeds: the
      // replacement could only restore revision 0, so the session goes to
      // an operator with CONTEXT_GAP and nothing is launched for it.
      await confirmExecutionGone(db, second.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "recovery_required",
        status: "failed",
        queued_turn_count: 1,
        attention: {
          code: "CONTEXT_GAP",
          last_ran_turn_id: "2",
          checkpointed_turn_id: "1",
        },
        durability: {
          checkpoint_pending_reason: "publish_failed",
          checkpoint_revision: 0,
        },
      });
      await expect(launchSession(db, { sessionId })).rejects.toThrow(
        "not launchable",
      );
    }, 60_000);
  },
);
