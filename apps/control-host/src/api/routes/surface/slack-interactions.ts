import {
  SLACK_INTERACTIONS_BODY_MAX_BYTES,
  slackInteractionResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackInteractionService } from "../../../wiring/chat-slack.ts";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClockWithin,
  jsonWithSchema,
} from "../../app.ts";
import type { SlackEventsLimiter } from "../../rate-limit.ts";

const REFUSED = "Request signature is not valid";

export function registerSlackInteractionRoutes(
  router: ApiRouter,
  deps: {
    interactions: SlackInteractionService;
    limiter: SlackEventsLimiter;
    logger?: StructuredLogger;
  },
) {
  const { interactions, limiter, logger } = deps;
  const ingest = ingestThenStopClockWithin(SLACK_INTERACTIONS_BODY_MAX_BYTES);

  apiRoute(
    router,
    "receiveSlackInteraction",
    async (context, next) => {
      const admitted = limiter.admit(context.req.param("agent_id") ?? "");
      if (!admitted.ok) {
        throw new ApiHttpError(
          429,
          "RATE_LIMITED",
          "Too many Slack interactions, try again later",
          true,
          admitted.retryAfter,
        );
      }
      return ingest(context, next);
    },
    async (context) => {
      const agentId = context.req.param("agent_id") ?? "";
      const outcome = await interactions.receive({
        agentId,
        rawBody: new Uint8Array(await context.req.arrayBuffer()),
        timestamp: context.req.header("X-Slack-Request-Timestamp") ?? null,
        signature: context.req.header("X-Slack-Signature") ?? null,
      });
      switch (outcome.kind) {
        case "unauthorized":
          logger?.warn("Slack interaction refused", { agent_id: agentId });
          throw new ApiHttpError(401, "UNAUTHORIZED", REFUSED);
        case "bad_request":
          throw new ApiHttpError(400, "BAD_REQUEST", "Not a Slack interaction");
        case "ok":
          logger?.info("Slack interaction received", {
            agent_id: agentId,
            result: outcome.result,
          });
          return jsonWithSchema(
            context,
            slackInteractionResponseSchema,
            outcome.body,
          );
      }
    },
  );
}
