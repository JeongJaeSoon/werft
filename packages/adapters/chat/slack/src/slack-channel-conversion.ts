import { SLACK_CHANNEL_CONVERSION_SUBTYPES } from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type ChannelKindNow,
  type SurfaceBindingStore,
} from "@werft-ai/platform";
import { z } from "zod";
import type { SlackBotApi } from "./slack-config-api.ts";
import type { SlackInboundHandler, SlackInboxLogger } from "./slack-inbox.ts";

const conversionSchema = z.object({
  type: z.literal("message"),
  subtype: z.enum(SLACK_CHANNEL_CONVERSION_SUBTYPES),
  channel: z.string().min(1),
});

/**
 * The `slack` role's handler for a channel made private or public, which
 * Slack tells as a message in it (`channel_convert_to_private`,
 * `channel_convert_to_public`): the channel's binding and its sessions
 * follow the new kind (answer 15, 94S-2001), each session moved with a
 * `share_session` receipt naming the event. The message itself is no one's
 * request and goes no further. Every other event goes to `next`.
 *
 * Conversions can arrive out of order, so the kind applied is the one Slack
 * reports now, not the one the message names. Without a bot token only a
 * conversion to private is applied: it narrows and never widens.
 */
export function createSlackChannelConversionHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  bindings: Pick<SurfaceBindingStore, "channelKindChanged">;
  slack: Pick<SlackBotApi, "channelKind">;
  /** The app's bot token from the secret store; null when it has none. */
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  logger: Pick<SlackInboxLogger, "info">;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  return async (claim) => {
    const event = (claim.payload as { event?: unknown }).event;
    const parsed = conversionSchema.safeParse(event);
    if (!parsed.success) return deps.next(claim);
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped") return;
    const named =
      parsed.data.subtype === "channel_convert_to_private"
        ? "private_channel"
        : "public_channel";
    // Asked inside the move, after its lock on the channel. A failed read
    // throws, and the inbox tries the event again.
    let applied: ChannelKindNow | null = null;
    let tokenless = false;
    const kindNow = async () => {
      const token = await deps.botToken(claim.workspaceId, claim.slackAppId);
      tokenless = token === null;
      const kind =
        token === null
          ? named === "private_channel"
            ? named
            : null
          : await deps.slack.channelKind(token, parsed.data.channel);
      applied = kind === "dm" ? null : kind;
      return applied;
    };
    const changed = await deps.bindings.channelKindChanged(
      {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        teamId: claim.teamId,
        channelId: parsed.data.channel,
      },
      kindNow,
      // Members are not read here: who loses the sessions is not counted.
      {
        ref: { event_id: claim.eventId },
        reason: "slack_channel_converted",
        by: "slack_event",
        noInstall: () => tokenless,
        peopleLosing: null,
      },
    );
    if (changed === null) {
      deps.logger.info(
        "Slack channel conversion not confirmed; left as it was",
        {
          event: "slack.channel_kind_unconfirmed",
          agent_id: agent.agentId,
          channel_id: parsed.data.channel,
          named,
        },
      );
      return;
    }
    deps.logger.info("Slack channel kind changed; sessions followed", {
      event: "slack.channel_kind_changed",
      agent_id: agent.agentId,
      channel_id: parsed.data.channel,
      channel_kind: applied,
      binding: changed.binding,
      sessions_moved: changed.moves.length,
      sessions_skipped: changed.skipped.length,
    });
    // A session linked while it ran was left out; the inbox tries the event
    // again, and the move, done once, takes the rest.
    if (changed.skipped.some((skip) => skip.reason === "share_changed")) {
      throw new Error(
        "Slack channel conversion left sessions linked meanwhile; tried again",
      );
    }
  };
}
