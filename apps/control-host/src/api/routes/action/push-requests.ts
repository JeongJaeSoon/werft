import {
  createPushRequestRequestSchema,
  listPushRequestsResponseSchema,
  type PushDecision,
  pushRequestParamsSchema,
  pushRequestSchema,
  pushRequestViewSchema,
  resolvePushRequestRequestSchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import type { PushRequestService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import {
  actorOf,
  mapped,
  requireIdempotencyKey,
  requireParams,
} from "../errors.ts";

export function registerPushRequestRoutes(
  router: ApiRouter,
  service: PushRequestService,
) {
  apiRoute(router, "createPushRequest", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, createPushRequestRequestSchema);
    const created = await mapped(() =>
      service.create(actorOf(context), params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(context, pushRequestSchema, created, 201);
  });

  apiRoute(router, "listPushRequests", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const page = await mapped(() =>
      service.listView(actorOf(context), params.id),
    );
    return jsonWithSchema(context, listPushRequestsResponseSchema, page);
  });

  apiRoute(router, "getPushRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const request = await mapped(() =>
      service.getView(actorOf(context), params.id, params.push_request_id),
    );
    return jsonWithSchema(context, pushRequestViewSchema, request);
  });

  // `/approve` and `/reject` share one idempotency scope: the path names
  // the action, which joins the body before it is hashed.
  const resolve =
    (decision: PushDecision) => async (context: Context<ApiEnvironment>) => {
      const params = requireParams(context, pushRequestParamsSchema);
      const key = requireIdempotencyKey(context);
      const resolved = await mapped(() =>
        service.decide(actorOf(context), params.id, params.push_request_id, {
          idempotencyKey: key,
          readBody: async () => ({
            decision,
            ...(await parseJsonBody(context, resolvePushRequestRequestSchema)),
          }),
        }),
      );
      return jsonWithSchema(context, pushRequestSchema, resolved);
    };

  apiRoute(router, "approvePushRequest", resolve("approve"));
  apiRoute(router, "rejectPushRequest", resolve("reject"));
}
