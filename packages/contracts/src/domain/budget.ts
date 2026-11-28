import { z } from "zod";

/**
 * Whose request a provider call serves, read from the root of the chain that
 * led to it, never from who queued the turn: a person (their own turn and
 * every turn that follows from it), a key or an allowed Slack bot (outside
 * requests, kept apart so a bot's spend can be read on its own), or nobody
 * (the agent on its own).
 */
export const BUDGET_ROOT_KIND_VALUES = [
  "user",
  "key",
  "slack_bot",
  "none",
] as const;
export type BudgetRootKind = (typeof BUDGET_ROOT_KIND_VALUES)[number];

/** Who started a call's chain, as the usage screen splits its total. */
export const INITIATOR_VALUES = ["person", "agent"] as const;
export type Initiator = (typeof INITIATOR_VALUES)[number];

/**
 * Each root kind on exactly one side, so the two sides add up to the total:
 * a key is one a person made, and an allowed Slack bot is no person.
 */
export const INITIATOR_ROOT_KINDS = {
  person: ["user", "key"],
  agent: ["none", "slack_bot"],
} as const satisfies Record<Initiator, readonly BudgetRootKind[]>;

/** A person's account, or an agent team's. */
export const BUDGET_OWNER_KIND_VALUES = ["user", "team"] as const;
export type BudgetOwnerKind = (typeof BUDGET_OWNER_KIND_VALUES)[number];

/**
 * What a budget limit row sets: the workspace's limit for every person, one
 * person's own limit in its place, or one team's.
 */
export const BUDGET_LIMIT_SUBJECT_VALUES = [
  "person_default",
  "user",
  "team",
] as const;
export type BudgetLimitSubject = (typeof BUDGET_LIMIT_SUBJECT_VALUES)[number];

/**
 * `resolved`: a reservation whose end was unknown was closed, by an
 * operator as spent or refunded or by the reconciler as estimated
 * (BudgetUnknownResolution). A late report then adds a
 * budget adjustment and leaves the row as it is.
 */
export const BUDGET_RESERVATION_STATE_VALUES = [
  "reserved",
  "settled",
  "released",
  "resolved",
] as const;
export type BudgetReservationState =
  (typeof BUDGET_RESERVATION_STATE_VALUES)[number];

/**
 * A provider call that serves no session (a conversation call): held on a
 * budget account when its token is issued, `in_flight` once the proxy used
 * the token, `settled` by the usage report. An unused token's reservation
 * is `released` when it expires. A call in flight whose end was unknown is
 * `resolved` when an operator closes its reservation. A call of no turn in
 * flight that its caller gave up on, or that outlived the provider exchange
 * lease, is `timed_out`: it holds no place under the call limits, and its
 * reservation stays held, of unknown end, until a late report settles it
 * or an operator resolves it.
 */
export const CONVERSATION_CALL_STATE_VALUES = [
  "reserved",
  "in_flight",
  "settled",
  "released",
  "resolved",
  "timed_out",
] as const;
export type ConversationCallState =
  (typeof CONVERSATION_CALL_STATE_VALUES)[number];

/**
 * How a reservation of unknown end was closed: an operator charged what it
 * held (the default, never charging an unknown call less) or gave it back,
 * or the reconciler charged what it held as an estimate, once its turn ended
 * and the call could no longer run (PROVIDER_CALL_MAX_MS).
 */
export const BUDGET_UNKNOWN_RESOLUTION_VALUES = [
  "spent",
  "refunded",
  "estimated",
] as const;
export type BudgetUnknownResolution =
  (typeof BUDGET_UNKNOWN_RESOLUTION_VALUES)[number];

/**
 * Why a conversation turn's permit was refused a call, as its row keeps it:
 * the account could not hold it, a call limit was full, or the turn had
 * made as many calls as a turn may.
 */
export const CONVERSATION_TURN_CALL_REFUSAL_VALUES = [
  "budget",
  "concurrency",
  "turn_limit",
] as const;
export type ConversationTurnCallRefusal =
  (typeof CONVERSATION_TURN_CALL_REFUSAL_VALUES)[number];

export const conversationCallIdSchema = z.uuid().brand<"ConversationCallId">();
export type ConversationCallId = z.infer<typeof conversationCallIdSchema>;

/**
 * What a conversation call does: M1's judgment of whether to step in, a
 * call of an M2 conversation turn, or a channel summary's.
 */
export const CONVERSATION_CALL_CLASS_VALUES = ["m1", "m2", "summary"] as const;
export type ConversationCallClass =
  (typeof CONVERSATION_CALL_CLASS_VALUES)[number];

/**
 * One conversation call's key in its agent, `{input or batch id}:{class}`.
 * A retry of the call keeps the key and takes the next attempt number.
 */
export const conversationCallKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^[A-Za-z0-9_-]{1,128}:(${CONVERSATION_CALL_CLASS_VALUES.join("|")})$`,
    ),
  )
  .brand<"ConversationCallKey">();
export type ConversationCallKey = z.infer<typeof conversationCallKeySchema>;

export const budgetAccountIdSchema = z.uuid().brand<"BudgetAccountId">();
export type BudgetAccountId = z.infer<typeof budgetAccountIdSchema>;
