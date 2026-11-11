import {
  apiKeyIdParamsSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  listApiKeysQuerySchema,
  listApiKeysResponseSchema,
  revokeApiKeyResponseSchema,
} from "@werft-ai/contracts";
import type { ApiKeyService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerApiKeyRoutes(
  router: ApiRouter,
  service: ApiKeyService,
) {
  apiRoute(router, "createApiKey", async (context) => {
    const body = await parseJsonBody(context, createApiKeyRequestSchema);
    const created = await mapped(() =>
      service.issue(context.get("caller"), body),
    );
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(context, createApiKeyResponseSchema, created, 201);
  });

  apiRoute(router, "listApiKeys", async (context) => {
    const query = requireQuery(context, listApiKeysQuerySchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), query),
    );
    return jsonWithSchema(context, listApiKeysResponseSchema, listed);
  });

  apiRoute(router, "revokeApiKey", async (context) => {
    const params = requireParams(context, apiKeyIdParamsSchema);
    const revoked = await mapped(() =>
      service.revoke(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, revokeApiKeyResponseSchema, revoked);
  });
}
