import {
  closeSessionRequestSchema,
  controlAcceptedResponseSchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import type { SessionService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "../errors.ts";

export function registerCloseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "closeSession">,
) {
  apiRoute(router, "closeSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, closeSessionRequestSchema);
    const accepted = await mapped(() =>
      service.closeSession(context.get("caller"), params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      controlAcceptedResponseSchema,
      accepted,
      202,
    );
  });
}
