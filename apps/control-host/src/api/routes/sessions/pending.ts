import {
  listPendingRequestsResponseSchema,
  postSessionAnswerInputSchema,
  postSessionAnswerResponseSchema,
  sessionIdParamsSchema,
  storedAnswer,
} from "@werft-ai/contracts";
import type { PendingRequestService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "../errors.ts";

export function registerPendingRoutes(
  router: ApiRouter,
  service: PendingRequestService,
) {
  apiRoute(router, "listPendingRequests", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const page = await mapped(() =>
      service.listPendingRequests(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listPendingRequestsResponseSchema, page);
  });

  apiRoute(router, "answerPendingRequest", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = storedAnswer(
      await parseJsonBody(context, postSessionAnswerInputSchema),
    );
    const accepted = await mapped(() =>
      service.answer(context.get("caller"), params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      postSessionAnswerResponseSchema,
      accepted,
      202,
    );
  });
}
