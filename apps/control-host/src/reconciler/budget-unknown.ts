import type { UnknownBudgetHeld } from "@werft-ai/db";
import {
  type ReconcilerEnvironment,
  type ReconcilerLogger,
  reconcilerSettings,
} from "./reconcile.ts";

export type UnknownBudgetReport = {
  accounts: UnknownBudgetHeld[];
  total: {
    accountCount: number;
    count: number;
    costUsd: number;
    tokens: number;
  };
};

/**
 * Logs the budget accounts holding the most reservations of unknown end, at
 * most the batch size, and the total over every account, so an account they
 * pile up on can be seen. Changes nothing: releasing them is an operator's
 * step a1 adds.
 */
export async function runUnknownBudgetReport(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  unknownByAccount(limit: number): Promise<UnknownBudgetReport>;
}): Promise<UnknownBudgetReport> {
  const { limit } = reconcilerSettings(input.environment ?? process.env);
  const report = await input.unknownByAccount(limit);
  for (const account of report.accounts) {
    input.logger.warn("Budget reservations of unknown end held", {
      account_id: account.accountId,
      owner_kind: account.ownerKind,
      owner_id: account.ownerId,
      unknown_count: account.count,
      held_cost_usd: account.costUsd,
      held_tokens: account.tokens,
    });
  }
  input.logger.info("Budget reservations of unknown end reported", {
    account_count: report.total.accountCount,
    logged_account_count: report.accounts.length,
    unknown_count: report.total.count,
    held_cost_usd: report.total.costUsd,
    held_tokens: report.total.tokens,
  });
  return report;
}
