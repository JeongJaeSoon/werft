import type { ConversationId, ConversationTopicId } from "@werft-ai/contracts";

/** What names one main conversation of one agent. */
export type ConversationKey =
  | {
      kind: "channel";
      workspaceId: string;
      agentId: string;
      /** Slack team id. */
      teamId: string;
      channelId: string;
    }
  | {
      kind: "dm";
      workspaceId: string;
      agentId: string;
      /** A Werft user id, not a Slack one. */
      personUserId: string;
    };

export type Conversation = ConversationKey & { id: ConversationId };

/** A chat thread: its team, its channel, and its root message's ts. */
export type ThreadAlias = {
  teamId: string;
  channelId: string;
  threadTs: string;
};

export type ConversationTopic = {
  id: ConversationTopicId;
  conversationId: ConversationId;
  /** Null for a web topic Slack has not placed yet. */
  thread: ThreadAlias | null;
};

/**
 * Main conversations and their topics. Each find-or-create gives every caller
 * one row however many race for it.
 */
export interface ConversationStore {
  /** A channel conversation makes its channel context too. */
  findOrCreateConversation(key: ConversationKey): Promise<Conversation>;
  /**
   * The topic of a Slack thread in `conversationId`. Throws when the
   * conversation is missing, when a channel conversation is asked for a
   * thread of another channel, or when the thread is already another
   * conversation's topic.
   */
  findOrCreateThreadTopic(
    conversationId: ConversationId,
    thread: ThreadAlias,
  ): Promise<ConversationTopic>;
}
