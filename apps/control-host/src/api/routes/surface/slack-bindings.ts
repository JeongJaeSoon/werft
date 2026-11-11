import {
  agentIdParamsSchema,
  listSlackBindingsResponseSchema,
  putSlackBindingRequestSchema,
  putSlackBindingResponseSchema,
  resolveSlackBindingRequestSchema,
  resolveSlackBindingResponseSchema,
  slackBindingParamsSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SurfaceBindingService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSlackBindingRoutes(
  router: ApiRouter,
  deps: { service: SurfaceBindingService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "listSlackBindings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const page = await mapped(() =>
      service.listSlackBindings(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listSlackBindingsResponseSchema, page);
  });

  apiRoute(router, "putSlackBinding", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, putSlackBindingRequestSchema);
    const set = await mapped(() =>
      service.putSlackBinding(context.get("caller"), params.id, body),
    );
    logger?.info("Slack binding set", {
      agent_id: params.id,
      surface_binding_id: set.slack_binding.id,
      channel_id: set.slack_binding.external_surface_id,
      mode: set.slack_binding.mode,
      home: set.slack_binding.home,
    });
    return jsonWithSchema(context, putSlackBindingResponseSchema, set);
  });

  for (const decision of ["approve", "reject"] as const) {
    apiRoute(router, `${decision}SlackBinding`, async (context) => {
      const params = requireParams(context, slackBindingParamsSchema);
      const body = await parseJsonBody(
        context,
        resolveSlackBindingRequestSchema,
      );
      const resolved = await mapped(() =>
        decision === "approve"
          ? service.approveSlackBinding(
              context.get("caller"),
              params.id,
              params.binding_id,
              body,
            )
          : service.rejectSlackBinding(
              context.get("caller"),
              params.id,
              params.binding_id,
              body,
            ),
      );
      logger?.info("Slack binding resolved", {
        agent_id: params.id,
        surface_binding_id: params.binding_id,
        decision,
        replayed: resolved.receipt_id === null,
      });
      return jsonWithSchema(
        context,
        resolveSlackBindingResponseSchema,
        resolved,
      );
    });
  }
}
