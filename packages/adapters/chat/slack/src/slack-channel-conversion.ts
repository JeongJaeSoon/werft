import { SLACK_CHANNEL_CONVERSION_SUBTYPES } from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type SurfaceBindingStore,
} from "@werft-ai/platform";
import { z } from "zod";
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
 * follow the new kind (answer 15, 94S-2001). The message itself is no one's
 * request and goes no further. Every other event goes to `next`.
 */
export function createSlackChannelConversionHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  bindings: Pick<SurfaceBindingStore, "channelKindChanged">;
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
    const kind =
      parsed.data.subtype === "channel_convert_to_private"
        ? "private_channel"
        : "public_channel";
    const changed = await deps.bindings.channelKindChanged(
      {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        teamId: claim.teamId,
        channelId: parsed.data.channel,
      },
      kind,
    );
    deps.logger.info("Slack channel kind changed; sessions followed", {
      event: "slack.channel_kind_changed",
      agent_id: agent.agentId,
      channel_id: parsed.data.channel,
      channel_kind: kind,
      binding: changed.binding,
      sessions_moved: changed.moves.length,
      sessions_skipped: changed.skipped.length,
    });
  };
}
