import {
  type ChannelSummaryLineId,
  CONVERSATION_TOPIC_SESSION_MAX_BYTES,
  CONVERSATION_TURN_FRESH_TEXT_MAX,
  type ConversationId,
  type ConversationInputId,
  type ConversationTopicId,
  type ScopeKey,
  scopeKeyOf,
} from "@werft-ai/contracts";
import type {
  ContextFragment,
  ContextFragmentSource,
  ContextRead,
} from "../ports/context-fragment-source.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";
import { mergeSources, type SourceKey } from "./source-sets.ts";

/**
 * The scopes a conversation may read (9-2): a channel conversation its
 * channel's, a DM its person's, and either its agent's. Another channel,
 * another person's DM and a person scope in a channel are never in it.
 */
export function readableScopes(conversation: ConversationKey): ScopeKey[] {
  const own =
    conversation.kind === "channel"
      ? scopeKeyOf({
          kind: "channel",
          workspaceId: conversation.workspaceId,
          teamId: conversation.teamId,
          channelId: conversation.channelId,
        })
      : scopeKeyOf({
          kind: "person",
          workspaceId: conversation.workspaceId,
          userId: conversation.personUserId,
        });
  return [
    own,
    scopeKeyOf({
      kind: "agent",
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
    }),
  ];
}

/**
 * The context assembler (G1): the fragments a conversation may read, each
 * with its scope and sources. A fragment whose scope is not one the
 * conversation reads is dropped here even if the source returned it.
 * Calls no model. The order and the size cut are fitContext's.
 */
export async function assembleContext(
  source: ContextFragmentSource,
  conversation: ConversationKey,
): Promise<ContextFragment[]> {
  return (await readContext(source, conversation)).fragments;
}

async function readContext(
  source: ContextFragmentSource,
  conversation: ConversationKey,
  topicId?: ConversationTopicId,
): Promise<ContextRead> {
  const readable = new Set<string>(readableScopes(conversation));
  const read = await source.read(
    conversation,
    topicId === undefined ? undefined : { topicId },
  );
  return {
    fragments: read.fragments.filter((fragment) =>
      readable.has(fragment.scope),
    ),
    unreadable: read.unreadable,
    ...(read.summaryVersion === undefined
      ? {}
      : { summaryVersion: read.summaryVersion }),
  };
}

/** The cut's start value: design v3's 8k tokens, as UTF-8 request bytes. */
export const CONTEXT_CAP_BYTES = 24_576;
/** A post goes in at most this many characters (graphemes). */
export const POST_CHAR_LIMIT = 2_000;
/** The share of the cap one batch of current posts may take together. */
export const CURRENT_POSTS_SHARE = 0.5;
/** What each piece costs past its text: the caller's framing of it. */
export const PIECE_OVERHEAD_BYTES = 32;

/** A post the call is about, handed in by its caller. Never dropped. */
export type CurrentPost = {
  inputId: ConversationInputId | null;
  body: string;
  sources: SourceKey[];
  receivedAt: Date;
};

/**
 * The order kinds are cut in, first to go first, and from which end of
 * their kind. Instructions and current posts are not in it: never cut.
 */
const CUT_ORDER: readonly {
  kind: ContextFragment["kind"];
  from: "oldest" | "last";
}[] = [
  // The back of the summary: its last lines.
  { kind: "channel_summary_line", from: "last" },
  { kind: "engagement", from: "oldest" },
  { kind: "conversation_turn", from: "oldest" },
  { kind: "buffered_message", from: "oldest" },
];

/** The order pieces are laid out in, before the current posts. */
const PLACE_ORDER: readonly ContextFragment["kind"][] = [
  "channel_summary_line",
  "engagement",
  "conversation_turn",
  "buffered_message",
];

const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

const bytesOf = (text: string) => encoder.encode(text).length;

/** At most `limit` characters, never splitting one. */
export function truncatePost(text: string, limit = POST_CHAR_LIMIT): string {
  let kept = 0;
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (kept === limit) return text.slice(0, end);
    kept += 1;
    end += segment.length;
  }
  return text;
}

