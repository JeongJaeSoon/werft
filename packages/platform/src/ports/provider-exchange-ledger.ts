import type { ProviderUsage } from "../limits/model-prices.ts";

/**
 * The ledger of provider calls the egress proxy opened before calling
 * upstream and that no usage report has settled yet
 * (docs/contributing/decisions/provider-usage-ledger.md). Observation only:
 * nothing reads it to judge a limit.
 */
export interface ProviderExchangeLedger {
  open(input: {
    exchangeId: string;
    sessionId: string;
    attemptId: string;
    reserve: ProviderUsage;
  }): Promise<ProviderExchangeOpenResult>;
  /** Extends a row that exists; never inserts one. */
  renew(exchangeId: string): Promise<"open" | "gone">;
}

export type ProviderExchangeOpenResult =
  // `created`: a new row. `open`: the same open again, its lease extended.
  | { outcome: "created" | "open" }
  // A usage report for this exchange, from the same owner, is already in.
  | { outcome: "settled" }
  // No such attempt of that session.
  | { outcome: "unknown_attempt" }
  // The id is another owner's, or the same id came with another reserve.
  | { outcome: "conflict" };
