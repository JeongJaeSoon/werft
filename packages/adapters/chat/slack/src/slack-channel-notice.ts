import type { SlackNoticeVersion } from "@werft-ai/contracts";
import type { SurfaceOutboxStore } from "@werft-ai/platform";

/**
 * The line a channel hears when the agent starts reading every message of
 * it, in each notice language, Korean first. It names no agent: the post goes
 * out under the agent's own Slack name and icon. The outbox escapes it, so it
 * notifies no one.
 */
export const SLACK_CHANNEL_NOTICE_LINES = [
  "이 채널의 글을 에이전트가 짧게 읽고 판단해요. 관여한 것만 남겨요.",
  "このチャンネルの投稿をエージェントが短時間読んで判断します。関わったものだけを残します。",
] as const;

export function slackChannelNoticeText(): string {
  return SLACK_CHANNEL_NOTICE_LINES.join("\n");
}

/**
 * Once per agent, channel and notice version that asked for approval: a
 * version that only rewords one, listening turned off and on, or a switch
 * lowered and raised again finds it taken. Channel ids are only unique
 * within a Slack team.
 */
export function slackChannelNoticeDedupeKey(target: {
  agentId: string;
  teamId: string;
  channelId: string;
  noticeVersion: SlackNoticeVersion;
}): string {
  return `channel-notice:${target.agentId.toLowerCase()}:${target.teamId}:${target.channelId}:${target.noticeVersion}`;
}

/**
 * Tells each channel the agent has started reading every message of, once;
 * the one post the agent makes in `shadow`. Returns the channels found.
 */
export async function enqueueSlackChannelNotices(deps: {
  outbox: Pick<SurfaceOutboxStore, "unnoticedChannels" | "enqueue">;
  limit: number;
}): Promise<number> {
  const unnoticedChannels = deps.outbox.unnoticedChannels;
  if (unnoticedChannels === undefined) return 0;
  const targets = await unnoticedChannels.call(deps.outbox, deps.limit);
  for (const target of targets) {
    await deps.outbox.enqueue({
      workspaceId: target.workspaceId,
      agentId: target.agentId.toLowerCase(),
      slackAppId: target.slackAppId,
      installationId: target.installationId,
      kind: "channel_notice",
      channelId: target.channelId,
      threadTs: "",
      slackUserId: null,
      sessionId: null,
      sessionLinkId: null,
      body: { text: slackChannelNoticeText() },
      dedupeKey: slackChannelNoticeDedupeKey(target),
    });
  }
  return targets.length;
}
