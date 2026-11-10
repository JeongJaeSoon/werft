import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  PendingSettlement,
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  createPushRequestService,
  createWorkerGateway,
  payloadHash,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresDecisionLog } from "./authz-decisions.ts";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresTurnInterrupts } from "./interrupt-control.ts";
import { reconcileExpiredLeases } from "./lease-reconcile.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { createPostgresPushIntents } from "./push-intents.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  authzDecisions,
  events,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { announceLapsedInputWaits } from "./session-events.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 60_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const catalog: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
  models: ["claude-sonnet-5"],
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

const QUESTION: RegisterPendingRequest["request"] = {
  kind: "question",
  questions: [
    {
      question_id: "q0",
      prompt: "Which environment?",
      options: [
        { option_id: "q0o0", label: "staging" },
        { option_id: "q0o1", label: "production" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
  ],
};

function permission(command = "ls"): RegisterPendingRequest["request"] {
  return { kind: "permission", tool: "Bash", input: { command } };
}

integration("pending requests and answers on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let service: ReturnType<typeof createPendingRequestService>;

  const gatewayWith = (pendingTtlMs?: number) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      pending: createPostgresWorkerPendingStore(db),
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: LEASE_TTL_MS,
        sleep: async () => {},
        ...(pendingTtlMs === undefined ? {} : { pendingTtlMs }),
      },
    });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pending_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    gateway = gatewayWith();
    service = createPendingRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPendingRequests(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function partitionFor(name: string) {
    return `${name}-${crypto.randomUUID()}`;
  }

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope;
    executionId: string;
  };

  async function claimAndDeliver(sessionId: string): Promise<Worker> {
    const l = await launchSession(db, { sessionId });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const principal: WorkerPrincipal = {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
    const scope: WorkerScope = {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
    const next = await gateway.nextInput(principal, scope);
    if (!next.input) throw new Error("no input delivered");
    return {
      principal,
      scope: { ...scope, turn_id: next.input.turn_id },
      executionId: l.executionId,
    };
  }

  // A session whose first turn is running on a worker.
  async function runningSession() {
    const partition = partitionFor("pending");
    const owner = testCaller(`owner-${crypto.randomUUID()}`);
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const worker = await claimAndDeliver(sessionId);
    expect(worker.scope.session_id).toBe(sessionId);
    return { owner, sessionId, partition, worker };
  }

  async function register(
    worker: Worker,
    request: RegisterPendingRequest["request"],
    inputHash = HASH_A,
    requestId = `req_${crypto.randomUUID()}`,
    via: WorkerGateway = gateway,
  ) {
    const response = await via.registerPending(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      request_id: requestId,
      input_hash: inputHash,
      request,
    });
    return { requestId, response };
  }

  function answer(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
    body: PostSessionAnswerRequest,
    key = crypto.randomUUID(),
  ) {
    return service.answer(owner, sessionId, { idempotencyKey: key, body });
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) return error.code;
      if (error instanceof WorkerGatewayError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  async function receiptOf(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  function poll(
    worker: Worker,
    answersAfter = 0,
    settled: PendingSettlement[] = [],
  ) {
    return gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: answersAfter,
      settled,
    });
  }

  test("lists what the worker registered, in the public shape, to its owner only", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const tool = await register(worker, permission("ls -la"));
    const asked = await register(worker, QUESTION, HASH_B);
    expect(tool.response.expires_in_ms).toBe(30 * 60_000);

    const listed = await service.listPendingRequests(owner, sessionId);
    expect(listed.items).toHaveLength(2);
    const byId = new Map(listed.items.map((item) => [item.request_id, item]));
    expect(byId.get(tool.requestId)).toEqual({
      request_id: tool.requestId,
      kind: "permission",
      turn_id: "1",
      attempt_id: worker.scope.attempt_id,
      tool: "Bash",
      input: { command: "ls -la" },
      created_at: expect.any(String),
      expires_at: tool.response.expires_at,
      state: "waiting",
      park_at: null,
      group: "1",
      summary: {
        verb: { key: "action.tool.runCommand" },
        target: "ls -la",
        excerpt: null,
      },
    });
    expect(byId.get(asked.requestId)).toMatchObject({
      kind: "question",
      turn_id: "1",
      questions: QUESTION.kind === "question" ? QUESTION.questions : [],
    });
    // The summary counts exactly what the list shows.
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect(detail?.pending_request_count).toBe(2);

    expect(
      await failure(
        service.listPendingRequests(testCaller("someone-else"), sessionId),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await failure(
        answer(testCaller("someone-else"), sessionId, {
          request_id: tool.requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("displayOf gives a card the chosen options and whether one was typed, never the typed text, to its owner only", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const store = createPostgresPendingRequests(db);
    const typed = "the staging password is in the vault";
    const asked = await register(worker, {
      kind: "question",
      questions: [
        {
          question_id: "q0",
          prompt: "Which environment?",
          options: [
            { option_id: "q0o0", label: "staging" },
            { option_id: "q0o1", label: "production" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    });
    const tool = await register(worker, permission("rm -rf build"), HASH_B);

    expect(
      await store.displayOf(owner.ownerId, sessionId, tool.requestId),
    ).toMatchObject({
      kind: "permission",
      tool: "Bash",
      input: { command: "rm -rf build" },
      context: {},
      state: "open",
      decision: null,
      decidedByUserId: null,
      closedReason: null,
    });

    await answer(owner, sessionId, {
      request_id: asked.requestId,
      kind: "question",
      answers: [
        {
          question_id: "q0",
          selected_option_ids: ["q0o1"],
          free_text: typed,
        },
      ],
    });
    await answer(owner, sessionId, {
      request_id: tool.requestId,
      kind: "permission",
      decision: "deny",
    });

    const question = await store.displayOf(
      owner.ownerId,
      sessionId,
      asked.requestId,
    );
    expect(question).toMatchObject({
      kind: "question",
      state: "answered",
      answers: [
        { question_id: "q0", selected_option_ids: ["q0o1"], typed: true },
      ],
      // A test caller names no person, so no one is named as the decider.
      decidedByUserId: null,
    });
    expect(JSON.stringify(question)).not.toContain(typed);
    expect(
      await store.displayOf(owner.ownerId, sessionId, tool.requestId),
    ).toMatchObject({ state: "answered", decision: "deny" });

    expect(
      await store.displayOf("someone-else", sessionId, asked.requestId),
    ).toBeNull();
    expect(
      await store.displayOf(owner.ownerId, sessionId, "req_unknown"),
    ).toBeNull();
    expect(
      await store.displayOf(owner.ownerId, "not-a-uuid", asked.requestId),
    ).toBeNull();
  });

  test("displayOf says why an unanswered request closed: expired, or with its session", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const store = createPostgresPendingRequests(db);
    const lapsed = await register(worker, permission("a"));
    await db
      .update(pendingRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(pendingRequests.requestId, lapsed.requestId));
    expect(
      await store.displayOf(owner.ownerId, sessionId, lapsed.requestId),
    ).toMatchObject({ state: "closed", closedReason: "expired" });

    const withdrawn = await register(worker, permission("b"), HASH_B);
    await db
      .update(pendingRequests)
      .set({ resolvedAt: new Date() })
      .where(eq(pendingRequests.requestId, withdrawn.requestId));
    expect(
      await store.displayOf(owner.ownerId, sessionId, withdrawn.requestId),
    ).toMatchObject({ state: "closed", closedReason: "stale" });
    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, sessionId));
    expect(
      await store.displayOf(owner.ownerId, sessionId, withdrawn.requestId),
    ).toMatchObject({ state: "closed", closedReason: "session_closed" });
  });

  test("an answer is stored, handed to its attempt, and succeeds once the worker says it landed", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const body: PostSessionAnswerRequest = {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    };
    const key = crypto.randomUUID();
    const accepted = await answer(owner, sessionId, body, key);
    expect(accepted.receipt_status).toBe("accepted");
    expect((await receiptOf(accepted.receipt_id))?.targetRef).toEqual({
      session_id: sessionId,
      turn_id: "1",
      request_id: requestId,
    });
    // Answered is closed to clients.
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);

    const beat = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(true);
    const delivered = await poll(worker);
    expect(delivered.answers).toEqual([
      { sequence: 1, answer: body, input_hash: HASH_A },
    ]);
    // Redelivered until settled, whatever the cursor says.
    expect((await poll(worker, 1)).answers).toEqual([]);
    expect((await poll(worker, 0)).answers).toHaveLength(1);

    await poll(worker, 1, [{ request_id: requestId, outcome: "answered" }]);
    expect((await receiptOf(accepted.receipt_id))?.status).toBe("succeeded");
    expect((await poll(worker, 0)).answers).toEqual([]);
    const after = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(after.control_pending).toBe(false);

    // The same key replays the original receipt at its current status; a
    // different body under it is a conflict, not a second answer.
    expect(await answer(owner, sessionId, body, key)).toEqual({
      receipt_id: accepted.receipt_id,
      receipt_status: "succeeded",
      approval: accepted.approval,
    });
    expect(
      await failure(
        answer(
          owner,
          sessionId,
          { ...body, decision: "deny", reason: "no" },
          key,
        ),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    // A new key on an answered request is too late.
    expect(await failure(answer(owner, sessionId, body))).toBe(
      "REQUEST_EXPIRED",
    );
  });

  test("an approval leaves one decision row and a receipt under the same request id", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const audited = createPendingRequestService({
      authorization: createAuthorizationPolicy({
        decisions: createPostgresDecisionLog(db),
      }),
      store: createPostgresPendingRequests(db),
    });
    // The person behind a key, answering from the web console.
    const approver = {
      ...owner,
      subject: { ...owner.subject, surface: { kind: "web" as const } },
      actor: {
        principal: { kind: "api_key" as const, id: owner.ownerId },
        userId: crypto.randomUUID(),
        workspaceId: null,
        apiKeyId: owner.ownerId,
      },
    };
    const approvalKey = crypto.randomUUID();
    // No reason: a denial's reason is optional.
    const approvalBody = {
      request_id: requestId,
      kind: "permission" as const,
      decision: "deny" as const,
    };
    const accepted = await audited.answer(approver, sessionId, {
      idempotencyKey: approvalKey,
      body: approvalBody,
    });
    const rows = await db
      .select()
      .from(authzDecisions)
      .where(eq(authzDecisions.requestId, owner.requestId));
    expect(rows).toHaveLength(1);
    const [approval] = await db
      .select({
        answeredBy: pendingRequests.answeredBy,
        answerSurface: pendingRequests.answerSurface,
        answerDecisionId: pendingRequests.answerDecisionId,
      })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(approval).toEqual({
      answeredBy: {
        principal: { kind: "api_key", id: owner.ownerId },
        actor_user_id: approver.actor.userId,
        agent_id: null,
      },
      answerSurface: "web",
      answerDecisionId: rows[0]?.id ?? "missing",
    });
    expect(accepted.approval).toEqual({
      answered_by: {
        principal: { kind: "api_key", id: owner.ownerId },
        actor_user_id: approver.actor.userId,
        agent_id: null,
      },
      surface: "web",
      decision_id: rows[0]?.id ?? "missing",
    });
    const replayed = await audited.answer(approver, sessionId, {
      idempotencyKey: approvalKey,
      body: approvalBody,
    });
    expect(replayed.approval).toEqual(accepted.approval);
    // A surface without the decision that admitted it is not a record.
    const orphaned = await db
      .update(pendingRequests)
      .set({ answerDecisionId: null })
      .where(eq(pendingRequests.requestId, requestId))
      .then(
        () => "accepted",
        (error: { cause?: Error }) => String(error.cause?.message ?? error),
      );
    expect(orphaned).toMatch(/pending_requests_approval_check/);
    expect(rows[0]).toMatchObject({
      action: "session.approve",
      resourceKind: "session",
      resourceId: sessionId,
      outcome: "allow",
      reasonCode: "ok",
    });
    expect((await receiptOf(accepted.receipt_id))?.requestId).toBe(
      owner.requestId,
    );
  });

  test("a key refused for answering the session it started leaves a failed answer receipt (GA-8)", async () => {
    const { owner, sessionId } = await runningSession();
    const deciderKey = {
      id: crypto.randomUUID(),
      kind: "agent",
      issued_by_user_id: crypto.randomUUID(),
    } as const;
    const id = await createPostgresPendingRequests(db).recordSelfApproval({
      principal: owner,
      sessionId: sessionId.toUpperCase(),
      requestId: "req_self",
      deciderKey,
    });
    expect(await receiptOf(id)).toMatchObject({
      operation: "answer",
      status: "failed",
      targetRef: {
        session_id: sessionId,
        turn_id: null,
        request_id: "req_self",
      },
      result: { reason_code: "self_approval", decider_key: deciderKey },
      error: { code: "FORBIDDEN" },
    });
  });

  test("refuses options the request never offered, and answers of the other kind", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, QUESTION);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "question",
          answers: [{ question_id: "q0", selected_option_ids: ["q0o9"] }],
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "question",
          answers: [
            {
              question_id: "q0",
              selected_option_ids: [],
              free_text: "this question takes none",
            },
          ],
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: "req_never-registered",
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("NOT_FOUND");
    // None of those took the request.
    const good = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });
    expect(good.receipt_status).toBe("accepted");
  });

  describe("allowing for the session", () => {
    const offer = [{ tool_name: "Bash", rule_content: "git status:*" }];
    const remembering = (requestId: string): PostSessionAnswerRequest => ({
      request_id: requestId,
      kind: "permission",
      decision: "allow",
      remember: "session",
    });

    test("an answer that remembers is refused for a request that offered nothing, and takes nothing", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const { requestId } = await register(worker, permission("ls"));
      expect(
        await failure(answer(owner, sessionId, remembering(requestId))),
      ).toBe("BAD_REQUEST");
      // The request is still open: a plain allow is taken.
      const plain = await answer(owner, sessionId, {
        request_id: requestId,
        kind: "permission",
        decision: "allow",
      });
      expect(plain.receipt_status).toBe("accepted");
    });

    test("a request that offered rules takes the answer, hands it to the worker as stored, and never lists the offer", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const { requestId } = await register(worker, {
        ...permission("git status"),
        remember_offer: offer,
      } as RegisterPendingRequest["request"]);

      const listed = await service.listPendingRequests(owner, sessionId);
      expect(JSON.stringify(listed)).not.toContain("remember_offer");
      expect(JSON.stringify(listed)).not.toContain("git status:*");

      await answer(owner, sessionId, remembering(requestId));
      const capable = await gateway.pendingControl(worker.principal, {
        ...worker.scope,
        capabilities: { approval_remember: true },
        answers_after: 0,
        settled: [],
      });
      expect(capable.answers.map((item) => item.answer)).toEqual([
        { ...remembering(requestId) },
      ]);
    });

    test("a poll that does not announce the capability gets the plain allow", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const { requestId } = await register(worker, {
        ...permission("git status"),
        remember_offer: offer,
      } as RegisterPendingRequest["request"]);
      await answer(owner, sessionId, remembering(requestId));
      const old = await poll(worker);
      expect(old.answers.map((item) => item.answer)).toEqual([
        { request_id: requestId, kind: "permission", decision: "allow" },
      ]);
    });

    test("displayOf says the allow was kept for the session, and a plain allow was not", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const store = createPostgresPendingRequests(db);
      const kept = await register(worker, {
        ...permission("git status"),
        remember_offer: offer,
      } as RegisterPendingRequest["request"]);
      const once = await register(worker, permission("ls"), HASH_B);
      await answer(owner, sessionId, remembering(kept.requestId));
      await answer(owner, sessionId, {
        request_id: once.requestId,
        kind: "permission",
        decision: "allow",
      });
      expect(
        await store.displayOf(owner.ownerId, sessionId, kept.requestId),
      ).toMatchObject({ decision: "allow", remember: "session" });
      expect(
        await store.displayOf(owner.ownerId, sessionId, once.requestId),
      ).toMatchObject({ decision: "allow", remember: null });
      expect(
        await store.requestOutcome(owner.ownerId, sessionId, kept.requestId),
      ).toMatchObject({ decision: "allow", remember: "session" });
    });

    // The engine's rule only lets the tool call start. Whether the push runs
    // is the push request's own state, which a person decides.
    test("allowing request_push for the session leaves its push request waiting for a person", async () => {
      const { owner, sessionId, worker } = await runningSession();
      const { requestId } = await register(worker, {
        kind: "permission",
        tool: "mcp__github__request_push",
        input: {},
        remember_offer: [{ tool_name: "mcp__github__request_push" }],
      } as RegisterPendingRequest["request"]);
      await answer(owner, sessionId, remembering(requestId));
      expect(
        await createPostgresPendingRequests(db).displayOf(
          owner.ownerId,
          sessionId,
          requestId,
        ),
      ).toMatchObject({ decision: "allow", remember: "session" });

      await db
        .update(sessions)
        .set({ checkpointRevision: 2, repositoryId: "sample-app" })
        .where(eq(sessions.id, sessionId));
      // The push is requested through the platform's own service on the real
      // store, as the request_push tool does.
      const pushes = createPostgresPushRequests(db);
      const service = createPushRequestService({
        authorization: createAuthorizationPolicy(),
        store: pushes,
        intents: createPostgresPushIntents(db),
        catalog: {
          connections: {},
          repositories: {
            "sample-app": {
              url: "https://example.invalid/app.git",
              branch: "main",
              auth: { kind: "github_app", registered: true },
            },
          },
        },
        source: {
          readPushSource: async () => ({
            status: "ready",
            revision: 2,
            gitCommit: "b".repeat(40),
          }),
          readPushSourceAt: async () => ({
            status: "ready",
            revision: 2,
            gitCommit: "b".repeat(40),
          }),
        },
      });
      const created = await service.create(
        {
          caller: owner,
          principal: {
            kind: "api_key",
            id: owner.ownerId,
            owner_id: owner.ownerId,
            workspace_id: null,
            scopes: ["sessions:write"],
          },
          ownerId: owner.ownerId,
          verified: true,
        },
        sessionId,
        {
          idempotencyKey: crypto.randomUUID(),
          body: { checkpoint_revision: 2 },
        },
      );
      expect(created).toMatchObject({
        state: "requested",
        resolved_by: null,
      });
      // Nothing is approved, so the pusher has nothing to claim.
      expect(await pushes.claimNextApproved(60_000)).toBeNull();
    });
  });

  test("a request past its expiry, or one the worker gave up on, is REQUEST_EXPIRED", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const brief = gatewayWith(1);
    const { requestId: late } = await register(
      worker,
      permission(),
      HASH_A,
      undefined,
      brief,
    );
    await Bun.sleep(5);
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: late,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_EXPIRED");

    const { requestId: dropped } = await register(worker, permission("pwd"));
    await poll(worker, 0, [{ request_id: dropped, outcome: "expired" }]);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: dropped,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_EXPIRED");
  });

  test("a registration replays with what is left of its lifetime and is never reopened", async () => {
    const { worker } = await runningSession();
    const first = await register(worker, permission());
    const again = await register(worker, permission(), HASH_A, first.requestId);
    expect(again.response.expires_at).toBe(first.response.expires_at);
    expect(again.response.expires_in_ms).toBeLessThanOrEqual(
      first.response.expires_in_ms,
    );
    expect(
      await failure(register(worker, permission(), HASH_B, first.requestId)),
    ).toBe("IDEMPOTENCY_CONFLICT");
    await poll(worker, 0, [
      { request_id: first.requestId, outcome: "cancelled" },
    ]);
    expect(
      await failure(register(worker, permission(), HASH_A, first.requestId)),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      await failure(
        gateway.registerPending(worker.principal, {
          ...(worker.scope as WorkerScope & { turn_id: string }),
          turn_id: "2",
          request_id: `req_${crypto.randomUUID()}`,
          input_hash: HASH_A,
          request: permission(),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a registration whose reply was lost still replays after its turn closed", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await register(worker, permission());
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    const again = await register(worker, permission(), HASH_A, first.requestId);
    expect(again.response.expires_at).toBe(first.response.expires_at);
    // The closed turn takes nothing new.
    expect(await failure(register(worker, permission()))).toBe("NOT_FOUND");
  });

  test("two requests answered in reverse order each get their own answer", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker, permission("ls"), HASH_A);
    const second = await register(worker, permission("rm -rf /"), HASH_B);
    const deny: PostSessionAnswerRequest = {
      request_id: second.requestId,
      kind: "permission",
      decision: "deny",
      reason: "Not here",
    };
    const allow: PostSessionAnswerRequest = {
      request_id: first.requestId,
      kind: "permission",
      decision: "allow",
    };
    await answer(owner, sessionId, deny);
    await answer(owner, sessionId, allow);

    const delivered = await poll(worker);
    expect(delivered.answers).toEqual([
      { sequence: 1, answer: deny, input_hash: HASH_B },
      { sequence: 2, answer: allow, input_hash: HASH_A },
    ]);
  });

  test("concurrent answers get one gapless sequence per session", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const registered = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        register(worker, permission(`echo ${index}`)),
      ),
    );
    await Promise.all(
      registered.map(({ requestId }) =>
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    );
    const delivered = await poll(worker);
    expect(delivered.answers.map((item) => item.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(new Set(delivered.answers.map((a) => a.answer.request_id))).toEqual(
      new Set(registered.map((r) => r.requestId)),
    );
  });

  test("a replaced worker's requests go stale, and only the new attempt's reach it", async () => {
    const { owner, sessionId, partition, worker } = await runningSession();
    const open = await register(worker, permission("ls"));
    const handed = await register(worker, permission("pwd"));
    const handedReceipt = await answer(owner, sessionId, {
      request_id: handed.requestId,
      kind: "permission",
      decision: "allow",
    });
    await poll(worker);

    // The worker goes away without saying what became of the answer.
    await gateway.release(worker.principal, {
      ...worker.scope,
      turn_id: null,
      reason: "replaced",
    });
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: open.requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_STALE");
    await confirmExecutionGone(db, worker.executionId);
    // It may have reached the callback before the worker died.
    const lost = await receiptOf(handedReceipt.receipt_id);
    expect(lost?.status).toBe("unknown");
    expect(lost?.error).toMatchObject({ code: "REQUEST_STALE" });

    // What an operator's recovery decision leaves behind: the
    // unknown turn settled and off the queue, the session taking input again.
    await db
      .update(turns)
      .set({ status: "cancelled" })
      .where(eq(turns.sessionId, sessionId));
    await db
      .delete(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId));
    await db
      .update(sessions)
      .set({ admissionState: "active", status: "idle" })
      .where(eq(sessions.id, sessionId));
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    await db
      .insert(unassignedSessions)
      .values({ sessionId, partition })
      .onConflictDoUpdate({
        target: unassignedSessions.sessionId,
        set: { partition },
      });
    const replacement = await claimAndDeliver(sessionId);
    expect(replacement.scope.attempt_id).not.toBe(worker.scope.attempt_id);
    expect(replacement.scope.turn_id).toBe("2");

    // The engine asks again, under a new id, on the new attempt.
    const again = await register(replacement, permission("ls"));
    const listed = await service.listPendingRequests(owner, sessionId);
    expect(listed.items.map((item) => item.request_id)).toEqual([
      again.requestId,
    ]);
    expect(listed.items[0]?.attempt_id).toBe(replacement.scope.attempt_id);
    await answer(owner, sessionId, {
      request_id: again.requestId,
      kind: "permission",
      decision: "allow",
    });
    const delivered = await poll(replacement);
    expect(delivered.answers.map((item) => item.answer.request_id)).toEqual([
      again.requestId,
    ]);
    // The old attempt hears nothing, and cannot ask any more either.
    expect(await failure(poll(worker))).toBe("STALE_EPOCH");
    expect(await failure(register(worker, permission("ls")))).toBe(
      "STALE_EPOCH",
    );
  });

  test("a poll past the lease settles nothing and delivers nothing", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const accepted = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(
      await failure(
        poll(worker, 0, [{ request_id: requestId, outcome: "answered" }]),
      ),
    ).toBe("LEASE_EXPIRED");
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.settledAt).toBeNull();
    expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");
  });

  test("a settlement that says the answer was dropped fails its receipt", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const accepted = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    // A late or unknown settlement, then the real one, then a contradicting
    // repeat: the first word on a request stands.
    await poll(worker, 0, [
      { request_id: "req_unknown", outcome: "answered" },
      { request_id: requestId, outcome: "expired" },
    ]);
    await poll(worker, 0, [{ request_id: requestId, outcome: "answered" }]);
    const receipt = await receiptOf(accepted.receipt_id);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toMatchObject({ code: "REQUEST_EXPIRED" });
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.settledOutcome).toBe("expired");
    expect(payloadHash(row?.answer)).toBe(
      payloadHash({
        request_id: requestId,
        kind: "permission",
        decision: "allow",
      }),
    );
  });

  test.each([
    [
      "applied",
      { outcome: "answered", answer_result: "applied" },
      "succeeded",
      null,
    ],
    [
      "from a worker that does not say",
      { outcome: "answered" },
      "succeeded",
      null,
    ],
    [
      "unknown to the run",
      { outcome: "answered", answer_result: "unknown" },
      "unknown",
      "may or may not have acted on it",
    ],
    [
      "stale to the run",
      { outcome: "cancelled", answer_result: "stale" },
      "failed",
      "had already closed the request",
    ],
    [
      "cut off by an interrupt",
      { outcome: "cancelled", reason: "interrupt" },
      "failed",
      "the turn was interrupted",
    ],
    [
      "refused by the worker",
      { outcome: "cancelled", reason: "refused" },
      "failed",
      "the worker refused the answer",
    ],
  ] as const)(
    "an answer %s settles its receipt and records why",
    async (_label, settlement, status, says) => {
      const { owner, sessionId, worker } = await runningSession();
      const { requestId } = await register(worker, permission());
      const accepted = await answer(owner, sessionId, {
        request_id: requestId,
        kind: "permission",
        decision: "allow",
      });
      await poll(worker, 0, [{ request_id: requestId, ...settlement }]);

      const receipt = await receiptOf(accepted.receipt_id);
      expect(receipt?.status).toBe(status);
      if (says === null) {
        expect(receipt?.error).toBeNull();
      } else {
        expect(receipt?.error).toMatchObject({ code: "REQUEST_STALE" });
        expect(
          (receipt?.error as { message: string } | null)?.message,
        ).toContain(says);
      }
      const [row] = await db
        .select()
        .from(pendingRequests)
        .where(eq(pendingRequests.requestId, requestId));
      expect([
        row?.settledOutcome,
        row?.settledReason,
        row?.settledAnswerResult,
      ]).toEqual([
        settlement.outcome,
        "reason" in settlement ? settlement.reason : null,
        "answer_result" in settlement ? settlement.answer_result : null,
      ]);
    },
  );

  test("a cancel nobody answered is recorded with its reason, apart from a person's deny", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const cancelled = await register(worker, permission("make deploy"));
    const denied = await register(worker, permission("rm -rf"), HASH_B);
    await answer(owner, sessionId, {
      request_id: denied.requestId,
      kind: "permission",
      decision: "deny",
      reason: "not that",
    });
    await poll(worker, 0, [
      { request_id: cancelled.requestId, outcome: "cancelled", reason: "park" },
      {
        request_id: denied.requestId,
        outcome: "answered",
        answer_result: "applied",
      },
    ]);

    const rows = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.sessionId, sessionId));
    const record = (id: string) => {
      const row = rows.find((candidate) => candidate.requestId === id);
      return {
        outcome: row?.settledOutcome,
        reason: row?.settledReason,
        decision: (row?.answer as { decision?: string } | null)?.decision,
      };
    };
    expect(record(cancelled.requestId)).toEqual({
      outcome: "cancelled",
      reason: "park",
      decision: undefined,
    });
    expect(record(denied.requestId)).toEqual({
      outcome: "answered",
      reason: null,
      decision: "deny",
    });
  });

  // What each reader says, next to what the columns hold.
  async function statuses(owner: { ownerId: string }, sessionId: string) {
    const reader = createPostgresSessionReader(db);
    const detail = await reader.getSession(owner.ownerId, sessionId);
    const turn = await reader.getTurn(owner.ownerId, sessionId, "1");
    const turnList = await reader.listTurns(owner.ownerId, sessionId, {
      limit: 10,
    });
    const listed = await reader.listSessions(
      owner.ownerId,
      { limit: 10 },
      { userId: null, apiKeyId: null },
    );
    const filtered = async (status: "needs_input" | "running") =>
      (
        await reader.listSessions(
          owner.ownerId,
          { limit: 10, status },
          { userId: null, apiKeyId: null },
        )
      ).items.length;
    const counted = await reader.countSessions(
      owner.ownerId,
      {},
      { userId: null, apiKeyId: null },
    );
    const [stored] = await db
      .select({ session: sessions.status, turn: turns.status })
      .from(sessions)
      .innerJoin(turns, eq(turns.sessionId, sessions.id))
      .where(and(eq(sessions.id, sessionId), eq(turns.sequence, 1)));
    return {
      session: detail?.status,
      count: detail?.pending_request_count,
      turn: turn?.status,
      turnListed: turnList?.items[0]?.status,
      listed: listed.items[0]?.status,
      filteredNeedsInput: await filtered("needs_input"),
      filteredRunning: await filtered("running"),
      countedNeedsInput: counted.counts.needs_input,
      countedRunning: counted.counts.running,
      stored,
    };
  }

  const WAITING = {
    session: "needs_input",
    turn: "needs_input",
    turnListed: "needs_input",
    listed: "needs_input",
    filteredNeedsInput: 1,
    filteredRunning: 0,
    countedNeedsInput: 1,
    countedRunning: 0,
    // Never written: the columns keep saying what the execution is doing.
    stored: { session: "running", turn: "running" },
  } as const;
  const RUNNING = {
    session: "running",
    count: 0,
    turn: "running",
    turnListed: "running",
    listed: "running",
    filteredNeedsInput: 0,
    filteredRunning: 1,
    countedNeedsInput: 0,
    countedRunning: 1,
    stored: { session: "running", turn: "running" },
  } as const;

  test("needs_input holds while any request waits and lifts once the last is answered or settled", async () => {
    const { owner, sessionId, worker } = await runningSession();
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);

    const asked = await register(worker, permission("ls"));
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });
    const other = await register(worker, QUESTION, HASH_B);
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 2 });

    // One answered, one left: still waiting on a person.
    await answer(owner, sessionId, {
      request_id: asked.requestId,
      kind: "permission",
      decision: "allow",
    });
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });

    // The worker gives up on the other one (its callback went away).
    await poll(worker, 0, [
      { request_id: other.requestId, outcome: "cancelled" },
    ]);
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
  });

  test("needs_input lifts when the last request expires, with nothing written", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });
    // Time passing, without waiting for it: only the deadline moves.
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.resolvedAt).toBeNull();
  });

  test("expiry is judged at each statement, not at the start of a longer transaction", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    // Repeatable read: the detail's fields must share one snapshot.
    await db.transaction(
      async (tx) => {
        await tx
          .update(pendingRequests)
          .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
          .where(eq(pendingRequests.requestId, requestId));
        const reader = createPostgresSessionReader(tx);
        const before = await reader.getSession(owner.ownerId, sessionId);
        expect(before?.status).toBe("needs_input");
        await tx.execute(sql`SELECT pg_sleep(1.2)`);
        const after = await reader.getSession(owner.ownerId, sessionId);
        expect(after?.status).toBe("running");
        expect(after?.pending_request_count).toBe(0);
      },
      { isolationLevel: "repeatable read" },
    );
  });

  test("a stored needs_input reads from the pending requests like running does", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await db
      .update(sessions)
      .set({ status: "needs_input" })
      .where(eq(sessions.id, sessionId));
    const legacy = {
      stored: { session: "needs_input", turn: "running" },
    } as const;
    expect(await statuses(owner, sessionId)).toEqual({ ...RUNNING, ...legacy });
    await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({
      ...WAITING,
      ...legacy,
      count: 1,
    });
  });

  test("an epoch, generation or auth rotation drops the old attempt's requests while its lease still runs", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker, permission());
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("session row missing");
    for (const moved of [
      { leaseEpoch: session.leaseEpoch + 1 },
      { executionGeneration: session.executionGeneration + 1 },
      { authRevision: session.authRevision + 1 },
    ]) {
      expect(await statuses(owner, sessionId)).toEqual({
        ...WAITING,
        count: 1,
      });
      await db.update(sessions).set(moved).where(eq(sessions.id, sessionId));
      expect(await statuses(owner, sessionId)).toEqual(RUNNING);
      await db
        .update(sessions)
        .set({
          leaseEpoch: session.leaseEpoch,
          executionGeneration: session.executionGeneration,
          authRevision: session.authRevision,
        })
        .where(eq(sessions.id, sessionId));
    }
  });

  test("a lapsed or fenced attempt's requests stop holding the session in needs_input", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });

    // The lease running out is enough, before any reconciler pass.
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);

    // The reconciler fences it (epoch bump, kill requested) without touching
    // the turn; nothing brings needs_input back.
    await reconcileExpiredLeases(db, {});
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(attempt?.state).toBe("lost");
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
  });
  // the stream reports the needs_input edges the reads derive.
  async function ask(
    worker: Worker,
    request: RegisterPendingRequest["request"],
    options: {
      requestId?: string;
      inputHash?: string;
      toolUseId?: string;
    } = {},
  ) {
    const requestId = options.requestId ?? `req_${crypto.randomUUID()}`;
    const response = await gateway.registerPending(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      request_id: requestId,
      input_hash: options.inputHash ?? HASH_A,
      request,
      announce: {
        tool_use_id: options.toolUseId ?? `toolu_${requestId}`,
        tool: request.kind === "permission" ? request.tool : "AskUserQuestion",
      },
    });
    return { requestId, response };
  }

  // The session's stream as a client reads it, reduced to what orders. It
  // opens with the status:running the delivery of turn 1 wrote.
  async function stream(sessionId: string) {
    const rows = await db
      .select({
        type: events.type,
        payload: events.payload,
        attemptId: events.attemptId,
        turnId: events.turnId,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.id));
    return rows.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return row.type === "status"
        ? `status:${payload.phase}`
        : row.type === "question"
          ? `question:${payload.request_id}`
          : row.type;
    });
  }

  async function announced(sessionId: string) {
    const [row] = await db
      .select({ flag: sessions.inputAnnounced })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.flag;
  }

  test("a question and the needs_input it opens are written together, question first, once", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await ask(worker, permission("ls"), {
      toolUseId: "toolu_first",
    });
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${first.requestId}`,
      "status:needs_input",
    ]);
    const [question] = await db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "question")));
    expect(question?.payload).toEqual({
      request_id: first.requestId,
      tool_use_id: "toolu_first",
      kind: "permission",
      tool: "Bash",
      input: { command: "ls" },
      expires_at: first.response.expires_at,
    });
    // It belongs to the attempt that asked and its turn, but takes no place
    // in that attempt's own numbering.
    expect(question?.attemptId).toBe(worker.scope.attempt_id);
    expect(question?.turnId).not.toBeNull();
    expect(question?.sourceSequence).toBeNull();
    expect(await announced(sessionId)).toBe(true);

    // A second question while waiting opens nothing new.
    const second = await ask(worker, QUESTION, { inputHash: HASH_B });
    // A registration whose reply was lost comes back: nothing is rewritten.
    await ask(worker, permission("ls"), {
      requestId: first.requestId,
      toolUseId: "toolu_first",
    });
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${first.requestId}`,
      "status:needs_input",
      `question:${second.requestId}`,
    ]);
    // The same id under another tool use is another request.
    expect(
      await failure(
        ask(worker, permission("ls"), {
          requestId: first.requestId,
          toolUseId: "toolu_other",
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const [secondEvent] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          sql`${events.payload}->>'request_id' = ${second.requestId}`,
        ),
      );
    expect(secondEvent?.payload).toMatchObject({
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        questions: QUESTION.kind === "question" ? QUESTION.questions : [],
      },
    });
  });

  test("the answer or settlement that leaves nothing to answer reports running, once", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await ask(worker, permission());
    const second = await ask(worker, permission("pwd"), { inputHash: HASH_B });
    const key = crypto.randomUUID();
    await answer(
      owner,
      sessionId,
      { request_id: first.requestId, kind: "permission", decision: "allow" },
      key,
    );
    // One is still open.
    expect((await stream(sessionId)).slice(4)).toEqual([]);

    await poll(worker, 0, [
      { request_id: second.requestId, outcome: "cancelled" },
    ]);
    const settledOnce = [
      "status:running",
      `question:${first.requestId}`,
      "status:needs_input",
      `question:${second.requestId}`,
      "status:running",
    ];
    expect(await stream(sessionId)).toEqual(settledOnce);
    expect(await announced(sessionId)).toBe(false);
    // It is about the turn whose request the settlement closed.
    const [pendingRow] = await db
      .select({ turnId: pendingRequests.turnId })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, second.requestId));
    const [returned] = await db
      .select({ turnId: events.turnId })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(returned?.turnId).toBe(pendingRow?.turnId ?? -1);

    // Repeats close nothing that was open: the answer's replay, the same
    // settlement again, and the answered row's own settlement.
    await answer(
      owner,
      sessionId,
      { request_id: first.requestId, kind: "permission", decision: "allow" },
      key,
    );
    await poll(worker, 0, [
      { request_id: second.requestId, outcome: "cancelled" },
      { request_id: first.requestId, outcome: "answered" },
    ]);
    expect(await stream(sessionId)).toEqual(settledOnce);
  });

  test("an answer that closes the last request reports running in its own transaction", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "deny",
    });
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${requestId}`,
      "status:needs_input",
      "status:running",
    ]);
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect(detail?.status).toBe("running");
  });

  test("GET and the stream's last status agree at every turn boundary, each written once", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const agreed = async () => {
      const detail = await createPostgresSessionReader(db).getSession(
        owner.ownerId,
        sessionId,
      );
      const last = (await stream(sessionId))
        .filter((entry) => entry.startsWith("status:"))
        .at(-1);
      expect(last).toBe(`status:${detail?.status}`);
      return detail?.status;
    };
    expect(await agreed()).toBe("running");
    // Handing the same turn to the same attempt again starts nothing.
    const again = await gateway.nextInput(worker.principal, {
      ...worker.scope,
      turn_id: null,
    });
    expect(again.input?.turn_id).toBe("1");
    expect(await stream(sessionId)).toEqual(["status:running"]);

    const { requestId } = await ask(worker, permission());
    expect(await agreed()).toBe("needs_input");
    await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    expect(await agreed()).toBe("running");
    const queued = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    expect(queued.outcome).toBe("accepted");
    expect(await agreed()).toBe("running");

    await gateway.appendEvents(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      batch_key: "result",
      events: [
        {
          event: "result",
          data: { type: "result", subtype: "success", session_id: "sdk" },
          source_sequence: 1,
          occurred_at: new Date().toISOString(),
        },
      ],
    });
    const finalize = () =>
      gateway.finalize(worker.principal, {
        ...(worker.scope as WorkerScope & { turn_id: string }),
        turn_id: "1",
        finalize_key: "fin-1",
        final_source_sequence: 1,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      });
    expect((await finalize()).status).toBe("completed");
    expect(await agreed()).toBe("idle");
    // The replay is answered from the stored turn and writes nothing.
    expect((await finalize()).status).toBe("completed");

    const next = await gateway.nextInput(worker.principal, {
      ...worker.scope,
      turn_id: null,
    });
    expect(next.input?.turn_id).toBe("2");
    expect(await agreed()).toBe("running");
    // The turn's end comes after its result, and each boundary once.
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${requestId}`,
      "status:needs_input",
      "status:running",
      "result",
      "status:idle",
      "status:running",
    ]);
    expect(await announced(sessionId)).toBe(false);
  });

  test("an input to a failed session puts queued on the stream with the read", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await gateway.finalize(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      turn_id: "1",
      finalize_key: "fin-failed",
      final_source_sequence: 0,
      terminal: { status: "failed", reason: "boom", result: null, usage: null },
      checkpoint: null,
    });
    expect((await stream(sessionId)).at(-1)).toBe("status:failed");
    const queued = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "try again",
    });
    expect(queued.outcome).toBe("accepted");
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect(detail?.status).toBe("queued");
    expect((await stream(sessionId)).at(-1)).toBe("status:queued");
  });

  test("an expiry is reported once by the reconciler, not by the settlement that follows it", async () => {
    const { sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    // The worker's own timer settles it: the wait had already ended.
    await poll(worker, 0, [{ request_id: requestId, outcome: "expired" }]);
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${requestId}`,
      "status:needs_input",
    ]);

    const swept = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: false,
    });
    expect(swept).toContainEqual({ sessionId, phase: "running" });
    await announceLapsedInputWaits(db, { limit: 1_000, dryRun: false });
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${requestId}`,
      "status:needs_input",
      "status:running",
    ]);
  });

  test("a dry run reports the lapsed wait and writes nothing", async () => {
    const { sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    const swept = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: true,
    });
    expect(swept).toContainEqual({ sessionId, phase: "running" });
    expect(await stream(sessionId)).toHaveLength(3);
    expect(await announced(sessionId)).toBe(true);
  });

  test("a lost attempt's wait is reported by the reconciler with the status the session reads", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await ask(worker, permission());
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    await reconcileExpiredLeases(db, {});
    await announceLapsedInputWaits(db, { limit: 1_000, dryRun: false });
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect((await stream(sessionId)).at(-1)).toBe(`status:${detail?.status}`);
    expect(detail?.status).toBe("running");
  });

  test("a new question after a wait that lapsed unreported reports the lapse first", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, first.requestId));
    const second = await ask(worker, permission("pwd"), { inputHash: HASH_B });
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${first.requestId}`,
      "status:needs_input",
      "status:running",
      `question:${second.requestId}`,
      "status:needs_input",
    ]);
  });

  test("an interrupt or a terminate that closes the requests reports the end of the wait", async () => {
    const interrupted = await runningSession();
    const asked = await ask(interrupted.worker, permission());
    const accepted = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: interrupted.owner,
      sessionId: interrupted.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "1",
    });
    expect(accepted.outcome).toBe("accepted");
    expect(await stream(interrupted.sessionId)).toEqual([
      "status:running",
      `question:${asked.requestId}`,
      "status:needs_input",
      "status:running",
    ]);

    const terminated = await runningSession();
    const pending = await ask(terminated.worker, permission());
    const [row] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, terminated.sessionId));
    const stopped = await createPostgresSessionControl(db).terminateAtomic({
      principal: terminated.owner,
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row?.revision ?? 0,
      reason: null,
      now: new Date(),
    });
    expect(stopped.outcome).toBe("accepted");
    const detail = await createPostgresSessionReader(db).getSession(
      terminated.owner.ownerId,
      terminated.sessionId,
    );
    expect(await stream(terminated.sessionId)).toEqual([
      "status:running",
      `question:${pending.requestId}`,
      "status:needs_input",
      `status:${detail?.status}`,
    ]);
  });

  test("a pause reports the status the session reads, needs_input included", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    const [row] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const paused = await createPostgresSessionControl(db).pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row?.revision ?? 0,
      reason: "overnight",
      now: new Date(),
    });
    expect(paused.outcome).toBe("accepted");
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    // The worker drains on its own lease, so its question still stands.
    expect(detail?.status).toBe("needs_input");
    expect(await stream(sessionId)).toEqual([
      "status:running",
      `question:${requestId}`,
      "status:needs_input",
      "status:needs_input",
    ]);
    expect(await announced(sessionId)).toBe(true);

    // A resume that cancels the pause leaves the drainer and its question.
    const [pausing] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const resumed = await createPostgresSessionControl(db).resumeAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: pausing?.revision ?? 0,
      now: new Date(),
    });
    expect(resumed.outcome).toBe("accepted");
    expect((await stream(sessionId)).at(-1)).toBe("status:needs_input");
    expect(await announced(sessionId)).toBe(true);
  });

  test("a worker that publishes its own question gets no question events from the gateway", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    expect(await stream(sessionId)).toEqual(["status:running"]);
    await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    expect(await stream(sessionId)).toEqual(["status:running"]);
    expect(await announced(sessionId)).toBe(false);
  });
});
