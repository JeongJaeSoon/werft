/**
 * Whether a Werft user is, right now, a member of a channel the agent's
 * Slack install can see (design 9-3). False whenever that cannot be told:
 * no live install or Slack link, no bot token, the bot out of the channel,
 * Slack failing or rate limiting, a channel past the member limit. Never
 * throws, so a caller hides what it cannot confirm.
 */
export interface ChannelMemberCheckable {
  isMember(input: {
    workspaceId: string;
    agentId: string;
    channelId: string;
    userId: string;
  }): Promise<boolean>;
}

/** A channel's cached member list; `checkedAt` is the database's clock. */
export type ChannelMemberRead = {
  memberIds: readonly string[] | null;
  checkedAt: Date;
};

/**
 * The member lists read from Slack, kept `SLACK_MEMBER_CACHE_TTL_MS`. Only
 * Slack user ids and times; never what anyone wrote.
 */
export interface ChannelMemberStore {
  /**
   * The agent's live install (the newest active identity on a verified
   * install) and the user's active Slack link in that install's team.
   */
  subject(input: {
    workspaceId: string;
    agentId: string;
    userId: string;
  }): Promise<{ installationId: string; slackUserId: string } | null>;
  /**
   * The list read within the TTL and not voided since; null otherwise.
   * `checkedAt` is what a read from Slack after this passes to `remember`.
   */
  cached(installationId: string, channelId: string): Promise<ChannelMemberRead>;
  /**
   * Stores a list Slack answered for a read that began at `checkedAt`.
   * Dropped when the channel was voided since, or the read outlived the TTL.
   */
  remember(
    installationId: string,
    channelId: string,
    memberIds: readonly string[],
    checkedAt: Date,
  ): Promise<void>;
  /** Voids the channel's list: someone joined or left it. */
  forget(installationId: string, channelId: string): Promise<void>;
}
