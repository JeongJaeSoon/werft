import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SseEvent } from "@werft-ai/contracts";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  executions,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import type { TestWorker } from "./testing/gateway.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { confirmExecutionGone } from "./testing/launches.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

// The session admission machine's recovery_required → closed by a person's
// terminate (docs/architecture/state-machines.md, section 1), and the stops a
// terminate still makes from every other state.

const CATALOG: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
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

let client: PGlite;
let db: Database;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

type Session = TestWorker & { sessionId: string; ownerId: string };

async function running(): Promise<Session> {
  const ownerId = crypto.randomUUID();
  const worker = await claimedSession(db, gateway, { ownerId });
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  return { ...worker, ownerId };
}

function terminate(
  session: Session,
  revision: number,
  idempotencyKey?: string,
) {
  return createPostgresSessionControl(db).terminateAtomic({
    principal: { ownerId: session.ownerId },
    sessionId: session.sessionId,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    payloadHash: "terminate-hash",
    expectedRevision: revision,
    reason: "operator",
    now: new Date(),
  });
}

async function sessionRow(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) throw new Error("session vanished");
  return row;
}

async function receiptRow(id: string) {
  const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
  if (!row) throw new Error("receipt vanished");
  return row;
}

function turnRows(sessionId: string) {
  return db
    .select({
      sequence: turns.sequence,
      status: turns.status,
      terminalReason: turns.terminalReason,
    })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(asc(turns.sequence));
}

// Status frames that carry an admission, and session_closed records, as a
// client following the stream reads them.
async function streamed(session: Session) {
  const page = await createPostgresSessionReader(db).readEvents(
    session.ownerId,
    session.sessionId,
    { limit: 100, maxBytes: 1 << 20 },
  );
  if (!page) throw new Error("session not readable");
  return page.items.flatMap((frame: SseEvent) => {
    const data = frame.data.data as Record<string, unknown>;
    if (frame.event === "status" && data.admission_state !== undefined) {
      return [data];
    }
    return frame.event === "system" && data.subtype === "session_closed"
      ? [data]
      : [];
  });
}

async function detail(session: Session) {
  const read = await createPostgresSessionReader(db).getSession(
    session.ownerId,
    session.sessionId,
  );
  return { status: read?.status, admission_state: read?.admission_state };
}

async function queueSecondInput(session: Session) {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: session.ownerId },
    sessionId: session.sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message: "second input",
  });
  if (appended.outcome !== "accepted") throw new Error(appended.outcome);
  return appended.response.receipt_id;
}

/** failed / recovery_required: the worker was lost mid-turn, nothing bound. */
async function lostMidTurn() {
  const session = await running();
  const queuedReceipt = await queueSecondInput(session);
  await confirmExecutionGone(db, session.executionId);
  const row = await sessionRow(session.sessionId);
  expect({
    status: row.status,
    admissionState: row.admissionState,
    executionId: row.executionId,
  }).toEqual({
    status: "failed",
    admissionState: "recovery_required",
    executionId: null,
  });
  return { session, queuedReceipt };
}

test("terminate closes a failed recovery_required session at once, and pressing it again changes nothing", async () => {
  const { session, queuedReceipt } = await lostMidTurn();
  const before = await sessionRow(session.sessionId);
  const framesBefore = await streamed(session);

  const key = crypto.randomUUID();
  const first = await terminate(session, before.revision, key);
  if (first.outcome !== "accepted") throw new Error(first.outcome);
  expect(first.response.receipt_status).toBe("succeeded");

  const after = await sessionRow(session.sessionId);
  expect({
    status: after.status,
    admissionState: after.admissionState,
    revision: after.revision,
    leaseEpoch: after.leaseEpoch,
  }).toEqual({
    status: "stopped",
    admissionState: "closed",
    revision: before.revision + 1,
    leaseEpoch: before.leaseEpoch + 1,
  });
  expect(await detail(session)).toEqual({
    status: "stopped",
    admission_state: "closed",
  });
  // Closing does not answer the unknown turn; the queued one never runs.
  expect(await turnRows(session.sessionId)).toEqual([
    {
      sequence: 1,
      status: "outcome_unknown",
      terminalReason: "execution_gone",
    },
    { sequence: 2, status: "cancelled", terminalReason: "closed" },
  ]);
  expect(await receiptRow(queuedReceipt)).toMatchObject({
    status: "failed",
    error: { code: "SESSION_CLOSED" },
  });
  expect(
    await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.sessionId)),
  ).toEqual([]);
  expect(await receiptRow(first.response.receipt_id)).toMatchObject({
    operation: "terminate",
    status: "succeeded",
    result: {
      execution_gone: true,
      checkpoint_revision: null,
      unconfirmed_turn_id: "1",
      external_effects_reverted: false,
    },
  });
  expect((await streamed(session)).slice(framesBefore.length)).toEqual([
    {
      phase: "stopped",
      admission_state: "closed",
      closed_by: "terminate",
      reason: "operator",
      actor: { owner_id: session.ownerId },
    },
    {
      type: "system",
      subtype: "session_closed",
      closed_by: "terminate",
      checkpoint_revision: null,
      cancelled_turn_count: 1,
    },
  ]);

  // The same press retried replays its receipt; a new one finds it closed.
  expect(await terminate(session, before.revision, key)).toEqual({
    outcome: "replayed",
    response: first.response,
  });
  expect(await terminate(session, after.revision)).toEqual({
    outcome: "rejected",
    admissionState: "closed",
  });
  const again = await sessionRow(session.sessionId);
  expect({
    admissionState: again.admissionState,
    revision: again.revision,
  }).toEqual({ admissionState: "closed", revision: after.revision });
  expect(await streamed(session)).toHaveLength(framesBefore.length + 2);
});

