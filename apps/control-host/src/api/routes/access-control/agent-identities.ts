import {
  agentIdentityParamsSchema,
  agentIdParamsSchema,
  linkAgentIdentityRequestSchema,
  linkAgentIdentityResponseSchema,
  listAgentIdentitiesResponseSchema,
  revokeAgentIdentityResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { AgentIdentityService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerAgentIdentityRoutes(
  router: ApiRouter,
  deps: { service: AgentIdentityService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "linkAgentIdentity", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, linkAgentIdentityRequestSchema);
    const linked = await mapped(() =>
      service.linkAgentIdentity(context.get("caller"), params.id, body),
    );
    logger?.info("Agent identity linked", {
      agent_id: params.id,
      agent_identity_id: linked.agent_identity.id,
      app_id: linked.agent_identity.app_id,
      team_id: linked.agent_identity.team_id,
    });
    return jsonWithSchema(
      context,
      linkAgentIdentityResponseSchema,
      linked,
      201,
    );
  });

  apiRoute(router, "listAgentIdentities", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const page = await mapped(() =>
      service.listAgentIdentities(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listAgentIdentitiesResponseSchema, page);
  });

  apiRoute(router, "revokeAgentIdentity", async (context) => {
    const params = requireParams(context, agentIdentityParamsSchema);
    const revoked = await mapped(() =>
      service.revokeAgentIdentity(
        context.get("caller"),
        params.id,
        params.identity_id,
      ),
    );
    if (revoked.receipt_id !== null) {
      logger?.info("Agent identity revoked", {
        agent_id: params.id,
        agent_identity_id: params.identity_id,
      });
    }
    return jsonWithSchema(context, revokeAgentIdentityResponseSchema, revoked);
  });
}
