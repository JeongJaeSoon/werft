import { budgetExceeded, type SessionBudget } from "./installation-limits.ts";
import { type ProviderUsage, priceProviderUsage } from "./model-prices.ts";
import type { HeldSpend } from "./ports/provider-exchange-ledger.ts";

/**
 * A reserve priced as the dearest call its request could turn out to be:
 * every prompt token written to the longest-lived cache, which the table
 * charges at each model's highest write multiple.
 */
export function reservationCostUsd(reserve: ProviderUsage): number {
  const prompt = reserve.inputTokens + reserve.cacheCreationInputTokens;
  return priceProviderUsage({
    ...reserve,
    inputTokens: 0,
    cacheCreationInputTokens: prompt,
    cacheCreation1hInputTokens: prompt,
  }).costUsd;
}

/** The same sum the provider_usage trigger adds to `provider_tokens`. */
export function reservationTokens(reserve: ProviderUsage): number {
  return (
    reserve.inputTokens +
    reserve.cacheCreationInputTokens +
    reserve.cacheReadInputTokens +
    reserve.outputTokens
  );
}

/**
 * Whether a session may open one more provider call: its stored spend with
 * every unreleased reserve added, the new one's included, is still under
 * both limits. An unmetered session's reserves cost nothing but still count
 * their tokens.
 */
export function admitsReservations(
  budget: SessionBudget,
): (held: HeldSpend) => boolean {
  return (held) => {
    let costUsd = held.costUsd;
    let providerTokens = held.providerTokens;
    for (const reserve of held.reserves) {
      if (!held.unmetered) costUsd += reservationCostUsd(reserve);
      providerTokens += reservationTokens(reserve);
    }
    return !budgetExceeded({ costUsd, providerTokens }, budget);
  };
}
