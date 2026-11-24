import type {
  ChannelSummaryLineId,
  ConversationInputId,
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
      sessionId: string;
      at: Date;
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
 * lines, the agent's engagement records and its buffered messages, a
 * message's text read again from where it points. None whose source Slack
 * deleted; none when the agent has no such conversation. Only the context
 * assembler reads through it (G1, checked in tests/architecture.test.ts).
 */
export interface ContextFragmentSource {
  read(conversation: ConversationKey): Promise<ContextRead>;
}
