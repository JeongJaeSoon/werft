// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.
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
