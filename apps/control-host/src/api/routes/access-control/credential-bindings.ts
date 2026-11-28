import {
  agentIdParamsSchema,
  createCredentialBindingRequestSchema,
  createCredentialBindingResponseSchema,
  credentialBindingParamsSchema,
  listCredentialBindingsResponseSchema,
  revokeCredentialBindingResponseSchema,
} from "@werft-ai/contracts";
import type { CredentialBindingService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerCredentialBindingRoutes(
  router: ApiRouter,
  service: CredentialBindingService,
) {
  apiRoute(router, "listCredentialBindings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      listCredentialBindingsResponseSchema,
      listed,
    );
  });

  apiRoute(router, "createCredentialBinding", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      createCredentialBindingRequestSchema,
    );
    const bound = await mapped(() =>
      service.bind(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(
      context,
      createCredentialBindingResponseSchema,
      bound,
    );
  });

  apiRoute(router, "revokeCredentialBinding", async (context) => {
    const params = requireParams(context, credentialBindingParamsSchema);
    const revoked = await mapped(() =>
      service.revoke(context.get("caller"), params.id, params.binding_id),
    );
    return jsonWithSchema(
      context,
      revokeCredentialBindingResponseSchema,
      revoked,
    );
  });
}
