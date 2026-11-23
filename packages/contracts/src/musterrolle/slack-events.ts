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

/** Why an event was dropped at the door. */
export const SLACK_INBOUND_DROP_REASON_VALUES = [
  // The install checks.
  ...SLACK_EVENT_DROP_REASON_VALUES,
  // The event names another app than the path agent's.
  "app_mismatch",
  // Posted by a bot (`bot_id`) the agent allows, but not as a direct mention
  // outside a DM; also a legacy bot post that names no user.
  "bot_message",
  // Posted by a bot while the agent's allow list is empty.
  "bot_allowlist_empty",
  // Posted by a bot that is not on the agent's allow list.
  "bot_not_allowed",
  // Posted by this app: as its bot user, or under another name (an
  // instruction the outbox posted for its sender) with this app's `app_id`.
  "own_bot_user",
  // Posted by another agent's bot of this Werft install, allowed or not.
  "werft_agent_bot",
  // Posted by Slackbot (`USLACK`), in a DM or a channel: never a person.
  "slackbot",
  // A message subtype the channel does not take.
  "message_subtype",
  // An event type the app never subscribes to.
  "unsupported_event",
  // `tokens_revoked` named no bot token.
  "user_tokens_only",
  // A message in a private channel that waits for approval and does not
  // mention the bot; its text is not kept.
  "channel_pending_approval",
  // An event of a private channel the bot left (binding `left`); its text is
  // not kept and nobody is answered.
  "channel_left",
  // An event of a channel Slack deleted (binding `gone`); its text is not
  // kept and nobody is answered.
  "channel_gone",
] as const;

/** Message subtypes kept besides a plain message (no subtype). */
export const SLACK_ACCEPTED_MESSAGE_SUBTYPES = ["thread_broadcast"] as const;

/**
 * The messages Slack posts in a channel made private or public: taken, text
 * dropped, so the channel's binding and sessions follow its kind.
 */
export const SLACK_CHANNEL_CONVERSION_SUBTYPES = [
  "channel_convert_to_private",
  "channel_convert_to_public",
] as const;

/** The `event.type` values the agent app's subscriptions deliver. */
export const SLACK_INBOUND_EVENT_TYPES = [
  "app_mention",
  "message",
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_archive",
  "channel_unarchive",
  "group_archive",
  "group_unarchive",
  "channel_rename",
  "group_rename",
  "channel_deleted",
  "group_deleted",
  "app_uninstalled",
  "tokens_revoked",
] as const;

/** The events that say a channel was archived, unarchived, renamed or deleted. */
export const SLACK_CHANNEL_LIFECYCLE_EVENT_TYPES = [
  "channel_archive",
  "channel_unarchive",
  "group_archive",
  "group_unarchive",
  "channel_rename",
  "group_rename",
  "channel_deleted",
  "group_deleted",
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

/**
 * Who posted a dropped event and what kind it was, so a drop can be told
 * apart afterwards. Never text, blocks, attachments or files.
 */
export type SlackInboundDropFields = {
  bot_id?: string;
  app_id?: string;
  user?: string;
  subtype?: string;
  message?: { subtype: string };
  /**
   * The message metadata's `event_type`, and the correlation id of a web
   * input's mirror; never the rest of `event_payload`.
   */
  metadata?: { event_type: string; correlation_id?: string };
};
