import {
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  githubWorkflowRunSchema,
  listSessionGitHubRefusalsResponseSchema,
  listSessionOutcomesResponseSchema,
  pullRequestReviewParamsSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  sessionGitHubAttributionSchema,
  sessionIdParamsSchema,
  submitPullRequestReviewRequestSchema,
  submitPullRequestReviewResponseSchema,
  workflowRunParamsSchema,
} from "@werft-ai/contracts";
import type {
  GitHubWorkService,
  SessionAttributionService,
  SessionOutcomeService,
} from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { actorOf } from "../action/push-requests.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerGitHubWorkRoutes(
  router: ApiRouter,
  service: GitHubWorkService,
) {
  apiRoute(router, "dispatchWorkflow", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, dispatchWorkflowRequestSchema);
    const dispatched = await mapped(() =>
      service.dispatch(actorOf(context), params.id, body),
    );
    return jsonWithSchema(
      context,
      dispatchWorkflowResponseSchema,
      dispatched,
      201,
    );
  });

  apiRoute(router, "getWorkflowRun", async (context) => {
    const params = requireParams(context, workflowRunParamsSchema);
    const run = await mapped(() =>
      service.getRun(actorOf(context), params.id, params.run_id),
    );
    return jsonWithSchema(context, githubWorkflowRunSchema, run);
  });

  apiRoute(router, "rerunWorkflow", async (context) => {
    const params = requireParams(context, workflowRunParamsSchema);
    const body = await parseJsonBody(context, rerunWorkflowRequestSchema);
    const rerun = await mapped(() =>
      service.rerun(actorOf(context), params.id, params.run_id, body),
    );
    return jsonWithSchema(context, rerunWorkflowResponseSchema, rerun, 201);
  });

  apiRoute(router, "submitPullRequestReview", async (context) => {
    const params = requireParams(context, pullRequestReviewParamsSchema);
    const body = await parseJsonBody(
      context,
      submitPullRequestReviewRequestSchema,
    );
    const review = await mapped(() =>
      service.review(actorOf(context), params.id, params.number, body),
    );
    return jsonWithSchema(
      context,
      submitPullRequestReviewResponseSchema,
      review,
      201,
    );
  });
}

export function registerSessionAttributionRoutes(
  router: ApiRouter,
  service: SessionAttributionService,
) {
  apiRoute(router, "getSessionGitHubAttribution", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const attribution = await mapped(() =>
      service.get(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionGitHubAttributionSchema, attribution);
  });
}

export function registerSessionOutcomeRoutes(
  router: ApiRouter,
  service: SessionOutcomeService,
) {
  apiRoute(router, "listSessionOutcomes", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listSessionOutcomesResponseSchema, listed);
  });

  apiRoute(router, "listSessionGitHubRefusals", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const listed = await mapped(() =>
      service.refusals(context.get("caller"), params.id),
    );
    return jsonWithSchema(
      context,
      listSessionGitHubRefusalsResponseSchema,
      listed,
    );
  });
}
