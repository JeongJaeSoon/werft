import type {
  ChannelSummaryLineId,
  ConversationId,
  ConversationInputId,
  ConversationTopicId,
  ConversationTurnId,
  EngagementKind,
  ScopeKey,
} from "@werft-ai/contracts";
import type { SourceKey } from "../conversations/index.ts";
import type { ConversationKey } from "./conversation-store.ts";

/**
 * A piece of context, tagged with the scope it was read under (taken from
 * the row it came from, not from the conversation that asked) and the
 * inputs it came from. Never a Slack message's text but a buffered one's.
 */
export type ContextFragment = { scope: ScopeKey; sources: SourceKey[] } & (
  | {
      kind: "channel_summary_line";
      lineId: ChannelSummaryLineId;
      text: string;
      writtenByAgentId: string;
      writtenAt: Date;
    }
  | {
      kind: "engagement";
      engagementKind: EngagementKind;
      /** What the agent took part through: a session, or a conversation turn. */
      target:
        | { kind: "session"; sessionId: string }
        | { kind: "conversation_turn"; turnId: ConversationTurnId };
      at: Date;
    }
  | {
      /** An answer the agent gave earlier in the topic, by a conversation turn. */
      kind: "conversation_turn";
      turnId: ConversationTurnId;
      answer: string;
      endedAt: Date;
    }
  | {
      kind: "buffered_message";
      inputId: ConversationInputId;
      body: string;
      poster: { kind: string; id: string };
      receivedAt: Date;
    }
);

export type ContextFragmentKind = ContextFragment["kind"];

/** What a source read for one conversation. */
export type ContextRead = {
  fragments: ContextFragment[];
  /** Left out: their text could not be read again where it points (deleted, no access). */
  unreadable: number;
};

/**
 * Reads the fragments of one main conversation: its channel's summary
 * lines, the agent's engagement records and its buffered messages, and, for
 * a topic, the answers of that topic's earlier turns; a message's text and
 * an answer read again from where they point. None whose source Slack
 * deleted; none when the agent has no such conversation. Only the context
 * assembler reads through it (G1, checked in tests/architecture.test.ts).
 */
export interface ContextFragmentSource {
  read(
    conversation: ConversationKey,
    options?: { topicId?: ConversationTopicId },
  ): Promise<ContextRead>;
  /** The key of the agent's conversation, null when it has none of that id. */
  conversationOf(ref: {
    workspaceId: string;
    agentId: string;
    conversationId: ConversationId;
  }): Promise<ConversationKey | null>;
  /** When an admin last deleted the conversation's records; null when never, or no such conversation. */
  recordsDeletedAt(ref: {
    workspaceId: string;
    agentId: string;
    conversationId: ConversationId;
  }): Promise<Date | null>;
  /** Whether Slack deleted any of these sources: check place ① for what a live session holds. */
  anyDeleted(
    workspaceId: string,
    sources: readonly SourceKey[],
  ): Promise<boolean>;
}
