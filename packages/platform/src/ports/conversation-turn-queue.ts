import type {
  ConversationInputId,
  ConversationRuntimeId,
  ConversationRuntimeTurn,
  ConversationTurnId,
  ConversationTurnLeaseId,
  ConversationTurnResult,
} from "@werft-ai/contracts";

/** A turn waiting for a runtime: what the runtime is handed, short of its lease. */
export type QueuedConversationTurn = Omit<
  ConversationRuntimeTurn,
  "lease_id" | "lease_expires_at"
>;

/**
 * How a turn ended: as the runtime that held it reported, or closed here
 * because no runtime took it in time (`not_taken`) or the one that did let
 * its lease run out (`lease_expired`).
 */
export type ConversationTurnOutcome =
  | ConversationTurnResult
  | {
      outcome: "failed";
      reason: "not_taken" | "lease_expired" | "emergency_stopped";
    };

export type ConversationTurnReport =
  | "recorded"
  // This same report was recorded before.
  | "duplicate"
  | "unknown_turn"
  // Another lease holds the turn, or none ever did.
  | "not_holder"
  // The reporter's lease ended first: the turn is closed as failed.
  | "lease_expired"
  // The holder reported this turn before, with another result.
  | "conflict";

export type EnqueueConversationTurn = {
  /**
   * The input the turn answers and which try at it this is, from 1: one
   * input's same attempt is queued once, so a repeated event adds no turn,
   * and a retry comes in under the next number.
   */
  inputId: ConversationInputId;
  attempt: number;
  /** When a runtime must have taken it. */
  takeBy: Date;
  now?: Date;
  /** When its permit ends. */
  usableUntil?: Date;
};

/**
 * The conversation turns waiting for a runtime and held by one. A turn is
 * leased to one runtime at most once: it ends with that runtime's report or
 * with its lease, and is never handed out again.
 */
export interface ConversationTurnQueue {
  /**
   * Whether a queued turn outlives this process and is seen by every API
   * process. A queue that is not serves a single API process only.
   */
  readonly durable: boolean;
  /**
   * Queues a turn a runtime must take before `takeBy`. Queued behind another
   * turn of its topic, it waits as long again from that turn's end, but is
   * never taken once a whole lease would outlast `usableUntil`, when its
   * permit ends. `duplicate`: that input's attempt is queued already, and
   * this turn is not. `ended`: the turn was ended before it was queued (an
   * emergency stop between its permit and here), and is not queued. A turn
   * id queued before throws.
   */
  enqueue(
    turn: QueuedConversationTurn,
    entry: EnqueueConversationTurn,
  ): Promise<"queued" | "duplicate" | "ended">;
  /** Leases the oldest waiting turn to `runtimeId`, or null when none waits. */
  lease(input: {
    runtimeId: ConversationRuntimeId;
    now: Date;
    leaseMs: number;
  }): Promise<ConversationRuntimeTurn | null>;
  report(input: {
    turnId: ConversationTurnId;
    leaseId: ConversationTurnLeaseId;
    runtimeId: ConversationRuntimeId;
    result: ConversationTurnResult;
    now: Date;
  }): Promise<ConversationTurnReport>;
  /** How the turn ended, `pending` until it has, null for a turn never queued. */
  outcome(
    turnId: ConversationTurnId,
    now: Date,
  ): Promise<ConversationTurnOutcome | "pending" | null>;
  /**
   * When the queue next changes with time alone, were nothing else to happen:
   * the first lease to run out, or the first waiting turn to go untaken. Null
   * when nothing in it is timed. A queue that cannot tell leaves this out.
   */
  nextTimedChange?(): Promise<Date | null>;
}
