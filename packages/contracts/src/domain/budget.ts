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

export const BUDGET_RESERVATION_STATE_VALUES = [
  "reserved",
  "settled",
  "released",
] as const;
export type BudgetReservationState =
  (typeof BUDGET_RESERVATION_STATE_VALUES)[number];

/**
 * A provider call that serves no session (a conversation call): held on a
 * budget account when its token is issued, `in_flight` once the proxy used
 * the token, `settled` by the usage report. An unused token's reservation
 * is `released` when it expires.
 */
export const CONVERSATION_CALL_STATE_VALUES = [
  "reserved",
  "in_flight",
  "settled",
  "released",
] as const;
export type ConversationCallState =
  (typeof CONVERSATION_CALL_STATE_VALUES)[number];

export const conversationCallIdSchema = z.uuid().brand<"ConversationCallId">();
export type ConversationCallId = z.infer<typeof conversationCallIdSchema>;

export const budgetAccountIdSchema = z.uuid().brand<"BudgetAccountId">();
export type BudgetAccountId = z.infer<typeof budgetAccountIdSchema>;
