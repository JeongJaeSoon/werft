import {
  ACHIEVEMENT_RULE_LIMIT,
  ACHIEVEMENT_TYPE_LIMIT,
  type AchievementCategory,
  type AchievementEvidenceKind,
  type AchievementRule,
  type AchievementRuleJudge,
  type AchievementRuleRequest,
  type AchievementType,
  BUILTIN_ACHIEVEMENT_TYPES,
  type ReceiptOperation,
  workspaceSettingsSchema,
} from "@werft-ai/contracts";
import type { AchievementRuleStore, TeamActor } from "@werft-ai/platform";
import { and, asc, count, desc, eq, isNull, max, ne, sql } from "drizzle-orm";
import { findPgError, lockPeople, receiptActorOf } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import {
  achievementCategories,
  achievementRules,
  achievementTypes,
  receipts,
  workspaces,
} from "../schema.ts";

const RULE_MANAGERS = ["owner", "admin"];

const iso = (at: Date | null) => at?.toISOString() ?? null;

function categoryOf(
  row: typeof achievementCategories.$inferSelect,
): AchievementCategory {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    archived_at: iso(row.archivedAt),
    archived_by: row.archivedBy,
  };
}

function typeOf(row: typeof achievementTypes.$inferSelect): AchievementType {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    evidence_kind: row.evidenceKind as AchievementEvidenceKind,
    builtin: row.builtin,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    archived_at: iso(row.archivedAt),
    archived_by: row.archivedBy,
  };
}

function ruleOf(row: typeof achievementRules.$inferSelect): AchievementRule {
  return {
    id: row.id,
    family_id: row.familyId,
    version: row.version,
    category_id: row.categoryId,
    title: row.title,
    type_id: row.typeId,
    definition: row.definition,
    judge: row.judge as AchievementRuleJudge,
    agent_ids: row.agentIds,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    superseded_by: row.supersededBy,
    disabled_at: iso(row.disabledAt),
    disabled_by: row.disabledBy,
  };
}

/** The types every workspace starts with; the migration gave older ones the same. */
export async function insertBuiltinAchievementTypes(
  tx: Database,
  workspaceId: string,
): Promise<void> {
  await tx
    .insert(achievementTypes)
    .values(
      BUILTIN_ACHIEVEMENT_TYPES.map((builtin) => ({
        id: crypto.randomUUID(),
        workspaceId,
        key: builtin.key,
        name: builtin.name,
        evidenceKind: builtin.evidence_kind,
        builtin: true,
      })),
    )
    .onConflictDoNothing();
}

// The actor's role is read again under a share lock, and the workspace row
// is held so that limit and in-use checks see every other write settled.
export async function managing(
  tx: Database,
  actor: TeamActor,
): Promise<boolean> {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  if (me?.live !== true || !RULE_MANAGERS.includes(me.role)) return false;
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, actor.workspaceId))
    .for("no key update");
  return workspace !== undefined;
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  id: string,
  operation: Extract<
    ReceiptOperation,
    `${string}_achievement_${string}` | "set_achievement_judge"
  >,
  result: Record<string, unknown>,
) {
  await tx.insert(receipts).values({
    id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: actor.workspaceId },
      workspace_id: actor.workspaceId,
    },
    result,
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
}

const ruleReceipt = (rule: AchievementRule) => ({
  rule_id: rule.id,
  family_id: rule.family_id,
  version: rule.version,
});

function violated(error: unknown, constraint: string): boolean {
  return findPgError(error, "23505")?.constraint === constraint;
}

const inUse = and(
  isNull(achievementRules.supersededBy),
  isNull(achievementRules.disabledAt),
);

async function liveCategory(tx: Database, workspaceId: string, id: string) {
  const [row] = await tx
    .select({ id: achievementCategories.id })
    .from(achievementCategories)
    .where(
      and(
        eq(achievementCategories.id, id),
        eq(achievementCategories.workspaceId, workspaceId),
        isNull(achievementCategories.archivedAt),
      ),
    );
  return row !== undefined;
}

async function liveType(tx: Database, workspaceId: string, id: string) {
  const [row] = await tx
    .select({ id: achievementTypes.id })
    .from(achievementTypes)
    .where(
      and(
        eq(achievementTypes.id, id),
        eq(achievementTypes.workspaceId, workspaceId),
        isNull(achievementTypes.archivedAt),
      ),
    );
  return row !== undefined;
}

