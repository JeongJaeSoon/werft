import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  createSessionResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  pendingRequests,
  permissionGrants,
  queueMessages,
  receipts,
  turnContinuations,
  turns,
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
  createInterruptService,
  createPendingRequestService,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  FakeAgentRuntime,
  type FakeStep,
  type NativeSdkMessage,
} from "@werft-ai/runtime-claude/testing";
import type { WorkerCheckpointState } from "@werft-ai/runtime-core";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerEventRoutes } from "../apps/control-host/src/api/routes/sessions/events.ts";
import { registerInterruptRoutes } from "../apps/control-host/src/api/routes/sessions/interrupt.ts";
import { registerPendingRoutes } from "../apps/control-host/src/api/routes/sessions/pending.ts";
import { registerReceiptRoutes } from "../apps/control-host/src/api/routes/sessions/receipts.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "../apps/control-host/src/api/routes/workers/worker.ts";
import { PostgresSessionNotifier } from "../apps/control-host/src/api/session-notifier.ts";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import { drainOnSignals } from "../apps/worker/src/main.ts";
import {
  inputUuid,
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";
import { until } from "./until.ts";

/**
 * A drain park carried on end to end in one process: a real SIGTERM parks
 * the first worker's turn, the public API takes the person's answer, and a
 * second WorkerHost claims the session through the Worker Gateway's own
 * HTTP routes and runs the turn that carries the park on. Only the engine
 * is fake.
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

function result(uuid: string): NativeSdkMessage {
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
  // The pointer the session stands at; -1 for none. Revisions start at 0,
  // as the gateway's pointer does.
  pointer: number,
): WorkerCheckpointPort {
  let revision = pointer;
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

integration(
  "a parked turn resumes on a new worker once answered, end to end",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let notifier: PostgresSessionNotifier;
    let gateway: WorkerGateway;
    let server: ReturnType<typeof Bun.serve>;
    const owner = `owner-${crypto.randomUUID()}`;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "park_resume_e2e" });
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
          registerPendingRoutes(
            router,
            createPendingRequestService({
              authorization: createAuthorizationPolicy(),
              store: createPostgresPendingRequests(db),
            }),
          );
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

    const silent: WorkerLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    function startHost(
      launch: TestLaunch,
      runtime: FakeAgentRuntime,
      pointer = -1,
    ) {
      const states: Array<WorkerCheckpointState | undefined> = [];
      const logger = silent;
      const host = new WorkerHost({
        checkpoints: capturing(states, pointer),
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
            start: ({ runtimeConfig, principal, ...rest }) =>
              runtime.run({
                claudeConfigDir: "/tmp/fake/config",
                cwd: "/tmp/fake/workspace",
                home: "/tmp/fake/home",
                model: runtimeConfig.model,
                profile: {
                  ...runtimeConfig.provider,
                  principal: { ownerScope: principal.owner_scope },
                },
                tools: runtimeConfig.tools,
                ...rest,
              }),
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
          // A resumed run restores before it reads input.
          startupTimeoutMs: 10_000,
        },
        workspace: noWorkspace,
      });
      return host;
    }

    type Ask = Omit<
      Extract<FakeStep, { type: "permissions" }>["requests"][number],
      "requestId" | "toolUseId"
    >;

    // A session whose first turn asked `ask` and was parked on it by a real
    // SIGTERM through the worker's own signal wiring.
    async function parkedOn(ask: Ask) {
      const created = await post("/v1/sessions", {
        profile_id: PROFILE_ID,
        repository_id: "sample-app",
        message: "deploy it",
      });
      expect(created.status).toBe(201);
      const sessionId = createSessionResponseSchema.parse(
        await created.json(),
      ).session_id;
      const partition = `park-resume-e2e-${crypto.randomUUID()}`;
      await db
        .update(schema.sessions)
        .set({ partition })
        .where(eq(schema.sessions.id, sessionId));
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));
      const launch = await launchSession(db, { sessionId });
      const runtime = new FakeAgentRuntime([
        { type: "await-input" },
        {
          type: "permissions",
          requests: [{ ...ask, requestId: "sdk-first", toolUseId: "toolu_1" }],
        },
        {
          type: "emit",
          message: result(inputUuid(sessionId, "1", "1")),
        },
        { type: "await-input" },
      ]);
      const host = startHost(launch, runtime);
      const release = drainOnSignals(host);
      try {
        const loop = host.runLoop();
        const requestId = await until(async () => {
          const [row] = await db
            .select({ requestId: pendingRequests.requestId })
            .from(pendingRequests)
            .where(eq(pendingRequests.sessionId, sessionId));
          return row?.requestId;
        }, "the request to be registered");
        process.kill(process.pid, "SIGTERM");
        const summary = await loop;
        expect(summary.turns).toEqual([
          { turnId: "1", status: "interrupted", reason: "input_wait_parked" },
        ]);
        const [row] = await db
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.requestId, requestId));
        expect(row?.parkedAt).not.toBeNull();
        await confirmExecutionGone(db, launch.executionId);
        return { sessionId, requestId, parkedTurnRowId: row?.turnId ?? -1 };
      } finally {
        release();
      }
    }

    async function answer(sessionId: string, body: unknown) {
      const response = await post(`/v1/sessions/${sessionId}/answers`, body);
      expect(response.status).toBe(202);
      return (await response.json()) as {
        receipt_id: string;
        resumed?: boolean;
        waiting_for?: number;
      };
    }

    async function continuing(sessionId: string, parkedTurnRowId: number) {
      const [row] = await db
        .select({ turn: turns, queueId: queueMessages.id })
        .from(turnContinuations)
        .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
        .innerJoin(queueMessages, eq(queueMessages.turnId, turns.id))
        .where(
          and(
            eq(turns.sessionId, sessionId),
            eq(turnContinuations.parkedTurnId, parkedTurnRowId),
          ),
        );
      if (!row) throw new Error("no continuing turn");
      return row;
    }

    // A new worker claims the session and runs the turn that carries the park
    // on, its engine scripted by `steps` given that turn's input uuid.
    async function resume(
      sessionId: string,
      parkedTurnRowId: number,
      steps: (uuid: string) => FakeStep[],
      // Run beside the worker, as a person acting while its turn runs.
      during: () => Promise<void> = async () => {},
    ) {
      const { turn, queueId } = await continuing(sessionId, parkedTurnRowId);
      const launch = await launchSession(db, { sessionId });
      const runtime = new FakeAgentRuntime(
        steps(inputUuid(sessionId, String(turn.sequence), String(queueId))),
      );
      // The park's own checkpoint is revision 0.
      const loop = startHost(launch, runtime, 0).runLoop();
      await during();
      return { summary: await loop, runtime, turn };
    }

    async function receiptStatus(receiptId: string) {
      const [row] = await db
        .select({ status: receipts.status, error: receipts.error })
        .from(receipts)
        .where(eq(receipts.id, receiptId));
      return row;
    }

    async function pendingRows(sessionId: string) {
      return db
        .select()
        .from(pendingRequests)
        .where(eq(pendingRequests.sessionId, sessionId));
    }

    const DEPLOY = { command: "echo deployed >> marker" };

    test("an allow resumes the parked turn on a new worker, whose engine is let through for the same call exactly once", async () => {
      const parked = await parkedOn({ tool: "Bash", input: DEPLOY });
      const answered = await answer(parked.sessionId, {
        request_id: parked.requestId,
        kind: "permission",
        action: "allow",
      });
      expect(answered).toMatchObject({ resumed: true, waiting_for: 0 });
      const { turn } = await continuing(
        parked.sessionId,
        parked.parkedTurnRowId,
      );
      expect(turn.message).toContain("Bash call: allowed");
      const [grant] = await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.requestId, parked.requestId));
      expect(grant?.turnId).toBe(turn.id);

      const resumed = await resume(
        parked.sessionId,
        parked.parkedTurnRowId,
        (uuid) => [
          { type: "await-input" },
          {
            type: "permissions",
            requests: [
              {
                tool: "Bash",
                input: DEPLOY,
                requestId: "sdk-again",
                toolUseId: "toolu_again",
              },
            ],
          },
          { type: "emit", message: result(uuid) },
          { type: "await-input" },
        ],
      );

      expect(resumed.summary.turns).toMatchObject([
        { turnId: String(turn.sequence), status: "completed" },
      ]);
      // Allowed by the grant: nobody was asked again.
      expect(resumed.runtime.permissionDecisions).toEqual([
        { behavior: "allow" },
      ]);
      const rows = await pendingRows(parked.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        settledOutcome: "answered",
        settledAnswerResult: "applied",
      });
      const [spent] = await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.requestId, parked.requestId));
      expect(spent?.consumedAt).not.toBeNull();
      expect(await receiptStatus(answered.receipt_id)).toEqual({
        status: "succeeded",
        error: null,
      });
    }, 60_000);

    test("a denial resumes with the turn told so, and leaves no grant: the same call is asked again", async () => {
      const parked = await parkedOn({ tool: "Bash", input: DEPLOY });
      const answered = await answer(parked.sessionId, {
        request_id: parked.requestId,
        kind: "permission",
        action: "deny",
        reason: "not on a Friday",
      });
      expect(answered).toMatchObject({ resumed: true, waiting_for: 0 });
      const { turn } = await continuing(
        parked.sessionId,
        parked.parkedTurnRowId,
      );
      expect(turn.message).toContain(
        "Bash call: denied. Reason: not on a Friday",
      );
      expect(
        await db
          .select()
          .from(permissionGrants)
          .where(eq(permissionGrants.sessionId, parked.sessionId)),
      ).toEqual([]);

      const resumed = await resume(
        parked.sessionId,
        parked.parkedTurnRowId,
        (uuid) => [
          { type: "await-input" },
          {
            type: "permissions",
            requests: [
              {
                tool: "Bash",
                input: DEPLOY,
                requestId: "sdk-again",
                toolUseId: "toolu_again",
              },
            ],
          },
          { type: "emit", message: result(uuid) },
          { type: "await-input" },
        ],
        async () => {
          // Asked again: with no grant the call waits on a person.
          const again = await until(async () => {
            const rows = await pendingRows(parked.sessionId);
            return rows.find((row) => row.requestId !== parked.requestId);
          }, "the call to be asked again");
          await answer(parked.sessionId, {
            request_id: again.requestId,
            kind: "permission",
            action: "deny",
          });
        },
      );
      expect(resumed.summary.turns).toMatchObject([
        { turnId: String(turn.sequence), status: "completed" },
      ]);
      expect(resumed.runtime.permissionDecisions).toEqual([
        expect.objectContaining({ behavior: "deny" }),
      ]);
      expect(await receiptStatus(answered.receipt_id)).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(resumed.runtime.inputs[0]?.message ?? "").toContain("denied");
    }, 60_000);

    test("a question's chosen option resumes the turn, which is told what was asked and chosen", async () => {
      const parked = await parkedOn({
        tool: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "where",
              question: "Which environment?",
              multiSelect: false,
              options: [
                { label: "staging", description: "safe" },
                { label: "production", description: "not" },
              ],
            },
          ],
        },
      });
      const answered = await answer(parked.sessionId, {
        request_id: parked.requestId,
        kind: "question",
        answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
      });
      expect(answered).toMatchObject({ resumed: true, waiting_for: 0 });
      const { turn } = await continuing(
        parked.sessionId,
        parked.parkedTurnRowId,
      );
      expect(turn.message).toContain("Which environment?: staging");

      const resumed = await resume(
        parked.sessionId,
        parked.parkedTurnRowId,
        (uuid) => [
          { type: "await-input" },
          { type: "emit", message: result(uuid) },
          { type: "await-input" },
        ],
      );
      expect(resumed.summary.turns).toMatchObject([
        { turnId: String(turn.sequence), status: "completed" },
      ]);
      expect(resumed.runtime.permissionDecisions).toEqual([]);
      expect(await receiptStatus(answered.receipt_id)).toEqual({
        status: "succeeded",
        error: null,
      });
    }, 60_000);
  },
);
