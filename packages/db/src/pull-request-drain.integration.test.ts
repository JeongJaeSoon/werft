import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  OpenedPullRequest,
  PullRequestDrainStore,
  PullRequestStore,
  PushRequestStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPullRequestDrain } from "./pull-request-drain.ts";
import { createPostgresPullRequests } from "./pull-requests.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { pullRequests, pushRequests, sessions, slackOutbox } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-drain";
const COMMIT = "d".repeat(40);
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};

integration("postgres pull request drain", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let drain: PullRequestDrainStore;
  let store: PullRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pr_drain_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    drain = createPostgresPullRequestDrain(db);
    store = createPostgresPullRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  /** A pushed request whose pull request stage is due. */
  async function due(
    intent: unknown = { title: "Add the thing" },
    putStage = true,
  ) {
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
    // L5 slice (b) makes `finish` do this when the intent carries a pull
    // request; here the stage is put in place by hand.
    if (putStage) {
      await db
        .update(pushRequests)
        .set({ prState: "due", pullRequestIntent: intent })
        .where(eq(pushRequests.id, id));
    }
    return { id, sessionId };
  }

  const opened = (
    sessionId: string,
    number = 7,
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

  test("a claim counts the attempt and holds the row; a settle records the pull request, the verified head and the duplicate check", async () => {
    const { id, sessionId } = await due();
    const job = await drain.claimNextDue(60_000);
    expect(job).toMatchObject({ id, attempt: 1, gitCommit: COMMIT });
    expect(job?.intent).toEqual({ title: "Add the thing" });
    expect((await row(id))?.prState).toBe("opening");
    // The lease is live: nobody else takes it.
    expect(await drain.claimNextDue(60_000)).toBeNull();
    if (job === null) throw new Error("no job");
    expect(
      await drain.settle(job, { kind: "opened", ...opened(sessionId) }),
    ).toEqual({ result: "settled" });
    expect(await row(id)).toMatchObject({
      prState: "opened",
      prVerifiedNumber: 7,
      prVerifiedHeadSha: COMMIT,
      prClaimToken: null,
      prError: null,
    });
    expect(await store.findPullRequest(OWNER, id)).toMatchObject({ number: 7 });
  });

  test("a claim taken over after its lease lapsed cannot write over its successor", async () => {
    const { id, sessionId } = await due();
    const first = await drain.claimNextDue(60_000);
    if (first === null) throw new Error("no job");
    await db
      .update(pushRequests)
      .set({ prLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(pushRequests.id, id));
    const second = await drain.claimNextDue(60_000);
    expect(second).toMatchObject({ id, attempt: 2 });
    expect(second?.claimToken).not.toBe(first.claimToken);
    expect(
      await drain.settle(first, { kind: "opened", ...opened(sessionId, 3) }),
    ).toEqual({ result: "fenced" });
    expect((await row(id))?.prState).toBe("opening");
    expect(await store.findPullRequest(OWNER, id)).toBeNull();
    if (second === null) throw new Error("no job");
    expect(
      await drain.settle(second, { kind: "opened", ...opened(sessionId, 4) }),
    ).toEqual({ result: "settled" });
    expect(await store.findPullRequest(OWNER, id)).toMatchObject({ number: 4 });
  });

  test("a retry gives the claim back and waits out its backoff", async () => {
    const { id } = await due();
    const job = await drain.claimNextDue(60_000);
    if (job === null) throw new Error("no job");
    await drain.settle(job, {
      kind: "retry",
      error: "forge_failed",
      delayMs: 3_600_000,
    });
    expect(await row(id)).toMatchObject({
      prState: "due",
      prError: "forge_failed",
      prClaimToken: null,
    });
    expect(await drain.claimNextDue(60_000)).toBeNull();
    await db
      .update(pushRequests)
      .set({ prNextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(pushRequests.id, id));
    expect(await drain.claimNextDue(60_000)).toMatchObject({ id, attempt: 2 });
  });

  test("a stop ends the stage with its code and details", async () => {
    const { id } = await due();
    const job = await drain.claimNextDue(60_000);
    if (job === null) throw new Error("no job");
    await drain.settle(job, {
      kind: "stop",
      stage: "failed",
      error: "head_moved",
      details: { expected_sha: COMMIT, actual_sha: "e".repeat(40) },
    });
    expect(await row(id)).toMatchObject({
      prState: "failed",
      prError: "head_moved",
      prErrorDetails: { expected_sha: COMMIT, actual_sha: "e".repeat(40) },
    });
    expect(await drain.claimNextDue(60_000)).toBeNull();
  });

  test("a different pull request already on record ends uncertain with both, and records nothing new", async () => {
    const { id, sessionId } = await due();
    await store.savePullRequest({
      ownerId: OWNER,
      sessionId,
      pushRequestId: id,
      actor: HUMAN,
      repositoryId: "app",
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      title: "first",
      head: `agent/${sessionId}`,
      base: "main",
      created: true,
    });
    const job = await drain.claimNextDue(60_000);
    if (job === null) throw new Error("no job");
    expect(
      await drain.settle(job, { kind: "opened", ...opened(sessionId, 9) }),
    ).toMatchObject({ result: "duplicate", recorded: { number: 5 } });
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

  test("a stage whose last attempt died with its lease ends uncertain instead of being claimed again", async () => {
    const { id } = await due();
    await db
      .update(pushRequests)
      .set({
        flow: "actions",
        prState: "opening",
        prAttempts: 3,
        prClaimToken: crypto.randomUUID(),
        prLeaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(pushRequests.id, id));
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect(await row(id)).toMatchObject({
      prState: "uncertain",
      prError: "lease_expired",
      prClaimToken: null,
      prLeaseExpiresAt: null,
    });
  });

  test("a pushed request with no pull request stage is never claimed and keeps its state", async () => {
    const { id } = await due(null, false);
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect(await row(id)).toMatchObject({
      state: "pushed",
      prState: null,
      prAttempts: 0,
      prClaimToken: null,
    });
  });

  test("an intent that no longer parses is failed instead of claimed", async () => {
    const { id } = await due({ title: 42 });
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect(await row(id)).toMatchObject({
      prState: "failed",
      prError: "intent_invalid",
    });
  });

  /**
   * A primary Slack thread for the session. Foreign keys are switched off for
   * this one connection: the thread's workspace, agent, release and binding
   * rows are nothing this test reads.
   */
  async function slackThread(sessionId: string) {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      const workspace = crypto.randomUUID();
      const installation = crypto.randomUUID();
      const agent = crypto.randomUUID();
      // The outbox row references these two for real, from another
      // connection, so they are rows and not skipped checks.
      await client.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'w')",
        [workspace, `w-${workspace}`],
      );
      await client.query(
        "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', (SELECT id FROM t))",
        [agent, workspace],
      );
      const appId = `A${crypto.randomUUID().slice(0, 8)}`;
      await client.query(
        "INSERT INTO slack_apps (id, workspace_id, kind, state, app_id, redirect_url) VALUES ($1, $2, 'link', 'creating', $3, 'https://example.invalid/cb')",
        [crypto.randomUUID(), workspace, appId],
      );
      await client.query(
        "INSERT INTO slack_installations (id, workspace_id, app_id, team_id, status) VALUES ($1, $2, $3, 'T1', 'pending')",
        [installation, workspace, appId],
      );
      await client.query(
        "INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id, profile_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'C1', '1.1', '1.1', $8, 'r1', 'p1')",
        [
          crypto.randomUUID(),
          workspace,
          OWNER,
          sessionId,
          installation,
          crypto.randomUUID(),
          `ref-${sessionId}`,
          agent,
        ],
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
  }

  const noticesOf = (sessionId: string) =>
    db.select().from(slackOutbox).where(eq(slackOutbox.sessionId, sessionId));

  test("an intent that no longer parses tells the thread in the same transaction, once", async () => {
    const { id, sessionId } = await due({ title: 42 });
    await db
      .update(pushRequests)
      .set({ flow: "actions" })
      .where(eq(pushRequests.id, id));
    await slackThread(sessionId);
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect(await drain.claimNextDue(60_000)).toBeNull();
    const notices = await noticesOf(sessionId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "action_notice",
      dedupeKey: `action:${id}:pr_failed`,
    });
    expect((notices[0]?.body as { text: string }).text).toContain(
      "intent_invalid",
    );
  });

  test("a failed intent whose session someone else holds is left alone, and does not stall a younger request", async () => {
    const older = await due({ title: 42 });
    const younger = await due();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        older.sessionId,
      ]);
      const claimed = await Promise.race([
        drain.claimNextDue(60_000),
        new Promise<"stalled">((resolve) =>
          setTimeout(() => resolve("stalled"), 3_000),
        ),
      ]);
      expect(claimed).not.toBe("stalled");
      expect(claimed).toMatchObject({ id: younger.id });
      // Untouched: the session was busy, so it is failed on a later claim.
      expect((await row(older.id))?.prState).toBe("due");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect((await row(older.id))?.prError).toBe("intent_invalid");
    await db
      .update(pushRequests)
      .set({ prState: "cancelled", prClaimToken: null })
      .where(eq(pushRequests.id, younger.id));
  });

  test("an expired opening stage on a request that is not pushed is never claimed", async () => {
    const { id } = await due();
    await db
      .update(pushRequests)
      .set({
        state: "failed",
        prState: "opening",
        prAttempts: 1,
        prClaimToken: crypto.randomUUID(),
        prLeaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(pushRequests.id, id));
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect((await row(id))?.prState).toBe("opening");
  });

  test("a legacy request with an invalid intent is left alone: the drain only works the actions flow", async () => {
    const { id, sessionId } = await due({ title: 42 });
    await db
      .update(pushRequests)
      .set({ flow: "legacy" })
      .where(eq(pushRequests.id, id));
    await slackThread(sessionId);
    expect(await drain.claimNextDue(60_000)).toBeNull();
    expect((await row(id))?.prError).toBeNull();
    expect(await noticesOf(sessionId)).toHaveLength(0);
  });
});
