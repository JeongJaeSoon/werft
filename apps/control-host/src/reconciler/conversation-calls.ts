import {
  type ReconcilerEnvironment,
  type ReconcilerLogger,
  reconcilerSettings,
} from "./reconcile.ts";

/**
 * Releases the reservations of conversation calls whose token expired
 * unused, giving the account back what the issue held. A call the proxy
 * used and never reported stays held: its end is unknown.
 */
export async function runConversationCallReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  releaseExpired(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ released: number }>;
}): Promise<{ released: number }> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const result = await input.releaseExpired({ dryRun, limit });
  input.logger.info("Conversation call reservations reconciled", {
    dry_run: dryRun,
    released_count: result.released,
  });
  return result;
}
