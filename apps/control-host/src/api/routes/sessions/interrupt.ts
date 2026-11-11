import {
  controlAcceptedResponseSchema,
  interruptSessionRequestSchema,
} from "@werft-ai/contracts";
import type { InterruptService } from "@werft-ai/platform";
import type { ApiRouter } from "../../app.ts";
import { sessionControlRoute } from "../errors.ts";

export function registerInterruptRoutes(
  router: ApiRouter,
  service: InterruptService,
) {
  sessionControlRoute(
    router,
    "interruptSession",
    interruptSessionRequestSchema,
    controlAcceptedResponseSchema,
    (caller, id, input) => service.interrupt(caller, id, input),
  );
}
