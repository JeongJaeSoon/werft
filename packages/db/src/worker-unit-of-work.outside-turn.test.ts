import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { CheckpointRef, WorkerEvent } from "@werft-ai/contracts";
import type { WorkerFence } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { deliveredTurnInput, stoppedBackgroundLine } from "./cut-off-input.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { attempts, checkpoints, events, sessions, turns } from "./schema.ts";
import { contextCoverage, contextGap } from "./sessions/context-gap.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/*
 * The turn and attempt transitions a checkpoint outside a turn adds
 * (docs/architecture/state-machines.md, section 2): every allowed one once,
 * every refused one once, on the store that judges them.
 */

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows these transitions read; their triggers and foreign keys
  // are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const AT = new Date("2026-11-27T00:00:00.000Z");
const A = "att-a";
const B = "att-b";

const work = () => createPostgresWorkerUnitOfWork(db);

async function sessionWith(...attemptIds: string[]): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-outside-turn",
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    repositoryId: "app",
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 1,
  });
  for (const id of attemptIds) {
    await db.insert(attempts).values({
      id: `${id}-${sessionId}`,
      sessionId,
      executionId: `exec-${id}-${sessionId}`,
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 1,
      state: "running",
      leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    });
  }
  return sessionId;
}

function fenceOf(sessionId: string, attempt: string, epoch = 1): WorkerFence {
  return {
    sessionId,
    attemptId: `${attempt}-${sessionId}`,
    leaseEpoch: epoch,
    executionGeneration: 1,
    authRevision: 1,
  };
}

/** A turn as it stands: `by` null and not started is one still queued. */
async function turn(
  sessionId: string,
  sequence: number,
  status: string,
  by: string | null,
) {
  const [row] = await db
    .insert(turns)
    .values({
      sessionId,
      sequence,
      message: `turn ${sequence}`,
      status,
      attemptId: by === null ? null : `${by}-${sessionId}`,
      deliveryStartedAt: by === null ? null : AT,
      startedAt: by === null ? null : AT,
      endedAt: status === "running" || status === "queued" ? null : AT,
    })
    .returning();
  if (row === undefined) throw new Error("turn not written");
  return row;
}

function ref(revision: number): CheckpointRef {
  return {
    revision,
    manifest_ref: `sessions/s/checkpoints/${revision}/manifest.json`,
    manifest_sha256: "a".repeat(64),
  };
}

function commit(fence: WorkerFence, turnId: string, revision: number) {
  return work().commitCheckpointAtomic({
    fence,
    now: AT,
    turnId,
    checkpoint: ref(revision),
  });
}

async function sessionRow(sessionId: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (row === undefined) throw new Error("session vanished");
  return row;
}

/** Whether a new worker would start without turns no checkpoint covers. */
async function gap(sessionId: string): Promise<boolean> {
  const session = await sessionRow(sessionId);
  return contextGap(session, await contextCoverage(db, session));
}

function engineEvent(sequence: number, text: string): WorkerEvent {
  return {
    event: "assistant",
    data: { type: "assistant", message: { content: [{ type: "text", text }] } },
    source_sequence: sequence,
    occurred_at: AT.toISOString(),
  } as WorkerEvent;
}

function append(fence: WorkerFence, batch: WorkerEvent[]) {
  return work().commitEventsAtomic({
    fence,
    turnId: null,
    now: AT,
    events: batch,
  });
}

async function stored(sessionId: string) {
  return db
    .select({
      sequence: events.sourceSequence,
      turnId: events.turnId,
      neutral: events.neutral,
      attemptId: events.attemptId,
    })
    .from(events)
    .where(and(eq(events.sessionId, sessionId)))
    .orderBy(asc(events.id));
}

