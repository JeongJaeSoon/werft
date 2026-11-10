import type { SlackInboxLogger } from "./slack-inbox.ts";
import type { SlackNoticeSink } from "./slack-notice-sink.ts";

/**
 * Keeps each refusal notice as one log line until 94S-792's outbox sends
 * it; the notice's text and link stay out of the log.
 */
export function createLoggingSlackNoticeSink(
  logger: SlackInboxLogger,
): SlackNoticeSink {
  return {
    async record(notice) {
      logger.info("Slack notice held for delivery", {
        workspace_id: notice.workspaceId,
        agent_id: notice.agentId,
        installation_id: notice.installationId,
        channel_id: notice.channelId,
        thread_ts: notice.threadTs,
        slack_user_id: notice.slackUserId,
        reason: notice.reason,
        once_key: notice.onceKey,
      });
    },
  };
}
