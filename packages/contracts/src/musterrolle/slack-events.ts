import { z } from "zod";

import { agentIdSchema } from "../shared/index.ts";
import { SLACK_EVENT_DROP_REASON_VALUES } from "./agent-identities.ts";

/**
 * Slack's events request bound: larger than the API's own body limit, since
 * a message event carries blocks and attachments as well as its text.
 */
export const SLACK_EVENTS_BODY_MAX_BYTES = 256 * 1024;

/** How far a request's `X-Slack-Request-Timestamp` may be from now. */
export const SLACK_SIGNATURE_WINDOW_SECONDS = 300;

/**
 * `received`: waiting for the channel to act on it. `dropped`: kept only so
 * a retry stays deduplicated and the drop can be read back; its payload is
 * not stored. `processed`: handled, where it arrived (an uninstall) or by
 * the `slack` role. `failed`: the role gave up on it after
 * SLACK_INBOUND_MAX_ATTEMPTS attempts.
 */
export const SLACK_INBOUND_EVENT_STATUS_VALUES = [
  "received",
  "dropped",
  "processed",
  "failed",
] as const;

/** Claims of one event, lease expiries included, before it is `failed`. */
export const SLACK_INBOUND_MAX_ATTEMPTS = 5;

/**
 * Why an event was dropped at the door: the install checks of
 * `SLACK_EVENT_DROP_REASON_VALUES`, plus
 * - `app_mismatch`: the event names another app than the path agent's.
 * - `bot_message`: posted by a bot (`bot_id`).
 * - `own_bot_user`: posted as this app's bot user.
 * - `message_subtype`: a message subtype the channel does not take.
 * - `unsupported_event`: an event type the app never subscribes to.
 * - `user_tokens_only`: `tokens_revoked` named no bot token.
 * - `channel_pending_approval`: a message in a private channel that waits for
 *   approval and does not mention the bot; its text is not kept.
 */
export const SLACK_INBOUND_DROP_REASON_VALUES = [
  ...SLACK_EVENT_DROP_REASON_VALUES,
  "app_mismatch",
  "bot_message",
  "own_bot_user",
  "message_subtype",
  "unsupported_event",
  "user_tokens_only",
  "channel_pending_approval",
] as const;

/** Message subtypes kept besides a plain message (no subtype). */
export const SLACK_ACCEPTED_MESSAGE_SUBTYPES = ["thread_broadcast"] as const;

/** The `event.type` values the agent app's subscriptions deliver. */
export const SLACK_INBOUND_EVENT_TYPES = [
  "app_mention",
  "message",
  "member_joined_channel",
  "member_left_channel",
  "app_uninstalled",
  "tokens_revoked",
] as const;

export const slackEventsParamsSchema = z
  .object({ agent_id: agentIdSchema })
  .strict();

const slackRequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/);

export const slackUrlVerificationSchema = z.looseObject({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(256),
});

export const slackEventCallbackSchema = z.looseObject({
  type: z.literal("event_callback"),
  team_id: slackRequestIdSchema,
  api_app_id: slackRequestIdSchema,
  event_id: slackRequestIdSchema,
  event_time: z.number().int().nonnegative().optional(),
  event: z.looseObject({
    type: z.string().min(1).max(64),
    subtype: z.string().max(64).optional(),
    user: z.string().max(64).optional(),
    bot_id: z.string().max(64).optional(),
  }),
});

/** Any other envelope type (e.g. `app_rate_limited`) is acknowledged and ignored. */
export const slackEventEnvelopeSchema = z.union([
  slackUrlVerificationSchema,
  slackEventCallbackSchema,
  z.looseObject({ type: z.string().min(1).max(64) }),
]);

export const slackEventsAckSchema = z.object({ ok: z.literal(true) }).strict();
export const slackUrlVerificationResponseSchema = z
  .object({ challenge: z.string() })
  .strict();
export const slackEventsResponseSchema = z.union([
  slackUrlVerificationResponseSchema,
  slackEventsAckSchema,
]);

export type SlackInboundEventStatus =
  (typeof SLACK_INBOUND_EVENT_STATUS_VALUES)[number];
export type SlackInboundDropReason =
  (typeof SLACK_INBOUND_DROP_REASON_VALUES)[number];
export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;
