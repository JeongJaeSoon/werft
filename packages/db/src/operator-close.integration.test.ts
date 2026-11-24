import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  SessionCatalog,
  WorkerGateway,
  WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import { events, receipts, sessions, turns } from "./schema.ts";
import { closeSessionAsOperator } from "./sessions/operator-close.ts";
import { createPostgresWorkerPendingStore } from "./sessions/pending-control.ts";
import {
  testWorkerGateway,
  type TestWorker as Worker,
  workerOf,
} from "./testing/gateway.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import {
  newPartitionedSession,
  type PartitionedSession as Session,
} from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const MANIFEST_SHA = "c".repeat(64);

const catalog: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { stored: "connection:test-connection" },
    },
  },
  models: ["claude-sonnet-5"],
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

integration("operator close on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "operator_close_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    gateway = testWorkerGateway(db, catalog, {
      pending: createPostgresWorkerPendingStore(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function claim(session: Session): Promise<Worker> {
    const { executionId, generation, nonce } = await launchSession(db, {
      sessionId: session.sessionId,
    });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    });
    return workerOf(claimed, executionId);
  }

  // The worker answered its one turn, checkpointed, and waits for the next.
  async function idleWorker(name: string) {
    const session = await newPartitionedSession(db, name);
    const worker = await claim(session);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    if (!next.input) throw new Error("no input delivered");
    await gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: next.input.turn_id,
      finalize_key: `${worker.scope.attempt_id}:${next.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${session.sessionId}/0`,
        manifest_sha256: MANIFEST_SHA,
      },
    });
    return { session, worker };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function statusPayloads(sessionId: string) {
    const rows = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(asc(events.id));
    return rows
      .map((row) => row.payload as Record<string, unknown>)
      .filter((payload) => "admission_state" in payload);
  }

  const operatorClose = (sessionId: string) =>
    closeSessionAsOperator(db, {
      sessionId,
      reason: "idle worker holds the node",
      now: new Date(),
    });

  test("an idle worker drains and releases, the session closes, and the stream names the operator", async () => {
    const { session, worker } = await idleWorker("idle-worker");
    const before = await sessionRow(session.sessionId);

    const result = await operatorClose(session.sessionId.toUpperCase());
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result).toMatchObject({
      ownerId: session.ownerId,
      receiptStatus: "accepted",
      admissionState: "closing",
    });
    expect((await sessionRow(session.sessionId)).revision).toBe(
      before.revision + 1,
    );
    // Running the command again while the worker drains says so.
    expect(await operatorClose(session.sessionId)).toEqual({
      outcome: "closing",
      receiptId: result.receiptId,
    });

    // The worker sees the close as the drain it is.
    const beat = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(true);
    const control = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
    });
    expect(control.control).toMatchObject({
      control_id: result.receiptId,
      kind: "pause",
    });
    expect(
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "pause",
        pause_control_id: result.receiptId,
      }),
    ).toEqual({ released: true });
    await confirmExecutionGone(db, worker.executionId);

    const closed = await sessionRow(session.sessionId);
    expect(closed.admissionState).toBe("closed");
    expect(closed.status).toBe("stopped");
    expect(closed.executionId).toBeNull();
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, result.receiptId));
    expect(receipt).toMatchObject({
      operation: "close",
      ownerId: session.ownerId,
      status: "succeeded",
      result: {
        resulting_admission_state: "closed",
        checkpoint_revision: 0,
        cancelled_turn_count: 0,
      },
    });
    expect(
      await db
        .select({ status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, session.sessionId)),
    ).toEqual([{ status: "completed" }]);

    const steps = await statusPayloads(session.sessionId);
    expect(steps[0]).toMatchObject({
      admission_state: "closing",
      reason: "idle worker holds the node",
      actor: { kind: "operator", by: "operator_cli" },
    });
    expect(JSON.stringify(steps)).not.toContain(session.ownerId);
    expect(steps.at(-1)).toMatchObject({
      phase: "stopped",
      admission_state: "closed",
    });

    expect(await operatorClose(session.sessionId)).toEqual({
      outcome: "already_closed",
    });
  });

  test("a session with no worker closes at once", async () => {
    const session = await newPartitionedSession(db, "no-worker");
    const result = await operatorClose(session.sessionId);
    expect(result).toMatchObject({
      outcome: "accepted",
      receiptStatus: "succeeded",
      admissionState: "closed",
    });
    const steps = await statusPayloads(session.sessionId);
    expect(steps).toEqual([
      expect.objectContaining({
        phase: "stopped",
        admission_state: "closed",
        actor: { kind: "operator", by: "operator_cli" },
      }),
    ]);
  });

  test("an unknown session is not found", async () => {
    expect(await operatorClose(crypto.randomUUID())).toEqual({
      outcome: "not_found",
    });
  });
});
