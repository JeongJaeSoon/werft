import type { ConversationId } from "@werft-ai/contracts";

/** Where a conversation is, and whose agent it belongs to. */
export type ConversationPlaceFacts = { agentId: string } & (
  | { kind: "channel"; channelId: string; private: boolean }
  | { kind: "dm"; personUserId: string }
);

/** A channel binding's listening setting (design 14). */
export type ConversationListening = "free" | "mention" | "off";

/**
 * What a conversation decision reads (design 9-3), each part from the store
 * that owns it. Read for every decision, never cached across requests.
 */
export interface ConversationAccess {
  /** Null when the conversation is not in this workspace. */
  placeOf(
    workspaceId: string,
    conversationId: ConversationId,
  ): Promise<ConversationPlaceFacts | null>;
  /** The user's active Slack link in the team of the agent's live install. */
  slackLinked(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<boolean>;
  /** As `ChannelMemberCheckable`: false whenever it cannot be told. */
  isMember(input: {
    workspaceId: string;
    agentId: string;
    channelId: string;
    userId: string;
  }): Promise<boolean>;
  archived(
    workspaceId: string,
    conversationId: ConversationId,
  ): Promise<boolean>;
  listening(
    workspaceId: string,
    conversationId: ConversationId,
  ): Promise<ConversationListening>;
}
