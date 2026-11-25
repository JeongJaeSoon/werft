import type { BudgetOwnerKind } from "@werft-ai/contracts";

/**
 * One thread notice per link, account owner and month: a budget account is
 * one month's, so a refusal in a later month is told again, and the same
 * account refusing every turn after is not. `period` is the refusal's
 * month in UTC, `YYYY-MM`.
 */
export function budgetAccountRefusalDedupeKey(
  sessionLinkId: string,
  owner: BudgetOwnerKind,
  period: string,
): string {
  return `budget_account:${sessionLinkId}:${owner}:${period}`;
}
