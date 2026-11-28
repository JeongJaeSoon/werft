import {
  agentIdParamsSchema,
  agentUsageSchema,
  putAgentUsageRequestSchema,
  putAgentUsageResponseSchema,
} from "@werft-ai/contracts";
import type { AgentUsageService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAgentUsageRoutes(
  router: ApiRouter,
  service: AgentUsageService,
) {
  apiRoute(router, "getAgentUsage", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const usage = await mapped(() =>
      service.getAgentUsage(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentUsageSchema, usage);
  });

  apiRoute(router, "putAgentUsage", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, putAgentUsageRequestSchema);
    const saved = await mapped(() =>
      service.putAgentUsage(
        context.get("caller"),
        params.id,
        body,
        context.req.header("If-Match"),
      ),
    );
    return jsonWithSchema(context, putAgentUsageResponseSchema, saved);
  });
}
