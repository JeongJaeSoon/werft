import { budgetExceeded, type SessionBudget } from "./installation-limits.ts";
import {
  type PriceSource,
  type ProviderUsage,
  priceProviderUsage,
} from "./model-prices.ts";
import type { HeldSpend } from "./ports/provider-exchange-ledger.ts";

/**
 * A reserve priced as the dearest call its request could turn out to be:
 * every prompt token written to the longest-lived cache, which the table
 * charges at each model's highest write multiple. `pricedBy` is what prices
 * the model the request asked for.
 */
export function priceReservation(reserve: ProviderUsage): {
  costUsd: number;
  pricedBy: PriceSource;
} {
  const prompt = reserve.inputTokens + reserve.cacheCreationInputTokens;
  return priceProviderUsage({
    ...reserve,
    inputTokens: 0,
    cacheCreationInputTokens: prompt,
    cacheCreation1hInputTokens: prompt,
  });
}

export function reservationCostUsd(reserve: ProviderUsage): number {
  return priceReservation(reserve).costUsd;
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
 * What an open is judged against: the session's budget, and how many tokens
 * of unknown price it may use. The second is judged at an open alone; no
 * dispatch gate reads it.
 */
export type ExchangeBudget = SessionBudget & { unknownPriceTokens: number };

/**
 * Whether a session may open one more provider call: its stored spend with
 * every unreleased reserve added, the new one's included, is still under
 * both limits. An unmetered session's reserves cost nothing but still count
 * their tokens.
 *
 * A model nothing prices is charged the highest known rate, which its real
 * price may exceed, so its tokens are held to a limit no price enters: the
 * tokens of the session's settled calls marked unknown, with every held
 * reserve for such a model, stay under `unknownPriceTokens`. A session with
 * none of either is never refused by it. An unmetered session's calls are
 * not of unknown price: its connection declared them free.
 */
export function admitsReservations(
  budget: ExchangeBudget,
): (held: HeldSpend) => boolean {
  return (held) => {
    let costUsd = held.costUsd;
    let providerTokens = held.providerTokens;
    let unknownPriceTokens = held.unknownPriceTokens;
    for (const reserve of held.reserves) {
      const tokens = reservationTokens(reserve);
      if (!held.unmetered) {
        const priced = priceReservation(reserve);
        costUsd += priced.costUsd;
        if (priced.pricedBy === "unknown") unknownPriceTokens += tokens;
      }
      providerTokens += tokens;
    }
    return (
      !budgetExceeded({ costUsd, providerTokens }, budget) &&
      unknownPriceTokens < budget.unknownPriceTokens
    );
  };
}
