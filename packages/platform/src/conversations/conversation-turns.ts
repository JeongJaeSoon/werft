import {
  CONVERSATION_TURN_LEASE_MS,
  type ConversationId,
  type ConversationRuntimeId,
  type ConversationRuntimeTurn,
  type ConversationTopicId,
  type ConversationTurnDecision,
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

// A lease taken now would outlast the turn's permit.
const tooLate = (usableUntil: Date | null, now: Date, leaseMs: number) =>
  usableUntil !== null && now.getTime() + leaseMs > usableUntil.getTime();

// How long an ended turn is kept, so a repeated report is still told apart
// from an unknown one and whoever queued the turn can read how it ended.
export const ENDED_TURN_KEPT_MS = 10 * 60_000;

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
      usableUntil: Date | null;
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
 * this API process alone. For tests; the API serves the queue in the
 * database, which keeps the same rules.
 */
export function createMemoryConversationTurnQueue(): ConversationTurnQueue {
  const entries = new Map<ConversationTurnId, Entry>();
  // Each input's attempt queued, kept after its turn is forgotten.
  const attempts = new Set<string>();
  const attemptKey = (inputId: string, attempt: number) =>
    `${inputId}:${attempt}`;
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
      (tooLate(entry.usableUntil, now, CONVERSATION_TURN_LEASE_MS) ||
        (!topicBusy(topicId) &&
          now.getTime() >=
            Math.max(
              entry.takeBy.getTime(),
              (topicFreedAt.get(topicId) ?? 0) + entry.takeMs,
            )))
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

    async enqueue(
      turn,
      { inputId, attempt, takeBy, now = new Date(), usableUntil },
    ) {
      assertAttempt(attempt);
      if (entries.has(turn.turn_id)) {
        throw new Error(`Conversation turn ${turn.turn_id} is already queued`);
      }
      const key = attemptKey(inputId, attempt);
      if (attempts.has(key)) return "duplicate";
      attempts.add(key);
      entries.set(turn.turn_id, {
        turn,
        state: "queued",
        takeBy,
        takeMs: Math.max(0, takeBy.getTime() - now.getTime()),
        usableUntil: usableUntil ?? null,
      });
      return "queued";
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
        if (tooLate(entry.usableUntil, now, leaseMs)) continue;
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

/** An input's attempts count from 1. */
export function assertAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `A turn's attempt is a whole number from 1, not ${attempt}`,
    );
  }
}

