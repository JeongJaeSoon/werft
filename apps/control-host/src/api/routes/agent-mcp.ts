import {
  agentIdParamsSchema,
  agentMcpResponseSchema,
  putAgentMcpSettingsRequestSchema,
  putAgentMcpSettingsResponseSchema,
} from "@werft-ai/contracts";
import type { AgentMcpService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerAgentMcpRoutes(
  router: ApiRouter,
  service: AgentMcpService,
) {
  apiRoute(router, "getAgentMcpSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentMcpResponseSchema,
      await mapped(() => service.get(context.get("caller"), params.id)),
    );
  });

  apiRoute(router, "putAgentMcpSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, putAgentMcpSettingsRequestSchema);
    return jsonWithSchema(
      context,
      putAgentMcpSettingsResponseSchema,
      await mapped(() => service.put(context.get("caller"), params.id, body)),
    );
  });
}
