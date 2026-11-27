import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SseEvent } from "@werft-ai/contracts";
import { TASK_CLOSING_DEFAULT } from "@werft-ai/contracts";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { executions, sessions, turns, unassignedSessions } from "./schema.ts";
import { openTaskLimit } from "./sessions/task-open.ts";
import {
  createPostgresSessionStops,
  STOP_BEFORE_START,
} from "./stop-control.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { launchSession } from "./testing/launches.ts";
import {
  claimedSession,
  newPartitionedSession,
  type PartitionedSession,
} from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

// A stop that reaches a task session before its first turn started: the
// session admission machine's active → closed for it, and active stays for
// every other session a stop reaches.

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

async function asTask(sessionId: string) {
  await db
    .update(sessions)
    .set({ taskClosing: TASK_CLOSING_DEFAULT })
    .where(eq(sessions.id, sessionId));
}

function stop(
  session: { sessionId: string; ownerId: string },
  idempotencyKey = "slack-stop:first",
) {
  return createPostgresSessionStops(db).cancelQueued({
    principal: { ownerId: session.ownerId },
    sessionId: session.sessionId,
    idempotencyKey,
  });
}

async function sessionRow(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) throw new Error("session vanished");
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

/** The task limit as the next spawn_task would meet it: one open task. */
async function overTaskLimit(sessionId: string) {
  const row = await sessionRow(sessionId);
  if (row.agentReleaseId === null) throw new Error("no release");
  return db.transaction((tx) =>
    openTaskLimit(tx, {
      releaseId: row.agentReleaseId as string,
      conversationId: null,
      limits: { conversation: 3, agent: 1 },
    }),
  );
}

async function streamed(session: PartitionedSession) {
  const page = await createPostgresSessionReader(db).readEvents(
    session.ownerId,
    session.sessionId,
    { limit: 50, maxBytes: 1 << 20 },
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

test("a task stopped before its first turn closes at once: its input cancelled, its open-task place given back, nothing left to launch, and a retry replays", async () => {
  const session = await newPartitionedSession(db, "unstarted");
  await asTask(session.sessionId);
  expect(await overTaskLimit(session.sessionId)).toBe("agent");

  const first = await stop(session);
  expect(first).toEqual({
    outcome: "cancelled",
    cancelled: 1,
    runningTurnId: null,
    closed: true,
  });
  expect(await turnRows(session.sessionId)).toEqual([
    { sequence: 1, status: "cancelled", terminalReason: "stop_requested" },
  ]);
  expect(await sessionRow(session.sessionId)).toMatchObject({
    admissionState: "closed",
    status: "stopped",
    taskClosedReason: "cancelled",
  });
  expect(await overTaskLimit(session.sessionId)).toBeNull();
  // No empty launch: it left the dispatch queue and the scheduler refuses it.
  expect(
    await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.sessionId)),
  ).toEqual([]);
  await expect(
    launchSession(db, { sessionId: session.sessionId }),
  ).rejects.toThrow("is not launchable");
  expect(await streamed(session)).toMatchObject([
    {
      phase: "stopped",
      admission_state: "closed",
      closed_by: STOP_BEFORE_START,
    },
    {
      subtype: "session_closed",
      closed_by: STOP_BEFORE_START,
      checkpoint_revision: null,
      cancelled_turn_count: 1,
    },
  ]);

  // The same stop again replays; a new one finds it closed.
  expect(await stop(session)).toEqual(first);
  expect(await stop(session, "slack-stop:second")).toEqual({
    outcome: "closed",
  });
  expect(await streamed(session)).toHaveLength(2);
});

test("a task whose worker claimed it but took no input yet closes too, with the kill intent and the worker fenced out", async () => {
  const claimed = await claimedSession(db, gateway, {
    ownerId: crypto.randomUUID(),
  });
  await asTask(claimed.sessionId);
  const session = await sessionRow(claimed.sessionId);

  expect(
    await stop({ sessionId: session.id, ownerId: session.ownerId }),
  ).toEqual({
    outcome: "cancelled",
    cancelled: 1,
    runningTurnId: null,
    closed: true,
  });
  expect(await sessionRow(session.id)).toMatchObject({
    admissionState: "closed",
    status: "stopped",
    leaseEpoch: session.leaseEpoch + 1,
  });
  const [execution] = await db
    .select({ desiredState: executions.desiredState })
    .from(executions)
    .where(eq(executions.id, claimed.executionId));
  expect(execution?.desiredState).toBe("terminated");
  await expect(
    gateway.nextInput(claimed.principal, claimed.scope),
  ).rejects.toThrow();
});

test("a stop leaves active, as decision 35 has it, a session that is no task and a task whose first turn started", async () => {
  // No task: nothing holds a task's place, and the next input runs it.
  const plain = await newPartitionedSession(db, "plain");
  expect(await stop(plain)).toMatchObject({ cancelled: 1, closed: false });

  // The first turn running: the stop interrupts it, the session stays.
  const running = await newPartitionedSession(db, "running");
  await asTask(running.sessionId);
  await db
    .update(turns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(turns.sessionId, running.sessionId));
  expect(await stop(running)).toEqual({
    outcome: "cancelled",
    cancelled: 0,
    runningTurnId: "1",
    closed: false,
  });

  // The first turn ran and ended; the input after it is cancelled alone.
  const ran = await newPartitionedSession(db, "ran");
  await asTask(ran.sessionId);
  await db
    .update(turns)
    .set({ status: "completed", startedAt: new Date(), endedAt: new Date() })
    .where(eq(turns.sessionId, ran.sessionId));
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: ran.ownerId },
    sessionId: ran.sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message: "and then this",
  });
  expect(appended.outcome).toBe("accepted");
  expect(await stop(ran)).toEqual({
    outcome: "cancelled",
    cancelled: 1,
    runningTurnId: null,
    closed: false,
  });

  for (const { sessionId } of [plain, running, ran]) {
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "active",
      taskClosedReason: null,
    });
  }
  expect(await overTaskLimit(ran.sessionId)).toBe("agent");
});
