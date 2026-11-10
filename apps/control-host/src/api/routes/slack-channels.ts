import {
  agentIdParamsSchema,
  lookupSlackChannelsQuerySchema,
  lookupSlackChannelsResponseSchema,
  searchSlackChannelsQuerySchema,
  searchSlackChannelsResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackChannelSearchService } from "../../wiring/chat-slack.ts";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerSlackChannelRoutes(
  router: ApiRouter,
  deps: { service: SlackChannelSearchService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "lookupSlackChannels", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, lookupSlackChannelsQuerySchema);
    const found = await mapped(() =>
      service.lookupSlackChannels(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, lookupSlackChannelsResponseSchema, found);
  });

  apiRoute(router, "searchSlackChannels", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, searchSlackChannelsQuerySchema);
    const found = await mapped(() =>
      service.searchSlackChannels(context.get("caller"), params.id, query),
    );
    logger?.info("Slack channels searched", {
      agent_id: params.id,
      slack_app_id: found.slackAppId,
      cache: found.cache,
      count: found.page.items.length,
    });
    return jsonWithSchema(
      context,
      searchSlackChannelsResponseSchema,
      found.page,
    );
  });
}
