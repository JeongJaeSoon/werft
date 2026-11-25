import {
  agentIdParamsSchema,
  getSlackInstructionsHeadResponseSchema,
} from "@werft-ai/contracts";
import type { InstructionsHeadService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSlackInstructionsHeadRoutes(
  router: ApiRouter,
  service: InstructionsHeadService,
) {
  apiRoute(router, "getSlackInstructionsHead", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const read = await mapped(() =>
      service.getSlackInstructionsHead(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      getSlackInstructionsHeadResponseSchema,
      read,
    );
  });
}
