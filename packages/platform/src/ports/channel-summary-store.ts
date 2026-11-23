import type {
  ChannelSummaryLineId,
  ConversationInputId,
} from "@werft-ai/contracts";

/** The channel a summary is of: one per channel, shared by its agents. */
export type ChannelSummaryPlace = {
  workspaceId: string;
  teamId: string;
  channelId: string;
};

/**
 * A line an agent adds: its own text and the input it sums up. Who spoke and
 * where are the input row's to say, never the writer's (G8), so neither is
 * taken here.
 */
export type NewChannelSummaryLine = {
  text: string;
  inputId: ConversationInputId;
};

/** A Slack message a line came from, as the server read it off the input row. */
export type ChannelSummarySource = {
  inputId: ConversationInputId;
  teamId: string;
  channelId: string;
  ts: string;
  /** The input's requester; a kind the reader does not know is unknown. */
  speaker: { kind: string; id: string };
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
  // Not an input of the writing agent in this channel with a Slack place.
  | { outcome: "invalid_source"; inputId: ConversationInputId }
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
 * edited is removed from every version, so no revert brings it back.
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
