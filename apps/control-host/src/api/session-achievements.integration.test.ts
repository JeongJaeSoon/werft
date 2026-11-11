import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listSessionAchievementsResponseSchema,
  reviewAchievementResponseSchema,
  WEB_SESSION_COOKIE_NAME,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  achievementJudgments,
  createPostgresAchievementJudgments,
  createPostgresAchievementRuleStore,
  insertBuiltinAchievementTypes,
  insertPullRequestOutcome,
  memberships,
  receipts,
  sessions as sessionRows,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  callerFor,
  createAchievementJudge,
  createAuthorizationPolicy,
  createSessionAchievementService,
  type IdentityStore,
  type ResolvedWebSession,
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
import { createApiApp } from "./app.ts";
import { generateWebSessionToken, hashWebSessionToken } from "./auth.ts";
import { registerSessionAchievementRoutes } from "./routes/sessions/achievements.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("a session's achievement reviews on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const webSessions = new Map<string, ResolvedWebSession>();
  const people: Partial<Record<WorkspaceRole, string>> = {};
  const outputs = {
    status: "ready" as const,
    revision: 1,
    outputs: [
      {
        path: "out/report.md",
        bytes: 42,
        sha256: "b".repeat(64),
        key: `sessions/${sessionId}/outputs/${"b".repeat(64)}`,
      },
    ],
  };
  const judge = () =>
    createAchievementJudge({
      store: createPostgresAchievementJudgments(db),
      outputs: {
        readOutputs: async () => outputs,
        openOutput: async () => ({ status: "missing" }),
      },
      logger: { info() {}, warn() {} },
    });
  // As if the quiet time had passed since the session's last trigger.
  const quietPassed = () =>
    db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(
        and(
          eq(achievementJudgments.sessionId, sessionId),
          eq(achievementJudgments.status, "queued"),
        ),
      );

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_achievements_it" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    await insertBuiltinAchievementTypes(db, workspaceId);
    for (const role of ["owner", "member"] as const) {
      const id = crypto.randomUUID();
      people[role] = id;
      await db.insert(users).values({
        id,
        email: `${role}@example.invalid`,
        displayName: role,
      });
      await db.insert(memberships).values({ workspaceId, userId: id, role });
    }
    const ownerId = people.owner ?? "";
    const owner: TeamActor = {
      principal: callerFor(
        {
          kind: "user",
          id: ownerId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: ["sessions:read"],
        },
        { kind: "web" },
        crypto.randomUUID(),
      ),
      workspaceId,
      userId: ownerId,
    };
    const rules = createPostgresAchievementRuleStore(db);
    const category = await rules.createCategory({
      actor: owner,
      receiptId: crypto.randomUUID(),
      name: "Delivery",
    });
    if (category.outcome !== "created") throw new Error(category.outcome);
    for (const type of await rules.listTypes(workspaceId)) {
      if (type.key === "code_review") continue;
      const made = await rules.createRule({
        actor: owner,
        receiptId: crypto.randomUUID(),
        rule: {
          category_id: category.category.id,
          title: type.key === "document" ? "Design document" : "Merged PR",
          type_id: type.id,
          definition: "Counts as it appears.",
          judge: "always",
          agent_ids: null,
        },
      });
      if (made.outcome !== "created") throw new Error(made.outcome);
    }
    await db.insert(sessionRows).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://github.com/acme/app.git",
      branch: `agent/${sessionId}`,
      repositoryId: "app",
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
    });
    const receiptId = crypto.randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: workspaceId,
      operation: "open_pull_request",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: {},
      error: null,
      actor: {
        principal: { kind: "api_key", id: "key-pr" },
        actor_user_id: null,
        agent_id: null,
      },
    });
    await db.transaction((tx) =>
      insertPullRequestOutcome(tx, {
        ownerId: workspaceId,
        sessionId,
        url: "https://github.com/acme/app/pull/12",
        repositoryId: "app",
        number: 12,
        title: "Retry failed payments",
        head: `agent/${sessionId}`,
        base: "main",
        adopted: false,
        receiptId,
        createdAt: new Date(),
      }),
    );
    await quietPassed();
    await judge().runOnce();

    const identity = {
      async resolveWebSession(tokenHash: Uint8Array) {
        return webSessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
      },
      async renewWebSession() {
        return null;
      },
    } as unknown as IdentityStore;
    app = createApiApp({
      authMode: "api-key",
      identity,
      registerRoutes: (router) =>
        registerSessionAchievementRoutes(
          router,
          createSessionAchievementService({
            authorization: createAuthorizationPolicy(),
            store: createPostgresAchievementJudgments(db),
          }),
        ),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function call(
    method: string,
    path: string,
    body?: unknown,
    role: WorkspaceRole = "owner",
  ) {
    const token = generateWebSessionToken();
    webSessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
      sessionId: crypto.randomUUID(),
      userId: people[role] ?? "",
      email: `${role}@example.invalid`,
      displayName: role,
      locale: null,
      workspaceId,
      role,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return app.request(path, {
      method,
      headers: {
        Cookie: `${WEB_SESSION_COOKIE_NAME}=${token}`,
        ...(method === "GET" ? {} : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function listed() {
    const response = await call(
      "GET",
      `/v1/sessions/${sessionId}/achievements`,
    );
    expect(response.status).toBe(200);
    return listSessionAchievementsResponseSchema.parse(await response.json());
  }

  test("a review through the API writes its receipt, and a rejudge leaves the reviews as they are", async () => {
    const before = await listed();
    const pull = before.items.find((item) => item.type_key === "pull_request");
    const file = before.items.find((item) => item.type_key === "document");
    if (!pull || !file) throw new Error("no achievements");
    expect([pull.review_state, file.review_state]).toEqual([
      "auto",
      "needs_review",
    ]);

    expect(
      (
        await call(
          "POST",
          `/v1/achievements/${file.id}/review`,
          { action: "confirm" },
          "member",
        )
      ).status,
    ).toBe(403);

    const confirmed = await call("POST", `/v1/achievements/${file.id}/review`, {
      action: "confirm",
      note: "Read the file",
    });
    expect(confirmed.status).toBe(200);
    const body = reviewAchievementResponseSchema.parse(await confirmed.json());
    expect(body.achievement).toMatchObject({
      review_state: "confirmed",
      reviewed_by: people.owner,
      review_note: "Read the file",
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, body.receipt_id));
    expect(receipt).toMatchObject({
      operation: "review_achievement",
      result: { achievement_id: file.id, review_state: "confirmed" },
    });
    expect(
      (
        await call("POST", `/v1/achievements/${pull.id}/review`, {
          action: "reject",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", `/v1/achievements/${pull.id}/review`, {
          action: "reject",
        })
      ).status,
    ).toBe(409);

    expect(
      (await call("POST", `/v1/sessions/${sessionId}/achievement-judgments`))
        .status,
    ).toBe(202);
    await quietPassed();
    await judge().runOnce();

    const after = await listed();
    expect(after.judgment).toMatchObject({
      trigger: "manual",
      status: "succeeded",
    });
    expect(after.judgment_count).toBe(2);
    expect(
      after.items.map((item) => [item.id, item.review_state]).sort(),
    ).toEqual(
      [
        [pull.id, "rejected"],
        [file.id, "confirmed"],
      ].sort(),
    );
  });
});
