import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  ADMISSION_STATE_VALUES,
  type AdmissionState,
  type SlackMessageRef,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "../control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  events,
  pendingRequests,
  receipts,
  sessions,
  turns,
  workspaces,
} from "../schema.ts";
import { createPostgresSlackSourceMarkStore } from "../surface/slack-source-marks.ts";
import { fixtureRelease, TEST_MODEL } from "../testing/spec-pins.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import { sourceDeletedTransition } from "./source-deletion.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };
const TEAM = "T0DEL";
const CHANNEL = "C0DEL";
const A = "1792800000.000100";
const B = "1792800000.000200";

describe("the transition a deleted source makes", () => {
  type Row = {
    from: AdmissionState;
    park?: boolean;
    legacy?: boolean;
    bound?: boolean;
    drainer?: boolean;
    into: AdmissionState | null;
    pauseReceipt?: "open" | "settled" | null;
  };
  // Every admission once, and each way active and a park can be reached.
  // null: left as it is, not marked.
  const table: Row[] = [
    { from: "active", into: "paused", pauseReceipt: "settled" },
    { from: "active", bound: true, into: "pausing", pauseReceipt: "open" },
    {
      from: "active",
      bound: true,
      drainer: true,
      into: "pausing",
      pauseReceipt: "open",
    },
    { from: "active", legacy: true, into: "active", pauseReceipt: null },
    { from: "pausing", bound: true, into: "pausing", pauseReceipt: null },
    {
      from: "pausing",
      park: true,
      bound: true,
      into: "pausing",
      pauseReceipt: "open",
    },
    { from: "paused", into: "paused", pauseReceipt: null },
    { from: "paused", park: true, into: "paused", pauseReceipt: null },
    { from: "resuming", bound: true, into: "stopping", pauseReceipt: null },
    { from: "resuming", into: "stopped", pauseReceipt: null },
    { from: "stopping", bound: true, into: "stopping", pauseReceipt: null },
    { from: "stopped", into: "stopped", pauseReceipt: null },
    {
      from: "recovery_required",
      into: "recovery_required",
      pauseReceipt: null,
    },
    { from: "closing", bound: true, into: null },
    { from: "closed", into: null },
  ];

  test("the table names every admission state", () => {
    expect(new Set(table.map((row) => row.from))).toEqual(
      new Set(ADMISSION_STATE_VALUES),
    );
  });

  test.each(table.map((row) => [row.from, row] as const))(
    "%s",
    (_from, row) => {
      const transition = sourceDeletedTransition({
        admissionState: row.from,
        pauseReason: row.park ? "awaiting_input" : null,
        legacy: row.legacy ?? false,
        bound: row.bound ?? false,
        drainer: row.drainer ?? false,
      });
      expect(transition).toEqual(
        row.into === null
          ? null
          : { into: row.into, pauseReceipt: row.pauseReceipt ?? null },
      );
    },
  );

  test("no session it marks is left where a worker could be launched for it", () => {
    for (const row of table) {
      const into = sourceDeletedTransition({
        admissionState: row.from,
        pauseReason: row.park ? "awaiting_input" : null,
        legacy: false,
        bound: row.bound ?? false,
        drainer: row.drainer ?? false,
      })?.into;
      if (into !== undefined)
        expect(["active", "resuming"]).not.toContain(into);
    }
  });
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

const slackMessage = (ts: string): SlackMessageRef => ({
  team_id: TEAM,
  channel_id: CHANNEL,
  ts,
  thread_ts: ts === A ? null : A,
  permalink: null,
});

async function workspace(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "ws" });
  return id;
}

async function create(slack: SlackMessageRef | null): Promise<string> {
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    titleSource: "derived",
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "start",
    limits: LIMITS,
    ...(slack === null ? {} : { channel: "slack", slackMessage: slack }),
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return created.response.session_id;
}

/**
 * Puts a session made by create() in its agent's workspace, where Slack
 * sessions live and where its messages still reach the agent.
 */
async function workspaceOf(sessionId: string): Promise<string> {
  await db.execute(sql`
    UPDATE sessions s SET workspace_id = a.workspace_id
    FROM agent_releases r JOIN agents a ON a.id = r.agent_id
    WHERE s.id = ${sessionId}::uuid AND r.id = s.agent_release_id`);
  const { workspaceId } = await row(sessionId);
  if (workspaceId === null) throw new Error("no workspace");
  return workspaceId;
}

