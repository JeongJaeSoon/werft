import { SLACK_CHANNEL_SHARING_EVENT_TYPES } from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type ChannelSharingReadable,
  type SecretStore,
  type SurfaceAppStore,
  type SurfaceBindingStore,
} from "@werft-ai/platform";
import { z } from "zod";
import type { SlackAudience } from "./slack-audience.ts";
import { slackBotToken } from "./slack-bot-token.ts";
import { lifecycleTime } from "./slack-channel-join.ts";
import type { SlackChannelSharingApi } from "./slack-config-api.ts";
import type { SlackInboundHandler } from "./slack-inbox.ts";

const sharingEventSchema = z.object({
  type: z.enum(SLACK_CHANNEL_SHARING_EVENT_TYPES),
  channel: z.string().min(1),
});

/**
 * The `slack` role's handler for a channel shared with another organization
 * or no longer (`channel_shared`, `channel_unshared`): Slack is asked again
 * whether another organization still shares it, since one of an Enterprise's
 * own workspaces sharing it does not count, and the answer goes on the
 * channel's binding. Unanswered, a share is taken as one until Slack says
 * otherwise; an unshare waits for the next post to ask. Every other event
 * goes to `next`.
 */
export function createSlackChannelSharingHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  audience: Pick<SlackAudience, "channelSharing">;
  bindings: Pick<SurfaceBindingStore, "recordExternalShared">;
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  const types = new Set<string>(SLACK_CHANNEL_SHARING_EVENT_TYPES);
  return async (claim) => {
    const event = (claim.payload as { event?: { type?: unknown } }).event;
    if (typeof event?.type !== "string" || !types.has(event.type)) {
      return deps.next(claim);
    }
    const parsed = sharingEventSchema.safeParse(event);
    if (!parsed.success) return;
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped") return;
    const { type, channel } = parsed.data;
    const sharing = await deps.audience.channelSharing({
      installationId: agent.installationId,
      channelId: channel,
      botToken: await deps.botToken(claim.workspaceId, claim.slackAppId),
      fresh: true,
    });
    if (sharing === null && type === "channel_shared") {
      const us = lifecycleTime(claim);
      await deps.bindings.recordExternalShared(
        agent.installationId,
        channel,
        true,
        us === null ? new Date() : new Date(us / 1000),
      );
    }
  };
}

/**
 * Channel sharing as the agent's own app sees it, for a binding being saved.
 * Without a secret store, an app or a bot token, nothing can be told.
 */
export function createSlackChannelSharingReader(deps: {
  apps: Pick<SurfaceAppStore, "findForAgent"> | null;
  secrets: Pick<SecretStore, "get"> | null;
  slack: SlackChannelSharingApi;
}): ChannelSharingReadable {
  return {
    async sharingOf(workspaceId, agentId, channelId) {
      if (deps.apps === null || deps.secrets === null) return null;
      const app = await deps.apps.findForAgent(workspaceId, agentId);
      if (app === null) return null;
      const token = await slackBotToken(deps.secrets, workspaceId, app.id);
      if (token === null) return null;
      try {
        return await deps.slack.channelSharing(token, channelId);
      } catch {
        return null;
      }
    },
  };
}
