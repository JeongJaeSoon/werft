import {
  agentEnvVariablesSchema,
  agentIdParamsSchema,
  agentVariableParamsSchema,
  deleteEnvVariableResponseSchema,
  envVariableListSchema,
  putEnvVariableFieldsSchema,
  putEnvVariableGrantsRequestSchema,
  putEnvVariableGrantsResponseSchema,
  putEnvVariableResponseSchema,
  workspaceVariableParamsSchema,
} from "@werft-ai/contracts";
import type { EnvVariableService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

const writeHeaders = (context: Context<ApiEnvironment>) => ({
  ifMatch: context.req.header("If-Match"),
  ifNoneMatch: context.req.header("If-None-Match"),
});

export function registerEnvVariableRoutes(
  router: ApiRouter,
  service: EnvVariableService,
) {
  apiRoute(router, "listWorkspaceVariables", async (context) => {
    const listed = await mapped(() =>
      service.listWorkspace(context.get("caller")),
    );
    return jsonWithSchema(context, envVariableListSchema, listed);
  });

  apiRoute(router, "putWorkspaceVariable", async (context) => {
    const params = requireParams(context, workspaceVariableParamsSchema);
    const body = await parseJsonBody(context, putEnvVariableFieldsSchema);
    const saved = await mapped(() =>
      service.putWorkspace(
        context.get("caller"),
        params.name,
        body,
        writeHeaders(context),
      ),
    );
    return jsonWithSchema(context, putEnvVariableResponseSchema, saved);
  });

  apiRoute(router, "deleteWorkspaceVariable", async (context) => {
    const params = requireParams(context, workspaceVariableParamsSchema);
    const deleted = await mapped(() =>
      service.deleteWorkspace(
        context.get("caller"),
        params.name,
        context.req.header("If-Match"),
      ),
    );
    return jsonWithSchema(context, deleteEnvVariableResponseSchema, deleted);
  });

  apiRoute(router, "putWorkspaceVariableGrants", async (context) => {
    const params = requireParams(context, workspaceVariableParamsSchema);
    const body = await parseJsonBody(
      context,
      putEnvVariableGrantsRequestSchema,
    );
    const saved = await mapped(() =>
      service.putGrants(
        context.get("caller"),
        params.name,
        body,
        context.req.header("If-Match"),
      ),
    );
    return jsonWithSchema(context, putEnvVariableGrantsResponseSchema, saved);
  });

  apiRoute(router, "listAgentVariables", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const listed = await mapped(() =>
      service.listAgent(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentEnvVariablesSchema, listed);
  });

  apiRoute(router, "putAgentVariable", async (context) => {
    const params = requireParams(context, agentVariableParamsSchema);
    const body = await parseJsonBody(context, putEnvVariableFieldsSchema);
    const saved = await mapped(() =>
      service.putAgent(
        context.get("caller"),
        params.id,
        params.name,
        body,
        writeHeaders(context),
      ),
    );
    return jsonWithSchema(context, putEnvVariableResponseSchema, saved);
  });

  apiRoute(router, "deleteAgentVariable", async (context) => {
    const params = requireParams(context, agentVariableParamsSchema);
    const deleted = await mapped(() =>
      service.deleteAgent(
        context.get("caller"),
        params.id,
        params.name,
        context.req.header("If-Match"),
      ),
    );
    return jsonWithSchema(context, deleteEnvVariableResponseSchema, deleted);
  });
}