function append(sessionId: string, slack: SlackMessageRef | null) {
  return createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message: "more",
    limits: LIMITS,
    ...(slack === null
      ? { channel: "web" }
      : { channel: "slack", slackMessage: slack }),
  });
}

const mark = (workspaceId: string, ts: string) => ({
  workspaceId,
  teamId: TEAM,
  channelId: CHANNEL,
  ts,
  at: new Date(),
});

async function row(sessionId: string) {
  const [found] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (found === undefined) throw new Error("no session");
  return found;
}

async function attention(sessionId: string) {
  return (
    await createPostgresSessionReader(db).getSession(OWNER.ownerId, sessionId)
  )?.attention;
}

async function systemEvents(sessionId: string) {
  return (
    await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.id))
  )
    .map((event) => event.payload as { type?: string; subtype?: string })
    .filter((payload) => payload.type === "system");
}

const control = () => ({
  principal: OWNER,
  idempotencyKey: crypto.randomUUID(),
  payloadHash: crypto.randomUUID(),
  now: new Date(),
});

describe("a deleted source stops the session", () => {
  beforeEach(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema });
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  test("before: a session with no deleted source runs on and takes messages", async () => {
    const sessionId = await create(slackMessage(A));
    const before = await row(sessionId);
    expect(before.admissionState).toBe("active");
    expect(before.sourceDeletedAt).toBeNull();
    expect(await attention(sessionId)).toBeNull();
    expect((await append(sessionId, slackMessage(B))).outcome).toBe("accepted");
  });

  test("after: the session pauses, says SOURCE_DELETED, refuses messages and resume, and closes", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    expect(
      await createPostgresSlackSourceMarkStore(db).markDeleted(
        mark(workspaceId, A),
      ),
    ).toBe("recorded");

    const after = await row(sessionId);
    // Nothing bound: paused here, with its queued input left as it was.
    expect(after.admissionState).toBe("paused");
    expect(after.sourceDeletedAt).not.toBeNull();
    expect(await attention(sessionId)).toEqual({ code: "SOURCE_DELETED" });
    const queued = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    expect(queued).toEqual([{ status: "queued" }]);
    const [pause] = await db
      .select({ status: receipts.status, actor: receipts.actor })
      .from(receipts)
      .where(
        sql`${receipts.operation} = 'pause' AND ${receipts.targetRef}->>'session_id' = ${sessionId}`,
      );
    expect(pause).toEqual({ status: "succeeded", actor: null });
    expect(await systemEvents(sessionId)).toContainEqual(
      expect.objectContaining({
        subtype: "source_deleted",
        source: { team_id: TEAM, channel_id: CHANNEL, ts: A },
        from_admission_state: "active",
        admission_state: "paused",
      }),
    );

    // The fixture caller is no member of the agent's workspace, so its
    // append reaches the session only as one outside any workspace.
    await db
      .update(sessions)
      .set({ workspaceId: null })
      .where(eq(sessions.id, sessionId));
    expect((await append(sessionId, null)).outcome).toBe("source_deleted");
    const controls = createPostgresSessionControl(db);
    expect(
      (
        await controls.resumeAtomic({
          ...control(),
          sessionId,
          expectedRevision: after.revision,
        })
      ).outcome,
    ).toBe("source_deleted");
    const closed = await controls.closeAtomic({
      ...control(),
      sessionId,
      expectedRevision: after.revision,
      reason: null,
    });
    expect(closed.outcome).toBe("accepted");
    expect((await row(sessionId)).admissionState).toBe("closed");
  });

  test("an inherited source stops it too", async () => {
    const sessionId = await create(slackMessage(A));
    expect((await append(sessionId, null)).outcome).toBe("accepted");
    const workspaceId = await workspaceOf(sessionId);
    // Only the second turn lists A, and only as inherited.
    await db
      .update(turns)
      .set({ sources: null })
      .where(sql`${turns.sessionId} = ${sessionId} AND ${turns.sequence} = 1`);
    await createPostgresSlackSourceMarkStore(db).markDeleted(
      mark(workspaceId, A),
    );
    expect((await row(sessionId)).sourceDeletedAt).not.toBeNull();
  });

  test("an edit, another message or another workspace stops nothing", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    const marks = createPostgresSlackSourceMarkStore(db);
    await marks.markEdited(mark(workspaceId, A));
    await marks.markDeleted(mark(workspaceId, B));
    await marks.markDeleted(mark(await workspace(), A));
    const after = await row(sessionId);
    expect(after.admissionState).toBe("active");
    expect(after.sourceDeletedAt).toBeNull();
    expect(await attention(sessionId)).toBeNull();
  });

  test("a closed session is left as it is; a redelivered delete stops nothing twice", async () => {
    const closedId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(closedId);
    await db
      .update(sessions)
      .set({ admissionState: "closed", status: "stopped" })
      .where(eq(sessions.id, closedId));
    const openId = await create(slackMessage(A));
    await workspaceOf(openId);
    const marks = createPostgresSlackSourceMarkStore(db);
    await marks.markDeleted(mark(workspaceId, A));
    expect(await marks.markDeleted(mark(workspaceId, A))).toBe("duplicate");

    const closed = await row(closedId);
    expect(closed.sourceDeletedAt).toBeNull();
    expect(await systemEvents(closedId)).toEqual([]);
    expect(
      (await systemEvents(openId)).filter(
        (event) => event.subtype === "source_deleted",
      ),
    ).toHaveLength(1);
  });

  test("a paused park becomes a plain pause, so no answer resumes it", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    await db
      .update(sessions)
      .set({ admissionState: "paused", pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    await createPostgresSlackSourceMarkStore(db).markDeleted(
      mark(workspaceId, A),
    );
    const after = await row(sessionId);
    expect(after.admissionState).toBe("paused");
    expect(after.pauseReason).toBeNull();
    expect(after.sourceDeletedAt).not.toBeNull();
  });

  test("a park left by an earlier turn takes no answer once a source is deleted", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    await db
      .update(sessions)
      .set({ admissionState: "pausing", pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    if (turn === undefined) throw new Error("no turn");
    await db.insert(pendingRequests).values({
      requestId: "req-parked",
      sessionId,
      turnId: turn.id,
      attemptId: "attempt-1",
      kind: "permission",
      payload: {},
      inputHash: "hash",
      expiresAt: new Date(Date.now() + 3_600_000),
      parkedAt: new Date(),
    });
    await createPostgresSlackSourceMarkStore(db).markDeleted(
      mark(workspaceId, A),
    );
    expect((await row(sessionId)).admissionState).toBe("pausing");
    await db
      .update(sessions)
      .set({ workspaceId: null })
      .where(eq(sessions.id, sessionId));
    const answered = await createPostgresPendingRequests(db).answerAtomic({
      principal: OWNER,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "answer",
      answer: {
        request_id: "req-parked",
        kind: "permission",
        decision: "allow",
      },
      approval: { surface: "web", decisionId: crypto.randomUUID() },
    });
    expect(answered.outcome).toBe("source_deleted");
  });

  test("a resume waiting on its worker stops, and the session closes from there", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    await db
      .update(sessions)
      .set({ admissionState: "resuming" })
      .where(eq(sessions.id, sessionId));
    await createPostgresSlackSourceMarkStore(db).markDeleted(
      mark(workspaceId, A),
    );
    const after = await row(sessionId);
    expect(after.admissionState).toBe("stopped");
    expect(after.status).toBe("stopped");
    expect(after.sourceDeletedAt).not.toBeNull();
    // The queued input will never run.
    expect(
      (
        await db
          .select({ status: turns.status })
          .from(turns)
          .where(eq(turns.sessionId, sessionId))
      ).map((turn) => turn.status),
    ).toEqual(["cancelled"]);
  });

  test("start_fresh is refused; a recovery close is not", async () => {
    const sessionId = await create(slackMessage(A));
    const workspaceId = await workspaceOf(sessionId);
    await db
      .update(sessions)
      .set({ admissionState: "recovery_required", status: "failed" })
      .where(eq(sessions.id, sessionId));
    await createPostgresSlackSourceMarkStore(db).markDeleted(
      mark(workspaceId, A),
    );
    const stopped = await row(sessionId);
    expect(stopped.admissionState).toBe("recovery_required");
    const controls = createPostgresSessionControl(db);
    expect(
      (
        await controls.decideRecoveryAtomic({
          ...control(),
          sessionId,
          decision: {
            decision: "start_fresh",
            expected_revision: stopped.revision,
            reason: "go on",
          },
        })
      ).outcome,
    ).toBe("source_deleted");
    expect(
      (
        await controls.decideRecoveryAtomic({
          ...control(),
          sessionId,
          decision: {
            decision: "close",
            expected_revision: stopped.revision,
            reason: "source deleted",
          },
        })
      ).outcome,
    ).toBe("accepted");
    expect((await row(sessionId)).admissionState).toBe("closed");
  });
});
