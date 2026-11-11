import {
  controlAcceptedResponseSchema,
  pauseSessionRequestSchema,
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

export function registerPauseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "pauseSession">,
) {
  apiRoute(router, "pauseSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, pauseSessionRequestSchema);
    const accepted = await mapped(() =>
      service.pauseSession(context.get("caller"), params.id, {
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