test("terminate closes a recovery_required session still bound to its execution, and the kill settles the receipt", async () => {
  const session = await running();
  await gateway.finalize(session.principal, {
    ...session.scope,
    turn_id: "1",
    finalize_key: "fin",
    final_source_sequence: 0,
    terminal: {
      status: "outcome_unknown",
      reason: "sdk crashed mid tool call",
      result: null,
      usage: null,
    },
    checkpoint: null,
  });
  const before = await sessionRow(session.sessionId);
  expect(before.admissionState).toBe("recovery_required");
  expect(before.executionId).toBe(session.executionId);

  const result = await terminate(session, before.revision);
  if (result.outcome !== "accepted") throw new Error(result.outcome);
  expect(result.response.receipt_status).toBe("accepted");
  const closed = await sessionRow(session.sessionId);
  expect(closed.admissionState).toBe("closed");
  const [execution] = await db
    .select({ desiredState: executions.desiredState })
    .from(executions)
    .where(eq(executions.id, session.executionId));
  expect(execution?.desiredState).toBe("terminated");

  await confirmExecutionGone(db, session.executionId);
  const after = await sessionRow(session.sessionId);
  expect({
    status: after.status,
    admissionState: after.admissionState,
    executionId: after.executionId,
  }).toEqual({
    status: "stopped",
    admissionState: "closed",
    executionId: null,
  });
  expect(await receiptRow(result.response.receipt_id)).toMatchObject({
    status: "succeeded",
    result: { execution_gone: true, unconfirmed_turn_id: "1" },
  });
});

test("a terminate that cut a running turn leaves recovery_required; the next terminate closes it", async () => {
  const session = await running();
  const first = await terminate(
    session,
    (await sessionRow(session.sessionId)).revision,
  );
  if (first.outcome !== "accepted") throw new Error(first.outcome);
  expect((await sessionRow(session.sessionId)).admissionState).toBe("stopping");
  await confirmExecutionGone(db, session.executionId);
  const cut = await sessionRow(session.sessionId);
  expect({ status: cut.status, admissionState: cut.admissionState }).toEqual({
    status: "stopped",
    admissionState: "recovery_required",
  });

  const second = await terminate(session, cut.revision);
  if (second.outcome !== "accepted") throw new Error(second.outcome);
  expect(second.response.receipt_status).toBe("succeeded");
  expect((await sessionRow(session.sessionId)).admissionState).toBe("closed");
});

test("terminate still stops, and does not close, a session that is not waiting on recovery", async () => {
  const session = await running();
  await gateway.finalize(session.principal, {
    ...session.scope,
    turn_id: "1",
    finalize_key: "fin",
    final_source_sequence: 0,
    terminal: { status: "completed", reason: null, result: null, usage: null },
    checkpoint: null,
  });
  const active = await sessionRow(session.sessionId);
  expect(active.admissionState).toBe("active");
  const result = await terminate(session, active.revision);
  if (result.outcome !== "accepted") throw new Error(result.outcome);
  expect(result.response.receipt_status).toBe("accepted");
  expect((await sessionRow(session.sessionId)).admissionState).toBe("stopping");
  await confirmExecutionGone(db, session.executionId);
  const stopped = await sessionRow(session.sessionId);
  expect({
    status: stopped.status,
    admissionState: stopped.admissionState,
  }).toEqual({ status: "stopped", admissionState: "stopped" });

  // A stopped session is where a terminate leads already: still not closed.
  const again = await terminate(session, stopped.revision);
  if (again.outcome !== "accepted") throw new Error(again.outcome);
  const after = await sessionRow(session.sessionId);
  expect({
    admissionState: after.admissionState,
    revision: after.revision,
  }).toEqual({ admissionState: "stopped", revision: stopped.revision });
  expect(
    (await streamed(session)).filter(
      (frame) => frame.subtype === "session_closed",
    ),
  ).toEqual([]);
});
