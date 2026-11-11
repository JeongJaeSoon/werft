import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACHIEVEMENT_RULE_LIMIT,
  ACHIEVEMENT_TYPE_LIMIT,
  type AchievementRuleRequest,
  achievementJudgeSettingsSchema,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "../control-shared.ts";
import { bootstrapOwner } from "../musterrolle/identity.ts";
import * as schema from "../schema.ts";
import {
  achievementRules,
  achievementTypes,
  memberships,
  receipts,
  users,
  workspaces,
} from "../schema.ts";
import {
  createPostgresAchievementRuleStore,
  insertBuiltinAchievementTypes,
} from "./achievement-rules.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dir, "../../migrations");

const DEFINITION = "Only a merged pull request counts. SECRET-DEFINITION-TEXT";

integration("achievement rules on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_rules_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresAchievementRuleStore(db);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `acme-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await insertBuiltinAchievementTypes(db, workspaceId);
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    const caller = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
    return acting(caller);
  }

  function acting(caller: Caller): TeamActor {
    return {
      principal: caller,
      workspaceId: caller.ownerId,
      userId: caller.actor?.userId ?? "",
    };
  }

  const write = (actor: TeamActor) => ({ actor, receiptId: randomUUID() });

  async function category(actor: TeamActor, name = "Delivery") {
    const result = await store().createCategory({ ...write(actor), name });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.category;
  }

  async function type(
    actor: TeamActor,
    key = `report_${randomUUID().slice(0, 6)}`,
  ) {
    const result = await store().createType({
      ...write(actor),
      key,
      name: "Report",
      evidenceKind: "out_file",
    });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.type;
  }

  function ruleOf(
    categoryId: string,
    typeId: string,
    extra: Partial<AchievementRuleRequest> = {},
  ): AchievementRuleRequest {
    return {
      category_id: categoryId,
      title: "Merged PR",
      type_id: typeId,
      definition: DEFINITION,
      judge: "luna",
      agent_ids: null,
      ...extra,
    };
  }

  async function rule(actor: TeamActor, request: AchievementRuleRequest) {
    const result = await store().createRule({ ...write(actor), rule: request });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.rule;
  }

  async function receiptsFor(ids: string[]) {
    return db
      .select({
        id: receipts.id,
        operation: receipts.operation,
        result: receipts.result,
      })
      .from(receipts)
      .where(inArray(receipts.id, ids));
  }

  test("a new workspace has the three built-in types, which cannot be archived", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const types = await store().listTypes(workspaceId);
    expect(
      types.map(({ key, name, evidence_kind, builtin, created_by }) => ({
        key,
        name,
        evidence_kind,
        builtin,
        created_by,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          key: "pull_request",
          name: "GitHub PR",
          evidence_kind: "github_pull_request",
          builtin: true,
          created_by: null,
        },
        {
          key: "code_review",
          name: "코드 리뷰",
          evidence_kind: "github_review",
          builtin: true,
          created_by: null,
        },
        {
          key: "document",
          name: "문서",
          evidence_kind: "out_file",
          builtin: true,
          created_by: null,
        },
      ]),
    );
    expect(types).toHaveLength(3);
    const pr = types.find((t) => t.key === "pull_request");
    if (!pr) throw new Error("no pull_request type");
    expect(
      (await store().archiveType({ ...write(owner), typeId: pr.id })).outcome,
    ).toBe("builtin");
  });

  test("an edit is the next version and supersedes the one before, receipts naming ids and versions only", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const report = await type(owner);
    const createReceipt = randomUUID();
    const created = await store().createRule({
      actor: owner,
      receiptId: createReceipt,
      rule: ruleOf(delivery.id, report.id),
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    expect(created.rule).toMatchObject({
      version: 1,
      superseded_by: null,
      agent_ids: null,
    });
    const editReceipt = randomUUID();
    const edited = await store().createRuleVersion({
      actor: owner,
      receiptId: editReceipt,
      familyId: created.rule.family_id,
      rule: ruleOf(delivery.id, report.id, { title: "Merged PR (main)" }),
    });
    if (edited.outcome !== "created") throw new Error(edited.outcome);
    expect(edited.rule).toMatchObject({
      family_id: created.rule.family_id,
      version: 2,
      title: "Merged PR (main)",
      superseded_by: null,
    });
    const [first] = await db
      .select()
      .from(achievementRules)
      .where(eq(achievementRules.id, created.rule.id));
    expect(first?.supersededBy).toBe(edited.rule.id);
    expect(first?.title).toBe("Merged PR");
    expect(await store().listRules(workspaceId)).toEqual([edited.rule]);

    const written = await receiptsFor([createReceipt, editReceipt]);
    expect(written).toHaveLength(2);
    expect(JSON.stringify(written)).not.toContain("SECRET-DEFINITION-TEXT");
    expect(written).toEqual(
      expect.arrayContaining([
        {
          id: createReceipt,
          operation: "create_achievement_rule",
          result: {
            rule_id: created.rule.id,
            family_id: created.rule.family_id,
            version: 1,
          },
        },
        {
          id: editReceipt,
          operation: "update_achievement_rule",
          result: {
            rule_id: edited.rule.id,
            family_id: created.rule.family_id,
            version: 2,
            previous_rule_id: created.rule.id,
          },
        },
      ]),
    );
  });

  test("one rule in use per type: create, edit and enable answer type_in_use", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const report = await type(owner);
    const other = await type(owner);
    const first = await rule(owner, ruleOf(delivery.id, report.id));
    expect(
      (
        await store().createRule({
          ...write(owner),
          rule: ruleOf(delivery.id, report.id),
        })
      ).outcome,
    ).toBe("type_in_use");

    const second = await rule(owner, ruleOf(delivery.id, other.id));
    expect(
      (
        await store().createRuleVersion({
          ...write(owner),
          familyId: second.family_id,
          rule: ruleOf(delivery.id, report.id),
        })
      ).outcome,
    ).toBe("type_in_use");

    // Disabled, the first frees its type; the second may take it, and the
    // first cannot come back while it does.
    const disabled = await store().setRuleDisabled({
      ...write(owner),
      familyId: first.family_id,
      disabled: true,
    });
    expect(disabled.outcome).toBe("changed");
    const moved = await store().createRuleVersion({
      ...write(owner),
      familyId: second.family_id,
      rule: ruleOf(delivery.id, report.id),
    });
    expect(moved.outcome).toBe("created");
    expect(
      (
        await store().setRuleDisabled({
          ...write(owner),
          familyId: first.family_id,
          disabled: false,
        })
      ).outcome,
    ).toBe("type_in_use");
  });

  test("the database refuses a second rule in use for one type", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const report = await type(owner);
    const existing = await rule(owner, ruleOf(delivery.id, report.id));
    const insert = (disabledAt: Date | null) =>
      db.insert(achievementRules).values({
        id: randomUUID(),
        workspaceId,
        familyId: randomUUID(),
        version: 1,
        categoryId: delivery.id,
        title: "Twin",
        typeId: report.id,
        definition: "twin",
        judge: "always",
        createdBy: owner.userId,
        disabledAt,
        disabledBy: disabledAt ? owner.userId : null,
      });
    const error = await insert(null).catch((caught: unknown) => caught);
    expect(findPgError(error, "23505")?.constraint).toBe(
      "achievement_rules_type_in_use_uniq",
    );
    await insert(new Date());
    const twin = await db
      .insert(achievementRules)
      .values({
        id: randomUUID(),
        workspaceId,
        familyId: existing.family_id,
        version: 1,
        categoryId: delivery.id,
        title: "Same version",
        typeId: (await type(owner)).id,
        definition: "same",
        judge: "always",
        createdBy: owner.userId,
      })
      .catch((caught: unknown) => caught);
    expect(findPgError(twin, "23505")?.constraint).toBe(
      "achievement_rules_family_version_uniq",
    );
  });

  test("disable and enable act on the latest version; a disabled family stays disabled when edited, its disable moving to the new version", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const report = await type(owner);
    const first = await rule(owner, ruleOf(delivery.id, report.id));
    const off = await store().setRuleDisabled({
      ...write(owner),
      familyId: first.family_id,
      disabled: true,
    });
    if (off.outcome !== "changed") throw new Error(off.outcome);
    expect(off.rule.disabled_by).toBe(owner.userId);
    expect(
      (
        await store().setRuleDisabled({
          ...write(owner),
          familyId: first.family_id,
          disabled: true,
        })
      ).outcome,
    ).toBe("unchanged");
    const edited = await store().createRuleVersion({
      ...write(owner),
      familyId: first.family_id,
      rule: ruleOf(delivery.id, report.id, { judge: "always" }),
    });
    if (edited.outcome !== "created") throw new Error(edited.outcome);
    expect(edited.rule.disabled_at).not.toBeNull();
    const [before] = await db
      .select()
      .from(schema.achievementRules)
      .where(eq(schema.achievementRules.id, first.id));
    expect(before).toMatchObject({
      supersededBy: edited.rule.id,
      disabledAt: null,
      disabledBy: null,
    });
    const on = await store().setRuleDisabled({
      ...write(owner),
      familyId: first.family_id,
      disabled: false,
    });
    if (on.outcome !== "changed") throw new Error(on.outcome);
    expect(on.rule).toMatchObject({
      id: edited.rule.id,
      version: 2,
      disabled_at: null,
      disabled_by: null,
    });
  });

  test("a category or type with a rule in use is not archived; without one it is", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const report = await type(owner);
    const used = await rule(owner, ruleOf(delivery.id, report.id));
    expect(
      (
        await store().archiveCategory({
          ...write(owner),
          categoryId: delivery.id,
        })
      ).outcome,
    ).toBe("category_in_use");
    expect(
      (await store().archiveType({ ...write(owner), typeId: report.id }))
        .outcome,
    ).toBe("type_in_use");
    await store().setRuleDisabled({
      ...write(owner),
      familyId: used.family_id,
      disabled: true,
    });
    const archivedType = await store().archiveType({
      ...write(owner),
      typeId: report.id,
    });
    expect(archivedType.outcome).toBe("archived");
    const archivedCategory = await store().archiveCategory({
      ...write(owner),
      categoryId: delivery.id,
    });
    expect(archivedCategory.outcome).toBe("archived");
    // Neither comes back through its rule.
    expect(
      (
        await store().setRuleDisabled({
          ...write(owner),
          familyId: used.family_id,
          disabled: false,
        })
      ).outcome,
    ).toBe("unknown_category");
    expect(
      (
        await store().createRule({
          ...write(owner),
          rule: ruleOf((await category(owner, "Other")).id, report.id),
        })
      ).outcome,
    ).toBe("unknown_type");
  });

  test("a type keeps its key and evidence kind; a key is unique in the workspace", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const report = await type(owner, "report");
    const renamed = await store().updateType({
      ...write(owner),
      typeId: report.id,
      name: "Design doc",
    });
    if (renamed.outcome !== "updated") throw new Error(renamed.outcome);
    expect(renamed.type).toMatchObject({
      key: "report",
      name: "Design doc",
      evidence_kind: "out_file",
    });
    expect(
      (
        await store().createType({
          ...write(owner),
          key: "report",
          name: "Again",
          evidenceKind: "conversation",
        })
      ).outcome,
    ).toBe("key_taken");
  });

  test("category names are unique among the unarchived, and new ones go last", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await category(owner, "Delivery");
    const second = await category(owner, "Review");
    expect([first.position, second.position]).toEqual([0, 1]);
    expect(
      (await store().createCategory({ ...write(owner), name: "Delivery" }))
        .outcome,
    ).toBe("name_taken");
    const moved = await store().updateCategory({
      ...write(owner),
      categoryId: second.id,
      position: 0,
      name: "Reviews",
    });
    if (moved.outcome !== "updated") throw new Error(moved.outcome);
    expect(moved.category).toMatchObject({ name: "Reviews", position: 0 });
    await store().archiveCategory({ ...write(owner), categoryId: first.id });
    expect((await category(owner, "Delivery")).name).toBe("Delivery");
  });

  test(`at most ${ACHIEVEMENT_TYPE_LIMIT} unarchived types and ${ACHIEVEMENT_RULE_LIMIT} rules in use`, async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const delivery = await category(owner);
    const made = [];
    for (let i = 3; i < ACHIEVEMENT_TYPE_LIMIT; i++) {
      made.push(await type(owner, `type_${i}`));
    }
    expect(
      (
        await store().createType({
          ...write(owner),
          key: "one_too_many",
          name: "Too many",
          evidenceKind: "out_file",
        })
      ).outcome,
    ).toBe("limit_reached");
    for (const t of made.slice(0, ACHIEVEMENT_RULE_LIMIT)) {
      await rule(owner, ruleOf(delivery.id, t.id));
    }
    const spare = made[ACHIEVEMENT_RULE_LIMIT];
    if (!spare) throw new Error("no spare type");
    expect(
      (
        await store().createRule({
          ...write(owner),
          rule: ruleOf(delivery.id, spare.id),
        })
      ).outcome,
    ).toBe("limit_reached");
  });

  test("a member writes nothing", async () => {
    const workspaceId = await workspace();
    const member = await person(workspaceId, "member");
    expect(
      (await store().createCategory({ ...write(member), name: "Delivery" }))
        .outcome,
    ).toBe("actor_inactive");
    expect(await store().listCategories(workspaceId)).toEqual([]);
  });

  test("the judge settings read their defaults and save with a receipt", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    expect(await store().getJudge(workspaceId)).toEqual(
      achievementJudgeSettingsSchema.parse({}),
    );
    const settings = achievementJudgeSettingsSchema.parse({
      every_n_turns: 10,
      transcript: "none",
    });
    const receiptId = randomUUID();
    expect(
      await store().setJudge({ actor: owner, receiptId, settings }),
    ).toEqual({ outcome: "set", settings });
    expect(await store().getJudge(workspaceId)).toEqual(settings);
    const [row] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row?.settings).toEqual({ achievement_judge: settings });
    expect(await receiptsFor([receiptId])).toEqual([
      {
        id: receiptId,
        operation: "set_achievement_judge",
        result: { achievement_judge: settings },
      },
    ]);
    expect(await store().getJudge(randomUUID())).toBeNull();
  });
});

