import {
  CONVERSATION_TURN_LEASE_MS,
  type ConversationRuntimeId,
  type ConversationRuntimeTurn,
  type ConversationTurnId,
  type ConversationTurnLeaseId,
  type ConversationTurnResult,
  conversationTurnLeaseIdSchema,
} from "@werft-ai/contracts";
import type {
  ConversationTurnOutcome,
  ConversationTurnQueue,
  ConversationTurnReport,
  QueuedConversationTurn,
} from "../ports/conversation-turn-queue.ts";
import type { TopicSessionChecks } from "./topic-session-checks.ts";

// How long an ended turn is kept, so a repeated report is still told apart
// from an unknown one and whoever queued the turn can read how it ended.
const ENDED_TURN_KEPT_MS = 10 * 60_000;

type Lease = {
  id: ConversationTurnLeaseId;
  runtimeId: ConversationRuntimeId;
  expiresAt: Date;
};

type Entry = { turn: QueuedConversationTurn } & (
  | {
      state: "queued";
      takeBy: Date;
      /** How long it may wait from its topic's last turn's end, behind which it queued. */
      takeMs: number;
    }
  | { state: "leased"; lease: Lease }
  | {
      state: "ended";
      lease: Lease | null;
      outcome: ConversationTurnOutcome;
      at: Date;
    }
);

/**
 * The turn queue in this process's memory: empty after a restart, and seen by
 * this API process alone. For an installation whose conversation turns only
 * its operator starts; a queue in the database replaces it before turns are
 * dispatched from people's messages.
 */
export function createMemoryConversationTurnQueue(): ConversationTurnQueue {
  const entries = new Map<ConversationTurnId, Entry>();
  // When each topic's last turn out ended: a turn queued behind it waits from then.
  const topicFreedAt = new Map<string, number>();

  const topicBusy = (topicId: string) =>
    [...entries.values()].some(
      (entry) =>
        entry.state === "leased" && entry.turn.scope.topic_id === topicId,
    );
  // Kept only while a turn of the topic waits: a later one waits from its own enqueue.
  const waiting = (topicId: string) =>
    [...entries.values()].some(
      (other) =>
        other.state === "queued" && other.turn.scope.topic_id === topicId,
    );
  const freed = (entry: Entry, at: Date) => {
    const topicId = entry.turn.scope.topic_id;
    if (waiting(topicId)) topicFreedAt.set(topicId, at.getTime());
    else topicFreedAt.delete(topicId);
  };

  // A turn nobody took, or whose holder went quiet, ends here: never requeued,
  // since its one-call permit may already be spent.
  function settle(id: ConversationTurnId, entry: Entry, now: Date): Entry {
    let ended: Entry | undefined;
    const topicId = entry.turn.scope.topic_id;
    if (
      entry.state === "queued" &&
      !topicBusy(topicId) &&
      now.getTime() >=
        Math.max(
          entry.takeBy.getTime(),
          (topicFreedAt.get(topicId) ?? 0) + entry.takeMs,
        )
    ) {
      ended = {
        turn: entry.turn,
        state: "ended",
        lease: null,
        outcome: { outcome: "failed", reason: "not_taken" },
        at: now,
      };
    } else if (entry.state === "leased" && now >= entry.lease.expiresAt) {
      ended = {
        turn: entry.turn,
        state: "ended",
        lease: entry.lease,
        outcome: { outcome: "failed", reason: "lease_expired" },
        at: now,
      };
      freed(entry, now);
    }
    if (ended === undefined) return entry;
    entries.set(id, ended);
    if (!waiting(topicId)) topicFreedAt.delete(topicId);
    return ended;
  }

  function sweep(now: Date): void {
    for (const [id, entry] of entries) {
      const current = settle(id, entry, now);
      if (
        current.state === "ended" &&
        now.getTime() - current.at.getTime() >= ENDED_TURN_KEPT_MS
      ) {
        entries.delete(id);
      }
    }
  }

  return {
    durable: false,

    async enqueue(turn, takeBy, now = new Date()) {
      if (entries.has(turn.turn_id)) {
        throw new Error(`Conversation turn ${turn.turn_id} is already queued`);
      }
      entries.set(turn.turn_id, {
        turn,
        state: "queued",
        takeBy,
        takeMs: Math.max(0, takeBy.getTime() - now.getTime()),
      });
    },

    async lease({ runtimeId, now, leaseMs }) {
      sweep(now);
      // One turn of a topic at a time: the next waits for the one out to end.
      const busy = new Set(
        [...entries.values()].flatMap((entry) =>
          entry.state === "leased" ? [entry.turn.scope.topic_id] : [],
        ),
      );
      // A Map keeps insertion order: the first queued entry is the oldest.
      for (const [id, entry] of entries) {
        if (entry.state !== "queued") continue;
        if (busy.has(entry.turn.scope.topic_id)) continue;
        const lease: Lease = {
          id: conversationTurnLeaseIdSchema.parse(crypto.randomUUID()),
          runtimeId,
          expiresAt: new Date(now.getTime() + leaseMs),
        };
        entries.set(id, { turn: entry.turn, state: "leased", lease });
        return {
          ...entry.turn,
          lease_id: lease.id,
          lease_expires_at: lease.expiresAt.toISOString(),
        };
      }
      return null;
    },

    async report({ turnId, leaseId, runtimeId, result, now }) {
      const found = entries.get(turnId);
      if (found === undefined) return "unknown_turn";
      const entry = settle(turnId, found, now);
      const holds = (lease: Lease | null) =>
        lease !== null && lease.id === leaseId && lease.runtimeId === runtimeId;
      if (entry.state === "queued") return "not_holder";
      if (!holds(entry.lease)) return "not_holder";
      if (entry.state === "leased") {
        freed(entry, now);
        entries.set(turnId, {
          turn: entry.turn,
          state: "ended",
          lease: entry.lease,
          outcome: result,
          at: now,
        });
        return "recorded";
      }
      if (
        "reason" in entry.outcome &&
        entry.outcome.reason === "lease_expired"
      ) {
        return "lease_expired";
      }
      return sameResult(entry.outcome, result) ? "duplicate" : "conflict";
    },

    async outcome(turnId, now) {
      const found = entries.get(turnId);
      if (found === undefined) return null;
      const entry = settle(turnId, found, now);
      return entry.state === "ended" ? entry.outcome : "pending";
    },
  };
}

