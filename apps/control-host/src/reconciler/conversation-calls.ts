import { CONVERSATION_CALL_UNKNOWN_WARN_AT } from "@werft-ai/platform";
import {
  type ReconcilerEnvironment,
  type ReconcilerLogger,
  reconcilerSettings,
} from "./reconcile.ts";

/**
 * Releases the reservations of conversation calls whose token expired
 * unused, giving the account back what the issue held. A call of no turn
 * still in flight past the lease is timed out: its caller is gone, so its
 * place under the call limits is given back, each one logged; its
 * reservation stays held as of unknown end. Any other call the proxy used
 * and never reported within the lease is marked unknown and stays held:
 * its end is unknown.
 */
export async function runConversationCallReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  releaseExpired(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ released: number }>;
  timeOutStale(options: { dryRun: boolean; limit: number }): Promise<{
    timedOut: {
      callId: string;
      workspaceId: string;
      agentId: string;
      startedAt: Date;
    }[];
  }>;
  markUnknown(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ unknown: number }>;
  unknownByAgent(options: {
    atLeast: number;
    limit: number;
  }): Promise<{ workspaceId: string; agentId: string; unknown: number }[]>;
}): Promise<{ released: number; timedOut: number; unknown: number }> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const { released } = await input.releaseExpired({ dryRun, limit });
  // At most `limit` a pass, so a pile left by a crash drains over passes.
  const { timedOut } = await input.timeOutStale({ dryRun, limit });
  for (const call of timedOut) {
    input.logger.warn(
      "Conversation call timed out: its caller never ended it",
      {
        dry_run: dryRun,
        call_id: call.callId,
        workspace_id: call.workspaceId,
        agent_id: call.agentId,
        started_at: call.startedAt.toISOString(),
      },
    );
  }
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
    timed_out_count: timedOut.length,
    unknown_count: unknown,
  });
  return { released, timedOut: timedOut.length, unknown };
}
