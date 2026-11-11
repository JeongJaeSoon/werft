import {
  controlAcceptedResponseSchema,
  interruptSessionRequestSchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import type { InterruptService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "../errors.ts";

export function registerInterruptRoutes(
  router: ApiRouter,
  service: InterruptService,
) {
  apiRoute(router, "interruptSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, interruptSessionRequestSchema);
    const accepted = await mapped(() =>
      service.interrupt(context.get("caller"), params.id, {
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
