import {
  SLACK_EVENTS_BODY_MAX_BYTES,
  slackEventsResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackEventsService } from "../../../wiring/chat-slack.ts";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClockWithin,
  jsonWithSchema,
} from "../../app.ts";
import type { SlackEventsLimiter } from "../../rate-limit.ts";

const REFUSED = "Request signature is not valid";

const retryNumOf = (header: string | undefined) =>
  header !== undefined && /^\d{1,4}$/.test(header) ? Number(header) : null;

// Why Slack says its last try failed. The header comes before the signature
// is checked, so only Slack's own values are logged, never what was sent.
const SLACK_RETRY_REASONS: ReadonlySet<string> = new Set([
  "http_timeout",
  "too_many_redirects",
  "connection_failed",
  "ssl_error",
  "http_error",
  "unknown_error",
]);
const retryReasonOf = (header: string | undefined) =>
  header !== undefined && SLACK_RETRY_REASONS.has(header) ? header : null;

export function registerSlackEventRoutes(
  router: ApiRouter,
  deps: {
    events: SlackEventsService;
    limiter: SlackEventsLimiter;
    logger?: StructuredLogger;
  },
) {
  const { events, limiter, logger } = deps;
  const ingest = ingestThenStopClockWithin(SLACK_EVENTS_BODY_MAX_BYTES);

  apiRoute(
    router,
    "receiveSlackEvent",
    async (context, next) => {
      const admitted = limiter.admit(context.req.param("agent_id") ?? "");
      if (!admitted.ok) {
        throw new ApiHttpError(
          429,
          "RATE_LIMITED",
          "Too many Slack events, try again later",
          true,
          admitted.retryAfter,
        );
      }
      return ingest(context, next);
    },
    async (context) => {
      const agentId = context.req.param("agent_id") ?? "";
      const retry = {
        retry_num: retryNumOf(context.req.header("X-Slack-Retry-Num")),
        retry_reason: retryReasonOf(context.req.header("X-Slack-Retry-Reason")),
      };
      const outcome = await events.receive({
        agentId,
        rawBody: new Uint8Array(await context.req.arrayBuffer()),
        timestamp: context.req.header("X-Slack-Request-Timestamp") ?? null,
        signature: context.req.header("X-Slack-Signature") ?? null,
      });
      switch (outcome.kind) {
        case "unauthorized":
          logger?.warn("Slack event refused", { agent_id: agentId, ...retry });
          throw new ApiHttpError(401, "UNAUTHORIZED", REFUSED);
        case "bad_request":
          throw new ApiHttpError(400, "BAD_REQUEST", "Not a Slack event");
        case "challenge":
          return jsonWithSchema(context, slackEventsResponseSchema, {
            challenge: outcome.challenge,
          });
        case "ack":
          // A retry means an earlier try of this event failed before it was
          // answered here, which only Slack's headers tell.
          logger?.[retry.retry_num === null ? "info" : "warn"](
            "Slack event received",
            {
              agent_id: agentId,
              team_id: outcome.teamId ?? null,
              event_id: outcome.eventId ?? null,
              result: outcome.result,
              status: outcome.status ?? null,
              drop_reason: outcome.reason ?? null,
              ...retry,
            },
          );
          return jsonWithSchema(context, slackEventsResponseSchema, {
            ok: true,
          });
      }
    },
  );
}
