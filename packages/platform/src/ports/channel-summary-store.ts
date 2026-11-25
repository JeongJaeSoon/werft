import type {
  ChannelSummaryLineId,
  ConversationInputId,
} from "@werft-ai/contracts";
import type { SourceKey } from "../conversations/index.ts";

/** The channel a summary is of: one per channel, shared by its agents. */
export type ChannelSummaryPlace = {
  workspaceId: string;
  teamId: string;
  channelId: string;
};

/**
 * What a new line read: an input, or a message a summary line it read came
 * from. `editedAt`: when the text read was last edited; unset, the text is
 * taken as the message's first.
 */
export type ChannelSummarySourceKey = SourceKey & { editedAt?: Date | null };

/**
 * A line an agent adds: its own text and everything the call that made it
 * read (decision 37). Who spoke is the input row's, or the summary source
 * row's, to say, never the writer's (G8), so it is not taken here.
 */
export type NewChannelSummaryLine = {
  text: string;
  sources: readonly ChannelSummarySourceKey[];
};

/** A Slack message a line came from, as the server read it off the input row. */
export type ChannelSummarySource = {
  inputId: ConversationInputId;
  teamId: string;
  channelId: string;
  ts: string;
  /** The input's requester; a kind the reader does not know is unknown. */
  speaker: { kind: string; id: string };
  /**
   * When the text the line was made from was written: its last edit, else
   * the message's ts. An edit mark at or before it leaves the line.
   */
  at: Date;
};

export type ChannelSummaryLine = {
  id: ChannelSummaryLineId;
  text: string;
  writtenByAgentId: string;
  writtenAt: Date;
  /** One for an added line; every folded line's for a folded one. */
  sources: ChannelSummarySource[];
};

export type ChannelSummary = { version: number; lines: ChannelSummaryLine[] };

export type ChannelSummaryWriteResult =
  | {
      outcome: "written";
      version: number;
      lineIds: ChannelSummaryLineId[];
      /** Inputs whose message is already marked deleted or edited: no line. */
      skipped: ConversationInputId[];
    }
  // The summary is at another version than the writer read; read again.
  | { outcome: "conflict"; version: number }
  // Neither an input of the writing agent with a Slack place nor a source
  // of a line of this channel's summary.
  | { outcome: "invalid_source"; source: SourceKey }
  | { outcome: "invalid_text" }
  // Not a line of the current version.
  | { outcome: "line_not_found"; lineId: ChannelSummaryLineId }
  | { outcome: "version_not_found" };

type Expected = { place: ChannelSummaryPlace; expectedVersion: number };

/**
 * A channel's summary, versioned: every change is one version up, and a
 * write names the version it read (compare-and-set; retries are the
 * caller's). A line lives from the version that added it to the one that
 * folded or reverted it away. A line whose source message is deleted or
 * edited after the text the line was made from is removed from every
 * version, so no revert brings it back.
 */
export interface ChannelSummaryStore {
  /** The summary as of `version` (the current one by default); null if none. */
  read(
    place: ChannelSummaryPlace,
    version?: number,
  ): Promise<ChannelSummary | null>;
  append(
    request: Expected & { agentId: string; lines: NewChannelSummaryLine[] },
  ): Promise<ChannelSummaryWriteResult>;
  /** Replaces current lines with one whose sources are all of theirs. */
  fold(
    request: Expected & {
      agentId: string;
      lineIds: ChannelSummaryLineId[];
      text: string;
    },
  ): Promise<ChannelSummaryWriteResult>;
  /** Makes a new version holding what `toVersion` held, as it holds now. */
  revert(
    request: Expected & { toVersion: number },
  ): Promise<ChannelSummaryWriteResult>;
  /** Removes the channel's summary, its lines and history. */
  deleteChannel(place: ChannelSummaryPlace): Promise<{ lines: number }>;
}

/**
 * How long an old version stays: one current at any time in this window
 * can be read and reverted to; an older one is removed (Architect, 94S-2107).
 */
export const CHANNEL_SUMMARY_HISTORY_MS = 7 * 24 * 60 * 60_000;
