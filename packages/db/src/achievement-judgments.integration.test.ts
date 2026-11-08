import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AchievementRuleJudge,
  listSessionAchievementsResponseSchema,
  type ReceiptActor,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  ACHIEVEMENT_JUDGMENT_QUIET_MS,
  type AchievementJudgmentStore,
  type ClaimedJudgment,
  callerFor,
  checkpointOutputObjects,
  checkpointOutputsDigest,
  createAchievementJudge,
  DecisionsCallError,
  type DecisionsRequest,
  type SessionOutputsResult,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresAchievementJudgments,
  createPostgresJudgmentEgress,
  queueAchievementJudgment,
  utcDayOf,
} from "./achievement-judgments.ts";
import {
  createPostgresAchievementRuleStore,
  insertBuiltinAchievementTypes,
} from "./achievement-rules.ts";
import { findPgError } from "./control-shared.ts";
import { acquireFence } from "./fence.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import {
  createPostgresPullRequests,
  insertPullRequestOutcome,
} from "./pull-requests.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  achievementJudgments,
  achievementJudgmentUsage,
  achievementTypes,
  agentAdmins,
  agents,
  attempts,
  memberships,
  receipts,
  sessionAchievements,
  sessionOutcomes,
  sessionShares,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionOutcomes } from "./session-outcomes.ts";
import { commitCheckpoint } from "./testing/checkpoints.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { advanceCheckpointPointer } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-achievements" },
  actor_user_id: null,
  agent_id: null,
};