function timeOf(fragment: ContextFragment): number {
  switch (fragment.kind) {
    case "channel_summary_line":
      return fragment.writtenAt.getTime();
    case "engagement":
      return fragment.at.getTime();
    case "conversation_turn":
      return fragment.endedAt.getTime();
    case "buffered_message":
      return fragment.receivedAt.getTime();
  }
}

/**
 * The text a fragment puts before the model, which the cap is counted on:
 * the caller renders a piece as this within PIECE_OVERHEAD_BYTES of framing.
 */
export function fragmentText(fragment: ContextFragment): string {
  switch (fragment.kind) {
    case "channel_summary_line":
      return fragment.text;
    case "engagement":
      return `${fragment.engagementKind} ${fragment.target.kind === "session" ? fragment.target.sessionId : fragment.target.turnId} ${fragment.at.toISOString()}`;
    case "conversation_turn":
      return fragment.answer;
    case "buffered_message":
      return fragment.body;
  }
}

const pieceBytes = (text: string) => PIECE_OVERHEAD_BYTES + bytesOf(text);

export type FittedContext =
  | {
      outcome: "fitted";
      instructions: string;
      /** In PLACE_ORDER, oldest first within a kind; posts cut to size. */
      fragments: ContextFragment[];
      /** Oldest first, each cut to POST_CHAR_LIMIT. */
      current: CurrentPost[];
      /** Current posts past their share, oldest first: not in this call. */
      left: CurrentPost[];
      /** What the kept pieces came from; a cut piece's sources are not in it. */
      sources: { keys: SourceKey[]; overflow: boolean };
      bytes: number;
    }
  // Nothing can be cut and it still passes the cap: no call, no reservation.
  | {
      outcome: "too_large";
      /** `instructions`: they alone pass it; else with the newest post. */
      reason: "instructions" | "current_post";
      bytes: number;
      capBytes: number;
    };

/**
 * Lays fragments out in the order the model reads them and cuts them to
 * `capBytes` (UTF-8 bytes of their text and framing), by CUT_ORDER. The
 * instructions and current posts are never dropped; current posts past their
 * share of the cap are left for a later call, oldest first.
 */
export function fitContext(input: {
  instructions: string;
  current: readonly CurrentPost[];
  fragments: readonly ContextFragment[];
  capBytes?: number;
  currentShare?: number;
}): FittedContext {
  const capBytes = input.capBytes ?? CONTEXT_CAP_BYTES;
  const share = input.currentShare ?? CURRENT_POSTS_SHARE;
  const instructionBytes = pieceBytes(input.instructions);

  const posts = [...input.current]
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    .map((post) => ({ ...post, body: truncatePost(post.body) }));
  // Newest first, so the posts left out are the oldest.
  const current: CurrentPost[] = [];
  const left: CurrentPost[] = [];
  let currentBytes = 0;
  // The batch's share, and never more than the instructions leave.
  const batchBytes = Math.min(
    Math.floor(capBytes * share),
    capBytes - instructionBytes,
  );
  for (const post of [...posts].reverse()) {
    const bytes = pieceBytes(post.body);
    // Once one does not fit, every older one waits too: a batch is the newest run.
    if (
      left.length === 0 &&
      (current.length === 0 || currentBytes + bytes <= batchBytes)
    ) {
      current.unshift(post);
      currentBytes += bytes;
    } else {
      left.unshift(post);
    }
  }
  const fixed = instructionBytes + currentBytes;
  if (fixed > capBytes) {
    return {
      outcome: "too_large",
      reason: instructionBytes > capBytes ? "instructions" : "current_post",
      bytes: fixed,
      capBytes,
    };
  }

  const currentIds = new Set(
    input.current.flatMap((post) => (post.inputId ? [post.inputId] : [])),
  );
  const byKind = new Map<ContextFragment["kind"], ContextFragment[]>();
  for (const kind of PLACE_ORDER) byKind.set(kind, []);
  for (const fragment of input.fragments) {
    // A current post is not read twice, nor one left for a later call.
    if (
      fragment.kind === "buffered_message" &&
      currentIds.has(fragment.inputId)
    )
      continue;
    const piece =
      fragment.kind === "buffered_message"
        ? { ...fragment, body: truncatePost(fragment.body) }
        : fragment;
    byKind.get(fragment.kind)?.push(piece);
  }
  for (const [kind, list] of byKind) {
    // Summary lines keep the summary's own order; the rest go by time.
    if (kind !== "channel_summary_line")
      list.sort((a, b) => timeOf(a) - timeOf(b));
  }

  let bytes =
    fixed +
    [...byKind.values()]
      .flat()
      .reduce((sum, piece) => sum + pieceBytes(fragmentText(piece)), 0);
  for (const { kind, from } of CUT_ORDER) {
    const list = byKind.get(kind) ?? [];
    while (bytes > capBytes && list.length > 0) {
      const cut = (
        from === "last" ? list.pop() : list.shift()
      ) as ContextFragment;
      bytes -= pieceBytes(fragmentText(cut));
    }
  }

  const fragments = PLACE_ORDER.flatMap((kind) => byKind.get(kind) ?? []);
  return {
    outcome: "fitted",
    instructions: input.instructions,
    fragments,
    current,
    left,
    sources: mergeSources([
      ...fragments.map((piece) => piece.sources),
      ...current.map((post) => post.sources),
    ]),
    bytes,
  };
}

