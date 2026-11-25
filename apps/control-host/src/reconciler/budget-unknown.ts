import type { EstimatedBudgetLine, UnknownBudgetHeld } from "@werft-ai/db";
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
 * Settles, at most the batch size, the reservations of unknown end whose call
 * can no longer run, at what each held, as estimated (settleDeadUnknownBudget),
 * and logs each: money moved without an operator.
 */
export async function runDeadUnknownBudgetSettle(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  settle(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<EstimatedBudgetLine[]>;
}): Promise<EstimatedBudgetLine[]> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const lines = await input.settle({ dryRun, limit });
  for (const line of lines) {
    input.logger.warn(
      "Budget reservation of unknown end settled as estimated",
      {
        dry_run: dryRun,
        call_id: line.callId,
        call_kind: line.callKind,
        account_id: line.accountId,
        charged_cost_usd: line.charged.costUsd,
        charged_tokens: line.charged.tokens,
        receipt_id: line.receiptId,
      },
    );
  }
  return lines;
}

/**
 * Logs the budget accounts holding the most reservations of unknown end, at
 * most the batch size, and the total over every account, so an account they
 * pile up on can be seen. Changes nothing: an operator resolves them, or
 * runDeadUnknownBudgetSettle once their call can no longer run.
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
