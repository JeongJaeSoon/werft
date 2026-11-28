import {
  completeWorkspaceMcpOAuthRequestSchema,
  createWorkspaceMcpServerRequestSchema,
  deleteWorkspaceMcpServerResponseSchema,
  disconnectWorkspaceMcpServerResponseSchema,
  discoverWorkspaceMcpServerRequestSchema,
  discoverWorkspaceMcpServerResponseSchema,
  putWorkspaceMcpBearerTokenRequestSchema,
  putWorkspaceMcpOAuthClientRequestSchema,
  startWorkspaceMcpOAuthResponseSchema,
  workspaceMcpServerListSchema,
  workspaceMcpServerParamsSchema,
  workspaceMcpServerSchema,
} from "@werft-ai/contracts";
import type { WorkspaceMcpService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../../app.ts";
import { mapped, requireParams } from "../../errors.ts";

export function registerWorkspaceMcpServerRoutes(
  router: ApiRouter,
  service: WorkspaceMcpService,
) {
  apiRoute(router, "listWorkspaceMcpServers", async (context) => {
    const listed = await mapped(() => service.list(context.get("caller")));
    return jsonWithSchema(context, workspaceMcpServerListSchema, listed);
  });

  apiRoute(router, "discoverWorkspaceMcpServer", async (context) => {
    const body = await parseJsonBody(
      context,
      discoverWorkspaceMcpServerRequestSchema,
    );
    const found = await mapped(() =>
      service.discover(context.get("caller"), body.url),
    );
    return jsonWithSchema(
      context,
      discoverWorkspaceMcpServerResponseSchema,
      found,
    );
  });

  apiRoute(router, "createWorkspaceMcpServer", async (context) => {
    const body = await parseJsonBody(
      context,
      createWorkspaceMcpServerRequestSchema,
    );
    const created = await mapped(() =>
      service.create(context.get("caller"), body),
    );
    return jsonWithSchema(context, workspaceMcpServerSchema, created, 201);
  });

  apiRoute(router, "deleteWorkspaceMcpServer", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const deleted = await mapped(() =>
      service.delete(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      deleteWorkspaceMcpServerResponseSchema,
      deleted,
    );
  });

  apiRoute(router, "putWorkspaceMcpBearerToken", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const body = await parseJsonBody(
      context,
      putWorkspaceMcpBearerTokenRequestSchema,
    );
    const saved = await mapped(() =>
      service.putBearerToken(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, workspaceMcpServerSchema, saved);
  });

  apiRoute(router, "putWorkspaceMcpOAuthClient", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const body = await parseJsonBody(
      context,
      putWorkspaceMcpOAuthClientRequestSchema,
    );
    const saved = await mapped(() =>
      service.putOAuthClient(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, workspaceMcpServerSchema, saved);
  });

  apiRoute(router, "startWorkspaceMcpOAuth", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const started = await mapped(() =>
      service.startOAuth(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      startWorkspaceMcpOAuthResponseSchema,
      started,
    );
  });

  apiRoute(router, "completeWorkspaceMcpOAuth", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const body = await parseJsonBody(
      context,
      completeWorkspaceMcpOAuthRequestSchema,
    );
    const connected = await mapped(() =>
      service.completeOAuth(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, workspaceMcpServerSchema, connected);
  });

  apiRoute(router, "disconnectWorkspaceMcpServer", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const disconnected = await mapped(() =>
      service.disconnect(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      disconnectWorkspaceMcpServerResponseSchema,
      disconnected,
    );
  });

  apiRoute(router, "refreshWorkspaceMcpTools", async (context) => {
    const params = requireParams(context, workspaceMcpServerParamsSchema);
    const refreshed = await mapped(() =>
      service.refreshTools(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, workspaceMcpServerSchema, refreshed);
  });
}
