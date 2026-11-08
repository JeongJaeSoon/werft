import {
  activateAgentRequestSchema,
  activateAgentResponseSchema,
  agentDetailSchema,
  agentIdParamsSchema,
  countAgentsResponseSchema,
  createAgentReleaseRequestSchema,
  createAgentReleaseResponseSchema,
  createAgentRequestSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  saveAgentResponseSchema,
  updateAgentRequestSchema,
} from "@werft-ai/contracts";
import type { AgentService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerAgentRoutes(
  router: ApiRouter,
  service: Omit<
    AgentService,
    | "resolveRelease"
    | "promptIdentity"
    | "rolloutRelease"
    | "migrateAgent"
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
