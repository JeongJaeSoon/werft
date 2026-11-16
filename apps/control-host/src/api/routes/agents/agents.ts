import {
  activateAgentRequestSchema,
  activateAgentResponseSchema,
  agentDetailSchema,
  agentIdParamsSchema,
  countAgentsResponseSchema,
  createAgentReleaseRequestSchema,
  createAgentReleaseResponseSchema,
  createAgentRequestSchema,
  deleteAgentResponseSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  listConnectionOptionsResponseSchema,
  listUsableAgentsResponseSchema,
  saveAgentResponseSchema,
  updateAgentRequestSchema,
} from "@werft-ai/contracts";
import type { AgentService } from "@werft-ai/platform";
import type { MiddlewareHandler } from "hono";
import {
  type ApiEnvironment,
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

/**
 * Answers 404 for a deleted agent on every `/v1/agents/{id}` route, ahead
 * of their authorization: a workspace manager's decision never reads the
 * agent, so this is where the deleted one goes missing for everyone.
 * Registered before any agent route.
 */
export function refuseDeletedAgents(
  router: ApiRouter,
  deleted: (workspaceId: string, agentId: string) => Promise<boolean>,
) {
  const refuse: MiddlewareHandler<ApiEnvironment> = async (context, next) => {
    if (await deleted(context.get("ownerId"), context.req.param("id") ?? "")) {
      throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
    }
    await next();
  };
  router.use("/agents/:id", refuse);
  router.use("/agents/:id/*", refuse);
}

export function registerAgentRoutes(
  router: ApiRouter,
  service: Omit<
    AgentService,
    | "resolveRelease"
    | "notRunnableReason"
    | "envNames"
    | "rolloutRelease"
    | "migrateModel"
    | "migrateAgent"
    | "unlockTools"
    | "revertMigration"
  >,
) {
  apiRoute(router, "listAgents", async (context) => {
    const query = requireQuery(context, listAgentsQuerySchema);
    const page = await mapped(() =>
      service.listAgents(context.get("caller"), query),
    );
    return jsonWithSchema(context, listAgentsResponseSchema, page);
  });

  apiRoute(router, "listConnectionOptions", async (context) => {
    const options = await mapped(() =>
      service.listConnections(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      listConnectionOptionsResponseSchema,
      options,
    );
  });

  apiRoute(router, "listUsableAgents", async (context) => {
    const usable = await mapped(() =>
      service.listUsableAgents(context.get("caller")),
    );
    return jsonWithSchema(context, listUsableAgentsResponseSchema, usable);
  });

  // Before getAgent, so "counts" is never read as an agent id.
  apiRoute(router, "countAgents", async (context) => {
    const counts = await mapped(() =>
      service.countAgents(context.get("caller")),
    );
    return jsonWithSchema(context, countAgentsResponseSchema, counts);
  });

  apiRoute(router, "createAgent", async (context) => {
    const body = await parseJsonBody(context, createAgentRequestSchema);
    const detail = await mapped(() =>
      service.createAgent(context.get("caller"), body),
    );
    return jsonWithSchema(context, saveAgentResponseSchema, detail, 201);
  });

  apiRoute(router, "getAgent", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const detail = await mapped(() =>
      service.getAgent(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentDetailSchema, detail);
  });

  apiRoute(router, "updateAgent", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, updateAgentRequestSchema);
    const detail = await mapped(() =>
      service.updateAgent(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, saveAgentResponseSchema, detail);
  });

  apiRoute(router, "deleteAgent", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const deleted = await mapped(() =>
      service.deleteAgent(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, deleteAgentResponseSchema, deleted);
  });

  apiRoute(router, "createAgentRelease", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, createAgentReleaseRequestSchema);
    const released = await mapped(() =>
      service.createRelease(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, createAgentReleaseResponseSchema, released);
  });

  apiRoute(router, "activateAgent", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, activateAgentRequestSchema);
    const activated = await mapped(() =>
      service.activateAgent(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, activateAgentResponseSchema, activated);
  });
}
