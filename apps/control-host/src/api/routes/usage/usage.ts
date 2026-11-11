import {
  type LimitsResponse,
  limitsQuerySchema,
  limitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
  usageAchievementsQuerySchema,
  usageAchievementsResponseSchema,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageOutcomesQuerySchema,
  usageOutcomesResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  usageToolCallsParamsSchema,
  usageToolCallsQuerySchema,
  usageToolCallsResponseSchema,
  usageToolsQuerySchema,
  usageToolsResponseSchema,
} from "@werft-ai/contracts";
import type { UsageService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerUsageRoutes(router: ApiRouter, service: UsageService) {
  apiRoute(router, "getInstallationLimits", async (context) => {
    const { scope } = requireQuery(context, limitsQuerySchema);
    const caller = context.get("caller");
    const limits = await mapped<LimitsResponse>(() =>
      scope === "me"
        ? service.getMemberLimits(caller)
        : service.getInstallationLimits(caller),
    );
    return jsonWithSchema(context, limitsResponseSchema, limits);
  });

  apiRoute(router, "getUsageSummary", async (context) => {
    const query = requireQuery(context, usageSummaryQuerySchema);
    const summary = await mapped(() =>
      service.getUsageSummary(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageSummaryResponseSchema, summary);
  });

  apiRoute(router, "getUsageOutcomes", async (context) => {
    const query = requireQuery(context, usageOutcomesQuerySchema);
    const outcomes = await mapped(() =>
      service.getUsageOutcomes(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageOutcomesResponseSchema, outcomes);
  });

  apiRoute(router, "getUsageAchievements", async (context) => {
    const query = requireQuery(context, usageAchievementsQuerySchema);
    const achievements = await mapped(() =>
      service.getUsageAchievements(context.get("caller"), query),
    );
    return jsonWithSchema(
      context,
      usageAchievementsResponseSchema,
      achievements,
    );
  });

  apiRoute(router, "getUsageSeries", async (context) => {
    const query = requireQuery(context, usageSeriesQuerySchema);
    const series = await mapped(() =>
      service.getUsageSeries(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageSeriesResponseSchema, series);
  });

  apiRoute(router, "getUsageBreakdown", async (context) => {
    const query = requireQuery(context, usageBreakdownQuerySchema);
    const breakdown = await mapped(() =>
      service.getUsageBreakdown(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageBreakdownResponseSchema, breakdown);
  });

  apiRoute(router, "getUsageTools", async (context) => {
    const query = requireQuery(context, usageToolsQuerySchema);
    const tools = await mapped(() =>
      service.getUsageTools(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageToolsResponseSchema, tools);
  });

  apiRoute(router, "getUsageToolCalls", async (context) => {
    const params = requireParams(context, usageToolCallsParamsSchema);
    const query = requireQuery(context, usageToolCallsQuerySchema);
    const calls = await mapped(() =>
      service.getUsageToolCalls(context.get("caller"), params.name, query),
    );
    return jsonWithSchema(context, usageToolCallsResponseSchema, calls);
  });

  apiRoute(router, "getSessionUsage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const usage = await mapped(() =>
      service.getSessionUsage(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionUsageResponseSchema, usage);
  });
}
