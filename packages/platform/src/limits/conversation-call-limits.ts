import type { ConversationCallClass } from "@werft-ai/contracts";

/**
 * The keys a conversation call is counted under while it is in progress:
 * a reserved call whose token has not expired, or an in-flight one, its end
 * unknown or not. An unknown call still holds its budget, so it holds its
 * place too, until it is settled or an operator releases it.
 */
export const CONVERSATION_CALL_LIMIT_VALUES = [
  "channel",
  "topic",
  "requester",
  "agent",
] as const;
export type ConversationCallLimit =
  (typeof CONVERSATION_CALL_LIMIT_VALUES)[number];

/** At most this many calls in progress at once per key. */
export const CONVERSATION_CALL_LIMITS = {
  // The M1 calls of one channel conversation: its judgments in a line.
  channel: 1,
  // One topic's calls, whatever their class.
  topic: 1,
  // One person's calls in the workspace, over every agent. A call with no
  // requester (M1, an operator's) is not counted.
  requester: 4,
  // Every call of the agent, an operator's included.
  agent: 8,
} as const satisfies Record<ConversationCallLimit, number>;

/** The one class the channel limit counts and applies to. */
export const CHANNEL_LIMITED_CLASS: ConversationCallClass = "m1";

/**
 * The reconciler warns of an agent once this many of its calls are of
 * unknown end; nothing releases them on its own.
 */
export const CONVERSATION_CALL_UNKNOWN_WARN_AT =
  CONVERSATION_CALL_LIMITS.agent / 2;
