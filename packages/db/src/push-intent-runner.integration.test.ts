import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPushIntentRunner,
  createPushRequestService,
  type PushSourceResult,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPullRequestDrain } from "./action/pull-request-drain.ts";
import { createPostgresPullRequests } from "./action/pull-requests.ts";
import { createPostgresPushIntents } from "./action/push-intents.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { pushIntents, pushRequests, sessions, turns } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-runner";
const PINNED_COMMIT = "a".repeat(40);
const LATEST_COMMIT = "b".repeat(40);
const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const CATALOG: SessionCatalog = {
  profiles: {},
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: { kind: "github_app", registered: true },
    },
  },
};
const quiet = { info: () => {}, warn: () => {} };

// The runner turns a pinned intent into a push request with the intent's own
// transition, whatever AGENT_ACTION_FLOWS says: nothing here reads it.
integration("push intent runner on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  // What readPushSourceAt answers for a pinned revision.
  let pinned: PushSourceResult = {
    status: "ready",
    revision: 1,
    gitCommit: PINNED_COMMIT,
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_runner_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const intents = () => createPostgresPushIntents(db);
  const requests = () => createPostgresPushRequests(db);

  function pushService() {
    const real = requests();
    const service = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      // The session has no agent rows here; the GitHub switch is on.
      store: {
        ...real,
        findSession: async (...args: Parameters<typeof real.findSession>) => {
          const found = await real.findSession(...args);
          return found && { ...found, githubEnabled: true };
        },
      },
      intents: intents(),
      catalog: CATALOG,
      source: {
        // The pointer's own checkpoint: a different commit from the pinned one.
        readPushSource: async () => ({
          status: "ready",
          revision: 5,
          gitCommit: LATEST_COMMIT,
        }),
        readPushSourceAt: async () => pinned,
      },
    });
    return service;
  }

  function runner() {
    const service = pushService();
    return createPushIntentRunner({
      store: intents(),
      createFromIntent: (job) => service.createFromIntent(job),
      logger: quiet,
    });
  }

  async function pinnedIntent(
    over: { admissionState?: "paused" | "closed" | "active" } = {},
  ) {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      repositoryId: "sample-app",
      checkpointRevision: 5,
      ...(over.admissionState === undefined
        ? {}
        : { admissionState: over.admissionState }),
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "work",
        status: "completed",
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
      repositoryId: "sample-app",
      targetBranch: `agent/${sessionId}`,
      status: "pinned",
      pinnedRevision: 1,
      actor: ACTOR,
      pullRequest: { title: "from the turn" },
      approvalBasis: "push.primary",
      policySource: "agent",
    });
    return { id, sessionId, turnId: turn.id };
  }

  const intentRow = async (id: string) => {
    const [row] = await db
      .select()
      .from(pushIntents)
      .where(eq(pushIntents.id, id));
    if (!row) throw new Error("no intent");
    return row;
  };
  // The decision columns move together with any state past "requested".
  const decided = (receiptId: string) => ({
    decidedAt: new Date(),
    decidedBy: ACTOR,
    decisionReceiptId: receiptId,
  });
  const requestsOf = (sessionId: string) =>
    db.select().from(pushRequests).where(eq(pushRequests.sessionId, sessionId));

  test("a pinned intent becomes an intent-origin request on the pinned commit, not the pointer's", async () => {
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
    const intent = await pinnedIntent();
    await runner().runOnce();
    const [request] = await requestsOf(intent.sessionId);
    expect(request).toMatchObject({
      origin: "intent",
      flow: "actions",
      state: "requested",
      pullRequestIntent: { title: "from the turn" },
      gitCommit: PINNED_COMMIT,
      checkpointRevision: 1,
      targetBranch: `agent/${intent.sessionId}`,
    });
    expect(await intentRow(intent.id)).toMatchObject({
      status: "requested",
      pushRequestId: request?.id,
      claimToken: null,
    });
  });

  test("the whole path: intent, request, approval, push, due stage, drain claim with the turn's content", async () => {
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
    const intent = await pinnedIntent();
    await runner().runOnce();
    const [request] = await requestsOf(intent.sessionId);
    if (!request) throw new Error("no request");
    const store = requests();
    const decision = await store.decide({
      ownerId: OWNER,
      sessionId: intent.sessionId,
      pushRequestId: request.id,
      actor: ACTOR,
      decision: "approve",
      gitCommit: PINNED_COMMIT,
      reason: null,
      idempotencyKey: `d-${request.id}`,
      payloadHash: "h",
    });
    expect(decision.outcome).toBe("written");
    const job = await store.claimNextApproved(60_000);
    if (job?.id !== request.id) throw new Error("claimed another request");
    await store.finish(job, {
      state: "pushed",
      remoteUrl: "https://example.invalid/app.git",
      remoteRef: `refs/heads/${job.targetBranch}`,
      previousCommit: null,
    });
    const [pushed] = await requestsOf(intent.sessionId);
    expect(pushed).toMatchObject({
      state: "pushed",
      prState: "due",
      pullRequestIntent: { title: "from the turn" },
    });
    const claimed =
      await createPostgresPullRequestDrain(db).claimNextDue(60_000);
    expect(claimed).toMatchObject({
      id: request.id,
      gitCommit: PINNED_COMMIT,
      intent: { title: "from the turn" },
    });
  });

  test("a reservation made after the runner claimed the intent still reaches the request", async () => {
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
    const intent = await pinnedIntent();
    await db
      .update(pushIntents)
      .set({ pullRequest: null })
      .where(eq(pushIntents.id, intent.id));
    const job = await intents().claimNext(60_000);
    if (job?.id !== intent.id) throw new Error("claimed another intent");
    expect(job.pullRequest ?? null).toBeNull();
    // The model reserves the pull request while the runner holds the claim.
    const reserved = await createPostgresPullRequests(db).schedule({
      ownerId: OWNER,
      sessionId: intent.sessionId,
      ref: { pushIntentId: intent.id },
      content: { title: "reserved late" },
      actor: ACTOR,
    });
    expect(reserved.kind).toBe("scheduled");
    await pushService().createFromIntent(job);
    const [request] = await requestsOf(intent.sessionId);
    expect(request?.pullRequestIntent).toEqual({ title: "reserved late" });
  });

  test("the session's list shows the request's flow and PR stage beside the intents", async () => {
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
    const intent = await pinnedIntent();
    await runner().runOnce();
    const listed = await requests().list(OWNER, intent.sessionId);
    expect(listed).toMatchObject([
      { origin: "intent", flow: "actions", pr_state: null },
    ]);
    expect(await intents().list(OWNER, intent.sessionId)).toMatchObject([
      { id: intent.id, status: "requested", push_request_id: listed?.[0]?.id },
    ]);
  });

  test("a session that closed or was paused after the claim cancels or keeps the intent", async () => {
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
    for (const [state, expected] of [
      ["closed", { status: "cancelled", refusalCode: "session_closed" }],
      ["paused", { status: "pinned", claimToken: null }],
    ] as const) {
      const intent = await pinnedIntent();
      const store = intents();
      const job = await store.claimNext(60_000);
      expect(job?.id).toBe(intent.id);
      await db
        .update(sessions)
        .set({ admissionState: state })
        .where(eq(sessions.id, intent.sessionId));
      if (job === null) throw new Error("unreachable");
      const result = await store.transition(job, {
        ownerId: OWNER,
        sessionId: job.sessionId,
        actor: ACTOR,
        payloadHash: "h",
        repositoryId: "sample-app",
        repositoryBinding: "sha256:b",
        checkpointRevision: 1,
        gitCommit: PINNED_COMMIT,
        policyApproval: null,
        policyFields: {},
      });
      expect(result.outcome).toBe(state === "closed" ? "ended" : "waiting");
      expect(await intentRow(intent.id)).toMatchObject(expected);
      expect(await requestsOf(intent.sessionId)).toHaveLength(0);
    }
  });

  test("two intents for one target are claimed oldest first, and the newer waits for it", async () => {
    const first = await pinnedIntent();
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId: first.sessionId,
        sequence: 2,
        message: "again",
        status: "completed",
        attemptId: "attempt-2",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    const secondId = crypto.randomUUID();
    await db.insert(pushIntents).values({
      id: secondId,
      ownerId: OWNER,
      sessionId: first.sessionId,
      turnId: turn.id,
      attemptId: "attempt-2",
      repositoryId: "sample-app",
      targetBranch: `agent/${first.sessionId}`,
      status: "pinned",
      pinnedRevision: 2,
      actor: ACTOR,
      approvalBasis: "push.primary",
      policySource: "agent",
    });
    const store = intents();
    // Other tests' leftovers may be older; take claims until this session's.
    const claimed: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const job = await store.claimNext(60_000);
      if (job === null) break;
      if (job.sessionId === first.sessionId) claimed.push(job.id);
    }
    // The first is held by its lease, so the second is not offered.
    expect(claimed).toEqual([first.id]);
    expect((await intentRow(secondId)).claimToken).toBeNull();
  });

  test("running it again makes no second request", async () => {
    const intent = await pinnedIntent();
    const r = runner();
    await r.runOnce();
    await r.runOnce();
    expect(await requestsOf(intent.sessionId)).toHaveLength(1);
  });

  test("two runners at once make exactly one request", async () => {
    const intent = await pinnedIntent();
    await Promise.all([runner().runOnce(), runner().runOnce()]);
    expect(await requestsOf(intent.sessionId)).toHaveLength(1);
    expect((await intentRow(intent.id)).status).toBe("requested");
  });

  test("a closed session cancels the intent and pushes nothing", async () => {
    const intent = await pinnedIntent({ admissionState: "closed" });
    await runner().runOnce();
    expect(await requestsOf(intent.sessionId)).toHaveLength(0);
    expect(await intentRow(intent.id)).toMatchObject({
      status: "cancelled",
      refusalCode: "session_closed",
    });
  });

  test("a paused session keeps the intent pinned, untouched", async () => {
    const intent = await pinnedIntent({ admissionState: "paused" });
    await runner().runOnce();
    expect(await requestsOf(intent.sessionId)).toHaveLength(0);
    expect(await intentRow(intent.id)).toMatchObject({
      status: "pinned",
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  test("a deferred intent whose turn ended without a pin is cancelled", async () => {
    const intent = await pinnedIntent();
    await db
      .update(pushIntents)
      .set({ status: "deferred", pinnedRevision: null })
      .where(eq(pushIntents.id, intent.id));
    await runner().runOnce();
    expect(await intentRow(intent.id)).toMatchObject({
      status: "cancelled",
      refusalCode: "turn_finalized_without_pin",
    });
  });

  test("an earlier open request for the same target makes the intent wait, then go", async () => {
    const intent = await pinnedIntent();
    const first = await requests().create({
      ownerId: OWNER,
      sessionId: intent.sessionId,
      actor: ACTOR,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:b",
      checkpointRevision: 5,
      gitCommit: LATEST_COMMIT,
      policyApproval: null,
      policyFields: {},
    });
    if (first.outcome !== "written") throw new Error("expected a request");
    const r = runner();
    await r.runOnce();
    expect(await intentRow(intent.id)).toMatchObject({ status: "pinned" });
    expect(await requestsOf(intent.sessionId)).toHaveLength(1);

    // The earlier push ends; the intent's short backoff passes.
    await db
      .update(pushRequests)
      .set({
        state: "failed",
        finishedAt: new Date(),
        ...decided(first.request.request_receipt_id),
      })
      .where(eq(pushRequests.id, first.request.id));
    await db
      .update(pushIntents)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(pushIntents.id, intent.id));
    await r.runOnce();
    expect((await intentRow(intent.id)).status).toBe("requested");
  });

  test("a pull request stage still open for the target also holds the intent", async () => {
    const intent = await pinnedIntent();
    const first = await requests().create({
      ownerId: OWNER,
      sessionId: intent.sessionId,
      actor: ACTOR,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:b",
      checkpointRevision: 5,
      gitCommit: LATEST_COMMIT,
      policyApproval: null,
      policyFields: {},
    });
    if (first.outcome !== "written") throw new Error("expected a request");
    await db
      .update(pushRequests)
      .set({
        state: "pushed",
        prState: "opening",
        ...decided(first.request.request_receipt_id),
      })
      .where(eq(pushRequests.id, first.request.id));
    await runner().runOnce();
    expect((await intentRow(intent.id)).status).toBe("pinned");
    expect(await requestsOf(intent.sessionId)).toHaveLength(1);
  });

  test("a commit a person already rejected for the target fails the intent", async () => {
    const intent = await pinnedIntent();
    const rejected = await requests().create({
      ownerId: OWNER,
      sessionId: intent.sessionId,
      actor: ACTOR,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:b",
      checkpointRevision: 5,
      gitCommit: PINNED_COMMIT,
      policyApproval: null,
      policyFields: {},
    });
    if (rejected.outcome !== "written") throw new Error("expected a request");
    await db
      .update(pushRequests)
      .set({
        state: "rejected",
        ...decided(rejected.request.request_receipt_id),
      })
      .where(eq(pushRequests.id, rejected.request.id));
    await runner().runOnce();
    expect(await intentRow(intent.id)).toMatchObject({
      status: "failed",
      refusalCode: "rejected_before",
    });
  });

  test("an unreadable or unverifiable pinned revision ends the intent with the reason", async () => {
    const cases: Array<[PushSourceResult, string]> = [
      [{ status: "none" }, "source_missing"],
      [{ status: "unavailable", reason: "gone" }, "checkpoint_unavailable"],
    ];
    for (const [source, code] of cases) {
      pinned = source;
      const intent = await pinnedIntent();
      await runner().runOnce();
      expect(await intentRow(intent.id)).toMatchObject({
        status: "failed",
        refusalCode: code,
      });
      expect(await requestsOf(intent.sessionId)).toHaveLength(0);
    }
    pinned = { status: "ready", revision: 1, gitCommit: PINNED_COMMIT };
  });

  test("a claim whose lease was lost writes nothing", async () => {
    const intent = await pinnedIntent();
    const store = intents();
    const first = await store.claimNext(60_000);
    expect(first?.id).toBeDefined();
    // Another claim cannot be taken while the lease holds.
    expect(await store.claimNext(60_000)).toBeNull();
    if (first === null) throw new Error("unreachable");
    // A stale token cannot end or transition the row.
    const stale = { ...first, claimToken: crypto.randomUUID() };
    expect(await store.end(stale, "cancelled", "session_closed")).toBe(false);
    expect(
      await store.transition(stale, {
        ownerId: OWNER,
        sessionId: first.sessionId,
        actor: ACTOR,
        payloadHash: "h",
        repositoryId: "sample-app",
        repositoryBinding: "sha256:b",
        checkpointRevision: 1,
        gitCommit: PINNED_COMMIT,
        policyApproval: null,
        policyFields: {},
      }),
    ).toEqual({ outcome: "lost" });
    expect((await intentRow(intent.id)).status).toBe("pinned");
    // The holder can still end it.
    expect(await store.end(first, "cancelled", "session_closed")).toBe(true);
  });

  test("intents left pinned stay out of reach of settleStale", async () => {
    const intent = await pinnedIntent();
    expect(await intents().settleStale()).toBeGreaterThanOrEqual(0);
    expect((await intentRow(intent.id)).status).toBe("pinned");
    await db
      .update(pushIntents)
      .set({ status: "cancelled", refusalCode: "session_closed" })
      .where(inArray(pushIntents.id, [intent.id]));
  });
});