/** Whether a repeated report says what the recorded outcome says. */
export function sameResult(
  outcome: ConversationTurnOutcome,
  result: ConversationTurnResult,
): boolean {
  if (outcome.outcome !== result.outcome) return false;
  if (outcome.outcome === "completed" && result.outcome === "completed") {
    return (
      outcome.text === result.text &&
      JSON.stringify(outcome.decision) === JSON.stringify(result.decision)
    );
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
 * A person's mention of the agent, to become a conversation turn of its
 * thread's topic (v1-b/D1). The requester is the server's value for who
 * mentioned the agent, never one read off the text.
 */
export type MentionTurnRequest = {
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  slackInstallationId: string;
  message: { teamId: string; channelId: string; ts: string };
  requesterUserId: string;
  /** The mention's text, the bot's own mention taken out: the turn's instruction. */
  text: string;
};

export type MentionTurnStart =
  | { outcome: "queued"; turnId: ConversationTurnId }
  // The message is a turn already: Slack sent its event again.
  | { outcome: "duplicate" }
  | { outcome: "source_deleted" }
  | { outcome: "unknown_agent" }
  | { outcome: "unknown_conversation" }
  | { outcome: "no_active_release" }
  | { outcome: "connection_unavailable" }
  // Longer than a turn's input may be.
  | { outcome: "too_long" };

/** A mention's turn whose Slack thread was set to "processing" and not yet back. */
export type MentionTurnDue = {
  turnId: ConversationTurnId;
  workspaceId: string;
  agentId: string;
  createdAt: Date;
  thread: { teamId: string; channelId: string; threadTs: string };
  /** The agent's Slack app; null when it is gone. */
  slackAppId: string | null;
};

export interface MentionTurnStatusStore {
  /**
   * Up to `limit` mention turns whose thread status is still due, oldest
   * first; none another pass claimed within `claimMs`.
   */
  due(limit: number, claimMs: number): Promise<MentionTurnDue[]>;
  /**
   * Claims setting the turn's thread back, for `claimMs`: `send` for the
   * one claim; `superseded`, marked set back with nothing to send, when a
   * newer mention turn of the thread is still due, whose "processing"
   * stays; `done` when it was set back or another pass holds it.
   */
  claimReset(
    turnId: ConversationTurnId,
    claimMs: number,
  ): Promise<"send" | "superseded" | "done">;
  /** Marks the thread set back, once Slack took it. */
  confirmReset(turnId: ConversationTurnId): Promise<void>;
  /**
   * Lets the claim go: a pass's, so a later pass sends again; or the one the
   * turn is written with, held until it is queued.
   */
  releaseReset(turnId: ConversationTurnId): Promise<void>;
  /** Whether a newer mention turn of the turn's thread is still due. */
  newerDue(turnId: ConversationTurnId): Promise<boolean>;
}

/**
 * What a turn's "reply" decision did (v1-b/E1): `enqueued` its answer's
 * outbox row; `duplicate` when an earlier run did; `none` when the turn
 * holds no reply decision (another one, none, or voided by a delete);
 * `no_thread` when its topic has no Slack thread, or the agent no Slack
 * app, to answer in.
 */
export type ConversationReplyEffect =
  | "enqueued"
  | "duplicate"
  | "none"
  | "no_thread";

export interface ConversationReplyStore {
  /**
   * Enqueues the turn's answer as the server recorded it, in its topic's
   * thread: where it goes is never read from the model's text.
   */
  post(turnId: ConversationTurnId): Promise<ConversationReplyEffect>;
}

/**
 * The decisions that mean "the agent took this message on" (v1-b/E2, Architect
 * Q4): answering, making a new task, handing it to an open one. Staying quiet
 * is not one.
 */
export const CONVERSATION_ANSWERING_DECISIONS = [
  "reply",
  "spawn_task",
  "route_to_task",
] as const satisfies readonly ConversationTurnDecision[];

/**
 * What a turn's 👀 did: `enqueued` its reaction row; `duplicate` when the
 * message holds one already; `none` when the turn made no such decision;
 * `no_message` when no Slack message called it, or the agent has no Slack
 * app; `no_scope` when the app lacks `reactions:write`.
 */
export type ConversationReactionEffect =
  | "enqueued"
  | "duplicate"
  | "none"
  | "no_message"
  | "no_scope";

export interface ConversationReactionStore {
  /** Puts one 👀 on the message that called the turn, once it took it on. */
  react(turnId: ConversationTurnId): Promise<ConversationReactionEffect>;
}

export type MentionTurnEndings = {
  ended: number;
  /** Turns whose reply decision enqueued its answer. */
  replied: number;
  /** Turns that put a 👀 on the message that called them. */
  reacted: number;
  reset: number;
  superseded: number;
  /** Threads told "processing" again for a newer turn after an `active`. */
  reprocessing: number;
  failed: number;
};

/**
 * Ends the mention turns whose run is over, each once however it ended
 * (a decision, none, a limit, a failure, the time limit, a refused budget),
 * and sets their thread back from "processing". A turn its queue has not
 * ended by the time its permit could last is ended here as out of time; one
 * the queue never held, once it is past being taken. At most `limit` turns,
 * and none after `deadline`.
 */
export async function endMentionTurns(deps: {
  statuses: MentionTurnStatusStore;
  queue: Pick<ConversationTurnQueue, "outcome">;
  replies: ConversationReplyStore;
  reactions: ConversationReactionStore;
  calls: {
    endTurn(
      turnId: ConversationTurnId,
      outcome?: ConversationTurnOutcome,
    ): Promise<unknown>;
  };
  /**
   * Sets the thread's status: false when the thread shows none (the app is
   * gone, or Slack shows none there); throws when Slack may not have taken
   * it.
   */
  setStatus(
    turn: MentionTurnDue,
    status: "active" | "processing",
  ): Promise<boolean>;
  /** How long a turn may wait to be taken, and then run. */
  takeMs: number;
  leaseMs: number;
  /**
   * How long a claim to set a thread back holds: past it, the pass that
   * claimed is taken to be gone and the next one sends.
   */
  claimMs: number;
  limit: number;
  /** Epoch milliseconds, by the pass's clock. */
  deadline: number;
  now?: () => Date;
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}): Promise<MentionTurnEndings> {
  const now = deps.now ?? (() => new Date());
  const result: MentionTurnEndings = {
    ended: 0,
    replied: 0,
    reacted: 0,
    reset: 0,
    superseded: 0,
    reprocessing: 0,
    failed: 0,
  };
  for (const turn of await deps.statuses.due(deps.limit, deps.claimMs)) {
    // The pass's own time, whatever clock the turns are judged by.
    if (Date.now() >= deps.deadline) break;
    const at = now();
    const ids = { turn_id: turn.turnId, agent_id: turn.agentId };
    try {
      const age = at.getTime() - turn.createdAt.getTime();
      const queued = await deps.queue.outcome(turn.turnId, at);
      let outcome: ConversationTurnOutcome | undefined;
      if (queued === "pending") {
        // Past its permit: no call of it is granted any more.
        if (age < deps.takeMs + deps.leaseMs) continue;
        outcome = { outcome: "failed", reason: "lease_expired" };
      } else if (queued === null) {
        // Not queued yet, or never: its writer died before the queue held it.
        if (age < deps.takeMs) continue;
      } else {
        outcome = queued;
      }
      await deps.calls.endTurn(turn.turnId, outcome);
      result.ended += 1;
      deps.logger.info("Mention turn ended", {
        ...ids,
        turn_outcome: outcome?.outcome ?? "not_queued",
        ...(outcome !== undefined && "reason" in outcome
          ? { turn_failure: outcome.reason }
          : {}),
      });
      // Before the thread is set back: a failure here leaves the turn due,
      // and the next pass runs it again under the same key.
      // The 👀 first, so it lands before the answer it announces.
      if ((await deps.reactions.react(turn.turnId)) === "enqueued") {
        result.reacted += 1;
      }
      if ((await deps.replies.post(turn.turnId)) === "enqueued") {
        result.replied += 1;
      }
      const claim = await deps.statuses.claimReset(turn.turnId, deps.claimMs);
      if (claim === "superseded") result.superseded += 1;
      if (claim !== "send") continue;
      try {
        await deps.setStatus(turn, "active");
      } catch (error) {
        await deps.statuses.releaseReset(turn.turnId);
        throw error;
      }
      // Unconfirmed, the claim runs out and a later pass sends again.
      await deps.statuses.confirmReset(turn.turnId);
      result.reset += 1;
      // A newer turn written after the claim: its "processing" may have
      // reached Slack before this `active`, so it is said again.
      if (await deps.statuses.newerDue(turn.turnId)) {
        await deps.setStatus(turn, "processing");
        result.reprocessing += 1;
      }
    } catch (error) {
      // One turn's failure leaves the others going; it is tried next pass.
      result.failed += 1;
      deps.logger.warn("Mention turn ending failed; tried again", {
        ...ids,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return result;
}

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
  /** Told of each turn as it is leased, before the runtime has it. */
  leased?: (turn: ConversationRuntimeTurn) => Promise<void>;
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
          const handed =
            deps.topicSessions === undefined
              ? turn
              : await deps.topicSessions.handOut(turn);
          await deps.leased?.(handed);
          return handed;
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
