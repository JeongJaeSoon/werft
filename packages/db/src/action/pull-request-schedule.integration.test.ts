import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  PullRequestStore,
  PushRequestStore,
  PushWriteResult,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushRequests } from "../push-requests.ts";
import * as schema from "../schema.ts";
import {
  pushIntents,
  pushRequests,
  receipts,
  sessions,
  turns,
} from "../schema.ts";
import { createPostgresPullRequestDrain } from "./pull-request-drain.ts";
import { createPostgresPullRequests } from "./pull-requests.ts";
import { createPostgresPushFollowUpStore } from "./push-follow-ups.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-schedule";
const COMMIT = "c".repeat(40);
const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};
const FIRST = { title: "first" };
const SECOND = { title: "second" };

function written(result: PushWriteResult) {
  if (result.outcome !== "written") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("scheduling a pull request on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let store: PullRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pr_schedule_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    store = createPostgresPullRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function newSession() {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
    });
    return sessionId;
  }

  async function request(sessionId: string, flow: "legacy" | "actions") {
    return written(
      await pushes.create({
        ownerId: OWNER,
        sessionId,
        actor: ACTOR,
        idempotencyKey: `k-${crypto.randomUUID()}`,
        payloadHash: "h",
        repositoryId: "app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: 1,
        gitCommit: COMMIT,
        flow,
        policyApproval: null,
        policyFields: {},
      }),
    );
  }

  async function approve(sessionId: string, pushRequestId: string) {
    written(
      await pushes.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId,
        actor: ACTOR,
        decision: "approve",
        gitCommit: COMMIT,
        reason: null,
        idempotencyKey: `d-${pushRequestId}`,
        payloadHash: "h",
      }),
    );
  }

  async function push(pushRequestId: string, state: "pushed" | "failed") {
    // The claim skips a row another transaction holds (the overlapped
    // schedule below), so it asks again until the row is free.
    let job = await pushes.claimNextApproved(60_000);
    for (let tries = 0; job === null && tries < 50; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await pushes.claimNextApproved(60_000);
    }
    if (job?.id !== pushRequestId) throw new Error("claimed another request");
    await pushes.finish(
      job,
      state === "pushed"
        ? {
            state: "pushed",
            remoteUrl: "https://github.com/acme/app.git",
            remoteRef: `refs/heads/${job.targetBranch}`,
            previousCommit: null,
          }
        : { state: "failed", refusal: "push_failed" },
    );
  }

  const schedule = (
    sessionId: string,
    ref: { pushRequestId: string } | { pushIntentId: string },
    content: unknown = FIRST,
  ) =>
    store.schedule({ ownerId: OWNER, sessionId, ref, content, actor: ACTOR });

  const row = async (id: string) => {
    const [found] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.id, id));
    if (!found) throw new Error("no row");
    return found;
  };

  test("a request that is not pushed yet keeps the first content, and the push then makes it due", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    const first = await schedule(sessionId, { pushRequestId: made.id }, FIRST);
    expect(first).toMatchObject({
      kind: "scheduled",
      pushRequestId: made.id,
      pushIntentId: null,
    });
    const again = await schedule(sessionId, { pushRequestId: made.id }, SECOND);
    expect(again.kind).toBe("scheduled");
    expect((await row(made.id)).pullRequestIntent).toEqual(FIRST);
    expect((await row(made.id)).prState).toBeNull();

    await approve(sessionId, made.id);
    await push(made.id, "pushed");
    expect(await row(made.id)).toMatchObject({
      state: "pushed",
      prState: "due",
      pullRequestIntent: FIRST,
    });
  });

  test("a scheduled request whose push fails ends cancelled, never due", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    await schedule(sessionId, { pushRequestId: made.id });
    await approve(sessionId, made.id);
    await push(made.id, "failed");
    expect(await row(made.id)).toMatchObject({
      state: "failed",
      prState: "cancelled",
    });
  });

  test("an already pushed actions request becomes due in the schedule's own transaction", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    await approve(sessionId, made.id);
    await push(made.id, "pushed");
    expect((await row(made.id)).prState).toBeNull();

    const outcome = await schedule(sessionId, { pushRequestId: made.id });
    expect(outcome.kind).toBe("scheduled");
    expect(await row(made.id)).toMatchObject({
      prState: "due",
      pullRequestIntent: FIRST,
    });
    // Scheduling again changes nothing and never moves the stage back.
    await db
      .update(pushRequests)
      .set({ prState: "failed", prError: "forge_failed" })
      .where(eq(pushRequests.id, made.id));
    expect(
      await schedule(sessionId, { pushRequestId: made.id }, SECOND),
    ).toEqual({ kind: "open_now", pushRequestId: made.id });
    expect(await row(made.id)).toMatchObject({
      prState: "failed",
      pullRequestIntent: FIRST,
    });
  });

  test("a pushed legacy request with no stage is left to the open path", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "legacy");
    await approve(sessionId, made.id);
    await push(made.id, "pushed");
    expect(await schedule(sessionId, { pushRequestId: made.id })).toEqual({
      kind: "open_now",
      pushRequestId: made.id,
    });
    expect((await row(made.id)).prState).toBeNull();
  });

  test("a legacy request that is not pushed is refused, held nothing, and the drain never opens it", async () => {
    const drain = createPostgresPullRequestDrain(db);
    const sessionId = await newSession();
    const made = await request(sessionId, "legacy");
    // Waiting for a person, then approved but not pushed: both are refused
    // as they were before scheduling existed.
    for (const state of ["requested", "approved"] as const) {
      if (state === "approved") await approve(sessionId, made.id);
      expect(await schedule(sessionId, { pushRequestId: made.id })).toEqual({
        kind: "refused",
        refusal: "not_pushed",
        pushRequestState: state,
        details: { push_request_id: made.id },
      });
      expect(await row(made.id)).toMatchObject({
        pullRequestIntent: null,
        prState: null,
      });
    }
    await push(made.id, "pushed");
    // Nothing was held, so the push makes no stage: the drain has nothing
    // to open, and only the open path (the follow-up turn) can.
    expect(await row(made.id)).toMatchObject({
      state: "pushed",
      pullRequestIntent: null,
      prState: null,
    });
    // Other tests leave due rows behind, so the claim is read until empty.
    const claimed: string[] = [];
    for (let job = await drain.claimNextDue(60_000); job !== null; ) {
      claimed.push(job.id);
      job = await drain.claimNextDue(60_000);
    }
    expect(claimed.includes(made.id)).toBe(false);
    expect(await schedule(sessionId, { pushRequestId: made.id })).toEqual({
      kind: "open_now",
      pushRequestId: made.id,
    });
  });

  test("a legacy request an earlier build gave content is refused too, and its push makes no due stage", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "legacy");
    await db
      .update(pushRequests)
      .set({ pullRequestIntent: FIRST })
      .where(eq(pushRequests.id, made.id));
    expect(await schedule(sessionId, { pushRequestId: made.id })).toMatchObject(
      { kind: "refused", refusal: "not_pushed" },
    );
    await approve(sessionId, made.id);
    await push(made.id, "pushed");
    expect(await row(made.id)).toMatchObject({
      state: "pushed",
      prState: null,
    });
  });

  test("the drain never claims a legacy row an earlier build left due or opening", async () => {
    const drain = createPostgresPullRequestDrain(db);
    const sessionId = await newSession();
    const dueRow = await request(sessionId, "legacy");
    await approve(sessionId, dueRow.id);
    await push(dueRow.id, "pushed");
    const openingSession = await newSession();
    const openingRow = await request(openingSession, "legacy");
    await approve(openingSession, openingRow.id);
    await push(openingRow.id, "pushed");
    await db
      .update(pushRequests)
      .set({ pullRequestIntent: FIRST, prState: "due", prNextAttemptAt: null })
      .where(eq(pushRequests.id, dueRow.id));
    await db
      .update(pushRequests)
      .set({
        pullRequestIntent: FIRST,
        prState: "opening",
        prAttempts: 1,
        prClaimToken: crypto.randomUUID(),
        prLeaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(pushRequests.id, openingRow.id));
    const claimed: string[] = [];
    for (let job = await drain.claimNextDue(60_000); job !== null; ) {
      claimed.push(job.id);
      job = await drain.claimNextDue(60_000);
    }
    expect(claimed.includes(dueRow.id)).toBe(false);
    expect(claimed.includes(openingRow.id)).toBe(false);
    expect(await row(dueRow.id)).toMatchObject({ prState: "due" });
    expect(await row(openingRow.id)).toMatchObject({ prState: "opening" });
  });

  test("failHeadMoved ends the stage for good with the number, and findSource reads it back", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    await approve(sessionId, made.id);
    await push(made.id, "pushed");
    const details = { number: 7, url: "https://github.com/acme/app/pull/7" };
    await store.failHeadMoved({
      ownerId: OWNER,
      pushRequestId: made.id,
      details,
    });
    expect(await store.findSource(OWNER, sessionId, made.id)).toMatchObject({
      prState: "failed",
      prError: "head_moved",
      prErrorDetails: details,
    });
  });

  test("a rejected or failed request is refused with its state and id", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    written(
      await pushes.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId: made.id,
        actor: ACTOR,
        decision: "reject",
        gitCommit: COMMIT,
        reason: "not this way",
        idempotencyKey: `r-${made.id}`,
        payloadHash: "h",
      }),
    );
    expect(await schedule(sessionId, { pushRequestId: made.id })).toEqual({
      kind: "refused",
      refusal: "not_pushed",
      pushRequestState: "rejected",
      details: { push_request_id: made.id },
    });
  });

  test("a later request to the same target supersedes an earlier pushed one", async () => {
    const sessionId = await newSession();
    const a = await request(sessionId, "actions");
    await approve(sessionId, a.id);
    await push(a.id, "pushed");
    // A has no stage and no content, so a second request may be made.
    const b = await request(sessionId, "actions");
    expect(await schedule(sessionId, { pushRequestId: a.id })).toEqual({
      kind: "refused",
      refusal: "superseded",
      details: { push_request_id: b.id },
    });
    expect((await row(a.id)).prState).toBeNull();
    // The later request itself still takes the content.
    expect((await schedule(sessionId, { pushRequestId: b.id })).kind).toBe(
      "scheduled",
    );
  });

  test("a request that waited for the session lock is stamped after the lock, so it orders after the holder", async () => {
    const sessionId = await newSession();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        sessionId,
      ]);
      // The create transaction starts now and blocks on the session row.
      const waiting = request(sessionId, "actions");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rows } = await holder.query(
        "SELECT clock_timestamp() AS released",
      );
      await holder.query("COMMIT");
      const created = await waiting;
      const stored = await row(created.id);
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(
        new Date(rows[0].released).getTime(),
      );
    } finally {
      holder.release();
    }
  });

  test("finish takes the session lock before the request row, so a session holder never waits on a locked request", async () => {
    const sessionId = await newSession();
    const a = await request(sessionId, "actions");
    await approve(sessionId, a.id);
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== a.id) throw new Error("claimed another request");
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        sessionId,
      ]);
      const finishing = pushes.finish(job, {
        state: "pushed",
        remoteUrl: "https://github.com/acme/app.git",
        remoteRef: `refs/heads/${job.targetBranch}`,
        previousCommit: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // finish is waiting for the session; it must not hold the request yet.
      await probe.query("BEGIN");
      await probe.query(
        "SELECT id FROM push_requests WHERE id = $1 FOR UPDATE NOWAIT",
        [a.id],
      );
      await probe.query("ROLLBACK");
      await holder.query("COMMIT");
      expect(await finishing).toBe(true);
    } finally {
      holder.release();
      probe.release();
    }
    expect((await row(a.id)).state).toBe("pushed");
  });

  test("scheduling first makes the next request wait: request_open for a pending stage", async () => {
    const sessionId = await newSession();
    const a = await request(sessionId, "actions");
    await approve(sessionId, a.id);
    await push(a.id, "pushed");
    await schedule(sessionId, { pushRequestId: a.id });
    const second = await pushes.create({
      ownerId: OWNER,
      sessionId,
      actor: ACTOR,
      idempotencyKey: `k-${crypto.randomUUID()}`,
      payloadHash: "h",
      repositoryId: "app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: COMMIT,
      flow: "actions",
      policyApproval: null,
      policyFields: {},
    });
    expect(second).toMatchObject({
      outcome: "refused",
      refusal: "request_open",
      reason: "pull_request_pending",
    });
  });

  test("the schedule and the push finishing serialize on the request row, in both orders", async () => {
    // Order 1: finish first, schedule second (covered above: due by the
    // schedule). Order 2 overlapped: both start at once; whichever wins, the
    // row ends `pushed` with the content and a due stage.
    for (let round = 0; round < 5; round += 1) {
      const sessionId = await newSession();
      const made = await request(sessionId, "actions");
      await approve(sessionId, made.id);
      const [outcome] = await Promise.all([
        schedule(sessionId, { pushRequestId: made.id }),
        push(made.id, "pushed"),
      ]);
      expect(outcome.kind === "scheduled" || outcome.kind === "open_now").toBe(
        true,
      );
      expect(await row(made.id)).toMatchObject({
        state: "pushed",
        prState: "due",
        pullRequestIntent: FIRST,
      });
    }
  });

  async function intentOf(sessionId: string, status = "deferred") {
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "work",
        status: "running",
        attemptId: "attempt-1",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    const id = crypto.randomUUID();
    await db.insert(pushIntents).values({
      id,
      ownerId: OWNER,
      sessionId,
      turnId: turn.id,
      attemptId: "attempt-1",
      repositoryId: "app",
      targetBranch: `agent/${sessionId}`,
      status,
      pinnedRevision: status === "pinned" ? 1 : null,
      refusalCode: status === "cancelled" ? "session_closed" : null,
      actor: ACTOR,
    });
    return id;
  }

  test("an intent without a push request holds the first content on its own row", async () => {
    const sessionId = await newSession();
    const intentId = await intentOf(sessionId);
    const outcome = await schedule(
      sessionId,
      { pushIntentId: intentId },
      FIRST,
    );
    expect(outcome).toMatchObject({
      kind: "scheduled",
      pushRequestId: null,
      pushIntentId: intentId,
    });
    await schedule(sessionId, { pushIntentId: intentId }, SECOND);
    const [intent] = await db
      .select()
      .from(pushIntents)
      .where(eq(pushIntents.id, intentId));
    expect(intent?.pullRequest).toEqual(FIRST);
    // The receipt names no push request.
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, (outcome as { receiptId: string }).receiptId));
    expect(receipt).toMatchObject({
      operation: "open_pull_request",
      status: "succeeded",
    });
  });

  test("an ended intent is refused with its code; another session's id is not found", async () => {
    const sessionId = await newSession();
    const ended = await intentOf(sessionId, "cancelled");
    expect(await schedule(sessionId, { pushIntentId: ended })).toEqual({
      kind: "refused",
      refusal: "intent_ended",
      details: { intent_refusal: "session_closed" },
    });
    const other = await newSession();
    expect(await schedule(other, { pushIntentId: ended })).toEqual({
      kind: "refused",
      refusal: "not_found",
    });
  });

  test("get_push_request reads the same push by the intent id and by the request id", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    const intentId = await intentOf(sessionId, "pinned");
    await db
      .update(pushIntents)
      .set({ status: "requested", pushRequestId: made.id })
      .where(eq(pushIntents.id, intentId));
    await schedule(sessionId, { pushRequestId: made.id });

    const byIntent = await pushes.snapshot(OWNER, sessionId, {
      pushIntentId: intentId,
    });
    const byRequest = await pushes.snapshot(OWNER, sessionId, {
      pushRequestId: made.id,
    });
    expect(byIntent).not.toBeNull();
    expect(byIntent).toEqual(byRequest);
    expect(byIntent).toMatchObject({
      push_intent_id: intentId,
      intent_status: "requested",
      push_request_id: made.id,
      push_state: "requested",
      pull_request_scheduled: true,
      pull_request_stage: null,
      pull_request: null,
    });
    expect(
      await pushes.snapshot("someone-else", sessionId, {
        pushRequestId: made.id,
      }),
    ).toBeNull();
  });

  test("the follow-up store reads the flow the request was made under, from its row", async () => {
    const sessionId = await newSession();
    const legacy = await request(sessionId, "legacy");
    const follow = createPostgresPushFollowUpStore(db);
    expect(await follow.flowOf({ sessionId, pushRequestId: legacy.id })).toBe(
      "legacy",
    );
    const other = await newSession();
    const actions = await request(other, "actions");
    expect(
      await follow.flowOf({ sessionId: other, pushRequestId: actions.id }),
    ).toBe("actions");
    // The request belongs to the session it names, and a missing one is null.
    expect(
      await follow.flowOf({ sessionId: other, pushRequestId: legacy.id }),
    ).toBeNull();
  });

  test("an intent that already became a request schedules through the request", async () => {
    const sessionId = await newSession();
    const made = await request(sessionId, "actions");
    const intentId = await intentOf(sessionId, "pinned");
    await db
      .update(pushIntents)
      .set({ status: "requested", pushRequestId: made.id })
      .where(eq(pushIntents.id, intentId));
    const outcome = await schedule(sessionId, { pushIntentId: intentId });
    expect(outcome).toMatchObject({
      kind: "scheduled",
      pushRequestId: made.id,
      pushIntentId: intentId,
    });
    expect((await row(made.id)).pullRequestIntent).toEqual(FIRST);
  });
});
