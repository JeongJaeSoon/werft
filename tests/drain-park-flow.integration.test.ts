import { describe, expect, test } from "bun:test";
import {
  type CheckpointRef,
  createSessionResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  events,
  pendingRequests,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import type { SessionCatalog } from "@werft-ai/platform";
import {
  approvalInputHash,
  type WorkerCheckpointState,
} from "@werft-ai/runtime-core";
import type {
  EngineMessage,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";
import { fakeRuntimeFor } from "@werft-ai/runtime-registry/testing";
import { and, eq } from "drizzle-orm";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import { drainOnSignals } from "../apps/worker/src/main.ts";
import { noWorkspace } from "../apps/worker/src/testing/no-workspace.ts";
import {
  SCRIPTED_KIND,
  startScripted,
} from "../apps/worker/src/testing/scripted-engine.ts";
import {
  inputUuid,
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { flowHarness } from "./flow-harness.ts";
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

const RAW_MARKER = "raw-park-marker-5d2c";

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
  const flow = flowHarness({ prefix: "drain_park_e2e", catalog });
  const { call, post } = flow;

  async function turnStatus(sessionId: string, sequence: number) {
    const [row] = await flow.db
      .select({ status: turns.status })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
    return row?.status;
  }

  test("SIGTERM parks the waiting turn: the row stays open and parked, the session waits on it, and the raw arguments live only in the manifest", async () => {
    const created = await post("/v1/sessions", {
      repository_id: "sample-app",
      message: "deploy it",
    });
    expect(created.status).toBe(201);
    const sessionId = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    const partition = `drain-park-e2e-${crypto.randomUUID()}`;
    await flow.db
      .update(schema.sessions)
      .set({ partition })
      .where(eq(schema.sessions.id, sessionId));
    await flow.db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const launch = await launchSession(flow.db, { sessionId });

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
        const [row] = await flow.db
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
      const [row] = await flow.db
        .select()
        .from(pendingRequests)
        .where(eq(pendingRequests.requestId, requestId));
      expect(row?.parkedAt).not.toBeNull();
      expect(row?.settledAt).toBeNull();
      expect(row?.resolvedAt).toBeNull();
      const [session] = await flow.db
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
        await flow.db
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.sessionId, sessionId)),
        await flow.db
          .select()
          .from(events)
          .where(eq(events.sessionId, sessionId)),
        await flow.db
          .select()
          .from(turns)
          .where(eq(turns.sessionId, sessionId)),
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
