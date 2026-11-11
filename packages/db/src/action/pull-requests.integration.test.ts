import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  PullRequestStore,
  PushRequestStore,
  PushWriteResult,
  SessionOutcomeStore,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushRequests } from "../push-requests.ts";
import * as schema from "../schema.ts";
import {
  pullRequests,
  receipts,
  sessionOutcomes,
  sessions,
} from "../schema.ts";
import { createPostgresSessionOutcomes } from "../sessions/session-outcomes.ts";
import { createPostgresPullRequests } from "./pull-requests.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-pull";
const COMMIT = "c".repeat(40);
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};

function written(result: PushWriteResult) {
  if (result.outcome !== "written") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("postgres pull requests", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let store: PullRequestStore;
  let outcomes: SessionOutcomeStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pull_requests_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    store = createPostgresPullRequests(db);
    outcomes = createPostgresSessionOutcomes(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function pushed(existing?: string) {
    const sessionId = existing ?? crypto.randomUUID();
    if (existing === undefined) {
      await db.insert(sessions).values({
        id: sessionId,
        ownerId: OWNER,
        repoUrl: "https://github.com/acme/app.git",
        branch: "main",
        repositoryId: "app",
        checkpointRevision: 1,
      });
    }
    const request = written(
      await pushes.create({
        ownerId: OWNER,
        sessionId,
        actor: HUMAN,
        idempotencyKey: `k-${crypto.randomUUID()}`,
        payloadHash: "h",
        repositoryId: "app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: 1,
        gitCommit: COMMIT,
        policyApproval: null,
        policyFields: {},
      }),
    );
    written(
      await pushes.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId: request.id,
        actor: HUMAN,
        decision: "approve",
        gitCommit: COMMIT,
        reason: null,
        idempotencyKey: `d-${request.id}`,
        payloadHash: "h",
      }),
    );
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== request.id) throw new Error("claimed another request");
    await pushes.finish(job, {
      state: "pushed",
      remoteUrl: "https://github.com/acme/app.git",
      remoteRef: `refs/heads/agent/${sessionId}`,
      previousCommit: null,
    });
    return { sessionId, pushRequestId: request.id };
  }

  const save = (
    source: { sessionId: string; pushRequestId: string },
    number = 7,
    title: string | null = "Retry failed payments",
  ) =>
    store.savePullRequest({
      ownerId: OWNER,
      sessionId: source.sessionId,
      pushRequestId: source.pushRequestId,
      actor: HUMAN,
      repositoryId: "app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      title,
      head: `agent/${source.sessionId}`,
      base: "main",
      created: true,
    });

  test("reads the pushed request it opens from, only for its owner", async () => {
    const source = await pushed();
    expect(
      await store.findSource(
        OWNER,
        source.sessionId.toUpperCase(),
        source.pushRequestId,
      ),
    ).toMatchObject({
      id: source.pushRequestId,
      state: "pushed",
      repositoryBinding: "sha256:binding",
      targetBranch: `agent/${source.sessionId}`,
      gitCommit: COMMIT,
    });
    expect(
      await store.findSource(
        "someone-else",
        source.sessionId,
        source.pushRequestId,
      ),
    ).toBeNull();
  });

  test("records one pull request per push request with its receipt; racing saves keep the first", async () => {
    const source = await pushed();
    const [a, b] = await Promise.all([save(source, 7), save(source, 8)]);
    const winner = a?.created ? a : b;
    const loser = a?.created ? b : a;
    expect(winner?.created).toBe(true);
    expect(loser?.created).toBe(false);
    expect(loser?.pullRequest).toEqual(winner?.pullRequest);
    expect(await store.findPullRequest(OWNER, source.pushRequestId)).toEqual(
      winner?.pullRequest ?? null,
    );
    expect(
      await store.findPullRequest("someone-else", source.pushRequestId),
    ).toBeNull();

    const [row] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, winner?.receiptId ?? ""));
    expect(row).toMatchObject({
      ownerId: OWNER,
      operation: "open_pull_request",
      status: "succeeded",
      actor: HUMAN,
      targetRef: {
        session_id: source.sessionId,
        turn_id: null,
        request_id: source.pushRequestId,
      },
      result: { verdict: "allow", created: true, refusal: null },
    });
  });

  test("a later push request answered with the same pull request shares its row", async () => {
    const first = await pushed();
    const opened = await save(first, 11);
    const again = await store.savePullRequest({
      ownerId: OWNER,
      sessionId: first.sessionId,
      pushRequestId: crypto.randomUUID(),
      actor: HUMAN,
      repositoryId: "app",
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      title: null,
      head: `agent/${first.sessionId}`,
      base: "main",
      created: false,
    });
    expect(again).toMatchObject({
      pullRequest: opened.pullRequest,
      created: false,
    });
    expect(
      await store.findBranchPullRequest(
        OWNER,
        first.sessionId.toUpperCase(),
        "app",
        `agent/${first.sessionId}`,
      ),
    ).toEqual(opened.pullRequest);
    expect(
      await store.findBranchPullRequest(
        "someone-else",
        first.sessionId,
        "app",
        `agent/${first.sessionId}`,
      ),
    ).toBeNull();
    expect(
      await store.findBranchPullRequest(
        OWNER,
        first.sessionId,
        "app",
        "agent/other",
      ),
    ).toBeNull();
    // The same branch name in another repository is another pull request.
    expect(
      await store.findBranchPullRequest(
        OWNER,
        first.sessionId,
        "other-app",
        `agent/${first.sessionId}`,
      ),
    ).toBeNull();
  });

  test("two push requests of one session saving the same pull request at once both answer it", async () => {
    const first = await pushed();
    const second = await pushed(first.sessionId);
    const [a, b] = await Promise.all([save(first, 21), save(second, 21)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.pullRequest.url).toBe(b.pullRequest.url);
  });

  test("a row from before push requests is filled in", async () => {
    const source = await pushed();
    await db.insert(pullRequests).values({
      sessionId: source.sessionId,
      url: "https://github.com/acme/app/pull/31",
    });
    const saved = await save(source, 31);
    expect(saved.created).toBe(false);
    expect(saved.pullRequest).toMatchObject({
      push_request_id: source.pushRequestId,
      number: 31,
      head: `agent/${source.sessionId}`,
    });
    expect(await store.findPullRequest(OWNER, source.pushRequestId)).toEqual(
      saved.pullRequest,
    );
  });

  const outcomesOf = (sessionId: string) =>
    db
      .select()
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.sessionId, sessionId));

  test("the outcome is written in the pull request's transaction, with its receipt", async () => {
    const source = await pushed();
    const saved = await save(source, 41);
    const [row] = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.sessionId, source.sessionId));
    expect(await outcomesOf(source.sessionId)).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        agentReleaseId: null,
        agentId: null,
        type: "github_pull_request",
        url: "https://github.com/acme/app/pull/41",
        repositoryId: "app",
        externalId: "41",
        state: "open",
        stateChangedAt: row?.createdAt,
        stateCheckedAt: null,
        checkError: null,
        receiptId: saved.receiptId,
        createdAt: row?.createdAt,
        metadata: {
          title: "Retry failed payments",
          head: `agent/${source.sessionId}`,
          base: "main",
          adopted: false,
          merge_commit_sha: null,
          additions: null,
          deletions: null,
          changed_files: null,
          commits: null,
        },
      }),
    ]);
  });

  test("the outcome keeps the first 200 characters of the title", async () => {
    const source = await pushed();
    await save(source, 44, `${"a".repeat(200)}b`);
    expect((await outcomesOf(source.sessionId))[0]?.metadata).toMatchObject({
      title: "a".repeat(200),
    });
  });

  test("a second open of the same URL writes no second outcome", async () => {
    const first = await pushed();
    const second = await pushed(first.sessionId);
    await save(first, 42);
    const again = await store.savePullRequest({
      ownerId: OWNER,
      sessionId: first.sessionId,
      pushRequestId: second.pushRequestId,
      actor: HUMAN,
      repositoryId: "app",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: null,
      head: `agent/${first.sessionId}`,
      base: "main",
      created: false,
    });
    const outcomes = await outcomesOf(first.sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.receiptId).not.toBe(again.receiptId);
    expect(outcomes[0]?.metadata).toMatchObject({ adopted: false });
  });

  test("a pull request the forge did not create is adopted", async () => {
    const source = await pushed();
    await store.savePullRequest({
      ownerId: OWNER,
      sessionId: source.sessionId,
      pushRequestId: source.pushRequestId,
      actor: HUMAN,
      repositoryId: "app",
      number: 43,
      url: "https://github.com/acme/app/pull/43",
      title: null,
      head: `agent/${source.sessionId}`,
      base: "main",
      created: false,
    });
    expect((await outcomesOf(source.sessionId))[0]?.metadata).toMatchObject({
      adopted: true,
    });
  });

  test("an outcome that cannot be written takes the pull request row and its receipt back with it", async () => {
    const source = await pushed();
    await db.execute(sql`
      CREATE FUNCTION refuse_outcome_it() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'outcome refused'; END $$`);
    await db.execute(sql`
      CREATE TRIGGER refuse_outcome_it BEFORE INSERT ON session_outcomes
      FOR EACH ROW WHEN (NEW.url LIKE '%/pull/666') EXECUTE FUNCTION refuse_outcome_it()`);
    try {
      await expect(save(source, 666)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER refuse_outcome_it ON session_outcomes`);
      await db.execute(sql`DROP FUNCTION refuse_outcome_it()`);
    }
    expect(
      await db
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.sessionId, source.sessionId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.operation, "open_pull_request"),
            sql`${receipts.targetRef} ->> 'session_id' = ${source.sessionId}`,
          ),
        ),
    ).toEqual([]);
    expect(await outcomesOf(source.sessionId)).toEqual([]);
  });

  describe("a close or reopen GitHub took", () => {
    const changeState = (
      source: { sessionId: string; pushRequestId: string },
      number: number,
      state: "open" | "closed",
    ) => {
      const url = `https://github.com/acme/app/pull/${number}`;
      return store.recordStateChange({
        ownerId: OWNER,
        sessionId: source.sessionId,
        pushRequestId: source.pushRequestId,
        actor: HUMAN,
        operation:
          state === "open" ? "reopen_pull_request" : "close_pull_request",
        url,
        result: {
          push_request_id: source.pushRequestId,
          verdict: "allow",
          refusal: null,
          repository_id: "app",
          number,
          url,
          head: `agent/${source.sessionId}`,
          base: "main",
          created: false,
          state,
          changed: true,
        },
      });
    };
    const claimOf = async (sessionId: string) =>
      (
        await outcomes.claim({
          quotaKey: `quota-${crypto.randomUUID()}`,
          repositoryIds: ["app"],
          max: 100,
          leaseMs: 60_000,
        })
      ).filter((claimed) => claimed.sessionId === sessionId);
    const read = (state: "open" | "closed") =>
      ({
        kind: "state",
        state,
        mergedAt: null,
        closedAt: state === "closed" ? new Date() : null,
        metadata: {
          title: "Retry failed payments",
          merge_commit_sha: null,
          additions: null,
          deletions: null,
          changed_files: null,
          commits: null,
        },
      }) as const;

    test("a reopen of one closed over 30 days ago is read again, and the read moves it to open", async () => {
      const source = await pushed();
      await save(source, 43);
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await db
        .update(sessionOutcomes)
        .set({ state: "closed", closedAt: longAgo, stateCheckedAt: longAgo })
        .where(eq(sessionOutcomes.sessionId, source.sessionId));
      expect(await claimOf(source.sessionId)).toEqual([]);

      const id = await changeState(source, 43, "open");
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, id));
      expect(receipt).toMatchObject({
        operation: "reopen_pull_request",
        status: "succeeded",
        result: { state: "open", changed: true },
      });
      const [claimed] = await claimOf(source.sessionId);
      expect(claimed).toMatchObject({ number: 43, state: "closed" });
      if (claimed === undefined) throw new Error("not claimed");
      expect(await outcomes.finish(claimed, read("open"))).toBe(true);
      expect(await outcomesOf(source.sessionId)).toEqual([
        expect.objectContaining({ state: "open", closedAt: null }),
      ]);
    });

    test("a read that began before the change cannot write over it", async () => {
      const source = await pushed();
      await save(source, 44);
      const [early] = await claimOf(source.sessionId);
      if (early === undefined) throw new Error("not claimed");

      await changeState(source, 44, "closed");
      expect(await outcomes.finish(early, read("open"))).toBe(false);
      const [again] = await claimOf(source.sessionId);
      if (again === undefined) throw new Error("not claimed again");
      expect(await outcomes.finish(again, read("closed"))).toBe(true);
      expect(await outcomesOf(source.sessionId)).toEqual([
        expect.objectContaining({ state: "closed" }),
      ]);
    });
  });

  test("a refusal receipt is failed with the refusal's error", async () => {
    const source = await pushed();
    const id = await store.recordReceipt({
      ownerId: OWNER,
      sessionId: source.sessionId,
      pushRequestId: source.pushRequestId,
      actor: HUMAN,
      operation: "comment_pull_request",
      result: {
        push_request_id: source.pushRequestId,
        verdict: "refuse",
        refusal: "no_pull_request",
        repository_id: "app",
        number: null,
        url: null,
        head: null,
        base: null,
        created: null,
        marker: "status",
      },
    });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row).toMatchObject({
      operation: "comment_pull_request",
      status: "failed",
      error: { code: "PULL_REQUEST_MISSING" },
    });
  });
});
