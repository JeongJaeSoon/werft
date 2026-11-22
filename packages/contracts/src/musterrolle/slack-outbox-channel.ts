/** Why a row aimed at a person rather than a conversation was refused. */
export const SLACK_USER_CHANNEL_CODE = "user_channel";

/**
 * A Slack user id (`U…`, or `W…` on Enterprise Grid) as an outbox row's
 * channel would have chat.postMessage open a direct message the person never
 * started, and the agent opens none first (design v3 decision 45). Only a
 * model notice still goes that way, until it moves into its session's thread;
 * the `slack_outbox_channel_check` constraint says the same.
 */
export function slackOutboxChannelRefused(
  kind: string,
  channelId: string,
): boolean {
  return kind !== "model_notice" && /^[UW]/.test(channelId);
}