describe("a checkpoint committed outside a turn", () => {
  test("lands on the last turn the attempt finalized: the turn stays completed, the pointer moves, the advisory reason clears and the turn is covered", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    const first = await turn(sessionId, 1, "completed", A);
    // Input that arrived since and has not started holds nothing back.
    await turn(sessionId, 2, "queued", null);
    await work().checkpointStateAtomic({
      fence,
      now: AT,
      pendingReason: "background_writer",
    });
    // An idle exit now would leave turn 1 to a recovery decision.
    expect(await gap(sessionId)).toBe(true);

    expect(await commit(fence, "1", 0)).toEqual({
      outcome: "committed",
      turnId: "1",
      revision: 0,
    });

    const [after] = await db.select().from(turns).where(eq(turns.id, first.id));
    expect(after?.status).toBe("completed");
    expect(after?.endedAt).toEqual(first.endedAt);
    const session = await sessionRow(sessionId);
    expect(session.checkpointRevision).toBe(0);
    expect(session.checkpointPendingReason).toBeNull();
    expect(session.checkpointPendingAttemptId).toBeNull();
    expect(
      await db
        .select({ revision: checkpoints.revision, turnId: checkpoints.turnId })
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId)),
    ).toEqual([{ revision: 0, turnId: first.id }]);
    // The property the change exists for: no context gap at the exit.
    expect(await gap(sessionId)).toBe(false);
  });

  test("answers a resend of the same commit from what is stored, fenced or not", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    await commit(fence, "1", 0);

    const replayed = { outcome: "replayed", turnId: "1", revision: 0 } as const;
    expect(await commit(fence, "1", 0)).toEqual(replayed);
    expect(
      await work().peekCheckpointCommitAtomic({
        fence,
        turnId: "1",
        checkpoint: ref(0),
      }),
    ).toEqual(replayed);
    expect(
      await work().peekCheckpointCommitAtomic({
        fence,
        turnId: "1",
        checkpoint: ref(1),
      }),
    ).toEqual({ outcome: "open" });
    expect(
      await db
        .select({ revision: checkpoints.revision })
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId)),
    ).toHaveLength(1);
  });

  test("is refused from an attempt whose epoch has passed or whose lease has lapsed", async () => {
    const sessionId = await sessionWith(A);
    await turn(sessionId, 1, "completed", A);
    await db
      .update(attempts)
      .set({ leaseExpiresAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(attempts.sessionId, sessionId));
    expect(await commit(fenceOf(sessionId, A), "1", 0)).toEqual({
      outcome: "lease_expired",
    });

    await db
      .update(sessions)
      .set({ leaseEpoch: 2 })
      .where(eq(sessions.id, sessionId));
    expect(await commit(fenceOf(sessionId, A), "1", 0)).toEqual({
      outcome: "stale_epoch",
    });

    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
    expect(await gap(sessionId)).toBe(true);
  });

  test("is refused on a turn that is not the last the attempt finalized", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    await turn(sessionId, 2, "completed", A);

    expect(await commit(fence, "1", 0)).toEqual({
      outcome: "turn_refused",
      reason: "it is not the last turn this attempt finalized",
    });
    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
    // The last one takes it, and covers both.
    expect(await commit(fence, "2", 0)).toMatchObject({ outcome: "committed" });
    expect(await gap(sessionId)).toBe(false);
  });

  test("is refused once a later turn has started: that turn's finalize commits what covers both", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    await turn(sessionId, 2, "running", A);

    expect(await commit(fence, "1", 0)).toEqual({
      outcome: "turn_refused",
      reason: "a later turn has started",
    });
    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
  });

  test.each([
    ["running", "the turn is still open; its finalize commits its checkpoint"],
    [
      "outcome_unknown",
      "a turn that ended outcome_unknown takes no checkpoint",
    ],
    ["cancelled", "a turn that ended cancelled takes no checkpoint"],
  ])("is refused on a turn that is %s", async (status, reason) => {
    const sessionId = await sessionWith(A);
    await turn(sessionId, 1, status, A);

    expect(await commit(fenceOf(sessionId, A), "1", 0)).toEqual({
      outcome: "turn_refused",
      reason,
    });
    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
  });

  test("is refused on another attempt's turn, and on a turn the session does not have", async () => {
    const sessionId = await sessionWith(A, B);
    await turn(sessionId, 1, "completed", A);

    expect(await commit(fenceOf(sessionId, B), "1", 0)).toEqual({
      outcome: "turn_not_found",
    });
    expect(await commit(fenceOf(sessionId, A), "7", 0)).toEqual({
      outcome: "turn_not_found",
    });
    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
  });

  test("does not clear the blocking reason of the attempt that raised it, so the pointer stays untrusted", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    await work().checkpointStateAtomic({
      fence,
      now: AT,
      pendingReason: "mirror_error",
    });

    expect(await commit(fence, "1", 0)).toMatchObject({ outcome: "committed" });

    const session = await sessionRow(sessionId);
    expect(session.checkpointPendingReason).toBe("mirror_error");
    expect(session.checkpointPendingAttemptId).toBe(fence.attemptId);
    // A revision 0 row exists and names turn 1, yet no turn counts as
    // covered: a blocking reason distrusts the pointer itself.
    expect(await contextCoverage(db, session)).toEqual({
      lastRanTurn: 1,
      checkpointedTurn: null,
    });
    expect(await gap(sessionId)).toBe(true);
  });

  test("is refused when its revision is not the pointer's next", async () => {
    const sessionId = await sessionWith(A);
    await turn(sessionId, 1, "completed", A);

    expect(await commit(fenceOf(sessionId, A), "1", 3)).toEqual({
      outcome: "checkpoint_conflict",
      currentRevision: null,
    });
    expect((await sessionRow(sessionId)).checkpointRevision).toBeNull();
  });

  test("is refused from the turn alone before its manifest is judged, so a verdict on the manifest is never recorded for a turn that takes none", async () => {
    const sessionId = await sessionWith(A, B);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    const peek = (by: WorkerFence, turnId: string) =>
      work().peekCheckpointCommitAtomic({
        fence: by,
        turnId,
        checkpoint: ref(0),
      });

    expect(await peek(fence, "1")).toEqual({ outcome: "open" });
    expect(await peek(fenceOf(sessionId, B), "1")).toEqual({
      outcome: "turn_not_found",
    });
    await turn(sessionId, 2, "running", A);
    expect(await peek(fence, "1")).toEqual({
      outcome: "turn_refused",
      reason: "a later turn has started",
    });
    expect(await peek(fence, "2")).toEqual({
      outcome: "turn_refused",
      reason: "the turn is still open; its finalize commits its checkpoint",
    });
  });

  test("a resend that names another version of the manifest object is not the commit that landed", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);
    await commit(fence, "1", 0);

    expect(
      await work().commitCheckpointAtomic({
        fence,
        now: AT,
        turnId: "1",
        checkpoint: { ...ref(0), manifest_version: "version-2" },
      }),
    ).toEqual({ outcome: "checkpoint_conflict", currentRevision: 0 });
  });
});

