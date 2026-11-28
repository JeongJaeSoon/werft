import {
  agentIdParamsSchema,
  getSlackJudgmentsQuerySchema,
  getSlackJudgmentsResponseSchema,
} from "@werft-ai/contracts";
import type { JudgmentReviewService } from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
} from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerSlackJudgmentRoutes(
  router: ApiRouter,
  service: JudgmentReviewService,
) {
  apiRoute(router, "getSlackJudgments", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    // The query reader keeps one value; a repeated key would hide the rest.
    if (
      ["reason", "answer"].some(
        (key) => (context.req.queries(key)?.length ?? 0) > 1,
      )
    ) {
      throw new ApiHttpError(
        400,
        "BAD_REQUEST",
        "Query parameters are invalid",
      );
    }
    const query = requireQuery(context, getSlackJudgmentsQuerySchema);
    const read = await mapped(() =>
      service.getSlackJudgments(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, getSlackJudgmentsResponseSchema, read);
  });
}
