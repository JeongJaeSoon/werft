import {
  SLACK_BINDING_LIST_LIMIT,
  type SlackFinalizeWarning,
} from "@werft-ai/contracts";
import type { AgentStore } from "../ports/agent-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import type {
  SlackOutboxEntry,
  SlackOutboxStore,
} from "../ports/slack-outbox-store.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import type { WelcomeOutcome } from "../surface/ports/agent-welcomable.ts";
import type { ChannelJoinable } from "../surface/ports/channel-joinable.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import type { SlackInstallFinalize } from "./slack-install-service.ts";

/** The welcome's words; the outbox escapes them, so a name mentions no one. */
export function slackWelcomeText(agentName: string): string {
  return `안녕하세요, ${agentName}입니다. 이 채널에 연결됐어요. 멘션하면 답할게요`;
}

/**
 * One welcome per home binding: a new release, a rollback or a home moved
 * back all find it taken. The store also refuses a channel that heard one
 * under another binding or under a pre-94S-1298 per-release key.
 */
export function deploymentWelcomeKey(
  agentId: string,
  homeBindingId: string,
): string {
  return `deployment-welcome:${agentId.toLowerCase()}:${homeBindingId.toLowerCase()}`;
}

/** Every path that welcomes builds its row here. */
export function deploymentWelcome(input: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  slackAppId: string;
  installationId: string;
  homeBindingId: string;
  channelId: string;
}): SlackOutboxEntry {
  return {
    workspaceId: input.workspaceId,
    agentId: input.agentId.toLowerCase(),
    slackAppId: input.slackAppId,
    installationId: input.installationId,
    kind: "welcome",
    channelId: input.channelId,
    threadTs: "",
    slackUserId: null,
    sessionId: null,
    body: { text: slackWelcomeText(input.agentName) },
    dedupeKey: deploymentWelcomeKey(input.agentId, input.homeBindingId),
  };
}

export type SlackWelcomeOutcome = WelcomeOutcome;

// What asking Slack again can change.
const WAITING_ON_SLACK = new Set<SlackWelcomeOutcome["status"]>([
  "unknown_membership",
  "awaiting_invite",
  "config_error",
  "join_failed",
]);

/**
 * Finalize ②: each home channel of the agent hears once. Joining a
 * public home comes first; a private one waits for the invite.
 */
