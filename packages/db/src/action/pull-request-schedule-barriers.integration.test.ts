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
import { pushRequests, sessions } from "../schema.ts";
import { createPostgresPullRequests } from "./pull-requests.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-schedule-barrier";
const COMMIT = "b".repeat(40);
const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};
const CONTENT = { title: "first" };

function written(result: PushWriteResult) {
  if (result.outcome !== "written") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * The two orders of "reserve the pull request" and "the push finishes", each
 * fixed by a transaction that holds the push request's row: the first writer
 * is started and shown to wait, then the second, and the row is let go. Both
 * writers lock the session and then the row, so the first holds the session
 * while it waits for the row and the second queues behind it on the session:
 * neither order depends on timing luck.
 */
integration("scheduling and the push finishing, in each order", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let store: PullRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pr_schedule_barrier" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    store = createPostgresPullRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  /** An approved request of an actions session, claimed and mid-push. */
  async function pushing() {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
    });
    const made = written(
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
        flow: "actions",
        policyApproval: null,
        policyFields: {},
      }),
    );
    written(
      await pushes.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId: made.id,
        actor: ACTOR,
        decision: "approve",
        gitCommit: COMMIT,
        reason: null,
        idempotencyKey: `d-${made.id}`,
        payloadHash: "h",
      }),
    );
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== made.id) throw new Error("claimed another request");
    return { sessionId, id: made.id, job };
  }

  const finish = (job: Awaited<ReturnType<typeof pushing>>["job"]) =>
    pushes.finish(job, {
      state: "pushed",
      remoteUrl: "https://github.com/acme/app.git",
      remoteRef: `refs/heads/${job.targetBranch}`,
      previousCommit: null,
    });

  const schedule = (sessionId: string, pushRequestId: string) =>
    store.schedule({
      ownerId: OWNER,
      sessionId,
      ref: { pushRequestId },
      content: CONTENT,
      actor: ACTOR,
    });

  const row = async (id: string) => {
    const [found] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.id, id));
    if (!found) throw new Error("no row");
    return found;
  };

  /** Holds the push request's row until `release`. */
  function holdRow(id: string) {
    const holding = gate();
    const release = gate();
    const done = db.transaction(async (tx) => {
      await tx
        .select({ id: pushRequests.id })
        .from(pushRequests)
        .where(eq(pushRequests.id, id))
        .for("update");
      holding.open();
      await release.opened;
    });
    return { held: holding.opened, release: release.open, done };
  }

  /**
   * The lock each waiting backend of this database asked for, told apart by
   * the table of the statement it is stuck on: the session row or the push
   * request row. Oldest waiter first.
   */
  async function waitingFor(): Promise<string[]> {
    const { rows } = await pool.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        ORDER BY query_start`,
    );
    return rows.map((entry) =>
      entry.query.includes('from "sessions"') ? "session" : "request",
    );
  }

  /** Polls until `count` backends wait: a writer is shown to have reached its lock. */
  async function untilWaiting(count: number): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await waitingFor();
      if (waiting.length >= count) return waiting;
      await Bun.sleep(30);
    }
    throw new Error(`fewer than ${count} writers reached a lock`);
  }

  test("the reservation first, then the push finishes: the finish makes the stage due", async () => {
    const { sessionId, id, job } = await pushing();
    const barrier = holdRow(id);
    await barrier.held;

    const reserving = schedule(sessionId, id);
    // The first writer holds the session and waits for the barrier's row; the
    // second waits for the session behind it, not for the row.
    expect(await untilWaiting(1)).toEqual(["request"]);
    const finishing = finish(job);
    expect(await untilWaiting(2)).toEqual(["request", "session"]);
    expect(await row(id)).toMatchObject({ state: "pushing", prState: null });

    barrier.release();
    await barrier.done;
    expect(await reserving).toMatchObject({
      kind: "scheduled",
      pushRequestId: id,
    });
    expect(await finishing).toBe(true);
    expect(await row(id)).toMatchObject({
      state: "pushed",
      prState: "due",
      pullRequestIntent: CONTENT,
    });
  });

  test("the push finishes first, then the reservation: the reservation makes the stage due itself", async () => {
    const { sessionId, id, job } = await pushing();
    const barrier = holdRow(id);
    await barrier.held;

    const finishing = finish(job);
    expect(await untilWaiting(1)).toEqual(["request"]);
    const reserving = schedule(sessionId, id);
    expect(await untilWaiting(2)).toEqual(["request", "session"]);

    barrier.release();
    await barrier.done;
    expect(await finishing).toBe(true);
    expect(await reserving).toMatchObject({
      kind: "scheduled",
      pushRequestId: id,
    });
    // `pushed` with no stage is the row this ordering must never leave.
    expect(await row(id)).toMatchObject({
      state: "pushed",
      prState: "due",
      pullRequestIntent: CONTENT,
    });
  });
});
