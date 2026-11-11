import {
  controlAcceptedResponseSchema,
  pauseSessionRequestSchema,
} from "@werft-ai/contracts";
import type { SessionService } from "@werft-ai/platform";
import type { ApiRouter } from "../../app.ts";
import { sessionControlRoute } from "../errors.ts";

export function registerPauseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "pauseSession">,
) {
  sessionControlRoute(
    router,
    "pauseSession",
    pauseSessionRequestSchema,
    controlAcceptedResponseSchema,
    (caller, id, input) => service.pauseSession(caller, id, input),
  );
}
