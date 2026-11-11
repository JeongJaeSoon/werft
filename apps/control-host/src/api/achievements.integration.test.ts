import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  achievementCategoryChangeResponseSchema,
  achievementRuleChangeResponseSchema,
  achievementTypeChangeResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listAchievementRulesResponseSchema,
  listAchievementTypesResponseSchema,
  WEB_SESSION_COOKIE_NAME,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  achievementRules,
  createPostgresAchievementRuleStore,
  insertBuiltinAchievementTypes,
  memberships,
  receipts,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  createAchievementRuleService,
  createAuthorizationPolicy,
  type IdentityStore,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { generateWebSessionToken, hashWebSessionToken } from "./auth.ts";
import { registerAchievementRoutes } from "./routes/sessions/achievements.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const DEFINITION =
  "Only a merged pull request counts. DEFINITION-MUST-NOT-LEAK-INTO-RECEIPTS";

integration("achievement rule routes on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  const workspaceId = crypto.randomUUID();
  const sessions = new Map<string, ResolvedWebSession>();
  const people: Partial<Record<WorkspaceRole, string>> = {};

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_routes_it" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    await insertBuiltinAchievementTypes(db, workspaceId);
    for (const role of ["owner", "admin", "member"] as const) {
      const id = crypto.randomUUID();
      people[role] = id;
      await db.insert(users).values({
        id,
        email: `${role}@example.invalid`,
        displayName: role,
      });
      await db.insert(memberships).values({ workspaceId, userId: id, role });
    }
    const identity = {
      async resolveWebSession(tokenHash: Uint8Array) {
        return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
      },
      async renewWebSession() {
        return null;
      },
    } as unknown as IdentityStore;
    app = createApiApp({
      authMode: "api-key",
      identity,
      registerRoutes: (router) =>
        registerAchievementRoutes(
          router,
          createAchievementRuleService({
            authorization: createAuthorizationPolicy(),
            store: createPostgresAchievementRuleStore(db),
          }),
        ),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function cookie(role: WorkspaceRole): string {
    const token = generateWebSessionToken();
    sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
      sessionId: crypto.randomUUID(),
      userId: people[role] ?? "",
      email: `${role}@example.invalid`,
      displayName: role,
      locale: null,
      workspaceId,
      role,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return `${WEB_SESSION_COOKIE_NAME}=${token}`;
  }

  function call(
    method: string,
    path: string,
    body?: unknown,
    role: WorkspaceRole = "owner",
  ) {
    return app.request(path, {
      method,
      headers: {
        Cookie: cookie(role),
        ...(method === "GET" ? {} : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function reason(response: Response) {
    const { error } = apiErrorResponseSchema.parse(await response.json());
    return [
      response.status,
      error.code,
      (error.details as { reason_code?: string } | null)?.reason_code,
    ];
  }

  test("categories, types and rules through the API, with receipts that never carry a definition", async () => {
    const types = listAchievementTypesResponseSchema.parse(
      await (
        await call("GET", "/v1/achievement-types", undefined, "member")
      ).json(),
    ).items;
    expect(types.map((type) => type.key).sort()).toEqual([
      "code_review",
      "document",
      "pull_request",
    ]);
    const pullRequest = types.find((type) => type.key === "pull_request");
    if (!pullRequest) throw new Error("no pull_request type");

    expect(
      await reason(
        await call("POST", `/v1/achievement-types/${pullRequest.id}/archive`),
      ),
    ).toEqual([409, "REVISION_CONFLICT", "builtin"]);

    const madeCategory = await call("POST", "/v1/achievement-categories", {
      name: "Delivery",
    });
    expect(madeCategory.status).toBe(201);
    const category = achievementCategoryChangeResponseSchema.parse(
      await madeCategory.json(),
    );

    const madeType = await call("POST", "/v1/achievement-types", {
      key: "design_doc",
      name: "Design doc",
      evidence_kind: "out_file",
    });
    expect(madeType.status).toBe(201);
    const designDoc = achievementTypeChangeResponseSchema.parse(
      await madeType.json(),
    );
    const patched = await call(
      "PATCH",
      `/v1/achievement-types/${designDoc.type.id}`,
      { name: "Design doc", key: "renamed", evidence_kind: "conversation" },
    );
    expect(patched.status).toBe(400);

    const rule = {
      category_id: category.category.id,
      title: "Merged PR",
      type_id: pullRequest.id,
      definition: DEFINITION,
      judge: "luna",
    };
    const v1Response = await call("POST", "/v1/achievement-rules", rule);
    expect(v1Response.status).toBe(201);
    const v1 = achievementRuleChangeResponseSchema.parse(
      await v1Response.json(),
    );
    expect(
      await reason(await call("POST", "/v1/achievement-rules", rule)),
    ).toEqual([409, "REVISION_CONFLICT", "type_in_use"]);
    expect(
      await reason(
        await call(
          "POST",
          `/v1/achievement-categories/${category.category.id}/archive`,
        ),
      ),
    ).toEqual([409, "REVISION_CONFLICT", "category_in_use"]);
    expect(
      await reason(
        await call(
          "POST",
          `/v1/achievement-rules/${v1.rule.family_id}/versions`,
          rule,
          "member",
        ),
      ),
    ).toEqual([403, "FORBIDDEN", "role"]);

    const v2Response = await call(
      "POST",
      `/v1/achievement-rules/${v1.rule.family_id}/versions`,
      { ...rule, title: "Merged PR to main", judge: "always" },
      "admin",
    );
    expect(v2Response.status).toBe(201);
    const v2 = achievementRuleChangeResponseSchema.parse(
      await v2Response.json(),
    );
    expect(v2.rule).toMatchObject({
      family_id: v1.rule.family_id,
      version: 2,
      superseded_by: null,
    });
    const [previous] = await db
      .select({ supersededBy: achievementRules.supersededBy })
      .from(achievementRules)
      .where(eq(achievementRules.id, v1.rule.id));
    expect(previous?.supersededBy).toBe(v2.rule.id);
    expect(
      listAchievementRulesResponseSchema.parse(
        await (await call("GET", "/v1/achievement-rules")).json(),
      ).items,
    ).toEqual([v2.rule]);

    const disabled = await call(
      "POST",
      `/v1/achievement-rules/${v1.rule.family_id}/disable`,
    );
    expect(disabled.status).toBe(200);
    const other = await call("POST", "/v1/achievement-rules", {
      ...rule,
      title: "Any PR",
    });
    expect(other.status).toBe(201);
    expect(
      await reason(
        await call("POST", `/v1/achievement-rules/${v1.rule.family_id}/enable`),
      ),
    ).toEqual([409, "REVISION_CONFLICT", "type_in_use"]);

    const judge = await call(
      "PUT",
      `/v1/workspaces/${workspaceId}/achievement-judge`,
      { every_n_turns: 10 },
    );
    expect(judge.status).toBe(200);
    expect(
      (
        (await (
          await call("GET", `/v1/workspaces/${workspaceId}/achievement-judge`)
        ).json()) as { achievement_judge: { every_n_turns: number } }
      ).achievement_judge.every_n_turns,
    ).toBe(10);

    const written = await db
      .select({ operation: receipts.operation, result: receipts.result })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((receipt) => receipt.operation).sort()).toEqual(
      [
        "create_achievement_category",
        "create_achievement_type",
        "create_achievement_rule",
        "update_achievement_rule",
        "disable_achievement_rule",
        "create_achievement_rule",
        "set_achievement_judge",
      ].sort(),
    );
    expect(JSON.stringify(written)).not.toContain("DEFINITION-MUST-NOT-LEAK");
    expect(
      written.find((receipt) => receipt.operation === "update_achievement_rule")
        ?.result,
    ).toEqual({
      rule_id: v2.rule.id,
      family_id: v1.rule.family_id,
      version: 2,
      previous_rule_id: v1.rule.id,
    });
    const refusedIds = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        inArray(receipts.operation, [
          "archive_achievement_type",
          "archive_achievement_category",
          "enable_achievement_rule",
        ]),
      );
    expect(refusedIds).toEqual([]);
  });
});
