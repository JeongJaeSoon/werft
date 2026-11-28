import { z } from "zod";
import type { SlackUserKind } from "./authorization.ts";

/**
 * `external`: shared with another organization (Slack Connect). A channel
 * shared only among the workspaces of one Enterprise is `internal`.
 */
export const SLACK_CHANNEL_SHARING_VALUES = ["internal", "external"] as const;
export const slackChannelSharingSchema = z.enum(SLACK_CHANNEL_SHARING_VALUES);
export type SlackChannelSharing = z.infer<typeof slackChannelSharingSchema>;

/**
 * Whether `conversations.info`'s channel is shared with another
 * organization. Slack sets `is_ext_shared` on every channel; one that does
 * not say is taken as shared.
 */
export function slackChannelSharingOf(channel: {
  is_ext_shared?: boolean | undefined;
}): SlackChannelSharing {
  return channel.is_ext_shared === false ? "internal" : "external";
}

/**
 * Why an unmentioned post is kept from what the agent hears. People of
 * another organization never agreed to the notice, so a channel shared with
 * one is not heard at all, its own members' posts included; a guest is not
 * heard whatever the workspace allows guests to ask.
 */
export const SLACK_UNHEARD_REASON_VALUES = [
  "external_shared_channel",
  "guest_author",
  "external_author",
  // Slack could not be asked, so neither could be ruled out.
  "audience_unconfirmed",
] as const;
export type SlackUnheardReason = (typeof SLACK_UNHEARD_REASON_VALUES)[number];

/** The one rule the buffer, the judgment and the read tools share. */
export function slackUnheardReasonOf(input: {
  sharing: SlackChannelSharing | null;
  author: SlackUserKind | null;
}): SlackUnheardReason | null {
  if (input.sharing === "external") return "external_shared_channel";
  if (input.sharing === null) return "audience_unconfirmed";
  if (input.author === "guest") return "guest_author";
  if (input.author === "external") return "external_author";
  if (input.author === null) return "audience_unconfirmed";
  return null;
}