function sameResult(
  outcome: ConversationTurnOutcome,
  result: ConversationTurnResult,
): boolean {
  if (outcome.outcome !== result.outcome) return false;
  if (outcome.outcome === "completed" && result.outcome === "completed") {
    return outcome.text === result.text;
  }
  if (outcome.outcome === "failed" && result.outcome === "failed") {
    return (
      outcome.reason === result.reason &&
      ("detail" in outcome ? outcome.detail : undefined) === result.detail
    );
  }
  return false;
}

export type ConversationRuntimeTurns = ReturnType<
  typeof createConversationRuntimeTurns
>;

/**
 * The control host's side of the conversation runtime's protocol, over a turn
 * queue: a runtime's long poll for its next turn and its report of one, and,
 * for whoever queues a turn, the wait for how it ended.
 */
export function createConversationRuntimeTurns(deps: {
  queue: ConversationTurnQueue;
  /** Checks a turn's topic session as a runtime takes it, and learns how it ended. */
  topicSessions?: Pick<TopicSessionChecks, "handOut" | "ended">;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How often a waiting poll looks at the queue again. */
  pollMs?: number;
  leaseMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? 250;
  const leaseMs = deps.leaseMs ?? CONVERSATION_TURN_LEASE_MS;
  let lastPollAt: Date | null = null;

  return {
    queue: deps.queue,

    /** Leases the next turn to the runtime, waiting up to `waitMs` for one. */
    async nextTurn(input: {
      runtimeId: ConversationRuntimeId;
      waitMs: number;
      /** Ends the wait early, with no turn. */
      stop?: AbortSignal;
    }): Promise<ConversationRuntimeTurn | null> {
      const deadline = now().getTime() + input.waitMs;
      for (;;) {
        lastPollAt = now();
        const turn = await deps.queue.lease({
          runtimeId: input.runtimeId,
          now: lastPollAt,
          leaseMs,
        });
        if (turn !== null) {
          return deps.topicSessions === undefined
            ? turn
            : deps.topicSessions.handOut(turn);
        }
        const left = deadline - now().getTime();
        if (left <= 0 || input.stop?.aborted === true) return null;
        await sleep(Math.min(pollMs, left));
      }
    },

    async turnResult(input: {
      runtimeId: ConversationRuntimeId;
      turnId: ConversationTurnId;
      leaseId: ConversationTurnLeaseId;
      result: ConversationTurnResult;
    }): Promise<ConversationTurnReport> {
      const recorded = await deps.queue.report({ ...input, now: now() });
      if (recorded === "recorded") {
        deps.topicSessions?.ended(
          input.turnId,
          input.result.outcome === "completed",
        );
      }
      return recorded;
    },

    /** Whether a runtime asked for a turn within the last `withinMs`. */
    runtimePolledWithin(withinMs: number): boolean {
      return (
        lastPollAt !== null &&
        now().getTime() - lastPollAt.getTime() <= withinMs
      );
    },

    /** How the turn ended; null when it was never queued. */
    async ended(
      turnId: ConversationTurnId,
      stop?: AbortSignal,
    ): Promise<ConversationTurnOutcome | null> {
      for (;;) {
        const outcome = await deps.queue.outcome(turnId, now());
        if (outcome !== "pending") return outcome;
        if (stop?.aborted === true) return null;
        await sleep(pollMs);
      }
    },
  };
}
