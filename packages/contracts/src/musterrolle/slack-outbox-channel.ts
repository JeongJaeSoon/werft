/** Why a row aimed at a person rather than a conversation was refused. */
export const SLACK_USER_CHANNEL_CODE = "user_channel";

/**
 * A Slack user id (`U…`, or `W…` on Enterprise Grid) as an outbox row's
 * channel would have chat.postMessage open a direct message the person never
 * started, and the agent opens none first (design v3 decision 45). No kind
 * goes that way: a model notice goes to its session's thread. The
 * `slack_outbox_channel_check` constraint still lets a model notice in, for
 * the image before this one; such a row fails at send.
 */
export function slackOutboxChannelRefused(channelId: string): boolean {
  return /^[UW]/.test(channelId);
}
