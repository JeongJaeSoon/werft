import {
  agentIdParamsSchema,
  agentMcpResponseSchema,
  agentWorkspaceMcpServerListSchema,
  putAgentMcpSettingsRequestSchema,
  putAgentMcpSettingsResponseSchema,
  putAgentWorkspaceMcpServersRequestSchema,
  putAgentWorkspaceMcpServersResponseSchema,
} from "@werft-ai/contracts";
import type {
  AgentMcpService,
  AgentWorkspaceMcpService,
} from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

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

export function registerAgentWorkspaceMcpRoutes(
  router: ApiRouter,
  service: AgentWorkspaceMcpService,
) {
  apiRoute(router, "listAgentWorkspaceMcpServers", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentWorkspaceMcpServerListSchema,
      await mapped(() => service.list(context.get("caller"), params.id)),
    );
  });

  apiRoute(router, "putAgentWorkspaceMcpServers", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentWorkspaceMcpServersRequestSchema,
    );
    return jsonWithSchema(
      context,
      putAgentWorkspaceMcpServersResponseSchema,
      await mapped(() => service.put(context.get("caller"), params.id, body)),
    );
  });
}
