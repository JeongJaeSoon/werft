import {
  achievementCategoryChangeResponseSchema,
  achievementCategoryParamsSchema,
  achievementJudgeChangeResponseSchema,
  achievementJudgeRequestSchema,
  achievementJudgeResponseSchema,
  achievementParamsSchema,
  achievementRuleChangeResponseSchema,
  achievementRuleFamilyParamsSchema,
  achievementRuleRequestSchema,
  achievementTypeChangeResponseSchema,
  achievementTypeParamsSchema,
  createAchievementCategoryRequestSchema,
  createAchievementTypeRequestSchema,
  listAchievementCategoriesResponseSchema,
  listAchievementRulesResponseSchema,
  listAchievementTypesResponseSchema,
  listSessionAchievementsResponseSchema,
  rejudgeSessionResponseSchema,
  reviewAchievementRequestSchema,
  reviewAchievementResponseSchema,
  sessionIdParamsSchema,
  updateAchievementCategoryRequestSchema,
  updateAchievementTypeRequestSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type {
  AchievementRuleService,
  SessionAchievementService,
} from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAchievementRoutes(
  router: ApiRouter,
  achievements: AchievementRuleService,
) {
  apiRoute(router, "listAchievementCategories", async (context) => {
    const listed = await mapped(() =>
      achievements.listCategories(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      listAchievementCategoriesResponseSchema,
      listed,
    );
  });

  apiRoute(router, "createAchievementCategory", async (context) => {
    const body = await parseJsonBody(
      context,
      createAchievementCategoryRequestSchema,
    );
    const created = await mapped(() =>
      achievements.createCategory(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      achievementCategoryChangeResponseSchema,
      created,
      201,
    );
  });

  apiRoute(router, "updateAchievementCategory", async (context) => {
    const params = requireParams(context, achievementCategoryParamsSchema);
    const body = await parseJsonBody(
      context,
      updateAchievementCategoryRequestSchema,
    );
    const updated = await mapped(() =>
      achievements.updateCategory(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(
      context,
      achievementCategoryChangeResponseSchema,
      updated,
    );
  });

  apiRoute(router, "archiveAchievementCategory", async (context) => {
    const params = requireParams(context, achievementCategoryParamsSchema);
    const archived = await mapped(() =>
      achievements.archiveCategory(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      achievementCategoryChangeResponseSchema,
      archived,
    );
  });

  apiRoute(router, "listAchievementTypes", async (context) => {
    const listed = await mapped(() =>
      achievements.listTypes(context.get("caller")),
    );
    return jsonWithSchema(context, listAchievementTypesResponseSchema, listed);
  });

  apiRoute(router, "createAchievementType", async (context) => {
    const body = await parseJsonBody(
      context,
      createAchievementTypeRequestSchema,
    );
    const created = await mapped(() =>
      achievements.createType(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      achievementTypeChangeResponseSchema,
      created,
      201,
    );
  });

  apiRoute(router, "updateAchievementType", async (context) => {
    const params = requireParams(context, achievementTypeParamsSchema);
    const body = await parseJsonBody(
      context,
      updateAchievementTypeRequestSchema,
    );
    const updated = await mapped(() =>
      achievements.updateType(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(
      context,
      achievementTypeChangeResponseSchema,
      updated,
    );
  });

  apiRoute(router, "archiveAchievementType", async (context) => {
    const params = requireParams(context, achievementTypeParamsSchema);
    const archived = await mapped(() =>
      achievements.archiveType(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      achievementTypeChangeResponseSchema,
      archived,
    );
  });

  apiRoute(router, "listAchievementRules", async (context) => {
    const listed = await mapped(() =>
      achievements.listRules(context.get("caller")),
    );
    return jsonWithSchema(context, listAchievementRulesResponseSchema, listed);
  });

  apiRoute(router, "createAchievementRule", async (context) => {
    const body = await parseJsonBody(context, achievementRuleRequestSchema);
    const created = await mapped(() =>
      achievements.createRule(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      achievementRuleChangeResponseSchema,
      created,
      201,
    );
  });

  apiRoute(router, "createAchievementRuleVersion", async (context) => {
    const params = requireParams(context, achievementRuleFamilyParamsSchema);
    const body = await parseJsonBody(context, achievementRuleRequestSchema);
    const created = await mapped(() =>
      achievements.createRuleVersion(
        context.get("caller"),
        params.family_id,
        body,
      ),
    );
    return jsonWithSchema(
      context,
      achievementRuleChangeResponseSchema,
      created,
      201,
    );
  });

  for (const [operationId, disabled] of [
    ["disableAchievementRule", true],
    ["enableAchievementRule", false],
  ] as const) {
    apiRoute(router, operationId, async (context) => {
      const params = requireParams(context, achievementRuleFamilyParamsSchema);
      const changed = await mapped(() =>
        achievements.setRuleDisabled(
          context.get("caller"),
          params.family_id,
          disabled,
        ),
      );
      return jsonWithSchema(
        context,
        achievementRuleChangeResponseSchema,
        changed,
      );
    });
  }

  apiRoute(router, "getAchievementJudge", async (context) => {
    const params = requireParams(context, workspaceParamsSchema);
    const judge = await mapped(() =>
      achievements.getJudge(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, achievementJudgeResponseSchema, judge);
  });

  apiRoute(router, "putAchievementJudge", async (context) => {
    const params = requireParams(context, workspaceParamsSchema);
    const body = await parseJsonBody(context, achievementJudgeRequestSchema);
    const saved = await mapped(() =>
      achievements.setJudge(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, achievementJudgeChangeResponseSchema, saved);
  });
}

export function registerSessionAchievementRoutes(
  router: ApiRouter,
  service: SessionAchievementService,
) {
  apiRoute(router, "listSessionAchievements", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      listSessionAchievementsResponseSchema,
      listed,
    );
  });
  apiRoute(router, "rejudgeSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const queued = await mapped(() =>
      service.rejudge(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, rejudgeSessionResponseSchema, queued, 202);
  });
  apiRoute(router, "reviewAchievement", async (context) => {
    const params = requireParams(context, achievementParamsSchema);
    const body = await parseJsonBody(context, reviewAchievementRequestSchema);
    const reviewed = await mapped(() =>
      service.review(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, reviewAchievementResponseSchema, reviewed);
  });
}