export function createSlackWelcome(deps: {
  agents: Pick<AgentStore, "get" | "releaseSuperseded">;
  bindings: Pick<SurfaceBindingStore, "list">;
  apps: Pick<SlackAppStore, "findForAgent">;
  outbox: Pick<SlackOutboxStore, "enqueue">;
  /** Null without a bot token source: membership is only what was stored. */
  join: ChannelJoinable | null;
  logger: SlackInboxLogger;
}) {
  async function homeOf(workspaceId: string, agentId: string) {
    const [home] = await deps.bindings.list(workspaceId, agentId, 1);
    if (
      home === undefined ||
      !home.home ||
      home.status !== "ready" ||
      home.mode === "off" ||
      home.channelId === null ||
      home.installationId === null
    ) {
      return null;
    }
    return {
      ...home,
      channelId: home.channelId,
      installationId: home.installationId,
    };
  }

  /** The home and the release it would hear now; a status when none. */
  async function target(
    workspaceId: string,
    agentId: string,
  ): Promise<
    | { status: "no_home" | "no_release" | "rollback" }
    | {
        home: NonNullable<Awaited<ReturnType<typeof homeOf>>>;
        releaseId: string;
        agentName: string;
      }
  > {
    const home = await homeOf(workspaceId, agentId);
    if (home === null) return { status: "no_home" };
    const detail = await deps.agents.get(workspaceId, agentId);
    const releaseId = detail?.agent.active_release_id;
    if (!detail || !releaseId) return { status: "no_release" };
    if (await deps.agents.releaseSuperseded(workspaceId, agentId, releaseId)) {
      return { status: "rollback" };
    }
    return { home, releaseId, agentName: detail.agent.name };
  }

  /**
   * `ask`: ask Slack (and join) before deciding; otherwise only the stored
   * membership counts, so nothing but the database is read.
   */
  async function welcome(
    workspaceId: string,
    agentId: string,
    options: { ask: boolean },
  ): Promise<SlackWelcomeOutcome> {
    let found = await target(workspaceId, agentId);
    if ("status" in found) return found;
    const { home } = found;
    const channelId = home.channelId;
    let membership = home.membership;
    if (options.ask && deps.join !== null) {
      await deps.join(home);
      // The home may have moved, the release rolled back or an invite
      // landed while Slack answered: what is stored now decides.
      found = await target(workspaceId, agentId);
      if ("status" in found) return found;
      if (found.home.id !== home.id || found.home.channelId !== channelId) {
        return { status: "no_home" };
      }
      membership = found.home.membership;
    }
    if (membership === null) return { status: "unknown_membership", channelId };
    if (membership.state !== "joined") {
      return { status: membership.state, channelId, error: membership.error };
    }
    const app = await deps.apps.findForAgent(workspaceId, agentId);
    if (app === null) return { status: "not_installed" };
    const status = await deps.outbox.enqueue(
      deploymentWelcome({
        workspaceId,
        agentId,
        agentName: found.agentName,
        slackAppId: app.id,
        installationId: home.installationId,
        homeBindingId: home.id,
        channelId,
      }),
      // Moved, turned off or rolled back since it was read: not this home.
      { bindingId: home.id, releaseId: found.releaseId },
    );
    if (status === "not_home") return { status: "no_home" };
    return { status, channelId };
  }

  const logOutcome = (
    agentId: string,
    releaseId: string,
    outcome: SlackWelcomeOutcome,
  ) => {
    if (outcome.status === "enqueued" || outcome.status === "duplicate") return;
    deps.logger.info("Deployment welcome not enqueued", {
      agent_id: agentId,
      release_id: releaseId,
      ...outcome,
    });
  };

  return {
    welcome,

    /**
     * The install's Finalize ②: every bound channel is joined (or found
     * waiting), then the home hears the active release. What the bot is
     * not in yet comes back as warnings naming the channel.
     */
    finalize: (async (installed) => {
      const warnings: SlackFinalizeWarning[] = [];
      const bindings = await deps.bindings.list(
        installed.workspaceId,
        installed.agentId,
        SLACK_BINDING_LIST_LIMIT,
      );
      for (const binding of bindings) {
        if (binding.channelId === null || deps.join === null) continue;
        const membership = await deps.join(binding);
        if (membership !== null && membership.state !== "joined") {
          warnings.push({
            code: membership.state,
            channel_id: binding.channelId,
            ...(membership.error === null ? {} : { error: membership.error }),
          });
        }
      }
      await welcome(installed.workspaceId, installed.agentId, { ask: false });
      return { finalized: true, warnings };
    }) satisfies SlackInstallFinalize,

    /**
     * A release went live. A rollback, to a release older than one already
     * activated, says nothing on any path, even when that release was never
     * announced. The row is enqueued before this returns when the bot is
     * known to be in the home; otherwise Slack is asked after, so the
     * activation never waits on it. Never throws: a welcome that cannot go
     * is logged and left on the binding.
     */
    async activated(
      workspaceId: string,
      agentId: string,
      releaseId: string,
    ): Promise<SlackWelcomeOutcome | null> {
      try {
        // The release live by then is what is announced; `releaseId` names
        // the activation in the log.
        const outcome = await welcome(workspaceId, agentId, { ask: false });
        if (!WAITING_ON_SLACK.has(outcome.status) || deps.join === null) {
          logOutcome(agentId, releaseId, outcome);
          return outcome;
        }
        void welcome(workspaceId, agentId, { ask: true }).then(
          (asked) => logOutcome(agentId, releaseId, asked),
          (error: unknown) =>
            deps.logger.warn("Deployment welcome failed", {
              agent_id: agentId,
              release_id: releaseId,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return outcome;
      } catch (error) {
        deps.logger.warn("Deployment welcome failed", {
          agent_id: agentId,
          release_id: releaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
