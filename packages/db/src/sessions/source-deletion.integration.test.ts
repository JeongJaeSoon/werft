import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "../control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import { receipts, sessions, turns, workspaces } from "../schema.ts";
import { createPostgresSlackSourceMarkStore } from "../surface/slack-source-marks.ts";
import {
  testWorkerGateway,
  type TestWorker as Worker,
  workerOf,
} from "../testing/gateway.ts";
import { confirmExecutionGone, launchSession } from "../testing/launches.ts";
import {
  newPartitionedSession,
  type PartitionedSession as Session,
} from "../testing/sessions.ts";
import { testSessionCatalog } from "../testing/spec-pins.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANIFEST_SHA = "c".repeat(64);
const TEAM = "T0DEL";
const CHANNEL = "C0DEL";
const A = "1792800000.000100";

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

integration("a deleted source on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "source_deleted_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
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
    const claimed = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: executionId,
        execution_generation: generation,
        credential: { kind: "launch_nonce", nonce },
      },
    );
    return workerOf(claimed, executionId);
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  // The turn's Slack message, as newTurnSources writes it, and the
  // workspace a delete mark is matched in.
  async function fromSlack(session: Session, turnId: string) {
    const workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    await db
      .update(turns)
      .set({
        sources: {
          direct: [{ team_id: TEAM, channel_id: CHANNEL, ts: A }],
          inherited: [],
        },
      })
      .where(
        and(
          eq(turns.sessionId, session.sessionId),
          eq(turns.sequence, Number(turnId)),
        ),
      );
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, session.sessionId));
    return workspaceId;
  }

  const control = (session: Session) => ({
    principal: { ownerId: session.ownerId },
    sessionId: session.sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    now: new Date(),
  });

  test("a delete mid-turn lets the turn finish, then the session pauses and only closes", async () => {
    const session = await newPartitionedSession(db, "source-deleted");
    const worker = await claim(session);
    const next = await gateway.nextInput(worker.principal, worker.scope);
    const turnId = next.input?.turn_id;
    if (turnId === undefined) throw new Error("no input delivered");
    const queued = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "queued before the delete",
    });
    expect(queued.outcome).toBe("accepted");
    const workspaceId = await fromSlack(session, turnId);
    const before = await sessionRow(session.sessionId);

    await createPostgresSlackSourceMarkStore(db).markDeleted({
      workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
      ts: A,
      at: new Date(),
    });

    // The running turn is not cut: the worker keeps its lease and drains.
    const pausing = await sessionRow(session.sessionId);
    expect(pausing.admissionState).toBe("pausing");
    expect(pausing.sourceDeletedAt).not.toBeNull();
    expect(pausing.leaseEpoch).toBe(before.leaseEpoch);
    const pending = await gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
    });
    expect(pending.control).toMatchObject({ kind: "pause" });
    const controlId = pending.control?.control_id;
    if (controlId === undefined) throw new Error("no pause control");
    const [receipt] = await db
      .select({ actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.id, controlId));
    expect(receipt).toEqual({ actor: null });

    await gateway.finalize(worker.principal, {
      ...worker.scope,
      turn_id: turnId,
      finalize_key: `${worker.scope.attempt_id}:${turnId}`,
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
    // The queued turn is not handed over.
    expect(
      (await gateway.nextInput(worker.principal, worker.scope)).input,
    ).toBeNull();
    expect(
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "pause",
        pause_control_id: controlId,
      }),
    ).toEqual({ released: true });
    await confirmExecutionGone(db, worker.executionId);

    const paused = await sessionRow(session.sessionId);
    expect(paused.admissionState).toBe("paused");
    const detail = await createPostgresSessionReader(db).getSession(
      session.ownerId,
      session.sessionId,
    );
    expect(detail?.attention).toEqual({ code: "SOURCE_DELETED" });
    expect(
      (
        await db
          .select({ status: turns.status })
          .from(turns)
          .where(eq(turns.sessionId, session.sessionId))
          .orderBy(asc(turns.sequence))
      ).map((row) => row.status),
    ).toEqual(["completed", "queued"]);
    await expect(
      launchSession(db, { sessionId: session.sessionId }),
    ).rejects.toThrow("not launchable");

    // The owner is no member of the workspace the mark was matched in.
    await db
      .update(sessions)
      .set({ workspaceId: null })
      .where(eq(sessions.id, session.sessionId));
    const append = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "after the delete",
    });
    expect(append.outcome).toBe("source_deleted");
    const controls = createPostgresSessionControl(db);
    const revision = (await sessionRow(session.sessionId)).revision;
    expect(
      (
        await controls.resumeAtomic({
          ...control(session),
          expectedRevision: revision,
        })
      ).outcome,
    ).toBe("source_deleted");
    expect(
      (
        await controls.closeAtomic({
          ...control(session),
          expectedRevision: revision,
          reason: null,
        })
      ).outcome,
    ).toBe("accepted");
    const closed = await sessionRow(session.sessionId);
    expect(closed.admissionState).toBe("closed");
    const [cancelled] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        sql`${turns.sessionId} = ${session.sessionId} AND ${turns.sequence} = 2`,
      );
    expect(cancelled?.status).toBe("cancelled");
  });
});
