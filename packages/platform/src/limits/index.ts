// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.

export type { BudgetRoot } from "./budget-accounts.ts";
export type { ConversationCallLimit } from "./conversation-call-limits.ts";
export {
  CONVERSATION_CALL_PATH,
  CONVERSATION_CALL_TOKEN_PREFIX,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  type ConversationCalls,
  type ConversationCallUnavailable,
  conversationCallReserve,
  hashConversationCallToken,
} from "./conversation-calls.ts";
export {
  budgetExceeded,
  InstallationConfigUnavailableError,
  type InstallationLimits,
  limitsReached,
  MAX_PROVIDER_RETRIES,
  MAX_TURN_SECONDS_CEILING,
  readSetting,
  type SessionBudget,
  type SessionLimits,
  type SessionSpend,
  type Setting,
  STORAGE_ACCOUNTED_CONTENT,
  sessionBudgetOf,
} from "./installation-limits.ts";
export {
  type PricedBy,
  type ProviderUsage,
  priceJudgmentUsage,
  priceProviderUsage,
} from "./model-prices.ts";
export type {
  ConversationCallStore,
  ConversationTurnCallAuthorization,
} from "./ports/conversation-call-store.ts";
