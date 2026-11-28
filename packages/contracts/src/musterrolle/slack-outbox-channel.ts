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

/** Why a row bound for the top of a direct message was refused. */
export const SLACK_DM_THREAD_REQUIRED_CODE = "dm_thread_required";

// The rows that may stand at the top of a direct message: a web input's
// mirror, which opens the thread its answers go into, and the line that the
// agent was stopped, which belongs to no thread.
const DM_TOP_LEVEL_KINDS: ReadonlySet<string> = new Set([
  "input_mirror",
  "emergency_stop_notice",
]);

/**
 * A row for a direct message (`D…`) with no thread: every answer, progress
 * message and report in a DM goes in the thread of the person's DM post
 * (v1-b/DM2), as Slack shows and streams a bot's DM answers there alone.
 */
export function slackOutboxDmThreadRefused(row: {
  kind: string;
  channelId: string;
  threadTs: string;
}): boolean {
  return (
    row.channelId.startsWith("D") &&
    row.threadTs === "" &&
    !DM_TOP_LEVEL_KINDS.has(row.kind)
  );
}