integration("achievement judgments on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let judgments: AchievementJudgmentStore;
  const outputsBySession = new Map<string, SessionOutputsResult>();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_judgments_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    judgments = createPostgresAchievementJudgments(db);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const rules = () => createPostgresAchievementRuleStore(db);

  /** A workspace with its built-in types and an owner who manages rules. */
  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `acme-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await insertBuiltinAchievementTypes(db, workspaceId);
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const caller = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const owner: TeamActor = { principal: caller, workspaceId, userId };
    const created = await rules().createCategory({
      actor: owner,
      receiptId: randomUUID(),
      name: "Delivery",
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return { workspaceId, owner, categoryId: created.category.id };
  }

  async function typeId(workspaceId: string, typeKey: string) {
    const [row] = await db
      .select({ id: achievementTypes.id })
      .from(achievementTypes)
      .where(
        and(
          eq(achievementTypes.workspaceId, workspaceId),
          eq(achievementTypes.key, typeKey),
        ),
      );
    if (!row) throw new Error(`no type ${typeKey}`);
    return row.id;
  }

  async function personType(
    ws: Awaited<ReturnType<typeof workspace>>,
    evidenceKind: "github_pull_request" | "github_review",
  ) {
    const created = await rules().createType({
      actor: ws.owner,
      receiptId: randomUUID(),
      key: `custom_${randomUUID().slice(0, 6)}`,
      name: "Custom",
      evidenceKind,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.type.id;
  }

  async function rule(
    ws: Awaited<ReturnType<typeof workspace>>,
    type: string,
    judge: AchievementRuleJudge = "always",
  ) {
    const created = await rules().createRule({
      actor: ws.owner,
      receiptId: randomUUID(),
      rule: {
        category_id: ws.categoryId,
        title: "Counted",
        type_id: type,
        definition: "Counts as it appears.",
        judge,
        agent_ids: null,
      },
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.rule;
  }

  /** A claimed session of the workspace, ready for checkpoint commits. */
  async function session(workspaceId: string | null, title?: string) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId ?? "owner-legacy",
      workspaceId,
      repoUrl: "https://github.com/acme/app.git",
      branch: `agent/${id}`,
      repositoryId: "app",
      title: title ?? null,
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
    });
    return id;
  }

  async function receipt(ownerId: string, sessionId: string) {
    const id = randomUUID();
    await db.insert(receipts).values({
      id,
      ownerId,
      operation: "open_pull_request",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: {},
      error: null,
      actor: HUMAN,
    });
    return id;
  }

  let nextNumber = 10;
  /** A pull request outcome written as the PR service writes it. */
  async function pullRequest(sessionId: string, ownerId: string) {
    nextNumber += 1;
    const url = `https://github.com/acme/app/pull/${nextNumber}`;
    const receiptId = await receipt(ownerId, sessionId);
    await db.transaction((tx) =>
      insertPullRequestOutcome(tx, {
        ownerId,
        sessionId,
        url,
        repositoryId: "app",
        number: nextNumber,
        title: "Retry failed payments",
        head: `agent/${sessionId}`,
        base: "main",
        adopted: false,
        receiptId,
        createdAt: new Date(),
      }),
    );
    const [row] = await db
      .select()
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.url, url));
    if (!row) throw new Error("no outcome");
    return row;
  }

  async function review(sessionId: string, ownerId: string, number = 9) {
    const reviewId = Math.floor(Math.random() * 1_000_000_000);
    await createPostgresGitHubGateStore(db).recordReview({
      context: {
        ownerId,
        sessionId,
        agentId: null,
        agentReleaseId: null,
        repositoryId: "app",
        policy: {},
      },
      actor: HUMAN,
      result: { number, event: "APPROVE", review_id: reviewId },
      review: {
        id: reviewId,
        url: `https://github.com/acme/app/pull/${number}#pullrequestreview-${reviewId}`,
      },
      metadata: {
        number,
        event: "APPROVE",
        commit_id: "c".repeat(40),
        opened_by_session_id: null,
      },
    });
  }

  async function judgmentsOf(sessionId: string) {
    return db
      .select()
      .from(achievementJudgments)
      .where(eq(achievementJudgments.sessionId, sessionId))
      .orderBy(achievementJudgments.createdAt);
  }

  async function achievementsOf(sessionId: string) {
    return db
      .select()
      .from(sessionAchievements)
      .where(eq(sessionAchievements.sessionId, sessionId))
      .orderBy(sessionAchievements.createdAt, sessionAchievements.title);
  }

  /** As if the quiet time had passed since the session's last trigger. */
  async function quietPassed(sessionId: string) {
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(
        and(
          eq(achievementJudgments.sessionId, sessionId),
          eq(achievementJudgments.status, "queued"),
        ),
      );
  }

  function replica(claimMax?: number) {
    return createAchievementJudge({
      store: judgments,
      outputs: {
        readOutputs: async (sessionId) =>
          outputsBySession.get(sessionId) ?? { status: "none" },
        openOutput: async () => ({ status: "missing" }),
      },
      logger: { info() {}, warn() {} },
      ...(claimMax === undefined ? {} : { claimMax }),
    });
  }

  test("opening a pull request queues an evidence judgment in its own transaction; a review merges into it", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    await db
      .update(sessions)
      .set({ checkpointRevision: 1 })
      .where(eq(sessions.id, sessionId));
    const pushes = createPostgresPushRequests(db);
    const created = await pushes.create({
      ownerId: workspaceId,
      sessionId,
      actor: HUMAN,
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: "app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: "c".repeat(40),
      policyApproval: null,
      policyFields: {},
    });
    if (created.outcome !== "written") throw new Error("no push request");
    await createPostgresPullRequests(db).savePullRequest({
      ownerId: workspaceId,
      sessionId,
      pushRequestId: created.request.id,
      actor: HUMAN,
      repositoryId: "app",
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      title: "Retry failed payments",
      head: `agent/${sessionId}`,
      base: "main",
      created: true,
    });
    const [opened, ...none] = await judgmentsOf(sessionId);
    expect(none).toEqual([]);
    expect(opened).toMatchObject({
      workspaceId,
      ownerId: workspaceId,
      trigger: "evidence",
      status: "queued",
      attempts: 0,
    });
    const { rows: waits } = await pool.query(
      "SELECT next_attempt_at > now() + interval '100 seconds' AS later FROM achievement_judgments WHERE id = $1",
      [opened?.id],
    );
    expect(waits[0].later).toBe(true);

    await review(sessionId, workspaceId);
    const merged = await judgmentsOf(sessionId);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(opened?.id);
    expect(merged[0]?.nextAttemptAt.getTime()).toBeGreaterThan(
      opened?.nextAttemptAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    // The judgment commits with its evidence or not at all.
    const other = await session(workspaceId);
    const receiptId = await receipt(workspaceId, other);
    await expect(
      db.transaction(async (tx) => {
        await insertPullRequestOutcome(tx, {
          ownerId: workspaceId,
          sessionId: other,
          url: "https://github.com/acme/app/pull/6",
          repositoryId: "app",
          number: 6,
          title: null,
          head: `agent/${other}`,
          base: "main",
          adopted: false,
          receiptId,
          createdAt: new Date(),
        });
        const inside = await tx
          .select({ id: achievementJudgments.id })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.sessionId, other));
        expect(inside).toHaveLength(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await judgmentsOf(other)).toEqual([]);
  });

  test("a merge never moves the wait back: not from a long transaction, not below a later deadline", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const deadline = async () =>
      (await judgmentsOf(sessionId))[0]?.nextAttemptAt.getTime() ?? 0;

    // A transaction that began before another trigger queues after it.
    let begun: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    let proceed: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const slow = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT now()`);
      begun();
      await go;
      await queueAchievementJudgment(tx, sessionId);
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await queueAchievementJudgment(db, sessionId);
    const meanwhile = await deadline();
    await new Promise((resolve) => setTimeout(resolve, 50));
    proceed();
    await slow;
    expect(await deadline()).toBeGreaterThan(meanwhile);

    // A later deadline (a retry's) is kept.
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
      .where(eq(achievementJudgments.sessionId, sessionId));
    const later = await deadline();
    await queueAchievementJudgment(db, sessionId);
    expect(await deadline()).toBe(later);
  });

  test("the session row is locked before the queued entry, so a checkpoint's fence and a refresher's queue do not deadlock", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    let fenced: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      fenced = resolve;
    });
    let proceed: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    // As a checkpoint commit: the fence locks the session, then it queues.
    const checkpoint = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR UPDATE`,
      );
      fenced();
      await go;
      await queueAchievementJudgment(tx, sessionId);
    });
    await locked;
    // As the refresher: queues with no lock of its own first.
    const refresher = db.transaction((tx) =>
      queueAchievementJudgment(tx, sessionId),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    proceed();
    const results = await Promise.allSettled([checkpoint, refresher]);
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? findPgError(result.reason, "40P01")
            ? "deadlock"
            : "error"
          : "ok",
      ),
    ).toEqual(["ok", "ok"]);
    expect((await judgmentsOf(sessionId)).map((row) => row.status)).toEqual([
      "queued",
    ]);
  });

  /** A claimed judgment of a session with a pull request, and its retry. */
  async function claimedRetry() {
    const ws = await workspace();
    const counted = await rule(
      ws,
      await typeId(ws.workspaceId, "pull_request"),
    );
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const [claimed] = (
      await judgments.claim({ max: 100, leaseMs: 60_000 })
    ).filter((row) => row.sessionId === sessionId);
    if (!claimed) throw new Error("not claimed");
    // Longer than the quiet time, so a fold visibly moves a trigger's wait.
    const retry = {
      status: "queued" as const,
      retryInMs: 300_000,
      errorCode: "outputs_unavailable" as const,
      rules: [counted.id],
      evidenceIds: [pr.id],
      achievements: [
        {
          ruleId: counted.id,
          ruleFamilyId: counted.family_id,
          typeId: counted.type_id,
          agentId: null,
          agentReleaseId: null,
          title: "acme/app#pr",
          link: pr.url,
          evidenceKind: "github_pull_request" as const,
          evidenceId: pr.id,
          payload: null,
          judge: "always" as const,
          probability: null,
          reviewState: "auto" as const,
        },
      ],
    };
    return { sessionId, claimed, retry };
  }

  /** Runs `body`, waits for `release`, runs `after`, then commits. */
  function held(
    body: (tx: Database) => Promise<void>,
    after: (tx: Database) => Promise<void> = async () => {},
  ) {
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = db.transaction(async (tx) => {
      await body(tx);
      ready();
      await go;
      await after(tx);
    });
    return { started, release, done };
  }

  test("a retry folds into a judgment a trigger queued meanwhile, committed before or while it finishes", async () => {
    // Committed before: the retry's wait moves onto the queued one.
    const before = await claimedRetry();
    await queueAchievementJudgment(db, before.sessionId);
    expect(await judgments.finish(before.claimed, before.retry)).toBe(true);
    const folded = await judgmentsOf(before.sessionId);
    expect(folded.map((row) => [row.status, row.errorCode])).toEqual([
      ["failed", "outputs_unavailable"],
      ["queued", null],
    ]);
    expect(folded[1]?.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 250_000,
    );
    expect(await achievementsOf(before.sessionId)).toHaveLength(1);

    // A wait already longer than the retry's is kept.
    const longer = await claimedRetry();
    await queueAchievementJudgment(db, longer.sessionId);
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
      .where(
        and(
          eq(achievementJudgments.sessionId, longer.sessionId),
          eq(achievementJudgments.status, "queued"),
        ),
      );
    const [, kept] = await judgmentsOf(longer.sessionId);
    expect(await judgments.finish(longer.claimed, longer.retry)).toBe(true);
    expect((await judgmentsOf(longer.sessionId))[1]?.nextAttemptAt).toEqual(
      kept?.nextAttemptAt,
    );

    // Still uncommitted when the retry looks: it takes the queued slot first.
    const during = await claimedRetry();
    const trigger = held((tx) =>
      queueAchievementJudgment(tx, during.sessionId).then(() => {}),
    );
    await trigger.started;
    const finishing = judgments.finish(during.claimed, during.retry);
    await new Promise((resolve) => setTimeout(resolve, 200));
    trigger.release();
    await trigger.done;
    expect(await finishing).toBe(true);
    const raced = await judgmentsOf(during.sessionId);
    expect(raced.map((row) => row.status)).toEqual(["failed", "queued"]);
    expect(raced[1]?.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 250_000,
    );
    expect(await achievementsOf(during.sessionId)).toHaveLength(1);
  });

  test("a retry's finish and a checkpoint's fence and queue do not deadlock", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    // As a checkpoint commit: the fence locks the session, then it queues.
    const checkpoint = held(
      (tx) =>
        tx
          .execute(
            sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR UPDATE`,
          )
          .then(() => {}),
      (tx) => queueAchievementJudgment(tx, sessionId).then(() => {}),
    );
    await checkpoint.started;
    const finishing = judgments.finish(claimed, retry);
    await new Promise((resolve) => setTimeout(resolve, 200));
    checkpoint.release();
    const results = await Promise.allSettled([checkpoint.done, finishing]);
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? findPgError(result.reason, "40P01")
            ? "deadlock"
            : "error"
          : "ok",
      ),
    ).toEqual(["ok", "ok"]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
  });

  test("new evidence makes a waiting retry a first try again", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    expect(await judgments.finish(claimed, retry)).toBe(true);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 1 },
    ]);
    await queueAchievementJudgment(db, sessionId);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 0 },
    ]);
  });

  test("a second finish of a claim that went back to queued writes nothing", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    expect(await judgments.finish(claimed, retry)).toBe(true);
    await db
      .delete(sessionAchievements)
      .where(eq(sessionAchievements.sessionId, sessionId));
    expect(await judgments.finish(claimed, retry)).toBe(false);
    expect(await achievementsOf(sessionId)).toEqual([]);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 1 },
    ]);
  });

  test("a refresher read that changes a pull request's state queues a judgment; one that does not, queues none", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const row = await pullRequest(sessionId, workspaceId);
    // Judged already: nothing queued.
    await db
      .delete(achievementJudgments)
      .where(eq(achievementJudgments.sessionId, sessionId));
    const outcomes = createPostgresSessionOutcomes(db);
    const lease = async () => {
      const leaseToken = randomUUID();
      await db
        .update(sessionOutcomes)
        .set({ leaseToken, leaseExpiresAt: sql`now() + interval '1 minute'` })
        .where(eq(sessionOutcomes.id, row.id));
      return {
        id: row.id,
        sessionId,
        repositoryId: "app",
        number: Number(row.externalId),
        state: "open" as const,
        leaseToken,
      };
    };
    const metadata = {
      title: "Retry failed payments",
      merge_commit_sha: null,
      additions: 2,
      deletions: 1,
      changed_files: 1,
      commits: 1,
    };
    expect(
      await outcomes.finish(await lease(), {
        kind: "state",
        state: "open",
        mergedAt: null,
        closedAt: null,
        metadata,
      }),
    ).toBe(true);
    expect(await judgmentsOf(sessionId)).toEqual([]);

    const at = new Date();
    expect(
      await outcomes.finish(await lease(), {
        kind: "state",
        state: "merged",
        mergedAt: at,
        closedAt: at,
        metadata: { ...metadata, merge_commit_sha: "d".repeat(40) },
      }),
    ).toBe(true);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { trigger: "evidence", status: "queued" },
    ]);
  });

  test("a checkpoint queues a judgment only when its out/ list differs from its parent's, path by path, in its own transaction", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const attemptId = `attempt-${randomUUID()}`;
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: 1,
      executionId: `exec-${attemptId}`,
      id: attemptId,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 600_000),
      sessionId,
      state: "running",
    });
    const fence = {
      attemptId,
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
      sessionId,
    };
    const checkpoint = (revision: number) => ({
      revision,
      manifest_ref: `sessions/${sessionId}/checkpoints/${revision}/${attemptId}/manifest.json`,
      manifest_sha256: "a".repeat(64),
    });
    type Listed = Parameters<typeof checkpointOutputsDigest>[0] & {};
    const stored = (path: string, digit: string) => ({
      path,
      sha256: digit.repeat(64),
      bytes: 42,
      key: `sessions/${sessionId}/checkpoints/1/${attemptId}/outputs/${digit.repeat(64)}`,
    });
    const listed = (outputs: Listed) => ({
      outputs: checkpointOutputObjects(outputs),
      outputsDigest: checkpointOutputsDigest(outputs),
    });
    const commit = (revision: number, outputs: Listed) =>
      commitCheckpoint(db, {
        checkpoint: checkpoint(revision),
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
        ...listed(outputs),
      });
    const queued = async () => {
      const rows = await judgmentsOf(sessionId);
      await db
        .delete(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId));
      return rows.map((row) => row.status);
    };
    const report = stored("out/report.md", "a");
    const steps: [string, Listed, string[]][] = [
      ["no files", [], []],
      ["a new file", [report], ["queued"]],
      ["the same file inherited", [report], []],
      ["a rename", [{ ...report, path: "out/final.md" }], ["queued"]],
      [
        "a copy of the same content to a new path",
        [{ ...report, path: "out/final.md" }, report],
        ["queued"],
      ],
      [
        "a file over the limits, with no object",
        [
          { ...report, path: "out/final.md" },
          report,
          { path: "out/big.bin", bytes: 9e9, omitted: "too_large" },
        ],
        ["queued"],
      ],
      [
        "the same list in another order",
        [
          { path: "out/big.bin", bytes: 9e9, omitted: "too_large" },
          report,
          { ...report, path: "out/final.md" },
        ],
        [],
      ],
      ["a removal", [report], ["queued"]],
    ];
    const seen: [string, string[]][] = [];
    for (const [revision, [label, outputs]] of steps.entries()) {
      expect(await commit(revision, outputs)).toEqual({
        outcome: "committed",
        revision,
      });
      seen.push([label, await queued()]);
    }
    expect(seen).toEqual(steps.map(([label, , expected]) => [label, expected]));

    await expect(
      db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") throw new Error(fenced.outcome);
        const advanced = await advanceCheckpointPointer(tx, {
          fence,
          session: fenced.session,
          checkpoint: checkpoint(steps.length),
          turnRowId: null,
          now: new Date(),
          versionsHeld: false,
          ...listed([stored("out/other.md", "c")]),
        });
        expect(advanced.outcome).toBe("committed");
        const inside = await tx
          .select({ id: achievementJudgments.id })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.sessionId, sessionId));
        expect(inside).toHaveLength(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await queued()).toEqual([]);

    // A judgment that gave up on an unreadable out/ is retried by the next
    // checkpoint, though the list did not change.
    await db.insert(achievementJudgments).values({
      id: randomUUID(),
      workspaceId,
      ownerId: workspaceId,
      sessionId,
      trigger: "evidence",
      status: "failed",
      errorCode: "outputs_unavailable",
      nextAttemptAt: new Date(),
      finishedAt: new Date(),
    });
    expect(await commit(steps.length, [report])).toMatchObject({
      outcome: "committed",
    });
    expect(await queued()).toEqual(["failed", "queued"]);
    expect(await commit(steps.length + 1, [report])).toMatchObject({
      outcome: "committed",
    });
    expect(await queued()).toEqual([]);
  });

  test("nothing is queued for a workspace that turned on_evidence off, or for a session without a workspace", async () => {
    const { workspaceId } = await workspace();
    await db
      .update(workspaces)
      .set({
        settings: sql`jsonb_build_object('achievement_judge', jsonb_build_object('on_evidence', false))`,
      })
      .where(eq(workspaces.id, workspaceId));
    const off = await session(workspaceId);
    await review(off, workspaceId);
    expect(await judgmentsOf(off)).toEqual([]);

    const legacy = await session(null);
    await queueAchievementJudgment(db, legacy);
    expect(await judgmentsOf(legacy)).toEqual([]);
  });

  test("the judge waits out the quiet time, then writes each always rule's achievements with the payload and review state of their evidence", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const reviewed = await personType(ws, "github_review");
    await rule(ws, reviewed);
    const sessionId = await session(ws.workspaceId, "Fix the payments");
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await review(sessionId, ws.workspaceId);
    outputsBySession.set(sessionId, {
      status: "ready",
      revision: 1,
      outputs: [
        {
          path: "out/report.md",
          bytes: 42,
          sha256: "b".repeat(64),
          key: `sessions/${sessionId}/outputs/${"b".repeat(64)}`,
        },
      ],
    });

    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([{ status: "queued" }]);
    expect(await achievementsOf(sessionId)).toEqual([]);

    await quietPassed(sessionId);
    await replica().runOnce();
    const [judgment] = await judgmentsOf(sessionId);
    expect(judgment).toMatchObject({
      status: "succeeded",
      errorCode: null,
      attempts: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      calls: 0,
      costUsd: 0,
    });
    expect(judgment?.finishedAt).not.toBeNull();
    expect(judgment?.rules).toHaveLength(3);
    expect(judgment?.evidenceIds).toContain(pr.id);
    expect(judgment?.evidenceIds).toContain("out/report.md");

    const written = await achievementsOf(sessionId);
    const byKind = Object.fromEntries(
      written.map((row) => [row.evidenceKind, row]),
    );
    expect(written).toHaveLength(3);
    expect(byKind.github_pull_request).toMatchObject({
      title: `acme/app#${pr.externalId}`,
      link: pr.url,
      evidenceId: pr.id,
      judge: "always",
      probability: null,
      reviewState: "auto",
      judgmentId: judgment?.id,
      payload: {
        repository: "acme/app",
        number: Number(pr.externalId),
        url: pr.url,
        state: "open",
        merged_at: null,
        additions: null,
        deletions: null,
      },
    });
    expect(byKind.github_review).toMatchObject({
      title: "acme/app#9",
      typeId: reviewed,
      payload: null,
      reviewState: "auto",
    });
    expect(byKind.out_file).toMatchObject({
      title: "out/report.md",
      evidenceId: "out/report.md",
      link: `/sessions/${sessionId}`,
      payload: { path: "out/report.md", size: 42 },
      reviewState: "needs_review",
    });

    const listed = await judgments.list(ws.workspaceId, sessionId);
    if (listed === null) throw new Error("not listed");
    expect(listSessionAchievementsResponseSchema.parse(listed)).toEqual(listed);
    expect(listed?.items).toHaveLength(3);
    expect(listed?.judgment).toMatchObject({
      id: judgment?.id,
      trigger: "evidence",
      status: "succeeded",
      error_code: null,
    });
    expect(await judgments.list("another-owner", sessionId)).toBeNull();
  });

  test("duplicate triggers and a rule's next version never count a family's evidence twice", async () => {
    const ws = await workspace();
    const first = await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    await replica().runOnce();
    expect(await achievementsOf(sessionId)).toHaveLength(1);

    const edited = await rules().createRuleVersion({
      actor: ws.owner,
      receiptId: randomUUID(),
      familyId: first.family_id,
      rule: {
        category_id: ws.categoryId,
        title: "Counted, renamed",
        type_id: first.type_id,
        definition: "Counts as it appears.",
        judge: "always",
        agent_ids: null,
      },
    });
    expect(edited.outcome).toBe("created");
    for (let trigger = 0; trigger < 2; trigger += 1) {
      await queueAchievementJudgment(db, sessionId);
      await quietPassed(sessionId);
      await replica().runOnce();
    }
    const statuses = (await judgmentsOf(sessionId)).map((row) => row.status);
    expect(statuses).toEqual(["succeeded", "succeeded", "succeeded"]);
    const written = await achievementsOf(sessionId);
    expect(written).toHaveLength(1);
    expect(written[0]?.ruleId).toBe(first.id);
    expect(written[0]?.evidenceId).toBe(pr.id);

    // The index itself refuses a second live row for the family and evidence.
    const [judgment] = await judgmentsOf(sessionId);
    const duplicate = db.insert(sessionAchievements).values({
      ...(written[0] as typeof sessionAchievements.$inferInsert),
      id: randomUUID(),
      judgmentId: judgment?.id ?? "",
    });
    const error = await duplicate.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(findPgError(error, "23505")).toBeDefined();
  });

  test("one out/ path counts once in its session and once in each other session", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const report = (sessionId: string) =>
      outputsBySession.set(sessionId, {
        status: "ready",
        revision: 1,
        outputs: [
          {
            path: "out/report.md",
            bytes: 42,
            sha256: "b".repeat(64),
            key: `sessions/${sessionId}/outputs/${"b".repeat(64)}`,
          },
        ],
      });
    const a = await session(ws.workspaceId);
    const b = await session(ws.workspaceId);
    report(a);
    report(b);
    for (let trigger = 0; trigger < 2; trigger += 1) {
      for (const sessionId of [a, b]) {
        await queueAchievementJudgment(db, sessionId);
        await quietPassed(sessionId);
      }
      await replica().runOnce();
    }
    for (const sessionId of [a, b]) {
      expect(
        (await achievementsOf(sessionId)).map((row) => row.evidenceId),
      ).toEqual(["out/report.md"]);
    }
  });

  test("an unavailable out/ list still counts the pull request, then retries 1 minute later until the retries run out", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    outputsBySession.set(sessionId, {
      status: "unavailable",
      reason: "store down",
    });
    await quietPassed(sessionId);

    const before = Date.now();
    await replica().runOnce();
    const [retrying] = await judgmentsOf(sessionId);
    expect(retrying).toMatchObject({
      status: "queued",
      errorCode: "outputs_unavailable",
      attempts: 1,
    });
    expect(retrying?.finishedAt).toBeNull();
    const wait = (retrying?.nextAttemptAt.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(70_000);
    expect(
      (await achievementsOf(sessionId)).map((row) => row.evidenceId),
    ).toEqual([pr.id]);

    for (let retry = 0; retry < 3; retry += 1) {
      await quietPassed(sessionId);
      await replica().runOnce();
    }
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "failed", errorCode: "outputs_unavailable", attempts: 4 },
    ]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
  });

  test("with only luna rules and no judge, the judgment is skipped and nothing is counted", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "skipped", errorCode: "judge_unavailable" },
    ]);
    expect(await achievementsOf(sessionId)).toEqual([]);
    const listed = await judgments.list(ws.workspaceId, sessionId);
    expect(listed?.judgment).toMatchObject({
      status: "skipped",
      error_code: "judge_unavailable",
    });
  });

  test("a claimed judgment is not claimed again within its lease; after a takeover the late finish writes nothing", async () => {
    const ws = await workspace();
    const counted = await rule(
      ws,
      await typeId(ws.workspaceId, "pull_request"),
    );
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const ours = (claimed: ClaimedJudgment[]) =>
      claimed.filter((row) => row.sessionId === sessionId);

    const [first] = ours(await judgments.claim({ max: 100, leaseMs: 60_000 }));
    if (!first) throw new Error("not claimed");
    expect(ours(await judgments.claim({ max: 100, leaseMs: 60_000 }))).toEqual(
      [],
    );
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "running", attempts: 1 },
    ]);

    // The first replica died: its lease runs out and another takes it.
    await db
      .update(achievementJudgments)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.id, first.id));
    const [second] = ours(await judgments.claim({ max: 100, leaseMs: 60_000 }));
    expect(second?.id).toBe(first.id);
    expect(second?.leaseToken).not.toBe(first.leaseToken);

    const late = {
      status: "succeeded" as const,
      errorCode: null,
      rules: [],
      evidenceIds: [pr.id],
      achievements: [
        {
          ruleId: counted.id,
          ruleFamilyId: counted.family_id,
          typeId: counted.type_id,
          agentId: null,
          agentReleaseId: null,
          title: "late",
          link: pr.url,
          evidenceKind: "github_pull_request" as const,
          evidenceId: pr.id,
          payload: null,
          judge: "always" as const,
          probability: null,
          reviewState: "auto" as const,
        },
      ],
    };
    expect(await judgments.finish(first, late)).toBe(false);
    expect(await achievementsOf(sessionId)).toEqual([]);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "running", attempts: 2 },
    ]);
    // Held by the second claim: a pass leaves it alone.
    await replica().runOnce();
    expect(await achievementsOf(sessionId)).toEqual([]);

    await db
      .update(achievementJudgments)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.id, first.id));
    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "succeeded", attempts: 3 },
    ]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
  });

  test("two replicas judging at once judge every judgment once and count each evidence once", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    const sessionIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      sessionIds.push(sessionId);
    }
    const left = async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM achievement_judgments WHERE session_id = ANY($1::uuid[]) AND status <> 'succeeded'",
        [sessionIds],
      );
      return rows[0].n as number;
    };
    const a = replica(3);
    const b = replica(3);
    for (let pass = 0; pass < 10 && (await left()) > 0; pass += 1) {
      await Promise.all([a.runOnce(), b.runOnce()]);
    }
    expect(await left()).toBe(0);
    const { rows } = await pool.query(
      `SELECT j.session_id, j.attempts, count(a.id)::int AS achievements
       FROM achievement_judgments j
       LEFT JOIN session_achievements a ON a.judgment_id = j.id
       WHERE j.session_id = ANY($1::uuid[])
       GROUP BY j.id`,
      [sessionIds],
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 1, achievements: 1 });
    }
  });

  async function judgeSettings(
    workspaceId: string,
    settings: Record<string, unknown>,
  ) {
    await db
      .update(workspaces)
      .set({
        settings: sql`jsonb_build_object('achievement_judge', ${JSON.stringify(settings)}::jsonb)`,
      })
      .where(eq(workspaces.id, workspaceId));
  }

  async function claimOne(sessionId: string) {
    const [claimed] = (
      await judgments.claim({ max: 100, leaseMs: 60_000 })
    ).filter((row) => row.sessionId === sessionId);
    return claimed;
  }

  test("a deferred judgment waits for the next UTC day and is claimed again once due; a trigger meanwhile queues it again after the quiet time", async () => {
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const claimed = await claimOne(sessionId);
    if (!claimed) throw new Error("not claimed");
    const until = new Date(Date.now() + 3_600_000);
    const deferral = {
      status: "deferred" as const,
      until,
      errorCode: null,
      rules: [],
      evidenceIds: [],
      achievements: [],
    };
    expect(await judgments.finish(claimed, deferral)).toBe(true);
    const [deferred] = await judgmentsOf(sessionId);
    expect(deferred).toMatchObject({
      status: "deferred",
      attempts: 0,
      nextAttemptAt: until,
      leaseToken: null,
      finishedAt: null,
    });
    expect(await claimOne(sessionId)).toBeUndefined();
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.sessionId, sessionId));
    const due = await claimOne(sessionId);
    expect(due?.id).toBe(claimed.id);
    if (!due) throw new Error("not claimed");
    expect(await judgments.finish(due, deferral)).toBe(true);

    // New evidence must not wait for the next day's budget to have its
    // always pairs counted: the deferred judgment runs again after the
    // quiet time, and the judge defers its luna pairs again.
    await review(sessionId, ws.workspaceId);
    const [again] = await judgmentsOf(sessionId);
    expect(again).toMatchObject({ id: claimed.id, status: "queued" });
    expect(again?.nextAttemptAt.getTime()).toBeLessThan(until.getTime());
    expect(await claimOne(sessionId)).toBeUndefined();
    await quietPassed(sessionId);
    expect((await claimOne(sessionId))?.id).toBe(claimed.id);
  });

  test("context reads the judge settings, today's spend from the call ledger by the database's day, and the session's other judged judgments", async () => {
    const egress = createPostgresJudgmentEgress(db);
    const ws = await workspace();
    await judgeSettings(ws.workspaceId, {
      connection_id: "conn-1",
      daily_budget_usd: 0.5,
      max_per_session: 3,
    });
    const sessionId = await session(ws.workspaceId);
    const other = await session(ws.workspaceId);
    const row = (
      values: Partial<typeof achievementJudgments.$inferInsert>,
    ) => ({
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      ownerId: ws.workspaceId,
      trigger: "evidence",
      nextAttemptAt: new Date(),
      sessionId: other,
      status: "succeeded",
      ...values,
    });
    // Still waiting for its retry, it made a call just before midnight:
    // yesterday's spend, however long it stays unfinished.
    const unfinished = row({ costUsd: 0.4, calls: 1, status: "deferred" });
    const finished = row({ costUsd: 0.1, calls: 2, finishedAt: new Date() });
    const judged = row({
      costUsd: 0.05,
      calls: 1,
      status: "failed",
      sessionId,
      finishedAt: new Date(),
    });
    await db.insert(achievementJudgments).values([
      unfinished,
      finished,
      judged,
      row({
        costUsd: 0,
        calls: 0,
        status: "skipped",
        sessionId,
        finishedAt: new Date(),
      }),
    ]);
    const usage = (
      judgment: { id: string },
      costUsd: number,
      createdAt: ReturnType<typeof sql>,
    ) => ({
      exchangeId: randomUUID(),
      judgmentId: judgment.id,
      workspaceId: ws.workspaceId,
      inputTokens: 1,
      costUsd,
      createdAt,
    });
    await db
      .insert(achievementJudgmentUsage)
      .values([
        usage(
          unfinished,
          0.4,
          sql`date_trunc('day', now(), 'UTC') - interval '1 minute'`,
        ),
        usage(finished, 0.06, sql`date_trunc('day', now(), 'UTC')`),
        usage(finished, 0.04, sql`now()`),
        usage(judged, 0.05, sql`now()`),
      ]);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const claimed = await claimOne(sessionId);
    if (!claimed) throw new Error("not claimed");
    // Its own call is today's spend, but not one of the session's others.
    expect(
      await egress.recordUsage({
        exchangeId: randomUUID(),
        judgmentId: claimed.id,
        inputTokens: 1,
        costUsd: 0.01,
      }),
    ).toMatchObject({ outcome: "recorded" });
    const midnight = await db.execute<{ at: string }>(
      sql`SELECT ${utcDayOf(sql`now()`).next}::text AS at`,
    );
    expect((await judgments.context(claimed)).judge).toEqual({
      connectionId: "conn-1",
      dailyBudgetUsd: 0.5,
      maxPerSession: 3,
      spentUsd: 0.16,
      budgetResetsAt: new Date(midnight.rows[0]?.at ?? ""),
      sessionJudgments: 1,
      threshold: 0.9,
      transcript: "recent",
      lastInputDigest: null,
    });
  });

  test("a judgment token authorizes only while its lease holds; usage lands on the judgment once per exchange, never on the session", async () => {
    const egress = createPostgresJudgmentEgress(db);
    const ws = await workspace();
    await judgeSettings(ws.workspaceId, {
      connection_id: "conn-1",
      daily_budget_usd: 2,
    });
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const claimed = await claimOne(sessionId);
    if (!claimed) throw new Error("not claimed");
    const hash = new Uint8Array(32).fill(7);
    expect(
      await egress.issueToken({ ...claimed, leaseToken: randomUUID() }, hash),
    ).toBe(false);
    expect(await egress.issueToken(claimed, hash)).toBe(true);
    expect(await egress.authorizeToken({ tokenHash: hash })).toEqual({
      outcome: "ok",
      judgmentId: claimed.id,
      connectionId: "conn-1",
      dailyBudgetUsd: 2,
      spentUsd: 0,
    });
    expect(
      await egress.authorizeToken({ tokenHash: new Uint8Array(32).fill(8) }),
    ).toEqual({ outcome: "invalid_token" });

    const before = await db
      .select({ costUsd: sessions.costUsd, tokens: sessions.providerTokens })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const first = {
      exchangeId: randomUUID(),
      judgmentId: claimed.id,
      inputTokens: 600,
      costUsd: 0.00006,
    };
    expect(await egress.recordUsage(first)).toEqual({
      outcome: "recorded",
      costUsd: 0.00006,
    });
    // The proxy reports an exchange again when its report got no answer.
    expect(await egress.recordUsage(first)).toEqual({
      outcome: "replayed",
      costUsd: 0.00006,
    });
    expect(await egress.recordUsage({ ...first, inputTokens: 601 })).toEqual({
      outcome: "conflict",
    });
    expect(
      await egress.recordUsage({
        exchangeId: randomUUID(),
        judgmentId: claimed.id,
        inputTokens: 1,
        costUsd: 0.0000001,
      }),
    ).toEqual({ outcome: "recorded", costUsd: 0.000001 });
    expect(
      await egress.recordUsage({
        exchangeId: randomUUID(),
        judgmentId: randomUUID(),
        inputTokens: 1,
        costUsd: 1,
      }),
    ).toEqual({ outcome: "unknown_judgment" });
    const [ledger] = await judgmentsOf(sessionId);
    expect(ledger).toMatchObject({
      calls: 2,
      inputTokens: 601,
      // Each call rounded up to a whole micro-dollar.
      costUsd: 0.000061,
    });
    expect(
      await db
        .select({ costUsd: sessions.costUsd, tokens: sessions.providerTokens })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toEqual(before);
    expect(await egress.authorizeToken({ tokenHash: hash })).toMatchObject({
      outcome: "ok",
      spentUsd: 0.000061,
    });

    // The finish ends the lease and the token with it; the ledger stays.
    await judgments.finish(claimed, {
      status: "succeeded",
      errorCode: null,
      rules: [],
      evidenceIds: [],
      achievements: [],
    });
    expect(await egress.authorizeToken({ tokenHash: hash })).toEqual({
      outcome: "invalid_token",
    });
    expect((await judgmentsOf(sessionId))[0]).toMatchObject({
      tokenHash: null,
      calls: 2,
    });
    // A report arriving after the finish still counts.
    expect(
      await egress.recordUsage({
        exchangeId: randomUUID(),
        judgmentId: claimed.id,
        inputTokens: 10,
        costUsd: 0.000001,
      }),
    ).toMatchObject({ outcome: "recorded" });
    expect((await judgmentsOf(sessionId))[0]?.calls).toBe(3);
  });

  test("a judgment token dies with its lease: refused once the lease runs out, and not revived when another claim takes the judgment over", async () => {
    const egress = createPostgresJudgmentEgress(db);
    const ws = await workspace();
    await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const claimed = await claimOne(sessionId);
    if (!claimed) throw new Error("not claimed");
    const hash = new Uint8Array(32).fill(9);
    expect(await egress.issueToken(claimed, hash)).toBe(true);
    await db
      .update(achievementJudgments)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.id, claimed.id));
    expect(await egress.authorizeToken({ tokenHash: hash })).toEqual({
      outcome: "invalid_token",
    });

    const takeover = await claimOne(sessionId);
    expect(takeover?.id).toBe(claimed.id);
    if (!takeover) throw new Error("not claimed");
    expect(await egress.authorizeToken({ tokenHash: hash })).toEqual({
      outcome: "invalid_token",
    });
    expect(await egress.issueToken(claimed, hash)).toBe(false);
    const fresh = new Uint8Array(32).fill(10);
    expect(await egress.issueToken(takeover, fresh)).toBe(true);
    expect(await egress.authorizeToken({ tokenHash: fresh })).toMatchObject({
      outcome: "ok",
      judgmentId: claimed.id,
    });
  });

  /** A workspace over its day's judgment budget, with a luna rule on pull requests and an always rule on reviews. */
  async function overBudget() {
    const ws = await workspace();
    await judgeSettings(ws.workspaceId, {
      connection_id: "conn-1",
      daily_budget_usd: 0.01,
    });
    await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
    const counted = await rule(ws, await typeId(ws.workspaceId, "code_review"));
    const spender = await session(ws.workspaceId);
    const spent = randomUUID();
    await db.insert(achievementJudgments).values({
      id: spent,
      workspaceId: ws.workspaceId,
      ownerId: ws.workspaceId,
      sessionId: spender,
      trigger: "evidence",
      status: "succeeded",
      nextAttemptAt: new Date(),
      calls: 1,
      costUsd: 0.01,
      finishedAt: new Date(),
    });
    await db.insert(achievementJudgmentUsage).values({
      exchangeId: randomUUID(),
      judgmentId: spent,
      workspaceId: ws.workspaceId,
      inputTokens: 100,
      costUsd: 0.01,
    });
    return { ws, counted };
  }

  async function ledgerOf(workspaceId: string) {
    return db
      .select()
      .from(achievementJudgmentUsage)
      .where(eq(achievementJudgmentUsage.workspaceId, workspaceId));
  }

  test("over budget, new evidence on a deferred judgment has its always pair counted within the quiet time, the luna pair deferred again, and no call made", async () => {
    const { ws, counted } = await overBudget();
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    await replica().runOnce();
    const [deferred] = await judgmentsOf(sessionId);
    expect(deferred).toMatchObject({ status: "deferred", calls: 0 });
    expect(await achievementsOf(sessionId)).toEqual([]);

    await review(sessionId, ws.workspaceId);
    const [requeued] = await judgmentsOf(sessionId);
    expect(requeued).toMatchObject({ id: deferred?.id, status: "queued" });
    expect(requeued?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      Date.now() + ACHIEVEMENT_JUDGMENT_QUIET_MS + 5_000,
    );
    await quietPassed(sessionId);
    await replica().runOnce();

    expect(
      (await achievementsOf(sessionId)).map((row) => [
        row.ruleId,
        row.evidenceKind,
      ]),
    ).toEqual([[counted.id, "github_review"]]);
    const [again] = await judgmentsOf(sessionId);
    expect(again).toMatchObject({
      id: deferred?.id,
      status: "deferred",
      calls: 0,
      inputTokens: 0,
      costUsd: 0,
      tokenHash: null,
    });
    expect(again?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Only the call that spent the budget: none was made over it.
    expect(await ledgerOf(ws.workspaceId)).toHaveLength(1);
  });

  test("a judgment deferred while a trigger queued another leaves that one queued for its quiet time, committed before or while it finishes", async () => {
    const deferral = (until: Date) => ({
      status: "deferred" as const,
      until,
      errorCode: null,
      rules: [],
      evidenceIds: [],
      achievements: [],
    });
    const running = async () => {
      const { ws } = await overBudget();
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      const claimed = await claimOne(sessionId);
      if (!claimed) throw new Error("not claimed");
      return { sessionId, claimed };
    };
    const until = new Date(Date.now() + 3_600_000);

    const before = await running();
    await queueAchievementJudgment(db, before.sessionId);
    expect(await judgments.finish(before.claimed, deferral(until))).toBe(true);
    const folded = await judgmentsOf(before.sessionId);
    expect(folded.map((row) => row.status)).toEqual(["failed", "queued"]);
    expect(folded[1]?.nextAttemptAt.getTime()).toBeLessThan(until.getTime());

    const during = await running();
    const trigger = held((tx) =>
      queueAchievementJudgment(tx, during.sessionId).then(() => {}),
    );
    await trigger.started;
    const finishing = judgments.finish(during.claimed, deferral(until));
    await new Promise((resolve) => setTimeout(resolve, 200));
    trigger.release();
    await trigger.done;
    expect(await finishing).toBe(true);
    const raced = await judgmentsOf(during.sessionId);
    expect(raced.map((row) => row.status)).toEqual(["failed", "queued"]);
    expect(raced[1]?.nextAttemptAt.getTime()).toBeLessThan(until.getTime());
  });

  test("the UTC day and the next one are on the UTC calendar whatever the connection's TimeZone", async () => {
    // US daylight saving time starts that day.
    const day = utcDayOf(sql`'2026-03-08T12:00:00Z'::timestamptz`);
    const read = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone = 'America/New_York'`);
      const result = await tx.execute<{ start: string; next: string }>(
        sql`SELECT (extract(epoch FROM ${day.start}) * 1000)::float8 AS start,
                   (extract(epoch FROM ${day.next}) * 1000)::float8 AS next`,
      );
      return result.rows[0];
    });
    expect(new Date(Number(read?.start)).toISOString()).toBe(
      "2026-03-08T00:00:00.000Z",
    );
    expect(new Date(Number(read?.next)).toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });

  test("two reports of one exchange at once count it once: one recorded, one replayed", async () => {
    const egress = createPostgresJudgmentEgress(db);
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const claimed = await claimOne(sessionId);
    if (!claimed) throw new Error("not claimed");
    // Holds both reports mid-write: the first at its insert's foreign key,
    // the second behind the first's uncommitted exchange.
    const blocker = held(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM achievement_judgments WHERE id = ${claimed.id} FOR UPDATE`,
      );
    });
    await blocker.started;
    const report = {
      exchangeId: randomUUID(),
      judgmentId: claimed.id,
      inputTokens: 5,
      costUsd: 0.001,
    };
    const both = Promise.all([
      egress.recordUsage(report),
      egress.recordUsage(report),
    ]);
    for (let waited = 0; ; waited += 20) {
      const waiting = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((waiting.rows[0]?.n ?? 0) >= 2) break;
      if (waited > 5_000) throw new Error("reports never met");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    blocker.release();
    await blocker.done;
    const outcomes = (await both).map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["recorded", "replayed"]);
    expect((await judgmentsOf(sessionId))[0]).toMatchObject({
      calls: 1,
      inputTokens: 5,
      costUsd: 0.001,
    });
    expect(await ledgerOf(ws.workspaceId)).toHaveLength(1);
  });

  test("a turns trigger queues on every Nth turn only with every_n_turns set and a conversation rule in use", async () => {
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId, "Fix the build");
    const turns = (turn: number) =>
      db.transaction((tx) =>
        queueAchievementJudgment(tx, sessionId, { trigger: "turns", turn }),
      );
    // Off by default.
    expect(await turns(10)).toBeNull();
    await judgeSettings(ws.workspaceId, { every_n_turns: 5 });
    // No conversation rule yet.
    expect(await turns(10)).toBeNull();
    const conversation = await rules().createType({
      actor: ws.owner,
      receiptId: randomUUID(),
      key: `talk_${randomUUID().slice(0, 6)}`,
      name: "Talk",
      evidenceKind: "conversation",
    });
    if (conversation.outcome !== "created") throw new Error("no type");
    await rule(ws, conversation.type.id, "luna");
    expect(await turns(7)).toBeNull();
    const queued = await turns(10);
    expect(queued).not.toBeNull();
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { id: queued, trigger: "turns", status: "queued" },
    ]);
    // A later trigger merges into it and keeps its trigger.
    expect(await turns(15)).toBe(queued);
    expect(await judgmentsOf(sessionId)).toHaveLength(1);
  });

  test("an idle trigger queues only with on_idle on; a manual one always", async () => {
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId);
    const queue = (trigger: "idle" | "manual") =>
      db.transaction((tx) =>
        queueAchievementJudgment(tx, sessionId, { trigger }),
      );
    expect(await queue("idle")).toBeNull();
    await judgeSettings(ws.workspaceId, { on_idle: true, on_evidence: false });
    const idle = await queue("idle");
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { id: idle, trigger: "idle" },
    ]);

    const other = await session(ws.workspaceId);
    await judgeSettings(ws.workspaceId, { on_idle: false, on_evidence: false });
    const manual = await db.transaction((tx) =>
      queueAchievementJudgment(tx, other, { trigger: "manual" }),
    );
    expect(await judgmentsOf(other)).toMatchObject([
      { id: manual, trigger: "manual" },
    ]);
  });

  test("a manual rejudge queues with a rejudge_session receipt; another owner's session is not found", async () => {
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId);
    const receiptId = randomUUID();
    const result = await judgments.rejudge({
      actor: ws.owner,
      sessionId,
      receiptId,
    });
    if (result.outcome !== "queued") throw new Error(result.outcome);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { id: result.judgmentId, trigger: "manual", status: "queued" },
    ]);
    const [written] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(written).toMatchObject({
      operation: "rejudge_session",
      status: "succeeded",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      result: { judgment_id: result.judgmentId },
    });

    const elsewhere = await workspace();
    const foreign = await session(elsewhere.workspaceId);
    expect(
      await judgments.rejudge({
        actor: ws.owner,
        sessionId: foreign,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    expect(await judgmentsOf(foreign)).toEqual([]);
  });

  test("a trigger merging into a pending judgment leaves it the newest trigger", async () => {
    const ws = await workspace();
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    const [pending] = await judgmentsOf(sessionId);
    expect(pending).toMatchObject({ trigger: "evidence", status: "queued" });
    if (!pending) throw new Error("not queued");
    const result = await judgments.rejudge({
      actor: ws.owner,
      sessionId,
      receiptId: randomUUID(),
    });
    expect(result).toEqual({ outcome: "queued", judgmentId: pending.id });
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { id: pending.id, trigger: "manual", status: "queued" },
    ]);
  });

  describe("Luna pairs", () => {
    function lunaReplica(
      probability: () => number | "refuse" | "fail",
      options: {
        leaseMs?: number;
        delayMs?: number;
        claimMax?: number;
        /** Before the token, as a slow secret store would be. */
        upstreamDelayMs?: number;
      } = {},
    ) {
      const sent: DecisionsRequest[] = [];
      const judge = createAchievementJudge({
        store: judgments,
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        ...(options.claimMax === undefined
          ? {}
          : { claimMax: options.claimMax }),
        outputs: {
          readOutputs: async () => ({ status: "none" }),
          openOutput: async () => ({ status: "missing" }),
        },
        logger: { info() {}, warn() {} },
        luna: {
          connections: {
            upstream: async () => {
              if (options.upstreamDelayMs !== undefined) {
                await Bun.sleep(options.upstreamDelayMs);
              }
              return { url: "https://api.openai.com", headers: [] };
            },
          },
          tokens: createPostgresJudgmentEgress(db),
          decisions: {
            decide: async (_token, request) => {
              sent.push(request);
              if (options.delayMs !== undefined) {
                await Bun.sleep(options.delayMs);
              }
              const yes = probability();
              if (yes === "fail") throw new DecisionsCallError("timeout");
              if (yes === "refuse") {
                return { answers: [{ type: "refusal", name: "achievement" }] };
              }
              return {
                answers: [
                  {
                    type: "choice",
                    name: "achievement",
                    choice: yes >= 0.5 ? "yes" : "no",
                    probabilities: [
                      { value: "yes", probability: yes },
                      { value: "no", probability: 1 - yes },
                    ],
                  },
                ],
              };
            },
          },
        },
      });
      return { judge, sent };
    }

    async function judgedOnce(
      sessionId: string,
      replica: ReturnType<typeof lunaReplica>,
    ) {
      await queueAchievementJudgment(db, sessionId);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
    }

    test("a yes keeps its probability and the judgment its digest; the same input is not sent again, a merge is, and a no takes down the row unless a person reviewed it", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      const judged = await rule(
        ws,
        await typeId(ws.workspaceId, "pull_request"),
        "luna",
      );
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      let yes = 0.95;
      const replica = lunaReplica(() => yes);

      await quietPassed(sessionId);
      await replica.judge.runOnce();
      expect(replica.sent).toHaveLength(1);
      expect(replica.sent[0]?.input).toContain(
        "title: <untrusted>Retry failed payments</untrusted>",
      );
      expect(replica.sent[0]?.input).toContain(
        "<definition>Counts as it appears.</definition>",
      );
      const [first] = await judgmentsOf(sessionId);
      expect(first).toMatchObject({
        status: "succeeded",
        backend: "luna",
        connectionId: "conn-1",
      });
      expect(first?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        (await achievementsOf(sessionId)).map((row) => [
          row.ruleId,
          row.evidenceId,
          row.judge,
          row.probability,
          row.reviewState,
          row.supersededAt,
        ]),
      ).toEqual([[judged.id, pr.id, "luna", 0.95, "auto", null]]);

      await judgedOnce(sessionId, replica);
      expect(replica.sent).toHaveLength(1);
      const unchanged = (await judgmentsOf(sessionId)).at(-1);
      expect(unchanged).toMatchObject({
        status: "succeeded",
        inputDigest: first?.inputDigest,
        calls: 0,
      });

      await db
        .update(sessionOutcomes)
        .set({ state: "merged", mergedAt: new Date() })
        .where(eq(sessionOutcomes.id, pr.id));
      yes = 0.2;
      await judgedOnce(sessionId, replica);
      expect(replica.sent).toHaveLength(2);
      expect(replica.sent[1]?.input).toContain("state: merged");
      const flipped = (await judgmentsOf(sessionId)).at(-1);
      expect(flipped?.inputDigest).not.toBe(first?.inputDigest);
      const [down] = await achievementsOf(sessionId);
      expect(down?.supersededAt).not.toBeNull();
      expect(down?.supersededBy).toBe(flipped?.id ?? "");

      // A yes again counts anew; a person's confirmation then stands
      // against the next no.
      yes = 0.97;
      await db
        .update(sessionOutcomes)
        .set({ state: "closed" })
        .where(eq(sessionOutcomes.id, pr.id));
      await judgedOnce(sessionId, replica);
      const live = (await achievementsOf(sessionId)).filter(
        (row) => row.supersededAt === null,
      );
      expect(live.map((row) => row.probability)).toEqual([0.97]);
      await db
        .update(sessionAchievements)
        .set({ reviewState: "confirmed" })
        .where(eq(sessionAchievements.id, live[0]?.id ?? ""));
      yes = 0.1;
      await db
        .update(sessionOutcomes)
        .set({ state: "open", mergedAt: null })
        .where(eq(sessionOutcomes.id, pr.id));
      await judgedOnce(sessionId, replica);
      expect(replica.sent).toHaveLength(4);
      const kept = (await achievementsOf(sessionId)).filter(
        (row) => row.supersededAt === null,
      );
      expect(kept.map((row) => [row.reviewState, row.probability])).toEqual([
        ["confirmed", 0.97],
      ]);
    });

    test("a refused pair leaves an earlier yes for it as it was; the judgment succeeds with judge_refused", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      let answer: number | "refuse" = 0.95;
      const replica = lunaReplica(() => answer);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      const [before] = await achievementsOf(sessionId);
      expect(before?.probability).toBe(0.95);

      answer = "refuse";
      await db
        .update(sessionOutcomes)
        .set({ state: "merged", mergedAt: new Date() })
        .where(eq(sessionOutcomes.id, pr.id));
      await judgedOnce(sessionId, replica);
      expect(replica.sent).toHaveLength(2);
      expect((await judgmentsOf(sessionId)).at(-1)).toMatchObject({
        status: "succeeded",
        errorCode: "judge_refused",
      });
      expect(await achievementsOf(sessionId)).toEqual([before] as never);
    });

    test("a stricter threshold, rejudged by hand, asks again and takes down a yes under it", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, {
        connection_id: "conn-1",
        threshold: 0.9,
      });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      const replica = lunaReplica(() => 0.94);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      expect(
        (await achievementsOf(sessionId)).map((row) => row.supersededAt),
      ).toEqual([null]);

      await judgeSettings(ws.workspaceId, {
        connection_id: "conn-1",
        threshold: 0.95,
      });
      const queued = await judgments.rejudge({
        actor: ws.owner,
        sessionId,
        receiptId: randomUUID(),
      });
      expect(queued.outcome).toBe("queued");
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      expect(replica.sent).toHaveLength(2);
      const [down] = await achievementsOf(sessionId);
      expect(down?.supersededAt).not.toBeNull();
    });

    test("an achievement keeps the threshold its judgment asked with; a judgment that asks nothing keeps none", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, {
        connection_id: "conn-1",
        threshold: 0.9,
      });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      const replica = lunaReplica(() => 0.94);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      expect((await judgmentsOf(sessionId)).map((j) => j.threshold)).toEqual([
        0.9,
      ]);

      await judgeSettings(ws.workspaceId, {
        connection_id: "conn-1",
        threshold: 0.75,
      });
      const listed = await judgments.list(ws.workspaceId, sessionId);
      expect(listed?.items.map((item) => item.threshold)).toEqual([0.9]);
      expect(listed).not.toHaveProperty("threshold");

      // Same inputs, same threshold: nothing is asked.
      await judgeSettings(ws.workspaceId, {
        connection_id: "conn-1",
        threshold: 0.9,
      });
      await judgedOnce(sessionId, replica);
      expect(replica.sent).toHaveLength(1);
      expect(
        (await judgmentsOf(sessionId)).map((j) => [j.status, j.threshold]),
      ).toEqual([
        ["succeeded", 0.9],
        ["succeeded", null],
      ]);
    });

    test("a judgment after a merge says the evidence changed by it, and an achievement first counted then says it was judged again after the merge", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      let yes = 0.5;
      const replica = lunaReplica(() => yes);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      const before = await judgments.list(ws.workspaceId, sessionId);
      expect(before?.items).toEqual([]);
      expect(before?.judgment?.evidence_change).toBeNull();

      yes = 0.95;
      await db
        .update(sessionOutcomes)
        .set({ state: "merged", mergedAt: sql`now()` })
        .where(eq(sessionOutcomes.id, pr.id));
      await judgedOnce(sessionId, replica);
      const after = await judgments.list(ws.workspaceId, sessionId);
      expect(after?.judgment).toMatchObject({
        trigger: "evidence",
        evidence_change: "pr_merged",
      });
      expect(after?.items.map((item) => item.rejudged_after_merge)).toEqual([
        true,
      ]);

      // A judgment with no merge since the one before it says nothing.
      await judgedOnce(sessionId, replica);
      expect(
        (await judgments.list(ws.workspaceId, sessionId))?.judgment
          ?.evidence_change,
      ).toBeNull();
    });

    test("an achievement first counted after its pull request merged was not judged again", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      await db
        .update(sessionOutcomes)
        // Merged before the session's first judgment was queued.
        .set({ state: "merged", mergedAt: sql`now() - interval '1 hour'` })
        .where(eq(sessionOutcomes.id, pr.id));
      const replica = lunaReplica(() => 0.95);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      const listed = await judgments.list(ws.workspaceId, sessionId);
      expect(listed?.items.map((item) => item.rejudged_after_merge)).toEqual([
        false,
      ]);
      // The first judgment has no judgment before it to change from.
      expect(listed?.judgment?.evidence_change).toBeNull();
    });

    test("a merge a few hundred microseconds before the judgment, in the same millisecond, still changed its evidence", async () => {
      const ws = await workspace();
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      const [first] = await judgmentsOf(sessionId);
      // One transaction: now() is the same in every statement.
      const base = sql`date_trunc('milliseconds', now())`;
      const secondId = randomUUID();
      await db.transaction(async (tx) => {
        await tx
          .update(achievementJudgments)
          .set({
            status: "succeeded",
            createdAt: sql`${base} - interval '1 second'`,
            finishedAt: sql`${base} - interval '1 second'`,
          })
          .where(eq(achievementJudgments.id, first?.id ?? ""));
        await tx.insert(achievementJudgments).values({
          id: secondId,
          workspaceId: ws.workspaceId,
          ownerId: ws.workspaceId,
          sessionId,
          trigger: "evidence",
          status: "succeeded",
          nextAttemptAt: sql`${base}`,
          createdAt: sql`${base} + interval '900 microseconds'`,
          finishedAt: sql`${base} + interval '1 second'`,
        });
        await tx
          .update(sessionOutcomes)
          .set({
            state: "merged",
            mergedAt: sql`${base} + interval '600 microseconds'`,
          })
          .where(eq(sessionOutcomes.id, pr.id));
      });
      const listed = await judgments.list(ws.workspaceId, sessionId);
      expect(listed?.judgment).toMatchObject({
        id: secondId,
        evidence_change: "pr_merged",
      });
    });

    test("a judgment that asked and then failed keeps the threshold it asked with, but no digest, so the next try asks again", async () => {
      for (const answers of [
        [0.95, "fail"],
        ["fail", "fail"],
      ] as const) {
        const ws = await workspace();
        await judgeSettings(ws.workspaceId, {
          connection_id: "conn-1",
          threshold: 0.9,
        });
        await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
        const sessionId = await session(ws.workspaceId);
        await pullRequest(sessionId, ws.workspaceId);
        await pullRequest(sessionId, ws.workspaceId);
        let call = 0;
        let failing = true;
        const replica = lunaReplica(() =>
          failing ? (answers[call++] ?? 0.95) : 0.95,
        );
        await quietPassed(sessionId);
        await replica.judge.runOnce();
        const [tried] = await judgmentsOf(sessionId);
        expect(tried).toMatchObject({
          status: "queued",
          threshold: 0.9,
          inputDigest: null,
        });
        expect(tried?.errorCode).toBe("judge_timeout");

        failing = false;
        const sentBefore = replica.sent.length;
        await db
          .update(achievementJudgments)
          .set({ nextAttemptAt: sql`now() - interval '1 second'` })
          .where(eq(achievementJudgments.id, tried?.id ?? ""));
        await replica.judge.runOnce();
        expect(replica.sent.length).toBe(sentBefore + 2);
        const [retried] = await judgmentsOf(sessionId);
        expect(retried).toMatchObject({ status: "succeeded", threshold: 0.9 });
        expect(retried?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    test("a person's rejection stands against a yes and a no alike", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      let yes = 0.95;
      const replica = lunaReplica(() => yes);
      await quietPassed(sessionId);
      await replica.judge.runOnce();
      const [row] = await achievementsOf(sessionId);
      await db
        .update(sessionAchievements)
        .set({ reviewState: "rejected" })
        .where(eq(sessionAchievements.id, row?.id ?? ""));
      for (const [state, probability] of [
        ["merged", 0.99],
        ["closed", 0.1],
      ] as const) {
        yes = probability;
        await db
          .update(sessionOutcomes)
          .set({ state })
          .where(eq(sessionOutcomes.id, pr.id));
        await judgedOnce(sessionId, replica);
        expect(
          (await achievementsOf(sessionId)).map((a) => [
            a.id,
            a.reviewState,
            a.supersededAt,
          ]),
        ).toEqual([[row?.id, "rejected", null]] as never);
      }
      expect(replica.sent).toHaveLength(3);
    });

    test("a batch slower than its lease keeps it: another replica takes nothing over and each pair is asked once", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const numbers: string[] = [];
      const sessionIds: string[] = [];
      for (let index = 0; index < 2; index++) {
        const sessionId = await session(ws.workspaceId);
        sessionIds.push(sessionId);
        numbers.push(
          String((await pullRequest(sessionId, ws.workspaceId)).externalId),
        );
        await quietPassed(sessionId);
      }
      // 700ms a judgment against a 1s lease: the second one starts in time
      // and asks for its token after the lease taken at the claim ran out.
      const slow = lunaReplica(() => 0.95, {
        leaseMs: 1_000,
        upstreamDelayMs: 600,
        delayMs: 100,
      });
      const other = lunaReplica(() => 0.95, { leaseMs: 1_000 });
      let done = false;
      const running = slow.judge.runOnce().finally(() => {
        done = true;
      });
      while (!done) {
        await Bun.sleep(150);
        await other.judge.runOnce();
      }
      await running;
      const asked = [...slow.sent, ...other.sent]
        .map((request) => /number: (\d+)/.exec(request.input)?.[1])
        .filter((number) => number !== undefined && numbers.includes(number));
      expect(asked.sort()).toEqual([...numbers].sort());
      expect(other.sent).toHaveLength(0);
      for (const sessionId of sessionIds) {
        expect(
          (await judgmentsOf(sessionId)).map((j) => [j.status, j.attempts]),
        ).toEqual([["succeeded", 1]]);
        expect(await achievementsOf(sessionId)).toHaveLength(1);
      }
    }, 20_000);

    test("one replica's batch of slow judgments finishes each on its first try", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionIds: string[] = [];
      for (let index = 0; index < 6; index++) {
        const sessionId = await session(ws.workspaceId);
        sessionIds.push(sessionId);
        await pullRequest(sessionId, ws.workspaceId);
        await pullRequest(sessionId, ws.workspaceId);
        await quietPassed(sessionId);
      }
      const replica = lunaReplica(() => 0.95, {
        leaseMs: 1_000,
        delayMs: 600,
        claimMax: 6,
      });
      const pending = async () =>
        (await Promise.all(sessionIds.map(judgmentsOf)))
          .flat()
          .filter(
            (j) => !["succeeded", "skipped", "failed"].includes(j.status),
          );
      for (let pass = 0; pass < 10 && (await pending()).length > 0; pass++) {
        await replica.judge.runOnce();
      }
      for (const sessionId of sessionIds) {
        expect(
          (await judgmentsOf(sessionId)).map((j) => [j.status, j.attempts]),
        ).toEqual([["succeeded", 1]]);
        expect(await achievementsOf(sessionId)).toHaveLength(2);
      }
    }, 60_000);

    test("a lease that runs out while the input is read gets no token: nothing is sent or written, not even the always pairs, and the next claim judges it", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      await rule(ws, await typeId(ws.workspaceId, "code_review"));
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await review(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      const late = lunaReplica(() => 0.95, {
        leaseMs: 300,
        upstreamDelayMs: 600,
      });
      await late.judge.runOnce();
      expect(late.sent).toHaveLength(0);
      expect(
        (await judgmentsOf(sessionId)).map((j) => [j.status, j.attempts]),
      ).toEqual([["running", 1]]);
      expect(await achievementsOf(sessionId)).toHaveLength(0);

      const next = lunaReplica(() => 0.95);
      await next.judge.runOnce();
      expect(next.sent).toHaveLength(1);
      expect(
        (await judgmentsOf(sessionId)).map((j) => [j.status, j.attempts]),
      ).toEqual([["succeeded", 2]]);
      expect(await achievementsOf(sessionId)).toHaveLength(2);
    }, 20_000);

    test("a retry is claimed with the failure its last try wrote", async () => {
      const ws = await workspace();
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      const first = await claimOne(sessionId);
      if (!first) throw new Error("not claimed");
      expect(first.errorCode).toBeNull();
      expect(
        await judgments.finish(first, {
          status: "queued",
          retryInMs: 60_000,
          errorCode: "judge_timeout",
          rules: [],
          evidenceIds: [],
          achievements: [],
        }),
      ).toBe(true);
      await quietPassed(sessionId);
      const retry = await claimOne(sessionId);
      expect(retry).toMatchObject({ attempts: 2, errorCode: "judge_timeout" });
    });

    test("a finish under a lease taken over, or for a judgment no longer running, writes nothing", async () => {
      const ws = await workspace();
      await rule(ws, await typeId(ws.workspaceId, "pull_request"));
      const sessionId = await session(ws.workspaceId);
      const pr = await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      const claimed = await claimOne(sessionId);
      if (!claimed) throw new Error("not claimed");
      const [ruleRow] = (await judgments.context(claimed)).rules;
      if (!ruleRow) throw new Error("no rule");
      const result = {
        status: "succeeded" as const,
        errorCode: null,
        rules: [ruleRow.id],
        evidenceIds: [pr.id],
        achievements: [],
      };
      await db
        .update(achievementJudgments)
        .set({ status: "failed" })
        .where(eq(achievementJudgments.id, claimed.id));
      expect(await judgments.finish(claimed, result)).toBe(false);
      expect(
        (await judgmentsOf(sessionId)).map((j) => [j.status, j.finishedAt]),
      ).toEqual([["failed", null]]);

      await db
        .update(achievementJudgments)
        .set({
          status: "running",
          leaseExpiresAt: sql`now() - interval '1 second'`,
        })
        .where(eq(achievementJudgments.id, claimed.id));
      const takeover = await claimOne(sessionId);
      if (!takeover) throw new Error("not taken over");
      expect(await judgments.finish(claimed, result)).toBe(false);
      expect(
        (await judgmentsOf(sessionId)).map((j) => [j.status, j.leaseToken]),
      ).toEqual([["running", takeover.leaseToken]]);
    });

    test("a lease that ran out is renewed while no one took it over, but gets a token only once renewed; one taken over gets neither", async () => {
      const ws = await workspace();
      await judgeSettings(ws.workspaceId, { connection_id: "conn-1" });
      await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      const claimed = await claimOne(sessionId);
      if (!claimed) throw new Error("not claimed");
      const egress = createPostgresJudgmentEgress(db);
      const hash = new Uint8Array(32).fill(7);
      const other = { ...claimed, leaseToken: randomUUID() };
      expect(await judgments.renew(other, 60_000)).toBe(false);
      expect(await egress.issueToken(other, hash)).toBe(false);
      expect(await judgments.renew(claimed, 60_000)).toBe(true);
      await db
        .update(achievementJudgments)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(achievementJudgments.id, claimed.id));
      expect(await egress.issueToken(claimed, hash)).toBe(false);
      expect(await judgments.renew(claimed, 60_000)).toBe(true);
      expect(await egress.issueToken(claimed, hash)).toBe(true);
      await db
        .update(achievementJudgments)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(achievementJudgments.id, claimed.id));
      const takeover = await claimOne(sessionId);
      if (!takeover) throw new Error("not taken over");
      expect(await judgments.renew(claimed, 60_000)).toBe(false);
      expect(await egress.issueToken(claimed, hash)).toBe(false);
    });

    test("the transcript is the last ended turns' messages and final answers, oldest first", async () => {
      const ws = await workspace();
      const sessionId = await session(ws.workspaceId, "Talk");
      await db.insert(turns).values([
        ...Array.from({ length: 4 }, (_, index) => ({
          sessionId,
          sequence: index + 1,
          message: `ask ${index + 1}`,
          status: "completed",
          endedAt: new Date(),
          resultJson: { result: `answer ${index + 1}`, tool_result: "x" },
        })),
        { sessionId, sequence: 5, message: "running", status: "running" },
      ]);
      expect(await judgments.transcript(sessionId, 3)).toEqual([
        { sequence: 2, message: "ask 2", result: "answer 2" },
        { sequence: 3, message: "ask 3", result: "answer 3" },
        { sequence: 4, message: "ask 4", result: "answer 4" },
      ]);
    });
  });

  async function decided(ws: Awaited<ReturnType<typeof workspace>>) {
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    outputsBySession.set(sessionId, {
      status: "ready",
      revision: 1,
      outputs: [
        {
          path: "out/report.md",
          bytes: 42,
          sha256: "b".repeat(64),
          key: `sessions/${sessionId}/outputs/${"b".repeat(64)}`,
        },
      ],
    });
    await quietPassed(sessionId);
    await replica().runOnce();
    const listed = await judgments.list(ws.workspaceId, sessionId);
    if (!listed) throw new Error("not listed");
    const pull = listed.items.find(
      (item) => item.evidence_kind === "github_pull_request",
    );
    const file = listed.items.find((item) => item.evidence_kind === "out_file");
    if (!pull || !file) throw new Error("no achievements");
    return { sessionId, listed, pull, file };
  }

  function reviewing(
    actor: TeamActor,
    achievementId: string,
    action: "confirm" | "reject",
    note: string | null = null,
  ) {
    return judgments.review({
      actor,
      achievementId,
      action,
      note,
      receiptId: randomUUID(),
    });
  }

  test("the list names each achievement's rule version and type, and gives the finished judgments and their cost", async () => {
    const ws = await workspace();
    const { sessionId, listed, file } = await decided(ws);
    expect(listSessionAchievementsResponseSchema.parse(listed)).toEqual(listed);
    expect(file).toMatchObject({
      rule_title: "Counted",
      rule_version: 1,
      type_key: "document",
    });
    expect(listed).toMatchObject({
      judgment_count: 1,
      judge_cost_usd: 0,
    });
    // A pending judgment is not counted; the ledger's cost is.
    const [judgment] = await judgmentsOf(sessionId);
    await db
      .update(achievementJudgments)
      .set({ costUsd: 0.000_25 })
      .where(eq(achievementJudgments.id, judgment?.id ?? ""));
    await queueAchievementJudgment(db, sessionId, { trigger: "manual" });
    expect(await judgments.list(ws.workspaceId, sessionId)).toMatchObject({
      judgment: { status: "queued", trigger: "manual" },
      judgment_count: 1,
      judge_cost_usd: 0.000_25,
    });
  });

  test("a person confirms a needs_review achievement or rejects an undecided one once, with a review_achievement receipt", async () => {
    const ws = await workspace();
    const { sessionId, pull, file } = await decided(ws);
    expect(await judgments.find(ws.workspaceId, file.id)).toEqual({
      sessionId,
      agentId: null,
    });
    expect(await judgments.find("another-owner", file.id)).toBeNull();

    expect((await reviewing(ws.owner, pull.id, "confirm")).outcome).toBe(
      "not_reviewable",
    );
    const receiptId = randomUUID();
    const confirmed = await judgments.review({
      actor: ws.owner,
      achievementId: file.id,
      action: "confirm",
      note: "Read it",
      receiptId,
    });
    if (confirmed.outcome !== "reviewed") throw new Error(confirmed.outcome);
    expect(confirmed.achievement).toMatchObject({
      id: file.id,
      review_state: "confirmed",
      reviewed_by: ws.owner.userId,
      review_note: "Read it",
      rule_title: "Counted",
      type_key: "document",
    });
    expect(confirmed.achievement.reviewed_at).not.toBeNull();
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      ownerId: ws.workspaceId,
      operation: "review_achievement",
      status: "succeeded",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      result: { achievement_id: file.id, review_state: "confirmed" },
    });
    expect(JSON.stringify(receipt)).not.toContain("Read it");

    const rejected = await reviewing(ws.owner, pull.id, "reject");
    expect(rejected).toMatchObject({
      outcome: "reviewed",
      achievement: { review_state: "rejected" },
    });
    for (const [id, action] of [
      [file.id, "reject"],
      [pull.id, "reject"],
      [pull.id, "confirm"],
    ] as const) {
      expect((await reviewing(ws.owner, id, action)).outcome).toBe(
        "not_reviewable",
      );
    }
    const other = await workspace();
    expect((await reviewing(other.owner, file.id, "reject")).outcome).toBe(
      "not_found",
    );
  });

  test("confirmed and rejected achievements stay as decided when the session is judged again", async () => {
    const ws = await workspace();
    const { sessionId, pull, file } = await decided(ws);
    await reviewing(ws.owner, file.id, "reject");
    await reviewing(ws.owner, pull.id, "reject");
    const rejudged = await judgments.rejudge({
      actor: ws.owner,
      sessionId,
      receiptId: randomUUID(),
    });
    expect(rejudged.outcome).toBe("queued");
    await quietPassed(sessionId);
    await replica().runOnce();
    expect((await judgmentsOf(sessionId)).map((row) => row.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    const after = await judgments.list(ws.workspaceId, sessionId);
    expect(
      after?.items.map((item) => [item.id, item.review_state]).sort(),
    ).toEqual(
      [
        [pull.id, "rejected"],
        [file.id, "rejected"],
      ].sort(),
    );
  });

  test("a member reviews an agent's achievements only while administering it; a suspended person never", async () => {
    const ws = await workspace();
    const { pull, file } = await decided(ws);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws.workspaceId,
      managingTeamId: await fixtureTeam(db, ws.workspaceId),
      slug: `agent-${agentId.slice(0, 8)}`,
      name: "Fixer",
    });
    await db
      .update(sessionAchievements)
      .set({ agentId })
      .where(eq(sessionAchievements.id, file.id));
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "member",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.workspaceId, userId, role: "member" });
    const member: TeamActor = { ...ws.owner, userId };

    expect((await reviewing(member, file.id, "confirm")).outcome).toBe(
      "actor_inactive",
    );
    // An achievement without an agent has no agent admins.
    expect((await reviewing(member, pull.id, "reject")).outcome).toBe(
      "actor_inactive",
    );
    await db
      .insert(agentAdmins)
      .values({ workspaceId: ws.workspaceId, agentId, userId });
    expect((await reviewing(member, file.id, "confirm")).outcome).toBe(
      "reviewed",
    );
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, ws.owner.userId));
    expect((await reviewing(ws.owner, pull.id, "reject")).outcome).toBe(
      "actor_inactive",
    );
  });

  test("a session made private since the read is not reviewed by an agent admin who no longer sees it", async () => {
    const ws = await workspace();
    const { sessionId, file } = await decided(ws);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws.workspaceId,
      managingTeamId: await fixtureTeam(db, ws.workspaceId),
      slug: `agent-${agentId.slice(0, 8)}`,
      name: "Fixer",
    });
    await db
      .update(sessionAchievements)
      .set({ agentId })
      .where(eq(sessionAchievements.id, file.id));
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "member",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: ws.workspaceId, userId, role: "member" });
    await db
      .insert(agentAdmins)
      .values({ workspaceId: ws.workspaceId, agentId, userId });
    const member: TeamActor = { ...ws.owner, userId };
    await db.insert(sessionShares).values({
      sessionId,
      ownerId: ws.owner.principal.ownerId,
      workspaceId: ws.workspaceId,
      scope: "private",
    });

    expect((await reviewing(member, file.id, "confirm")).outcome).toBe(
      "not_found",
    );
    const [row] = await db
      .select({ reviewState: sessionAchievements.reviewState })
      .from(sessionAchievements)
      .where(eq(sessionAchievements.id, file.id));
    expect(row?.reviewState).toBe("needs_review");
    expect(
      await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.operation, "review_achievement"),
            eq(receipts.ownerId, ws.owner.principal.ownerId),
          ),
        ),
    ).toHaveLength(0);
  });
});
