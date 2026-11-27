import { describe, expect, test } from "bun:test";
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
  queueMessages,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import {
  confirmExecutionGone,
  launchSession,
} from "@werft-ai/db/testing/launches";
import type { SessionCatalog } from "@werft-ai/platform";
import {
  type CheckpointPreparation,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import { and, eq } from "drizzle-orm";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import type {
  CaptureRefusal,
  WorkerCheckpointPort,
} from "../apps/worker/src/checkpoint.ts";
import type { WorkerTimeouts } from "../apps/worker/src/config.ts";
import type { EngineExitWatch } from "../apps/worker/src/engine-processes.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import { noWorkspace } from "../apps/worker/src/testing/no-workspace.ts";
import {
  SCRIPTED_KIND,
  startScripted,
} from "../apps/worker/src/testing/scripted-engine.ts";
import {
  inputUuid,
  WorkerHost,
  type WorkerHostOptions,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { flowHarness } from "./flow-harness.ts";

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

const catalog: SessionCatalog = testCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { stored: "connection:conn-1" },
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

/** One process left under the run, which a signal or `end` ends. */
function backgroundProcess() {
  const signals: Array<[string, number[]]> = [];
  let alive = [4243];
  const engines: EngineExitWatch = {
    descendants: async () => alive,
    commands: async () => ["sleep"],
    signal: (pids, signal) => {
      signals.push([signal, [...pids]]);
      alive = [];
    },
    exited: async () => true,
    running: [],
    kill() {},
  };
  return {
    engines,
    signals,
    end: () => {
      alive = [];
    },
  };
}

/** A logger that says when an idle worker starts its background grace. */
function graceLogger(): { logger: WorkerLogger; graced: Promise<void> } {
  let graced: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    graced = resolve;
  });
  return {
    graced: promise,
    logger: {
      ...silent,
      info: (event) => {
        if (event === "worker.idle.background_grace") graced();
      },
    },
  };
}

/**
 * A port that commits what it captures and names its refusals the way
 * SessionCheckpoints does: a run that is not quiet, and each of `failures` in
 * turn, reported to the gateway under the reason the session then shows.
 * `beforeCapture` runs ahead of every ready capture, with its count. It hands
 * the host a checkpoint reference; the host commits it.
 */
function namingPort(
  gateway: HttpWorkerGatewayClient,
  options: {
    failures?: CaptureRefusal[];
    beforeCapture?: (ready: number) => Promise<void>;
    /**
     * Where a ready capture uploads its bundle and manifest first. A write
     * the store fails is a request that did not get through, as
     * SessionCheckpoints counts it.
     */
    objects?: MemoryCheckpointObjectStore;
    /**
     * The revision a capture names, as the gateway hands it out from the
     * committed pointer. One more than the last capture's by default.
     */
    nextRevision?: () => Promise<number>;
  } = {},
) {
  const failures = [...(options.failures ?? [])];
  const captures: Array<{ status: string; kind: string }> = [];
  let revision = -1;
  let ready = 0;
  const port: WorkerCheckpointPort = {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation, context) => {
      captures.push({
        status: preparation.status,
        kind: context.captureKind ?? "turn_end",
      });
      if (preparation.status !== "ready") {
        context.refused?.({
          reason: preparation.reason,
          infrastructure: false,
        });
        await gateway.requestCheckpoint({ ...context.scope, preparation });
        return null;
      }
      ready += 1;
      await options.beforeCapture?.(ready);
      let failure = failures.shift();
      if (failure === undefined && options.objects !== undefined) {
        const bytes = new TextEncoder().encode(`capture ${ready}`);
        try {
          await options.objects.putImmutable(`bundles/${ready}`, bytes);
          await options.objects.putImmutable(`manifests/${ready}`, bytes);
        } catch {
          failure = { reason: "publish_failed", infrastructure: true };
        }
      }
      if (failure !== undefined) {
        context.refused?.(failure);
        await gateway.requestCheckpoint({
          ...context.scope,
          preparation: {
            status: "rejected",
            reason: failure.reason,
            detail: "publish: store unavailable",
          },
        });
        return null;
      }
      revision =
        options.nextRevision === undefined
          ? revision + 1
          : await options.nextRevision();
      return {
        revision,
        manifest_ref: `manifests/${revision}.json`,
        manifest_sha256: "c".repeat(64),
      };
    },
  };
  return { port, captures };
}

