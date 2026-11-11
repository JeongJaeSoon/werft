import {
  agentEngineSettingsResponseSchema,
  agentIdParamsSchema,
  putEngineSettingsRequestSchema,
  putEngineSettingsResponseSchema,
  workspaceEngineSettingsResponseSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { EngineSettingsService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerEngineSettingsRoutes(
  router: ApiRouter,
  service: EngineSettingsService,
) {
  apiRoute(router, "getWorkspaceEngineSettings", async (context) => {
    const params = requireParams(context, workspaceParamsSchema);
    return jsonWithSchema(
      context,
      workspaceEngineSettingsResponseSchema,
      await mapped(() =>
        service.getWorkspace(context.get("caller"), params.id.toLowerCase()),
      ),
    );
  });

  apiRoute(router, "putWorkspaceEngineSettings", async (context) => {
    const params = requireParams(context, workspaceParamsSchema);
    const body = await parseJsonBody(context, putEngineSettingsRequestSchema);
    return jsonWithSchema(
      context,
      putEngineSettingsResponseSchema,
      await mapped(() =>
        service.putWorkspace(
          context.get("caller"),
          params.id.toLowerCase(),
          body,
        ),
      ),
    );
  });

  apiRoute(router, "getAgentEngineSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    return jsonWithSchema(
      context,
      agentEngineSettingsResponseSchema,
      await mapped(() => service.getAgent(context.get("caller"), params.id)),
    );
  });

  apiRoute(router, "putAgentEngineSettings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, putEngineSettingsRequestSchema);
    return jsonWithSchema(
      context,
      putEngineSettingsResponseSchema,
      await mapped(() =>
        service.putAgent(context.get("caller"), params.id, body),
      ),
    );
  });
}
