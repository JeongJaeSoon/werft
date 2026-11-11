import {
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  openPullRequestQuerySchema,
  openPullRequestRequestSchema,
  openPullRequestResponseSchema,
  openPullRequestResultSchema,
  pushRequestParamsSchema,
} from "@werft-ai/contracts";
import type { PullRequestService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { actorOf, mapped, requireParams, requireQuery } from "../errors.ts";

export function registerPullRequestRoutes(
  router: ApiRouter,
  service: PullRequestService,
) {
  apiRoute(router, "openPullRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const query = requireQuery(context, openPullRequestQuerySchema);
    const readBody = () => parseJsonBody(context, openPullRequestRequestSchema);
    // Without the query a push that has not finished is still refused with
    // `409 not_pushed`, as before; the schedule is opt-in.
    if (query.schedule === "true") {
      const answered = await mapped(() =>
        service.schedule(
          actorOf(context),
          params.id,
          { pushRequestId: params.push_request_id },
          { readBody },
        ),
      );
      if ("status" in answered) {
        return jsonWithSchema(
          context,
          openPullRequestResultSchema,
          answered,
          202,
        );
      }
      return jsonWithSchema(
        context,
        openPullRequestResultSchema,
        answered,
        answered.created ? 201 : 200,
      );
    }
    const opened = await mapped(() =>
      service.open(actorOf(context), params.id, params.push_request_id, {
        readBody,
      }),
    );
    return jsonWithSchema(
      context,
      openPullRequestResponseSchema,
      opened,
      opened.created ? 201 : 200,
    );
  });

  apiRoute(router, "commentPullRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const commented = await mapped(() =>
      service.comment(actorOf(context), params.id, params.push_request_id, {
        readBody: () => parseJsonBody(context, commentPullRequestRequestSchema),
      }),
    );
    return jsonWithSchema(
      context,
      commentPullRequestResponseSchema,
      commented,
      commented.comment.created ? 201 : 200,
    );
  });
}
