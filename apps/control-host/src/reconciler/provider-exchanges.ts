import {
  type ReconcilerEnvironment,
  type ReconcilerLogger,
  reconcilerSettings,
} from "./reconcile.ts";

export type ProviderExchangesReconciled = {
  settled: number;
  noticed: readonly {
    exchangeId: string;
    sessionId: string;
    attemptId: string;
    openedAt: Date;
  }[];
  deleted: number;
};

/**
 * The provider exchange ledger's pass (provider-usage-ledger.md): rows a
 * report already settled are deleted, the rest whose lease ran out are
 * logged once each, and those long expired are deleted. Observation only;
 * it changes no cost and no limit.
 */
export async function runProviderExchangeReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  reconcile(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<ProviderExchangesReconciled>;
}): Promise<ProviderExchangesReconciled> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const result = await input.reconcile({ dryRun, limit });
  // Not a lost cost by itself: the call may have failed before upstream
  // billed it, or may still be streaming with its renewals failing.
  for (const row of result.noticed) {
    input.logger.warn("Provider exchange reservation expired unsettled", {
      dry_run: dryRun,
      exchange_id: row.exchangeId,
      session_id: row.sessionId,
      attempt_id: row.attemptId,
      opened_at: row.openedAt.toISOString(),
    });
  }
  input.logger.info("Provider exchange ledger reconciled", {
    dry_run: dryRun,
    settled_count: result.settled,
    noticed_count: result.noticed.length,
    deleted_count: result.deleted,
  });
  return result;
}