/**
 * What one call reads: the conversation's fragments past G1 and check
 * place ① (assembleContext), laid out and cut to the cap (fitContext), and
 * how many the source could not read again.
 */
export async function assembleCallContext(
  source: ContextFragmentSource,
  conversation: ConversationKey,
  input: {
    instructions: string;
    current: readonly CurrentPost[];
    capBytes?: number;
    /** A topic's turn reads that topic's earlier answers too. */
    topicId?: ConversationTopicId;
  },
): Promise<FittedContext & { unreadable: number; summaryVersion: number }> {
  const read = await readContext(source, conversation, input.topicId);
  return {
    ...fitContext({ ...input, fragments: read.fragments }),
    unreadable: read.unreadable,
    // A summary not made yet is at version 0, which its first write names.
    summaryVersion: read.summaryVersion ?? 0,
  };
}

/**
 * What a judgment call reads, through the fragment source: the context of
 * its conversation, by `assembleCallContext`.
 */
export function judgmentContexts(source: ContextFragmentSource) {
  return {
    async assemble(
      ref: {
        workspaceId: string;
        agentId: string;
        conversationId: ConversationId;
      },
      input: Parameters<typeof assembleCallContext>[2],
    ): Promise<
      | Awaited<ReturnType<typeof assembleCallContext>>
      | { outcome: "unknown_conversation" }
    > {
      const conversation = await source.conversationOf(ref);
      if (conversation === null) return { outcome: "unknown_conversation" };
      return assembleCallContext(source, conversation, input);
    },
  };
}
export type JudgmentContexts = ReturnType<typeof judgmentContexts>;

/**
 * What a summary fold reads (a1/J10), through the fragment source: the
 * lines of its conversation's channel summary past G1, every one and uncut,
 * in the summary's order, and the version they are of. Null when the
 * conversation is not the agent's.
 */
export function summaryFoldContexts(source: ContextFragmentSource) {
  return {
    async read(ref: {
      workspaceId: string;
      agentId: string;
      conversationId: ConversationId;
    }): Promise<{
      version: number;
      lines: { id: ChannelSummaryLineId; text: string }[];
    } | null> {
      const conversation = await source.conversationOf(ref);
      if (conversation === null) return null;
      const read = await readContext(source, conversation);
      return {
        version: read.summaryVersion ?? 0,
        lines: read.fragments.flatMap((fragment) =>
          fragment.kind === "channel_summary_line"
            ? [{ id: fragment.lineId, text: fragment.text }]
            : [],
        ),
      };
    },
  };
}
export type SummaryFoldContexts = ReturnType<typeof summaryFoldContexts>;

/** How each kind is named before its text, within PIECE_OVERHEAD_BYTES. */
const PIECE_LABEL: Record<ContextFragment["kind"], string> = {
  channel_summary_line: "channel summary",
  engagement: "took part",
  conversation_turn: "your earlier answer",
  buffered_message: "message",
};

