import {
  agentIdParamsSchema,
  listConversationTurnsQuerySchema,
  listConversationTurnsResponseSchema,
} from "@werft-ai/contracts";
import type { ConversationTurnListService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerConversationTurnRoutes(
  router: ApiRouter,
  service: Pick<ConversationTurnListService, "listConversationTurns">,
) {
  apiRoute(router, "listConversationTurns", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, listConversationTurnsQuerySchema);
    const page = await mapped(() =>
      service.listConversationTurns(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, listConversationTurnsResponseSchema, page);
  });
}
