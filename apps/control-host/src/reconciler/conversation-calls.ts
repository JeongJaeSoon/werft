import { CONVERSATION_CALL_UNKNOWN_WARN_AT } from "@werft-ai/platform";
import {
  type ReconcilerEnvironment,
  type ReconcilerLogger,
  reconcilerSettings,
} from "./reconcile.ts";

/**
 * Releases the reservations of conversation calls whose token expired
 * unused, giving the account back what the issue held. A call the proxy
 * used and never reported within the lease is marked unknown and stays
 * held: its end is unknown.
 */
export async function runConversationCallReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  releaseExpired(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ released: number }>;
  markUnknown(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ unknown: number }>;
  unknownByAgent(options: {
    atLeast: number;
    limit: number;
  }): Promise<{ workspaceId: string; agentId: string; unknown: number }[]>;
}): Promise<{ released: number; unknown: number }> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const { released } = await input.releaseExpired({ dryRun, limit });
  const { unknown } = await input.markUnknown({ dryRun, limit });
  // Unknown calls hold the agent's concurrency limit until settled or an
  // operator releases them.
  for (const held of await input.unknownByAgent({
    atLeast: CONVERSATION_CALL_UNKNOWN_WARN_AT,
    limit,
  })) {
    input.logger.warn("Conversation calls of unknown end hold an agent", {
      workspace_id: held.workspaceId,
      agent_id: held.agentId,
      unknown_count: held.unknown,
    });
  }
  input.logger.info("Conversation call reservations reconciled", {
    dry_run: dryRun,
    released_count: released,
    unknown_count: unknown,
  });
  return { released, unknown };
}
