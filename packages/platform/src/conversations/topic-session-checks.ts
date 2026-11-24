import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  type ConversationRuntimeTurn,
  type ConversationTopicId,
  type ConversationTurnId,
} from "@werft-ai/contracts";
import type { TopicRef, TopicTurnContexts } from "./context-assembler.ts";
import { mergeSources, type SourceKey } from "./source-sets.ts";

type Seen = {
  topic: TopicRef;
  /** The conversation's last admin delete when the turn was handed out; NaN when unread. */
  recordsDeletedAt: number | null;
  handedOutAt: number;
  /** Every source the topic's live session may hold, as far as it is known. */
  keys: SourceKey[];
  /** More than the set holds: what the session holds is not known whole. */
  overflow: boolean;
  /** Null while a turn of the topic is out. */
  endedAt: number | null;
};

/**
 * The control host's half of a topic session's lifetime, in this process's
 * memory: for each topic, what its live session may have read. When a
 * runtime takes a turn, the turn gets the context a new session would start
 * from, assembled then, and `keep` only when the topic's last turn ended
 * within the idle time and none of what its session read was deleted since.
 * Whatever cannot be told is `drop`. A runtime that holds no session of the
 * topic starts anew either way, so this errs only towards a new session.
 */
export function createTopicSessionChecks(deps: {
  contexts: TopicTurnContexts;
  /** The agent's instructions a new session starts from. */
  instructions?: (turn: ConversationRuntimeTurn) => string;
  now?: () => number;
  idleMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? CONVERSATION_TOPIC_SESSION_IDLE_MS;
  const seen = new Map<ConversationTopicId, Seen>();
  // The turn each topic has out, by the turn's id.
  const out = new Map<ConversationTurnId, ConversationTopicId>();

  // A turn that never reported is swept from when it was handed out.
  function sweep(at: number): void {
    for (const [topicId, entry] of seen) {
      if (at - (entry.endedAt ?? entry.handedOutAt) >= idleMs) {
        seen.delete(topicId);
        for (const [turnId, topic] of out)
          if (topic === topicId) out.delete(turnId);
      }
    }
  }

  async function mayGoOn(
    entry: Seen | undefined,
    recordsDeletedAt: number | null,
  ): Promise<boolean> {
    // A turn still out is one that never reported: its session is gone.
    if (entry === undefined || entry.endedAt === null || entry.overflow) {
      return false;
    }
    // NaN, unread either time, is equal to nothing.
    if (recordsDeletedAt !== entry.recordsDeletedAt) return false;
    try {
      return !(await deps.contexts.anyDeleted(
        entry.topic.workspaceId,
        entry.keys,
      ));
    } catch {
      return false;
    }
  }

  return {
    /** The turn as the runtime is handed it, its topic's session checked now. */
    async handOut(
      turn: ConversationRuntimeTurn,
    ): Promise<ConversationRuntimeTurn> {
      const at = now();
      sweep(at);
      const topicId = turn.scope.topic_id;
      const topic: TopicRef = {
        workspaceId: turn.scope.workspace_id,
        agentId: turn.scope.agent_id,
        conversationId: turn.scope.conversation_id,
        topicId,
      };
      const entry = seen.get(topicId);
      const recordsDeletedAt = await deps.contexts
        .recordsDeletedAt(topic)
        .catch(() => Number.NaN);
      const keep = await mayGoOn(entry, recordsDeletedAt);
      for (const [turnId, topic] of out)
        if (topic === topicId) out.delete(turnId);
      out.set(turn.turn_id, topicId);
      const assembled = await deps.contexts
        .assemble(topic, {
          instructions: deps.instructions?.(turn) ?? "",
          current: {
            inputId: null,
            body: turn.input.text,
            sources: [],
            receivedAt: new Date(at),
          },
        })
        .catch(() => null);
      if (assembled === null || assembled.outcome !== "assembled") {
        // Nothing read now is safe to start from but the turn's own input.
        seen.set(topicId, {
          topic,
          recordsDeletedAt,
          handedOutAt: at,
          keys: [],
          overflow: false,
          endedAt: null,
        });
        return {
          ...turn,
          fresh_input: { ...turn.fresh_input, text: turn.input.text },
          topic_session: "drop",
        };
      }
      const merged = mergeSources([
        keep && entry !== undefined ? entry.keys : [],
        assembled.sources.keys,
      ]);
      const overflow = merged.overflow || assembled.sources.overflow;
      seen.set(topicId, {
        topic,
        recordsDeletedAt,
        handedOutAt: at,
        keys: merged.keys,
        overflow,
        endedAt: null,
      });
      return {
        ...turn,
        fresh_input: { ...turn.fresh_input, text: assembled.text },
        topic_session: keep && !overflow ? "keep" : "drop",
      };
    },

    /** How a turn handed out ended: a failed one leaves no session to go on in. */
    ended(turnId: ConversationTurnId, completed: boolean): void {
      const topicId = out.get(turnId);
      out.delete(turnId);
      const entry = topicId === undefined ? undefined : seen.get(topicId);
      if (topicId === undefined || entry === undefined) return;
      if (completed) entry.endedAt = now();
      else seen.delete(topicId);
    },

    /** Topics whose session may be alive, for a test or a gauge. */
    get size(): number {
      sweep(now());
      return seen.size;
    },
  };
}
export type TopicSessionChecks = ReturnType<typeof createTopicSessionChecks>;
