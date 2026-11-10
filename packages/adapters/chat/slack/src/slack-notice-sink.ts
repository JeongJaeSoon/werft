import type { SlackNotice } from "@werft-ai/contracts";

/**
 * A refusal the person who typed should see, alone, once per thread
 * (design 3.3). 94S-792 delivers it as an ephemeral message.
 */
export type SlackNoticeRecord = {
  workspaceId: string;
  agentId: string;
  installationId: string;
  slackAppId: string;
  teamId: string;
  channelId: string;
  /** The thread's root ts, where the ephemeral answer goes. */
  threadTs: string;
  slackUserId: string;
  /** The policy's reason, or the channel kind Slack's event disagreed on. */
  reason: string;
  notice: SlackNotice;
  /** `<installationId>:<surfaceRef>:<slackUserId>`: the same key, one notice. */
  onceKey: string;
};

export interface SlackNoticeSink {
  record(notice: SlackNoticeRecord): Promise<void>;
}
