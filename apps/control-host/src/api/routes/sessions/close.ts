import {
  closeSessionRequestSchema,
  controlAcceptedResponseSchema,
} from "@werft-ai/contracts";
import type { SessionService } from "@werft-ai/platform";
import type { ApiRouter } from "../../app.ts";
import { sessionControlRoute } from "../errors.ts";

export function registerCloseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "closeSession">,
) {
  sessionControlRoute(
    router,
    "closeSession",
    closeSessionRequestSchema,
    controlAcceptedResponseSchema,
    (caller, id, input) => service.closeSession(caller, id, input),
  );
}