describe("coverage, which a commit outside a turn does not change the rules of", () => {
  test("a checkpoint that names no turn covers none, so the session still waits on a decision", async () => {
    const sessionId = await sessionWith(A);
    await turn(sessionId, 1, "completed", A);
    await db.insert(checkpoints).values({
      sessionId,
      revision: 0,
      manifestRef: ref(0).manifest_ref,
      manifestSha256: ref(0).manifest_sha256,
      turnId: null,
    });
    await db
      .update(sessions)
      .set({ checkpointRevision: 0 })
      .where(eq(sessions.id, sessionId));

    const session = await sessionRow(sessionId);
    expect(await contextCoverage(db, session)).toEqual({
      lastRanTurn: 1,
      checkpointedTurn: null,
    });
    expect(await gap(sessionId)).toBe(true);
  });

  test("a commit outside a turn always names the turn it is put on", async () => {
    const sessionId = await sessionWith(A);
    const first = await turn(sessionId, 1, "failed", A);

    await commit(fenceOf(sessionId, A), "1", 0);

    const rows = await db
      .select({ turnId: checkpoints.turnId })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId));
    expect(rows).toEqual([{ turnId: first.id }]);
    expect(await gap(sessionId)).toBe(false);
  });
});

describe("events an attempt sends for no turn", () => {
  test("go on the turn it ended last, marked as after it, and a resend is the same event", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    const first = await turn(sessionId, 1, "completed", A);

    const batch = [engineEvent(1, "the build finished")];
    expect(await append(fence, batch)).toMatchObject({
      outcome: "ok",
      acceptedThrough: 1,
    });
    expect(await append(fence, batch)).toMatchObject({
      outcome: "ok",
      acceptedThrough: 1,
    });

    expect(await stored(sessionId)).toEqual([
      {
        sequence: 1,
        turnId: first.id,
        neutral: { after_turn: true },
        attemptId: fence.attemptId,
      },
    ]);
  });

  test("keep the neutral fields the codec derives beside the mark", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "completed", A);

    await work().commitEventsAtomic({
      fence,
      turnId: null,
      now: AT,
      events: [engineEvent(1, "done")],
      neutral: () => ({ text: "done" }),
    });

    expect((await stored(sessionId))[0]?.neutral).toEqual({
      text: "done",
      after_turn: true,
    });
  });

  test("stay on no turn while the attempt has one open, and a resend of an earlier one is still the same event", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    const first = await turn(sessionId, 1, "completed", A);
    await append(fence, [engineEvent(1, "after turn 1")]);
    await turn(sessionId, 2, "running", A);

    expect(
      await append(fence, [
        engineEvent(1, "after turn 1"),
        engineEvent(2, "while turn 2 runs"),
      ]),
    ).toMatchObject({ outcome: "ok", acceptedThrough: 2 });

    expect(
      (await stored(sessionId)).map(({ sequence, turnId, neutral }) => ({
        sequence,
        turnId,
        neutral,
      })),
    ).toEqual([
      { sequence: 1, turnId: first.id, neutral: { after_turn: true } },
      { sequence: 2, turnId: null, neutral: null },
    ]);
  });

  test("an event stored for a turn it named is not the same event sent again for no turn", async () => {
    const sessionId = await sessionWith(A);
    const fence = fenceOf(sessionId, A);
    await turn(sessionId, 1, "running", A);
    await work().commitEventsAtomic({
      fence,
      turnId: "1",
      now: AT,
      events: [engineEvent(1, "in the turn")],
    });
    await db
      .update(turns)
      .set({ status: "completed", endedAt: AT })
      .where(eq(turns.sessionId, sessionId));

    expect(await append(fence, [engineEvent(1, "in the turn")])).toMatchObject({
      outcome: "event_conflict",
    });
  });

  test("are never put on another attempt's turn", async () => {
    const sessionId = await sessionWith(A, B);
    await turn(sessionId, 1, "completed", A);

    // B has ended no turn of its own: A's turn is not its to continue.
    expect(
      await append(fenceOf(sessionId, B), [engineEvent(1, "starting up")]),
    ).toMatchObject({ outcome: "ok" });

    expect(await stored(sessionId)).toEqual([
      {
        sequence: 1,
        turnId: null,
        neutral: null,
        attemptId: fenceOf(sessionId, B).attemptId,
      },
    ]);
  });
});

