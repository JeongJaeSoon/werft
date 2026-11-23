import type {
  ConversationChannelState,
  ConversationId,
  ConversationTopicId,
} from "@werft-ai/contracts";

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

/** An agent's channel conversation, by the channel Slack names. */
export type ChannelConversationKey = Extract<
  ConversationKey,
  { kind: "channel" }
>;

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
  /**
   * Notes Slack archiving, unarchiving or deleting the channel at `at`
   * (microseconds since the epoch) on its conversation, when the agent has
   * one there; none is made. An archive or unarchive older than the state
   * already noted changes nothing, nor does anything after `deleted`, which
   * is final. A null `at` cannot be ordered and applies. False when the row
   * did not change.
   */
  recordChannelState(
    key: ChannelConversationKey,
    state: Exclude<ConversationChannelState, "active"> | "unarchived",
    at: number | null,
  ): Promise<boolean>;
  /** The channel's new name from a rename at `at`, by the same rules. */
  recordChannelName(
    key: ChannelConversationKey,
    name: string,
    at: number | null,
  ): Promise<boolean>;
}
