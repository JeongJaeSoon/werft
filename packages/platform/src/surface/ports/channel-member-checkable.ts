/**
 * Whether a Werft user is, right now, a member of a channel the agent's
 * Slack install can see (design 9-3). False whenever that cannot be told:
 * no live install or Slack link, no bot token, the bot out of the channel,
 * Slack failing or rate limiting, a channel past the member limit. Never
 * throws, so a caller hides what it cannot confirm.
 */
export interface ChannelMemberCheckable {
  isMember(input: ChannelMemberQuestion): Promise<boolean>;
  /**
   * isMember with the unknown kept apart: `unconfirmed` whenever isMember
   * would answer false without knowing. For a check that must not widen
   * anything on a guess (a requester taken to have left).
   */
  membership(input: ChannelMemberQuestion): Promise<ChannelMembership>;
  /**
   * membership read from the cached list alone, for a read across sessions
   * (a list, a count): Slack is never asked while the caller waits.
   * `pending` when no list is cached: one is read in the background, and a
   * later read answers. A list close to its TTL answers and is read again
   * in the background.
   */
  cachedMembership(
    input: ChannelMemberQuestion,
  ): Promise<ChannelMembership | "pending">;
}

export type ChannelMemberQuestion = {
  workspaceId: string;
  agentId: string;
  channelId: string;
  userId: string;
};

export type ChannelMembership = "member" | "not_member" | "unconfirmed";

/** A channel's cached member list; `checkedAt` is the database's clock. */
export type ChannelMemberRead = {
  memberIds: readonly string[] | null;
  checkedAt: Date;
  /** When the list `memberIds` holds was read from Slack; null with none. */
  fetchedAt: Date | null;
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
   * Stores a list Slack answered for a read that began at `checkedAt`;
   * true when kept. Dropped, and then the list must not answer either, when
   * the channel was voided since, the install was revoked or verified again
   * since, or the read outlived the TTL.
   */
  remember(
    installationId: string,
    channelId: string,
    memberIds: readonly string[],
    checkedAt: Date,
  ): Promise<boolean>;
  /** Voids the channel's list: someone joined or left it. */
  forget(installationId: string, channelId: string): Promise<void>;
}
