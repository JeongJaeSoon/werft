import {
  agentIdParamsSchema,
  agentWorkspaceMcpServerListSchema,
  putAgentWorkspaceMcpServersRequestSchema,
  putAgentWorkspaceMcpServersResponseSchema,
} from "@werft-ai/contracts";
import type { AgentWorkspaceMcpService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../../app.ts";
import { mapped, requireParams } from "../../errors.ts";

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
