import type { BudgetAccountId, BudgetOwnerKind } from "@werft-ai/contracts";
import type { BudgetChoice } from "../budget-accounts.ts";
import type { ProviderUsage } from "../index.ts";

/**
 * The ledger of provider calls the egress proxy opened before calling
 * upstream and that no usage report has settled yet. An open is where
 * a session's budget is judged with every call still in flight counted, and
 * the budget account it names, if any, in the same transaction: the call is
 * held on both or on neither. A usage report settles both, a release
 * frees both.
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
  /**
   * The account the open also holds the call on, priced as the session's
   * judge prices it. Absent: the session's limit alone, as before accounts.
   * A release ignores it and frees what the open held.
   */
  budget?: BudgetChoice;
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
  // The session's spend, or the account's, with this call's reserve reaches
  // a limit: nothing is held on either. `by` names which, for the log.
  | {
      outcome: "budget_exceeded";
      by: "session" | "account";
      // The account that refused; null for the session, or for the agent's
      // own work with no team to charge.
      accountId: BudgetAccountId | null;
      // Whose account refused; null for the session, and for the agent's
      // own work with no team to charge.
      owner: BudgetOwnerKind | null;
    }
  // No such attempt of that session.
  | { outcome: "unknown_attempt" }
  // The id is another owner's, or the same id came with another reserve or
  // another account.
  | { outcome: "conflict" };

export type ProviderExchangeReleaseResult =
  | "released"
  // Already reported: the report, not the release, decides what it cost.
  | "settled"
  | "unknown_attempt"
  | "conflict";
