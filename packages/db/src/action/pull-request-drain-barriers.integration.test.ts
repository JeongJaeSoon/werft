import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import {
  createPullRequestDrain,
  type OpenedPullRequest,
  type PullRequestDrainStore,
  type PushRequestStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushRequests } from "../push-requests.ts";
import * as schema from "../schema.ts";
import { pullRequests, pushRequests, sessions } from "../schema.ts";
import { createPostgresPullRequestDrain } from "./pull-request-drain.ts";
import { savePullRequestIn } from "./pull-requests.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-barrier";
const COMMIT = "e".repeat(40);
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Orders two writers of one session the way production does: a transaction
 * that holds the session row (as every writer of a session's push requests
 * does) is the barrier, and the other side is shown to wait behind it.
 */
integration("pull request drain, writers overlapped by a barrier", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let drain: PullRequestDrainStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pr_drain_barrier" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    drain = createPostgresPullRequestDrain(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  // A test may leave a stage it claimed; a later test must not claim it.
  afterEach(async () => {
    await db
      .update(pushRequests)
      .set({ prState: "cancelled", prClaimToken: null, prLeaseExpiresAt: null })
      .where(inArray(pushRequests.prState, ["due", "opening"]));
  });

  /** A pushed request whose pull request stage is due. */
  async function due() {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
    });
    const created = await pushes.create({
      ownerId: OWNER,
      sessionId,
      actor: HUMAN,
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
    if (created.outcome !== "written") throw new Error("not written");
    const id = created.request.id;
    await pushes.decide({
      ownerId: OWNER,
      sessionId,
      pushRequestId: id,
      actor: HUMAN,
      decision: "approve",
      gitCommit: COMMIT,
      reason: null,
      idempotencyKey: `d-${id}`,
      payloadHash: "h",
    });
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== id) throw new Error("claimed another request");
    await pushes.finish(job, {
      state: "pushed",
      remoteUrl: "https://github.com/acme/app.git",
      remoteRef: `refs/heads/agent/${sessionId}`,
      previousCommit: null,
    });
    await db
      .update(pushRequests)
      .set({ prState: "due", pullRequestIntent: { title: "Add the thing" } })
      .where(eq(pushRequests.id, id));
    return { id, sessionId };
  }

  const opened = (
    sessionId: string,
    number: number,
  ): { pullRequest: OpenedPullRequest } => ({
    pullRequest: {
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      head: `agent/${sessionId}`,
      base: "main",
      headSha: COMMIT,
      title: "Add the thing",
      created: true,
    },
  });

  const row = async (id: string) =>
    (await db.select().from(pushRequests).where(eq(pushRequests.id, id)))[0];

  /** Holds the session row until `release`, running `work` under it. */
  function holdSession(
    sessionId: string,
    work: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => Promise<void>,
  ) {
    const holding = gate();
    const release = gate();
    const done = db.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      await work(tx);
      holding.open();
      await release.opened;
    });
    return { held: holding.opened, release: release.open, done };
  }

  /** Whether a promise is still pending after a pause long enough to block. */
  async function stillWaiting(promise: Promise<unknown>) {
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Bun.sleep(300);
    return !settled;
  }

  test("a public open that stores its pull request first wins: the drain's settle waits for the session, then sees it and records nothing", async () => {
    const { id, sessionId } = await due();
    const job = await drain.claimNextDue(60_000);
    if (job?.id !== id) throw new Error("claimed another request");

    const barrier = holdSession(sessionId, async (tx) => {
      await savePullRequestIn(tx, {
        ownerId: OWNER,
        sessionId,
        pushRequestId: id,
        actor: HUMAN,
        repositoryId: "app",
        number: 5,
        url: "https://github.com/acme/app/pull/5",
        title: "public",
        head: `agent/${sessionId}`,
        base: "main",
        created: true,
      });
    });
    await barrier.held;

    const settling = drain.settle(job, {
      kind: "opened",
      ...opened(sessionId, 9),
    });
    expect(await stillWaiting(settling)).toBe(true);
    // Nothing of the drain's is written while it waits behind the barrier.
    expect(await row(id)).toMatchObject({ prState: "opening" });

    barrier.release();
    await barrier.done;
    expect(await settling).toMatchObject({
      result: "duplicate",
      recorded: { number: 5 },
    });
    expect(await row(id)).toMatchObject({
      prState: "uncertain",
      prError: "duplicate_pull_request",
    });
    const rows = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.pushRequestId, id));
    expect(rows.map((entry) => entry.number)).toEqual([5]);
  });

  test("a claim does not wait for a session someone else holds", async () => {
    const { id, sessionId } = await due();
    const barrier = holdSession(sessionId, async () => {});
    await barrier.held;

    try {
      // Settled well inside the pause `stillWaiting` allows a blocked call.
      const claiming = drain.claimNextDue(60_000);
      expect(await stillWaiting(claiming)).toBe(false);
      expect((await claiming)?.id).toBe(id);
      expect(await row(id)).toMatchObject({
        prState: "opening",
        prAttempts: 1,
      });
    } finally {
      barrier.release();
      await barrier.done;
    }
  });

  test("a claim whose lease lapsed and was taken over is fenced, and its successor settles", async () => {
    const { id, sessionId } = await due();
    const first = await drain.claimNextDue(60_000);
    if (first?.id !== id) throw new Error("claimed another request");
    await db
      .update(pushRequests)
      .set({ prLeaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(pushRequests.id, id));

    // A second replica takes the lapsed claim before the first settles.
    const second = await drain.claimNextDue(60_000);
    expect(second?.id).toBe(id);
    expect(second?.claimToken).not.toBe(first.claimToken);

    // The first settle waits for the session, then finds the claim is gone.
    const barrier = holdSession(sessionId, async () => {});
    await barrier.held;
    const stale = drain.settle(first, {
      kind: "opened",
      ...opened(sessionId, 7),
    });
    expect(await stillWaiting(stale)).toBe(true);

    barrier.release();
    await barrier.done;
    expect(await stale).toEqual({ result: "fenced" });
    expect(await row(id)).toMatchObject({ prState: "opening" });
    const none = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.pushRequestId, id));
    expect(none).toEqual([]);

    if (second === null) throw new Error("no second claim");
    expect(
      await drain.settle(second, { kind: "opened", ...opened(sessionId, 7) }),
    ).toEqual({ result: "settled" });
    expect(await row(id)).toMatchObject({ prState: "opened" });
  });

  test("a drain started fresh, with no settings at all, finishes the stage a dead process left opening", async () => {
    const { id, sessionId } = await due();
    const dead = await drain.claimNextDue(60_000);
    if (dead?.id !== id) throw new Error("claimed another request");
    await db
      .update(pushRequests)
      .set({ prLeaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(pushRequests.id, id));

    // What a restarted control-host builds: the store and an opener, and
    // nothing that reads AGENT_ACTION_FLOWS.
    const restarted = createPullRequestDrain({
      store: createPostgresPullRequestDrain(db),
      opener: {
        openForPushRequest: async () => ({
          kind: "opened",
          ...opened(sessionId, 11),
        }),
      },
      logger: { info() {}, warn() {} },
    });
    expect(await restarted.runOnce()).toBe(true);
    expect(await row(id)).toMatchObject({
      prState: "opened",
      prVerifiedNumber: 11,
      prAttempts: 2,
    });
    expect(await restarted.runOnce()).toBe(false);
  });

  test("two replicas claiming at once split the due rows: one row, one claim", async () => {
    const { id } = await due();
    const [a, b] = await Promise.all([
      drain.claimNextDue(60_000),
      drain.claimNextDue(60_000),
    ]);
    const claims = [a, b].filter((job) => job !== null);
    expect(claims.map((job) => job.id)).toEqual([id]);
    expect(await row(id)).toMatchObject({ prState: "opening", prAttempts: 1 });
  });
});