integration("built-in achievement types at bootstrap", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_boot_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("the workspace bootstrap creates gets the built-in types", async () => {
    const workspaceId = randomUUID();
    await bootstrapOwner(db, {
      userId: randomUUID(),
      email: "first@example.invalid",
      passwordHash: "argon2id$placeholder",
      displayName: "First",
      workspaceId,
      workspaceSlug: "first",
      workspaceName: "First",
      bootstrapTokenHash: new Uint8Array([1, 2, 3]),
      receiptId: randomUUID(),
      loginMethodId: randomUUID(),
    });
    const rows = await db
      .select({ key: achievementTypes.key })
      .from(achievementTypes)
      .where(
        and(
          eq(achievementTypes.workspaceId, workspaceId),
          eq(achievementTypes.builtin, true),
        ),
      );
    expect(rows.map((row) => row.key).sort()).toEqual([
      "code_review",
      "document",
      "pull_request",
    ]);
  });
});

integration("built-in achievement types by the migration", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_backfill_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("the migration gives a workspace made before it the built-in types", async () => {
    const files = (await readdir(MIGRATIONS)).filter((name) =>
      name.endsWith("_achievement_rules.sql"),
    );
    expect(files).toHaveLength(1);
    const backfill = (await readFile(join(MIGRATIONS, files[0] ?? ""), "utf8"))
      .split("--> statement-breakpoint")
      .filter((statement) => statement.includes("INSERT INTO"));
    expect(backfill).toHaveLength(1);
    const older = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: older, slug: "older", name: "Older" });
    await db.execute(sql.raw(backfill[0] ?? ""));
    const rows = await db
      .select({
        key: achievementTypes.key,
        name: achievementTypes.name,
        evidenceKind: achievementTypes.evidenceKind,
        builtin: achievementTypes.builtin,
        createdBy: achievementTypes.createdBy,
      })
      .from(achievementTypes)
      .where(eq(achievementTypes.workspaceId, older))
      .orderBy(achievementTypes.key);
    expect(rows).toEqual([
      {
        key: "code_review",
        name: "코드 리뷰",
        evidenceKind: "github_review",
        builtin: true,
        createdBy: null,
      },
      {
        key: "document",
        name: "문서",
        evidenceKind: "out_file",
        builtin: true,
        createdBy: null,
      },
      {
        key: "pull_request",
        name: "GitHub PR",
        evidenceKind: "github_pull_request",
        builtin: true,
        createdBy: null,
      },
    ]);
  });
});
