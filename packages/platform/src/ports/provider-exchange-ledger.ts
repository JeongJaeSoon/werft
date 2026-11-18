import type { ProviderUsage } from "../limits/index.ts";

/**
 * The ledger of provider calls the egress proxy opened before calling
 * upstream and that no usage report has settled yet
 * (docs/contributing/decisions/provider-usage-ledger.md). An open is where
 * a session's budget is judged with every call still in flight counted.
 */
export interface ProviderExchangeLedger {
  open(input: ProviderExchangeInput): Promise<ProviderExchangeOpenResult>;
  /** Extends a row that exists; never inserts one. */
  renew(exchangeId: string): Promise<"open" | "gone">;
  /** A call the provider did not bill: its reserve stops counting. */
  release(input: ProviderExchangeInput): Promise<ProviderExchangeReleaseResult>;
}

export type ProviderExchangeInput = {
  exchangeId: string;
  sessionId: string;
  attemptId: string;
  reserve: ProviderUsage;
};

/**
 * What one session holds when a call asks to open: its stored spend, and
 * the reserves of its unreleased rows with the new call's among them.
 */
export type HeldSpend = {
  costUsd: number;
  providerTokens: number;
  unmetered: boolean;
  reserves: readonly ProviderUsage[];
};

export type ProviderExchangeOpenResult =
  // `created`: a new row. `open`: the same open again, its lease extended.
  | { outcome: "created" | "open" }
  // A usage report for this exchange, from the same owner, is already in.
  | { outcome: "settled" }
  // Released before this open arrived: nothing counts it.
  | { outcome: "released" }
  // The session's spend with this call's reserve reaches a limit; no row.
  | { outcome: "budget_exceeded" }
  // No such attempt of that session.
  | { outcome: "unknown_attempt" }
  // The id is another owner's, or the same id came with another reserve.
  | { outcome: "conflict" };

export type ProviderExchangeReleaseResult =
  | "released"
  // Already reported: the report, not the release, decides what it cost.
  | "settled"
  | "unknown_attempt"
  | "conflict";
