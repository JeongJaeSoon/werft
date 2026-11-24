import type {
  BudgetAccountId,
  BudgetReservationState,
  BudgetRootKind,
} from "@werft-ai/contracts";
import type { BudgetChoice } from "../budget-accounts.ts";

/** Cost in the ledger's unit (USD, as provider_usage) and provider tokens. */
export type BudgetAmount = { costUsd: number; tokens: number };

/**
 * The budget accounts' reserve, settle and release, each atomic in its own
 * transaction. A call is named by its call id; repeating any of the three
 * with the same id changes nothing the first did not.
 */
export interface BudgetLedger {
  reserve(input: BudgetReserveInput): Promise<BudgetReserveResult>;
  settle(input: {
    callId: string;
    actual: BudgetAmount;
  }): Promise<BudgetSettleResult>;
  release(callId: string): Promise<BudgetReleaseResult>;
}

export type BudgetReserveInput = {
  callId: string;
  workspaceId: string;
  choice: BudgetChoice;
  reserve: BudgetAmount;
  /** The connection bills nothing: the call holds and spends tokens only. */
  unmetered: boolean;
};

export type BudgetReserveResult =
  // A new reservation, charged to the account of this month (null: none).
  | {
      outcome: "reserved";
      accountId: BudgetAccountId | null;
      rootKind: BudgetRootKind;
    }
  // The reserve does not fit, or the agent's own work has no limit: no row.
  | { outcome: "refused"; accountId: BudgetAccountId | null }
  // The same reservation again: what became of it.
  | { outcome: "replayed"; state: BudgetReservationState }
  // The id was reserved for another account or another amount.
  | { outcome: "conflict" };

export type BudgetSettleResult =
  | "settled"
  // Already settled: the first settlement stands.
  | "already_settled"
  // Resolved by an operator first: the difference from what that charged
  // was added as the call's one adjustment, now or by an earlier report.
  | "adjusted"
  | "already_adjusted"
  | "unknown";

export type BudgetReleaseResult =
  | "released"
  | "already_released"
  // Settled first: what it cost stands, and nothing is released.
  | "settled"
  // An operator resolved it first: what that charged stands.
  | "resolved"
  | "unknown";
