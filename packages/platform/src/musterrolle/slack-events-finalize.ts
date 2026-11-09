import type { SlackAppStore } from "../ports/slack-app-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import type { SlackAppService } from "./slack-app-service.ts";
import type {
  SlackFinalizeResult,
  SlackInstalled,
} from "./slack-install-service.ts";

export function slackEventsUrl(publicUrl: string, agentId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/v1/slack/events/${agentId.toLowerCase()}`;
}

export type SlackEventsFinalizeTarget = Pick<
  SlackInstalled,
  "workspaceId" | "agentId" | "slackAppId"
>;

/**
 * Finalize ①: sends the agent app's whole manifest again, now with its
 * event subscription. Idempotent, so the CLI can run it again for an app
 * installed before it existed. Without a public events address (the funnel
 * is the operator's), nothing is sent and the result says why.
 */
export function createSlackEventsFinalize(deps: {
  apps: Pick<SlackAppService, "updateAgentAppManifest">;
  agents: Pick<SlackAppStore, "manifestAgent">;
  publicUrl: string | null;
}): (target: SlackEventsFinalizeTarget) => Promise<SlackFinalizeResult> {
  return async (target) => {
    if (deps.publicUrl === null) {
      return { finalized: false, warnings: [{ code: "events_url_unset" }] };
    }
    const agent = await deps.agents.manifestAgent(
      target.workspaceId,
      target.agentId,
    );
    if (agent === null) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
    const { permissionsUpdated } = await deps.apps.updateAgentAppManifest(
      target.workspaceId,
      target.slackAppId,
      {
        name: agent.name,
        botName: agent.slug,
        description: agent.role,
        eventsUrl: slackEventsUrl(deps.publicUrl, target.agentId),
      },
    );
    return {
      finalized: true,
      warnings: permissionsUpdated ? [{ code: "reinstall_required" }] : [],
    };
  };
}
