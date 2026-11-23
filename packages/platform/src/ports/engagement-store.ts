/** A Slack thread as an agent's install sees it. */
export type EngagedThreadQuery = {
  agentId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
};

/**
 * The agent's engagement records. A record holds no thread: a thread is
 * engaged when a session the agent took part in is linked to it, the link
 * open, closed or revoked.
 */
export interface EngagementStore {
  engagedThread(query: EngagedThreadQuery): Promise<boolean>;
}