/** Whether a rule in use, other than `exceptFamily`, counts this type. */
async function typeTaken(
  tx: Database,
  typeId: string,
  exceptFamily: string | null,
) {
  const [row] = await tx
    .select({ id: achievementRules.id })
    .from(achievementRules)
    .where(
      and(
        eq(achievementRules.typeId, typeId),
        inUse,
        exceptFamily === null
          ? undefined
          : ne(achievementRules.familyId, exceptFamily),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function rulesInUse(tx: Database, workspaceId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(achievementRules)
    .where(and(eq(achievementRules.workspaceId, workspaceId), inUse));
  return row?.n ?? 0;
}

async function references(
  tx: Database,
  workspaceId: string,
  rule: Pick<AchievementRuleRequest, "category_id" | "type_id">,
) {
  if (!(await liveCategory(tx, workspaceId, rule.category_id))) {
    return "unknown_category" as const;
  }
  if (!(await liveType(tx, workspaceId, rule.type_id))) {
    return "unknown_type" as const;
  }
  return null;
}

// Every version of the family, locked; the latest is the one not superseded.
async function lockFamily(tx: Database, workspaceId: string, familyId: string) {
  const rows = await tx
    .select()
    .from(achievementRules)
    .where(
      and(
        eq(achievementRules.familyId, familyId),
        eq(achievementRules.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(achievementRules.version))
    .for("update");
  return rows.find((row) => row.supersededBy === null);
}

export function createPostgresAchievementRuleStore(
  db: Database,
): AchievementRuleStore {
  return {
    async listCategories(workspaceId) {
      const rows = await db
        .select()
        .from(achievementCategories)
        .where(eq(achievementCategories.workspaceId, workspaceId))
        .orderBy(
          asc(achievementCategories.position),
          asc(achievementCategories.createdAt),
          asc(achievementCategories.id),
        );
      return rows.map(categoryOf);
    },

    async listTypes(workspaceId) {
      const rows = await db
        .select()
        .from(achievementTypes)
        .where(eq(achievementTypes.workspaceId, workspaceId))
        .orderBy(
          desc(achievementTypes.builtin),
          asc(achievementTypes.createdAt),
          asc(achievementTypes.key),
        );
      return rows.map(typeOf);
    },

    async listRules(workspaceId) {
      const rows = await db
        .select({ rule: achievementRules })
        .from(achievementRules)
        .innerJoin(
          achievementCategories,
          eq(achievementCategories.id, achievementRules.categoryId),
        )
        .where(
          and(
            eq(achievementRules.workspaceId, workspaceId),
            isNull(achievementRules.supersededBy),
          ),
        )
        .orderBy(
          asc(achievementCategories.position),
          asc(achievementCategories.createdAt),
          asc(achievementCategories.id),
          asc(achievementRules.title),
          asc(achievementRules.familyId),
        );
      return rows.map(({ rule }) => ruleOf(rule));
    },

    async createCategory({ actor, receiptId, name }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [last] = await tx
            .select({ position: max(achievementCategories.position) })
            .from(achievementCategories)
            .where(eq(achievementCategories.workspaceId, actor.workspaceId));
          const [row] = await tx
            .insert(achievementCategories)
            .values({
              id: crypto.randomUUID(),
              workspaceId: actor.workspaceId,
              name,
              position:
                last?.position === null || !last ? 0 : last.position + 1,
              createdBy: actor.userId,
            })
            .returning();
          if (!row)
            throw new Error("achievement category insert returned no row");
          const category = categoryOf(row);
          await writeReceipt(
            tx,
            actor,
            receiptId,
            "create_achievement_category",
            {
              category_id: category.id,
            },
          );
          return { outcome: "created" as const, category };
        });
      } catch (error) {
        if (violated(error, "achievement_categories_live_name_uniq")) {
          return { outcome: "name_taken" };
        }
        throw error;
      }
    },

    async updateCategory({ actor, receiptId, categoryId, name, position }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [row] = await tx
            .select()
            .from(achievementCategories)
            .where(
              and(
                eq(achievementCategories.id, categoryId),
                eq(achievementCategories.workspaceId, actor.workspaceId),
              ),
            )
            .for("update");
          if (!row) return { outcome: "not_found" as const };
          const next = {
            name: name ?? row.name,
            position: position ?? row.position,
          };
          if (next.name === row.name && next.position === row.position) {
            return { outcome: "unchanged" as const, category: categoryOf(row) };
          }
          const [updated] = await tx
            .update(achievementCategories)
            .set(next)
            .where(eq(achievementCategories.id, row.id))
            .returning();
          if (!updated)
            throw new Error("achievement category update returned no row");
          const category = categoryOf(updated);
          await writeReceipt(
            tx,
            actor,
            receiptId,
            "update_achievement_category",
            {
              category_id: category.id,
            },
          );
          return { outcome: "updated" as const, category };
        });
      } catch (error) {
        if (violated(error, "achievement_categories_live_name_uniq")) {
          return { outcome: "name_taken" };
        }
        throw error;
      }
    },

    async archiveCategory({ actor, receiptId, categoryId }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(achievementCategories)
          .where(
            and(
              eq(achievementCategories.id, categoryId),
              eq(achievementCategories.workspaceId, actor.workspaceId),
            ),
          )
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.archivedAt !== null) {
          return { outcome: "unchanged" as const, category: categoryOf(row) };
        }
        const [remaining] = await tx
          .select({ id: achievementRules.id })
          .from(achievementRules)
          .where(and(eq(achievementRules.categoryId, row.id), inUse))
          .limit(1);
        if (remaining) return { outcome: "category_in_use" as const };
        const [archived] = await tx
          .update(achievementCategories)
          .set({ archivedAt: sql`now()`, archivedBy: actor.userId })
          .where(eq(achievementCategories.id, row.id))
          .returning();
        if (!archived)
          throw new Error("achievement category update returned no row");
        const category = categoryOf(archived);
        await writeReceipt(
          tx,
          actor,
          receiptId,
          "archive_achievement_category",
          {
            category_id: category.id,
          },
        );
        return { outcome: "archived" as const, category };
      });
    },

    async createType({ actor, receiptId, key, name, evidenceKind }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [live] = await tx
            .select({ n: count() })
            .from(achievementTypes)
            .where(
              and(
                eq(achievementTypes.workspaceId, actor.workspaceId),
                isNull(achievementTypes.archivedAt),
              ),
            );
          if ((live?.n ?? 0) >= ACHIEVEMENT_TYPE_LIMIT) {
            return { outcome: "limit_reached" as const };
          }
          const [row] = await tx
            .insert(achievementTypes)
            .values({
              id: crypto.randomUUID(),
              workspaceId: actor.workspaceId,
              key,
              name,
              evidenceKind,
              builtin: false,
              createdBy: actor.userId,
            })
            .returning();
          if (!row) throw new Error("achievement type insert returned no row");
          const type = typeOf(row);
          await writeReceipt(tx, actor, receiptId, "create_achievement_type", {
            type_id: type.id,
          });
          return { outcome: "created" as const, type };
        });
      } catch (error) {
        if (violated(error, "achievement_types_key_uniq")) {
          return { outcome: "key_taken" };
        }
        throw error;
      }
    },

    async updateType({ actor, receiptId, typeId, name }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(achievementTypes)
          .where(
            and(
              eq(achievementTypes.id, typeId),
              eq(achievementTypes.workspaceId, actor.workspaceId),
            ),
          )
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.name === name) {
          return { outcome: "unchanged" as const, type: typeOf(row) };
        }
        const [updated] = await tx
          .update(achievementTypes)
          .set({ name })
          .where(eq(achievementTypes.id, row.id))
          .returning();
        if (!updated)
          throw new Error("achievement type update returned no row");
        const type = typeOf(updated);
        await writeReceipt(tx, actor, receiptId, "update_achievement_type", {
          type_id: type.id,
        });
        return { outcome: "updated" as const, type };
      });
    },

    async archiveType({ actor, receiptId, typeId }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(achievementTypes)
          .where(
            and(
              eq(achievementTypes.id, typeId),
              eq(achievementTypes.workspaceId, actor.workspaceId),
            ),
          )
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.builtin) return { outcome: "builtin" as const };
        if (row.archivedAt !== null) {
          return { outcome: "unchanged" as const, type: typeOf(row) };
        }
        if (await typeTaken(tx, row.id, null)) {
          return { outcome: "type_in_use" as const };
        }
        const [archived] = await tx
          .update(achievementTypes)
          .set({ archivedAt: sql`now()`, archivedBy: actor.userId })
          .where(eq(achievementTypes.id, row.id))
          .returning();
        if (!archived)
          throw new Error("achievement type update returned no row");
        const type = typeOf(archived);
        await writeReceipt(tx, actor, receiptId, "archive_achievement_type", {
          type_id: type.id,
        });
        return { outcome: "archived" as const, type };
      });
    },

    async createRule({ actor, receiptId, rule }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const unknown = await references(tx, actor.workspaceId, rule);
          if (unknown) return { outcome: unknown };
          if (await typeTaken(tx, rule.type_id, null)) {
            return { outcome: "type_in_use" as const };
          }
          if (
            (await rulesInUse(tx, actor.workspaceId)) >= ACHIEVEMENT_RULE_LIMIT
          ) {
            return { outcome: "limit_reached" as const };
          }
          const [row] = await tx
            .insert(achievementRules)
            .values({
              id: crypto.randomUUID(),
              workspaceId: actor.workspaceId,
              familyId: crypto.randomUUID(),
              version: 1,
              categoryId: rule.category_id,
              title: rule.title,
              typeId: rule.type_id,
              definition: rule.definition,
              judge: rule.judge,
              agentIds: rule.agent_ids,
              createdBy: actor.userId,
            })
            .returning();
          if (!row) throw new Error("achievement rule insert returned no row");
          const created = ruleOf(row);
          await writeReceipt(
            tx,
            actor,
            receiptId,
            "create_achievement_rule",
            ruleReceipt(created),
          );
          return { outcome: "created" as const, rule: created };
        });
      } catch (error) {
        if (violated(error, "achievement_rules_type_in_use_uniq")) {
          return { outcome: "type_in_use" };
        }
        throw error;
      }
    },

    async createRuleVersion({ actor, receiptId, familyId, rule }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const latest = await lockFamily(tx, actor.workspaceId, familyId);
          if (!latest) return { outcome: "not_found" as const };
          const unknown = await references(tx, actor.workspaceId, rule);
          if (unknown) return { outcome: unknown };
          if (
            latest.disabledAt === null &&
            (await typeTaken(tx, rule.type_id, familyId))
          ) {
            return { outcome: "type_in_use" as const };
          }
          const id = crypto.randomUUID();
          // Out of the type-in-use index before the next version enters it;
          // a disable stays only on the latest version.
          await tx
            .update(achievementRules)
            .set({ supersededBy: id, disabledAt: null, disabledBy: null })
            .where(eq(achievementRules.id, latest.id));
          const [row] = await tx
            .insert(achievementRules)
            .values({
              id,
              workspaceId: actor.workspaceId,
              familyId,
              version: latest.version + 1,
              categoryId: rule.category_id,
              title: rule.title,
              typeId: rule.type_id,
              definition: rule.definition,
              judge: rule.judge,
              agentIds: rule.agent_ids,
              createdBy: actor.userId,
              disabledAt: latest.disabledAt,
              disabledBy: latest.disabledBy,
            })
            .returning();
          if (!row) throw new Error("achievement rule insert returned no row");
          const created = ruleOf(row);
          await writeReceipt(tx, actor, receiptId, "update_achievement_rule", {
            ...ruleReceipt(created),
            previous_rule_id: latest.id,
          });
          return { outcome: "created" as const, rule: created };
        });
      } catch (error) {
        if (violated(error, "achievement_rules_type_in_use_uniq")) {
          return { outcome: "type_in_use" };
        }
        throw error;
      }
    },

    async setRuleDisabled({ actor, receiptId, familyId, disabled }) {
      try {
        return await db.transaction(async (tx) => {
          if (!(await managing(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const latest = await lockFamily(tx, actor.workspaceId, familyId);
          if (!latest) return { outcome: "not_found" as const };
          if ((latest.disabledAt !== null) === disabled) {
            return { outcome: "unchanged" as const, rule: ruleOf(latest) };
          }
          if (!disabled) {
            const unknown = await references(tx, actor.workspaceId, {
              category_id: latest.categoryId,
              type_id: latest.typeId,
            });
            if (unknown) return { outcome: unknown };
            if (await typeTaken(tx, latest.typeId, familyId)) {
              return { outcome: "type_in_use" as const };
            }
            if (
              (await rulesInUse(tx, actor.workspaceId)) >=
              ACHIEVEMENT_RULE_LIMIT
            ) {
              return { outcome: "limit_reached" as const };
            }
          }
          const [updated] = await tx
            .update(achievementRules)
            .set(
              disabled
                ? { disabledAt: sql`now()`, disabledBy: actor.userId }
                : { disabledAt: null, disabledBy: null },
            )
            .where(eq(achievementRules.id, latest.id))
            .returning();
          if (!updated)
            throw new Error("achievement rule update returned no row");
          const changed = ruleOf(updated);
          await writeReceipt(
            tx,
            actor,
            receiptId,
            disabled ? "disable_achievement_rule" : "enable_achievement_rule",
            ruleReceipt(changed),
          );
          return { outcome: "changed" as const, rule: changed };
        });
      } catch (error) {
        if (violated(error, "achievement_rules_type_in_use_uniq")) {
          return { outcome: "type_in_use" };
        }
        throw error;
      }
    },

    async getJudge(workspaceId) {
      const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!row) return null;
      return workspaceSettingsSchema.shape.achievement_judge.parse(
        (row.settings as { achievement_judge?: unknown }).achievement_judge,
      );
    },

    async setJudge({ actor, receiptId, settings }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{achievement_judge}', ${JSON.stringify(settings)}::jsonb)`,
          })
          .where(eq(workspaces.id, actor.workspaceId));
        await writeReceipt(tx, actor, receiptId, "set_achievement_judge", {
          achievement_judge: settings,
        });
        return { outcome: "set" as const, settings };
      });
    },
  };
}
