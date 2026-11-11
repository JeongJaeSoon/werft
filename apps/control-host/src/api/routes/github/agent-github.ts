import {
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  agentIdParamsSchema,
  putAgentGitHubEnabledRequestSchema,
  putAgentGitHubEnabledResponseSchema,
  putAgentGitHubRepositoryAccessRequestSchema,
  putAgentGitHubRepositoryAccessResponseSchema,
  putAgentGitHubSettingsRequestSchema,
  putAgentGitHubSettingsResponseSchema,
} from "@werft-ai/contracts";
import type { AgentGitHubService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAgentGitHubRoutes(
  router: ApiRouter,
  service: AgentGitHubService,
) {
  apiRoute(router, "getAgentGitHub", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentGitHubResponseSchema,
      await mapped(() => service.get(context.get("caller"), params.id)),
    );
  });

  apiRoute(router, "putAgentGitHubSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentGitHubSettingsRequestSchema,
    );
    return jsonWithSchema(
      context,
      putAgentGitHubSettingsResponseSchema,
      await mapped(() =>
        service.putSettings(context.get("caller"), params.id, body),
      ),
    );
  });

  apiRoute(router, "putAgentGitHubRepositoryAccess", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentGitHubRepositoryAccessRequestSchema,
    );
    return jsonWithSchema(
      context,
      putAgentGitHubRepositoryAccessResponseSchema,
      await mapped(() =>
        service.putRepositoryAccess(context.get("caller"), params.id, body),
      ),
    );
  });

  apiRoute(router, "putAgentGitHubEnabled", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      putAgentGitHubEnabledRequestSchema,
    );
    return jsonWithSchema(
      context,
      putAgentGitHubEnabledResponseSchema,
      await mapped(() =>
        service.putEnabled(context.get("caller"), params.id, body.enabled),
      ),
    );
  });

  apiRoute(router, "getAgentGitHubActivity", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentGitHubActivityResponseSchema,
      await mapped(() => service.activity(context.get("caller"), params.id)),
    );
  });
}
