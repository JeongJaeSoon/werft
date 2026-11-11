import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PushRequest, ReceiptActor } from "@werft-ai/contracts";
import type {
  DecidePushRequestInput,
  PushRequestDisplayReader,
  PushRequestStore,
  PushWriteResult,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresPushRequests,
  toolSummaryContext,
} from "../push-requests.ts";
import * as schema from "../schema.ts";
import {
  catalogRepositories,
  pushRequests,
  receipts,
  sessions,
} from "../schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-push";
const COMMIT = "b".repeat(40);
const LEASE_MS = 60_000;
const PUSHED = {
  state: "pushed",
  remoteUrl: "https://example.invalid/app.git",
  remoteRef: "refs/heads/agent/x",
  previousCommit: null,
} as const;
const REQUESTER: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const APPROVER: ReceiptActor = {
  principal: { kind: "user", id: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35" },
  actor_user_id: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
  agent_id: null,
};

function written(result: PushWriteResult) {
  if (result.outcome !== "written" && result.outcome !== "replayed") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("postgres push requests", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: PushRequestStore & PushRequestDisplayReader;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_requests_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    store = createPostgresPushRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function session(checkpointRevision: number | null = 2) {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: OWNER,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      repositoryId: "sample-app",
      checkpointRevision,
    });
    return id;
  }

  const create = (sessionId: string, key = "k-create", revision = 2) =>
    store.create({
      ownerId: OWNER,
      sessionId,
      actor: REQUESTER,
      idempotencyKey: key,
      payloadHash: "h-create",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: revision,
      gitCommit: COMMIT,
      policyApproval: null,
      policyFields: {},
    });

  const decide = (
    sessionId: string,
    pushRequestId: string,
    overrides: Partial<DecidePushRequestInput> = {},
  ) =>
    store.decide({
      ownerId: OWNER,
      sessionId,
      pushRequestId,
      actor: APPROVER,
      decision: "approve",
      gitCommit: COMMIT,
      reason: null,
      idempotencyKey: "k-decide",
      payloadHash: "h-decide",
      ...overrides,
    });

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    if (!row) throw new Error(`no receipt ${id}`);
    return row;
  }

  test("create pins the commit and the platform's branch, with a receipt", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    expect(request).toMatchObject({
      session_id: sessionId,
      repository_id: "sample-app",
      checkpoint_revision: 2,
      git_commit: COMMIT,
      target_branch: `agent/${sessionId}`,
      state: "requested",
      requested_by: REQUESTER,
      resolved_by: null,
    });
    const row = await receipt(request.request_receipt_id);
    expect(row).toMatchObject({
      ownerId: OWNER,
      operation: "request_push",
      status: "succeeded",
      actor: REQUESTER,
      targetRef: {
        session_id: sessionId,
        turn_id: null,
        request_id: request.id,
      },
      result: {
        push_request_id: request.id,
        verdict: "allow",
        refusal: null,
        checkpoint_revision: 2,
        git_commit: COMMIT,
        target_branch: `agent/${sessionId}`,
      },
    });
    expect(written(await create(sessionId)).id).toBe(request.id);
    const second = await create(sessionId, "k-other");
    expect(second).toMatchObject({
      outcome: "refused",
      refusal: "request_open",
    });
    if (second.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(second.receiptId)).toMatchObject({
      operation: "request_push",
      status: "failed",
      error: { code: "PUSH_REQUEST_OPEN" },
      result: { verdict: "refuse", push_request_id: request.id },
    });
    expect(await store.list(OWNER, sessionId)).toHaveLength(1);
    expect(await store.list("someone-else", sessionId)).toBeNull();
    expect(await store.get("someone-else", sessionId, request.id)).toBeNull();
  });

  test("displayOf names the catalog repository and who decided, to its owner only", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId, "k-display"));
    // No catalog row yet: the id stands in for the name.
    expect(await store.displayOf(OWNER, sessionId, request.id)).toEqual({
      repositoryId: "sample-app",
      repositoryName: null,
      targetBranch: `agent/${sessionId}`,
      gitCommit: COMMIT,
      state: "requested",
      decidedByUserId: null,
      createdAt: expect.any(String),
    });
    await db
      .insert(catalogRepositories)
      .values({
        id: "sample-app",
        owner: "JeongJaeSoon",
        name: "werft-sandbox",
        url: "https://github.com/JeongJaeSoon/werft-sandbox.git",
        branch: "main",
        source: "seed",
      })
      .onConflictDoNothing();
    written(await decide(sessionId, request.id, { idempotencyKey: "k-dd" }));
    expect(await store.displayOf(OWNER, sessionId, request.id)).toMatchObject({
      repositoryName: "JeongJaeSoon/werft-sandbox",
      state: "approved",
      decidedByUserId: APPROVER.actor_user_id,
    });
    expect(await store.displayOf("someone-else", sessionId, request.id)).toBe(
      null,
    );
    expect(await store.displayOf(OWNER, sessionId, "not-a-uuid")).toBeNull();
  });

  test("a GitHub tool's summary reads the push row, the session's repository and the catalog", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId, "k-context"));
    await db
      .insert(catalogRepositories)
      .values({
        id: "sample-app",
        owner: "JeongJaeSoon",
        name: "werft-sandbox",
        url: "https://github.com/JeongJaeSoon/werft-sandbox.git",
        branch: "main",
        source: "seed",
      })
      .onConflictDoNothing();
    const name = "JeongJaeSoon/werft-sandbox";
    expect(
      await toolSummaryContext(
        db,
        sessionId,
        "mcp__github__open_pull_request",
        {
          push_request_id: request.id,
        },
      ),
    ).toEqual({ repository: name, branch: `agent/${sessionId}` });
    expect(
      await toolSummaryContext(db, sessionId, "mcp__github__request_push", {
        branch: "docs",
      }),
    ).toEqual({ repository: name, branch: `agent/${sessionId}-docs` });
    expect(
      await toolSummaryContext(
        db,
        sessionId,
        "mcp__github__attach_repository",
        {
          repository_id: "not-in-catalog",
        },
      ),
    ).toEqual({ repository: "not-in-catalog" });
    // Another session's push row, a bad input, or another tool: nothing.
    const other = await session();
    expect(
      await toolSummaryContext(db, other, "mcp__github__open_pull_request", {
        push_request_id: request.id,
      }),
    ).toEqual({});
    expect(
      await toolSummaryContext(db, sessionId, "mcp__github__request_push", {
        branch: "../x",
      }),
    ).toEqual({});
    expect(
      await toolSummaryContext(db, sessionId, "Bash", { command: "ls" }),
    ).toEqual({});
  });

  test("concurrent creates on one session open one request", async () => {
    const sessionId = await session();
    const results = await Promise.all(
      ["k-race-1", "k-race-2", "k-race-3"].map((key) => create(sessionId, key)),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "refused",
      "refused",
      "written",
    ]);
    for (const result of results) {
      if (result.outcome === "refused") {
        expect(result.refusal).toBe("request_open");
      }
    }
    expect(await store.list(OWNER, sessionId)).toHaveLength(1);
  });

  test("create refuses a pointer that moved after the caller read it", async () => {
    const sessionId = await session(3);
    expect(await create(sessionId, "k-moved", 2)).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    expect(await store.list(OWNER, sessionId)).toEqual([]);
  });

  test("approve once; a second decision is refused and recorded", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    const approved = written(
      await decide(sessionId, request.id, { reason: "reviewed" }),
    );
    expect(approved).toMatchObject({
      state: "approved",
      resolved_by: APPROVER,
      resolution_reason: "reviewed",
    });
    expect(approved).not.toHaveProperty("decided_by");
    expect(approved.resolved_at).not.toBeNull();
    expect(await receipt(approved.resolution_receipt_id ?? "")).toMatchObject({
      operation: "resolve_push",
      status: "succeeded",
      actor: APPROVER,
      result: {
        action: "approve",
        verdict: "allow",
        git_commit: COMMIT,
        checkpoint_revision: 2,
      },
    });
    expect(
      written(await decide(sessionId, request.id)).resolution_receipt_id,
    ).toBe(approved.resolution_receipt_id);
    expect(
      await decide(sessionId, request.id, { payloadHash: "other" }),
    ).toEqual({ outcome: "conflict" });
    const again = await decide(sessionId, request.id, {
      decision: "reject",
      idempotencyKey: "k-again",
    });
    expect(again).toMatchObject({
      outcome: "refused",
      refusal: "already_resolved",
    });
    if (again.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(again.receiptId)).toMatchObject({
      status: "failed",
      error: { code: "PUSH_REQUEST_RESOLVED" },
      result: { action: "reject", verdict: "refuse", git_commit: COMMIT },
    });
    expect((await store.get(OWNER, sessionId, request.id))?.state).toBe(
      "approved",
    );
  });

  test("a decision by a key names that key and its issuer in the receipt (GA-8)", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    const deciderKey = {
      id: crypto.randomUUID(),
      kind: "agent",
      issued_by_user_id: crypto.randomUUID(),
    } as const;
    const decided = written(
      await decide(sessionId, request.id, {
        actor: {
          principal: { kind: "api_key", id: deciderKey.id },
          actor_user_id: null,
          agent_id: crypto.randomUUID(),
        },
        deciderKey,
        idempotencyKey: "k-key",
      }),
    );
    expect(
      (await receipt(decided.resolution_receipt_id ?? "")).result,
    ).toMatchObject({ verdict: "allow", decider_key: deciderKey });
    const again = await decide(sessionId, request.id, {
      deciderKey,
      idempotencyKey: "k-key-again",
    });
    if (again.outcome !== "refused") throw new Error("expected a refusal");
    expect((await receipt(again.receiptId)).result).toMatchObject({
      verdict: "refuse",
      decider_key: deciderKey,
    });
    const person = await session();
    const asked = written(await create(person));
    const byPerson = written(await decide(person, asked.id));
    expect(
      (await receipt(byPerson.resolution_receipt_id ?? "")).result,
    ).toMatchObject({ decider_key: null });
  });

  test("an approval of another commit, or after the session checkpointed again, is refused", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    expect(
      await decide(sessionId, request.id, { gitCommit: "c".repeat(40) }),
    ).toMatchObject({ outcome: "refused", refusal: "commit_mismatch" });
    await db
      .update(sessions)
      .set({ checkpointRevision: 3 })
      .where(eq(sessions.id, sessionId));
    const moved = await decide(sessionId, request.id, {
      idempotencyKey: "k-moved",
    });
    expect(moved).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    if (moved.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(moved.receiptId)).toMatchObject({
      error: { code: "CHECKPOINT_MOVED" },
      result: { checkpoint_revision: 2, verdict: "refuse" },
    });
    expect((await store.get(OWNER, sessionId, request.id))?.state).toBe(
      "requested",
    );
    const rejected = written(
      await decide(sessionId, request.id, {
        decision: "reject",
        idempotencyKey: "k-reject",
      }),
    );
    expect(rejected.state).toBe("rejected");
    expect(
      written(await create(sessionId, "k-new", 3)).checkpoint_revision,
    ).toBe(3);
  });

  test("a replay answers only on the session it was made on", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId, "k-replay"));
    expect(
      await store.replayCreate({
        ownerId: OWNER,
        sessionId,
        idempotencyKey: "k-replay",
        payloadHash: "h-create",
      }),
    ).toMatchObject({ outcome: "replayed", request: { id: request.id } });
    expect(
      await store.replayCreate({
        ownerId: OWNER,
        sessionId,
        idempotencyKey: "k-unused",
        payloadHash: "h-create",
      }),
    ).toBeNull();
    written(await decide(sessionId, request.id, { idempotencyKey: "k-dr" }));
    const elsewhere = await session();
    expect(
      await decide(elsewhere, request.id, { idempotencyKey: "k-dr" }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
  });

  test("decisions on an unknown request or another owner's session are refused", async () => {
    const sessionId = await session();
    expect(
      await decide(sessionId, crypto.randomUUID(), { idempotencyKey: "k-x" }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
    const request = written(await create(sessionId));
    expect(
      await decide(sessionId, request.id, {
        ownerId: "someone-else",
        idempotencyKey: "k-y",
      }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
  });

  test("an approval after a checkpoint of the same commit stands, and pushes the pinned revision", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    await db
      .update(sessions)
      .set({ checkpointRevision: 3 })
      .where(eq(sessions.id, sessionId));
    expect(
      await decide(sessionId, request.id, {
        idempotencyKey: "k-other",
        latest: { revision: 3, gitCommit: "c".repeat(40) },
      }),
    ).toMatchObject({ outcome: "refused", refusal: "checkpoint_moved" });
    // Read at 3, but the session checkpointed again before the decision.
    await db
      .update(sessions)
      .set({ checkpointRevision: 4 })
      .where(eq(sessions.id, sessionId));
    expect(
      await decide(sessionId, request.id, {
        idempotencyKey: "k-raced",
        latest: { revision: 3, gitCommit: COMMIT },
      }),
    ).toMatchObject({ outcome: "refused", refusal: "checkpoint_moved" });
    const approved = written(
      await decide(sessionId, request.id, {
        idempotencyKey: "k-same",
        latest: { revision: 4, gitCommit: COMMIT },
      }),
    );
    expect(approved).toMatchObject({
      state: "approved",
      checkpoint_revision: 2,
      git_commit: COMMIT,
    });
    for (;;) {
      const job = await store.claimNextApproved(LEASE_MS);
      if (job === null) throw new Error("the approval was never claimed");
      if (job.sessionId !== sessionId) continue;
      expect(job).toMatchObject({ checkpointRevision: 2, gitCommit: COMMIT });
      break;
    }
  });

  test("the pusher claims each approved request once and records the outcome", async () => {
    const pushed = await session();
    const failed = await session();
    const approvals = new Map<string, PushRequest>();
    for (const sessionId of [pushed, failed]) {
      const request = written(await create(sessionId));
      approvals.set(sessionId, written(await decide(sessionId, request.id)));
    }
    const claimed = new Set<string>();
    for (;;) {
      const job = await store.claimNextApproved(LEASE_MS);
      if (job === null) break;
      claimed.add(job.sessionId);
      expect(job).toMatchObject({
        gitCommit: COMMIT,
        targetBranch: `agent/${job.sessionId}`,
        checkpointRevision: 2,
        repositoryBinding: "sha256:binding",
        attempt: 1,
      });
      expect(
        await store.finish(
          job,
          job.sessionId === pushed
            ? {
                state: "pushed",
                remoteUrl: "https://example.invalid/app.git",
                remoteRef: `refs/heads/agent/${job.sessionId}`,
                previousCommit: null,
              }
            : { state: "failed", refusal: "non_fast_forward" },
        ),
      ).toBe(true);
      expect(await store.finish(job, PUSHED)).toBe(false);
    }
    expect(claimed).toContain(pushed);
    expect(claimed).toContain(failed);
    const [done] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.sessionId, failed));
    expect(done).toMatchObject({
      state: "failed",
      leaseExpiresAt: null,
      pushError: { code: "REVISION_CONFLICT" },
    });
    expect(await receipt(done?.pushReceiptId ?? "")).toMatchObject({
      operation: "push",
      status: "failed",
      result: { verdict: "refuse", refusal: "non_fast_forward" },
      error: { code: "REVISION_CONFLICT" },
    });
    const [ok] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.sessionId, pushed));
    expect(await receipt(ok?.pushReceiptId ?? "")).toMatchObject({
      operation: "push",
      status: "succeeded",
      result: {
        verdict: "allow",
        git_commit: COMMIT,
        remote_url: "https://example.invalid/app.git",
        remote_ref: `refs/heads/agent/${pushed}`,
        previous_commit: null,
        approved_by: APPROVER,
      },
    });
    // A decision's replay shows the request as it is now, still naming
    // that decision.
    const approval = approvals.get(pushed);
    expect(await decide(pushed, approval?.id ?? "")).toMatchObject({
      outcome: "replayed",
      request: {
        state: "pushed",
        resolved_by: APPROVER,
        resolution_receipt_id: approval?.resolution_receipt_id,
        push_receipt_id: ok?.pushReceiptId,
      },
    });
  });

  test("only approved requests are claimed: requested, rejected and finished ones never are", async () => {
    const waiting = await session();
    written(await create(waiting));
    const rejected = await session();
    const toReject = written(await create(rejected));
    written(
      await decide(rejected, toReject.id, {
        decision: "reject",
        idempotencyKey: "k-reject",
      }),
    );
    const finished = await session();
    const done = written(await create(finished));
    written(await decide(finished, done.id));
    const drain = async () => {
      const seen: string[] = [];
      for (;;) {
        const next = await store.claimNextApproved(LEASE_MS);
        if (next === null) return seen;
        seen.push(next.sessionId);
        expect(await store.finish(next, PUSHED)).toBe(true);
      }
    };
    const first = await drain();
    expect(first).toContain(finished);
    expect(first).not.toContain(waiting);
    expect(first).not.toContain(rejected);
    expect(await drain()).toEqual([]);
  });

  test("a push refused for attribution says which commits in its receipt", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    written(await decide(sessionId, request.id));
    const job = await store.claimNextApproved(LEASE_MS);
    if (job === null) throw new Error("not claimed");
    const mismatches = [
      { commit: "c".repeat(40), problems: ["author" as const] },
    ];
    expect(
      await store.finish(job, {
        state: "failed",
        refusal: "attribution_mismatch",
        mismatches,
      }),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.id, request.id));
    expect(row?.state).toBe("failed");
    const stored = await receipt(row?.pushReceiptId ?? "");
    expect(stored).toMatchObject({
      status: "failed",
      result: {
        refusal: "attribution_mismatch",
        verdict: "refuse",
        mismatches,
      },
    });
  });

  test("a pusher that died loses its row once the lease runs out, and cannot finish it after", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    written(await decide(sessionId, request.id));
    const first = await store.claimNextApproved(LEASE_MS);
    expect(first).toMatchObject({ id: request.id, attempt: 1 });
    expect(await store.claimNextApproved(LEASE_MS)).toBeNull();
    await db
      .update(pushRequests)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(pushRequests.id, request.id));
    const second = await store.claimNextApproved(LEASE_MS);
    expect(second).toMatchObject({ id: request.id, attempt: 2 });
    if (!first || !second) throw new Error("not claimed");
    expect(await store.finish(first, PUSHED)).toBe(false);
    expect(await store.finish(second, PUSHED)).toBe(true);
    written(await create(sessionId, "k-again"));
  });

  test("the table refuses a branch other than agent/<session-id> and an undecided approval", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    const update = async (set: Partial<typeof pushRequests.$inferInsert>) => {
      await db
        .update(pushRequests)
        .set(set)
        .where(eq(pushRequests.id, request.id));
    };
    await expect(update({ targetBranch: "main" })).rejects.toThrow();
    await expect(update({ state: "approved" })).rejects.toThrow();
  });
});
