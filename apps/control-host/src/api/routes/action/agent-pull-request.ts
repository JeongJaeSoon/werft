import {
  agentIdParamsSchema,
  agentPullRequestResponseSchema,
  putAgentPullRequestSettingsRequestSchema,
  putAgentPullRequestSettingsResponseSchema,
} from "@werft-ai/contracts";
import type { AgentPullRequestService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAgentPullRequestRoutes(
  router: ApiRouter,
  service: AgentPullRequestService,
) {
  apiRoute(router, "getAgentPullRequestSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentPullRequestResponseSchema,
      await mapped(() => service.get(context.get("caller"), params.id)),
    );
  });

  apiRoute(router, "putAgentPullRequestSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentPullRequestSettingsRequestSchema,
    );
    return jsonWithSchema(
      context,
      putAgentPullRequestSettingsResponseSchema,
      await mapped(() => service.put(context.get("caller"), params.id, body)),
    );
  });
}
