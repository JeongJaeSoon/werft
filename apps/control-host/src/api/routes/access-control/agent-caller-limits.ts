import {
  agentCallerLimitsSchema,
  agentIdParamsSchema,
  putAgentCallerLimitsRequestSchema,
  putAgentCallerLimitsResponseSchema,
} from "@werft-ai/contracts";
import type { AgentCallerLimitsService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAgentCallerLimitsRoutes(
  router: ApiRouter,
  service: AgentCallerLimitsService,
) {
  apiRoute(router, "getAgentCallerLimits", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const limits = await mapped(() =>
      service.getAgentCallerLimits(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentCallerLimitsSchema, limits);
  });

  apiRoute(router, "putAgentCallerLimits", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentCallerLimitsRequestSchema,
    );
    const saved = await mapped(() =>
      service.putAgentCallerLimits(
        context.get("caller"),
        params.id,
        body,
        context.req.header("If-Match"),
      ),
    );
    return jsonWithSchema(context, putAgentCallerLimitsResponseSchema, saved);
  });
}
