import {
  agentIdParamsSchema,
  getSlackJudgmentsQuerySchema,
  getSlackJudgmentsResponseSchema,
} from "@werft-ai/contracts";
import type { JudgmentReviewService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerSlackJudgmentRoutes(
  router: ApiRouter,
  service: JudgmentReviewService,
) {
  apiRoute(router, "getSlackJudgments", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, getSlackJudgmentsQuerySchema);
    const read = await mapped(() =>
      service.getSlackJudgments(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, getSlackJudgmentsResponseSchema, read);
  });
}