integration(
  "a replaced worker without a covering checkpoint never silently drops the conversation",
  () => {
    const flow = flowHarness({
      prefix: "context_gap_e2e",
      catalog,
      interruptRoutes: false,
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
    });
    const { base, call, post } = flow;

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
      const [row] = await flow.db
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
      /** The engine's script, given each turn's result; one turn's by default. */
      steps?: (
        resultOf: (turn: number) => Promise<EngineMessage>,
      ) => Promise<ScriptedStep[]>;
      outsideTurnCheckpoint?: WorkerHostOptions["outsideTurnCheckpoint"];
      engines?: EngineExitWatch;
      logger?: WorkerLogger;
      timeouts?: Partial<WorkerTimeouts>;
      /** Handed the gateway client before the worker starts. */
      onClient?: (client: HttpWorkerGatewayClient) => void;
      /** Handed the worker before its loop starts, to drain it. */
      onHost?: (host: WorkerHost) => void;
    }) {
      const launch = await launchSession(flow.db, {
        sessionId: input.sessionId,
      });
      const executionId = launch.executionId;
      const resultOf = async (turn: number) =>
        result(
          inputUuid(
            input.sessionId,
            String(turn),
            await queueIdOf(input.sessionId, turn),
          ),
          input.engineSession,
        );
      const runtime = fakeRuntimeFor(
        SCRIPTED_KIND,
        input.steps === undefined
          ? [
              { type: "await-input" },
              { type: "emit", message: await resultOf(input.turn) },
              { type: "await-input" },
            ]
          : await input.steps(resultOf),
      );
      const launches: Array<{ mode: string; resume: string | null }> = [];
      const client = new HttpWorkerGatewayClient({
        baseUrl: base(),
        credential: launch.nonce,
        requestTimeoutMs: 5_000,
      });
      input.onClient?.(client);
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
        logger: input.logger ?? silent,
        ...(input.engines === undefined ? {} : { engines: input.engines }),
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
          ...input.timeouts,
        },
        workspace: noWorkspace,
        ...(input.outsideTurnCheckpoint === undefined
          ? {}
          : { outsideTurnCheckpoint: input.outsideTurnCheckpoint }),
      });
      input.onHost?.(host);
      const summary = await host.runLoop();
      return { summary, executionId, runtime, launches };
    }

    async function newSession(message: string) {
      const created = await post("/v1/sessions", {
        repository_id: "sample-app",
        message,
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `context-gap-e2e-${crypto.randomUUID()}`;
      await flow.db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await flow.db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));
      return sessionId;
    }

    async function turnRow(sessionId: string, sequence: number) {
      const [row] = await flow.db
        .select({ id: turns.id, status: turns.status })
        .from(turns)
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        );
      if (!row) throw new Error(`no turn ${sequence}`);
      return row;
    }

    test("a turn that left background work running is checkpointed once the work ends, so the idle exit leaves the session to its next worker", async () => {
      const sessionId = await newSession(
        "sleep 90 in the background, then say done",
      );
      let ported: ReturnType<typeof namingPort> | undefined;

      // Turn 1 ends with a background task alive; it ends later, and the
      // engine then answers on its own, outside any turn.
      const first = await runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-bg",
        checkpoints: (gateway) => {
          ported = namingPort(gateway);
          return ported.port;
        },
        steps: async (resultOf) => [
          { type: "await-input" },
          {
            type: "emit",
            message: {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: "bash_1", task_type: "local_bash" }],
            },
          },
          { type: "emit", message: await resultOf(1) },
          { type: "delay", delayMs: 150 },
          {
            type: "emit",
            message: {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [],
            },
          },
          {
            type: "emit",
            message: {
              type: "assistant",
              session_id: "engine-bg",
              parent_tool_use_id: null,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
              },
            },
          },
          {
            type: "emit",
            message: {
              type: "result",
              subtype: "success",
              session_id: "engine-bg",
              is_error: false,
            },
          },
          { type: "await-input" },
        ],
      });

      expect(first.summary.outcome).toBe("idle");
      expect(first.summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
      ]);
      // Refused at the turn's end, taken between turns once the run was quiet.
      expect(ported?.captures[0]).toEqual({
        status: "rejected",
        kind: "turn_end",
      });
      expect(ported?.captures.at(-1)).toEqual({
        status: "ready",
        kind: "between_turns",
      });
      // What the engine said after the turn is the turn's, marked as such.
      const first1 = await turnRow(sessionId, 1);
      expect(first1.status).toBe("completed");
      const said = await flow.db
        .select({
          turnId: schema.events.turnId,
          neutral: schema.events.neutral,
        })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.sessionId, sessionId),
            eq(schema.events.type, "assistant"),
          ),
        );
      expect(said).toEqual([
        {
          turnId: first1.id,
          neutral: expect.objectContaining({ after_turn: true }),
        },
      ]);

      // The scheduler observes the exit: no context gap, nothing to decide.
      await confirmExecutionGone(flow.db, first.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        status: "idle",
        attention: null,
        durability: {
          last_completed_turn_id: "1",
          last_checkpointed_turn_id: "1",
          checkpoint_pending_reason: null,
        },
      });

      // The next message goes to a new worker, which resumes the engine
      // session the checkpoint was captured from.
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "second",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);
      const second = await runWorker({
        sessionId,
        turn: 2,
        engineSession: "engine-bg",
        checkpoints: checkpointPort(true, 1, () => "engine-bg").port,
      });
      expect(second.launches).toEqual([
        { mode: "resume", resume: "engine-bg" },
      ]);
      expect(second.summary.turns).toEqual([
        { turnId: "2", status: "completed", reason: null },
      ]);
    }, 60_000);

    test("an upload the store failed is retried in the lease while the next message stays queued, and the retry's commit lets it start", async () => {
      const sessionId = await newSession("first");
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "second",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);

      // The second ready capture is the first retry: held here while the
      // session is read, as a store still down would hold it.
      let reached: () => void = () => {};
      const atRetry = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ported: ReturnType<typeof namingPort> | undefined;
      const running = runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-pf",
        checkpoints: (gateway) => {
          // Only the upload fails: the turn's own bundle write.
          const objects = createMemoryCheckpointObjectStore();
          objects.failWrites(1);
          ported = namingPort(gateway, {
            objects,
            beforeCapture: async (ready) => {
              if (ready !== 2) return;
              reached();
              await released;
            },
          });
          return ported.port;
        },
        steps: async (resultOf) => [
          { type: "await-input" },
          { type: "emit", message: await resultOf(1) },
          { type: "await-input" },
          { type: "emit", message: await resultOf(2) },
          { type: "await-input" },
        ],
        outsideTurnCheckpoint: { retryBackoffMs: [50] },
      });

      await atRetry;
      // Longer than several input polls would take: none is made.
      await Bun.sleep(500);
      expect((await turnRow(sessionId, 1)).status).toBe("completed");
      expect((await turnRow(sessionId, 2)).status).toBe("queued");
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        queued_turn_count: 1,
        durability: {
          last_completed_turn_id: "1",
          last_checkpointed_turn_id: null,
          checkpoint_pending_reason: "publish_failed",
        },
      });

      release();
      const done = await running;

      expect(done.summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
        { turnId: "2", status: "completed", reason: null },
      ]);
      expect(ported?.captures).toEqual([
        { status: "ready", kind: "turn_end" },
        { status: "ready", kind: "between_turns" },
        { status: "ready", kind: "turn_end" },
      ]);
      // Revision 0 is turn 1's, committed outside it; revision 1 is turn 2's.
      const first1 = await turnRow(sessionId, 1);
      const covered = await flow.db
        .select({
          revision: schema.checkpoints.revision,
          turnId: schema.checkpoints.turnId,
        })
        .from(schema.checkpoints)
        .where(eq(schema.checkpoints.sessionId, sessionId));
      expect(covered).toContainEqual({ revision: 0, turnId: first1.id });
      expect(covered).toHaveLength(2);
      await confirmExecutionGone(flow.db, done.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        status: "idle",
        attention: null,
        durability: {
          last_completed_turn_id: "2",
          last_checkpointed_turn_id: "2",
          checkpoint_pending_reason: null,
          checkpoint_revision: 1,
        },
      });
    }, 60_000);

    test("a commit the gateway failed is retried in the lease while the next message stays queued, and the retry's commit lets it start", async () => {
      const sessionId = await newSession("start a build in the background");
      const work = backgroundProcess();
      // Only the commit fails: every capture uploads, and the gateway answers
      // its commit 503 while this is set.
      let failing = true;
      let commitsSent = 0;
      let ported: ReturnType<typeof namingPort> | undefined;
      let host: WorkerHost | undefined;
      // Turn 2 is posted once the hold has begun, so its result is filled in
      // then: the engine emits it only after turn 2 is delivered.
      const secondResult: EngineMessage = {
        type: "result",
        subtype: "success",
        session_id: "engine-cf",
        is_error: false,
        user_message_uuid: null,
      };
      const running = runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-cf",
        engines: work.engines,
        checkpoints: (gateway) => {
          ported = namingPort(gateway, {
            // Failed commits leave the pointer where it was.
            nextRevision: async () =>
              ((await detail(sessionId)).durability.checkpoint_revision ?? -1) +
              1,
          });
          return ported.port;
        },
        onClient: (client) => {
          const commit = client.commitCheckpoint.bind(client);
          client.commitCheckpoint = async (request) => {
            commitsSent += 1;
            if (failing) {
              throw new WorkerGatewayRequestError(
                503,
                "BACKEND_UNAVAILABLE",
                "the database is not answering",
                true,
              );
            }
            return commit(request);
          };
        },
        onHost: (started) => {
          host = started;
        },
        steps: async (resultOf) => [
          { type: "await-input" },
          { type: "emit", message: await resultOf(1) },
          { type: "await-input" },
          { type: "emit", message: secondResult },
          { type: "await-input" },
        ],
        outsideTurnCheckpoint: { retryBackoffMs: [50], commitRetryMs: 100 },
        // No idle exit: the test ends the worker itself.
        timeouts: { idleTimeoutMs: 60_000 },
      });

      // Turn 1 ends with the build running, so its own capture is refused;
      // the build ends, and the capture taken then cannot commit.
      for (let i = 0; i < 500; i += 1) {
        if ((await turnRow(sessionId, 1)).status === "completed") break;
        await Bun.sleep(20);
      }
      expect((await turnRow(sessionId, 1)).status).toBe("completed");
      work.end();
      for (let i = 0; i < 500 && commitsSent < 2; i += 1) await Bun.sleep(20);
      expect(commitsSent).toBeGreaterThanOrEqual(2);
      expect(
        (
          await post(`/v1/sessions/${sessionId}/messages`, {
            message: "second",
            mode: "enqueue",
          })
        ).status,
      ).toBe(202);
      secondResult.user_message_uuid = inputUuid(
        sessionId,
        "2",
        await queueIdOf(sessionId, 2),
      );
      // Longer than several input polls would take: none is made.
      await Bun.sleep(500);
      expect((await turnRow(sessionId, 2)).status).toBe("queued");
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        queued_turn_count: 1,
        durability: {
          last_completed_turn_id: "1",
          last_checkpointed_turn_id: null,
        },
      });

      failing = false;
      for (let i = 0; i < 500; i += 1) {
        if ((await turnRow(sessionId, 2)).status === "completed") break;
        await Bun.sleep(20);
      }
      expect((await turnRow(sessionId, 2)).status).toBe("completed");
      host?.drain("test over");
      const done = await running;

      expect(done.summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
        { turnId: "2", status: "completed", reason: null },
      ]);
      const between = (ported?.captures ?? []).filter(
        (capture) => capture.kind === "between_turns",
      );
      expect(between.length).toBeGreaterThanOrEqual(2);
      const first1 = await turnRow(sessionId, 1);
      const covered = await flow.db
        .select({
          revision: schema.checkpoints.revision,
          turnId: schema.checkpoints.turnId,
        })
        .from(schema.checkpoints)
        .where(eq(schema.checkpoints.sessionId, sessionId));
      expect(covered).toContainEqual({ revision: 0, turnId: first1.id });
      await confirmExecutionGone(flow.db, done.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        attention: null,
        durability: {
          last_completed_turn_id: "2",
          last_checkpointed_turn_id: "2",
        },
      });
    }, 60_000);

    test("SIGTERM during the background grace stops the work, checkpoints the turn and leaves the session to its next worker", async () => {
      const sessionId = await newSession("start a dev server and leave it");
      const work = backgroundProcess();
      const { graced, logger } = graceLogger();
      let ported: ReturnType<typeof namingPort> | undefined;
      const first = await runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-drain",
        engines: work.engines,
        logger,
        checkpoints: (gateway) => {
          ported = namingPort(gateway);
          return ported.port;
        },
        // A grace the test never waits out: only the drain ends it.
        outsideTurnCheckpoint: { idleBackgroundGraceMs: 600_000 },
        onHost: (host) => {
          void graced.then(() => host.drain("received SIGTERM"));
        },
      });

      expect(first.summary.outcome).toBe("drained");
      expect(work.signals).toEqual([["SIGTERM", [4243]]]);
      expect(ported?.captures).toEqual([
        { status: "rejected", kind: "turn_end" },
        { status: "ready", kind: "before_idle_exit" },
      ]);
      const stopped = await flow.db
        .select({ payload: schema.events.payload })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.sessionId, sessionId),
            eq(schema.events.type, "system"),
          ),
        );
      expect(stopped.map((row) => row.payload)).toContainEqual(
        expect.objectContaining({
          subtype: "background_tasks_stopped",
          commands: ["sleep"],
        }),
      );

      // The scheduler observes the exit: covered, so nothing to decide.
      await confirmExecutionGone(flow.db, first.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "active",
        status: "idle",
        attention: null,
        durability: {
          last_completed_turn_id: "1",
          last_checkpointed_turn_id: "1",
          checkpoint_pending_reason: null,
        },
      });
    }, 60_000);

    test("SIGTERM during the background grace whose capture fails still leaves the session to a recovery decision", async () => {
      const sessionId = await newSession("start a dev server and leave it");
      const work = backgroundProcess();
      const { graced, logger } = graceLogger();
      let ported: ReturnType<typeof namingPort> | undefined;
      const first = await runWorker({
        sessionId,
        turn: 1,
        engineSession: "engine-drain-failed",
        engines: work.engines,
        logger,
        checkpoints: (gateway) => {
          ported = namingPort(gateway, {
            failures: [{ reason: "publish_failed", infrastructure: true }],
          });
          return ported.port;
        },
        outsideTurnCheckpoint: { idleBackgroundGraceMs: 600_000 },
        onHost: (host) => {
          void graced.then(() => host.drain("received SIGTERM"));
        },
      });

      expect(first.summary.outcome).toBe("drained");
      expect(work.signals).toEqual([["SIGTERM", [4243]]]);
      expect(ported?.captures).toEqual([
        { status: "rejected", kind: "turn_end" },
        { status: "ready", kind: "before_idle_exit" },
      ]);
      await confirmExecutionGone(flow.db, first.executionId);
      expect(await detail(sessionId)).toMatchObject({
        admission_state: "recovery_required",
        status: "failed",
        attention: {
          code: "CONTEXT_GAP",
          last_ran_turn_id: "1",
          checkpointed_turn_id: null,
        },
      });
    }, 60_000);

    test("an idle exit without a covering checkpoint waits on an operator, and start_fresh continues visibly on a new engine session", async () => {
      // 1. A session and its first turn.
      const created = await post("/v1/sessions", {
        repository_id: "sample-app",
        message: "first",
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `context-gap-e2e-${crypto.randomUUID()}`;
      await flow.db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await flow.db
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
      const [released] = await flow.db
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
      await confirmExecutionGone(flow.db, first.executionId);
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
      await expect(launchSession(flow.db, { sessionId })).rejects.toThrow(
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
      await confirmExecutionGone(flow.db, fresh.executionId);
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

    // This pins today's path; whichever option a fix adopts flips the marked
    // expectations (retry: one more capture; hold: the 202; show: attention).
    test("a completed turn whose publish failed leaves an unannounced gap that becomes CONTEXT_GAP once its worker is replaced", async () => {
      const created = await post("/v1/sessions", {
        repository_id: "sample-app",
        message: "first",
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `publish-failed-gap-${crypto.randomUUID()}`;
      await flow.db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await flow.db
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
      await confirmExecutionGone(flow.db, first.executionId);
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
      await confirmExecutionGone(flow.db, second.executionId);
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
      await expect(launchSession(flow.db, { sessionId })).rejects.toThrow(
        "not launchable",
      );
    }, 60_000);
  },
);