/**
 * The text the model reads for a fitted context: its instructions, its
 * pieces in their order, then the current posts. Each piece is framed in at
 * most PIECE_OVERHEAD_BYTES, so the text is never past the cap it was fitted to.
 */
export function renderContext(
  fitted: Extract<FittedContext, { outcome: "fitted" }>,
): string {
  const lines: string[] = [];
  if (fitted.instructions !== "") lines.push(fitted.instructions);
  for (const piece of fitted.fragments) {
    lines.push(`[${PIECE_LABEL[piece.kind]}] ${fragmentText(piece)}`);
  }
  for (const post of fitted.current) lines.push(`[now] ${post.body}`);
  return lines.join("\n");
}

/** Names one topic of one agent's conversation. */
export type TopicRef = {
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
};

export type TopicTurnContext =
  | {
      outcome: "assembled";
      /** What a new session of the topic starts from. */
      text: string;
      /** What that text came from. */
      sources: { keys: SourceKey[]; overflow: boolean };
    }
  | { outcome: "unknown_conversation" }
  | Extract<FittedContext, { outcome: "too_large" }>;

/**
 * What a conversation turn of a topic is assembled from, through the
 * fragment source: the context a new session of the topic starts from, and
 * whether a live session's sources were deleted since it read them.
 */
export function topicTurnContexts(source: ContextFragmentSource) {
  return {
    async assemble(
      topic: TopicRef,
      input: { instructions: string; current: CurrentPost },
    ): Promise<TopicTurnContext> {
      const conversation = await source.conversationOf(topic);
      if (conversation === null) return { outcome: "unknown_conversation" };
      const fitted = await assembleCallContext(source, conversation, {
        instructions: input.instructions,
        current: [input.current],
        topicId: topic.topicId,
      });
      if (fitted.outcome === "too_large") return fitted;
      // The turn's own input goes whole: a post's cut is for what others wrote.
      const text = renderContext({
        ...fitted,
        current: fitted.current.map((post) => ({
          ...post,
          body: input.current.body,
        })),
      });
      // A new session's first request carries it escaped, beside the engine's
      // own parts: past half a session's bound it starts from the input alone.
      const escaped = Buffer.byteLength(JSON.stringify(text));
      if (
        text.length > CONVERSATION_TURN_FRESH_TEXT_MAX ||
        escaped > CONVERSATION_TOPIC_SESSION_MAX_BYTES / 2
      ) {
        return {
          outcome: "too_large",
          reason: "current_post",
          bytes: escaped,
          capBytes: CONVERSATION_TOPIC_SESSION_MAX_BYTES / 2,
        };
      }
      return { outcome: "assembled", text, sources: fitted.sources };
    },

    /**
     * The conversation's channel summary lines a read tool shows, in the
     * summary's order: the assembler's read, so only the conversation's own
     * scopes and none whose source Slack deleted.
     */
    async channelSummary(ref: Omit<TopicRef, "topicId">): Promise<
      | {
          outcome: "read";
          lines: { text: string; writtenAt: Date; sources: SourceKey[] }[];
        }
      | { outcome: "unknown_conversation" }
    > {
      const conversation = await source.conversationOf(ref);
      if (conversation === null) return { outcome: "unknown_conversation" };
      const fragments = await assembleContext(source, conversation);
      return {
        outcome: "read",
        lines: fragments.flatMap((fragment) =>
          fragment.kind === "channel_summary_line"
            ? [
                {
                  text: fragment.text,
                  writtenAt: fragment.writtenAt,
                  sources: fragment.sources,
                },
              ]
            : [],
        ),
      };
    },

    /** An admin delete removes turns a live session may still hold. */
    async recordsDeletedAt(topic: TopicRef): Promise<number | null> {
      return (await source.recordsDeletedAt(topic))?.getTime() ?? null;
    },

    anyDeleted(
      workspaceId: string,
      sources: readonly SourceKey[],
    ): Promise<boolean> {
      return sources.length === 0
        ? Promise.resolve(false)
        : source.anyDeleted(workspaceId, sources);
    },
  };
}
export type TopicTurnContexts = ReturnType<typeof topicTurnContexts>;