describe("the next turn's input after an idle worker stopped background work", () => {
  function stopped(sequence: number, commands: unknown): WorkerEvent {
    return {
      event: "system",
      data: { type: "system", subtype: "background_tasks_stopped", commands },
      source_sequence: sequence,
      occurred_at: AT.toISOString(),
    } as WorkerEvent;
  }

  async function delivered(sessionId: string, sequence: number) {
    const next = await turn(sessionId, sequence, "queued", null);
    return (
      await deliveredTurnInput(db, {
        turn: next,
        workspaceId: null,
        redelivery: false,
      })
    ).message;
  }

  test("starts with one line naming the commands, and only what is shaped like a command name", async () => {
    const sessionId = await sessionWith(A);
    await turn(sessionId, 1, "completed", A);
    await append(fenceOf(sessionId, A), [
      stopped(1, ["sleep", "npm run dev --token=abc", "node"]),
    ]);

    expect(await delivered(sessionId, 2)).toBe(
      `${stoppedBackgroundLine(["sleep", "node"])}\n\nturn 2`,
    );
  });

  test("is the turn's own input when nothing was stopped, or when a turn has run since", async () => {
    const plain = await sessionWith(A);
    await turn(plain, 1, "completed", A);
    expect(await delivered(plain, 2)).toBe("turn 2");

    const since = await sessionWith(A);
    await turn(since, 1, "completed", A);
    await append(fenceOf(since, A), [stopped(1, ["sleep"])]);
    await turn(since, 2, "completed", B);
    expect(await delivered(since, 3)).toBe("turn 3");
  });
});
