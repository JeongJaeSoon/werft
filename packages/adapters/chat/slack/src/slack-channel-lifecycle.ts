import { SLACK_CHANNEL_LIFECYCLE_EVENT_TYPES } from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type ConversationStore,
  type SurfaceBindingStore,
} from "@werft-ai/platform";
import { z } from "zod";
import { lifecycleTime } from "./slack-channel-join.ts";
import type { SlackInboundHandler } from "./slack-inbox.ts";

const channelLifecycleSchema = z.union([
  z.object({
    type: z.enum([
      "channel_archive",
      "channel_unarchive",
      "group_archive",
      "group_unarchive",
      "channel_deleted",
      "group_deleted",
    ]),
    channel: z.string().min(1),
  }),
  // A rename names the channel as an object with its new name.
  z.object({
    type: z.enum(["channel_rename", "group_rename"]),
    channel: z.object({ id: z.string().min(1), name: z.string() }),
  }),
]);

/** The channel a lifecycle event of `SLACK_CHANNEL_LIFECYCLE_EVENT_TYPES` names. */
export function lifecycleChannelOf(event: unknown): string | null {
  const parsed = channelLifecycleSchema.safeParse(event);
  if (!parsed.success) return null;
  return typeof parsed.data.channel === "string"
    ? parsed.data.channel
    : parsed.data.channel.id;
}

/**
 * The `slack` role's handler for a channel being archived, unarchived,
 * renamed or deleted (`SLACK_CHANNEL_LIFECYCLE_EVENT_TYPES`): the agent's
 * conversation of that channel, when it has one, notes the state or the new
 * name; a deletion also makes the channel's binding `gone`. The binding of
 * an archived channel is left as it is. Every other event goes to `next`.
 */
export function createSlackChannelLifecycleHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  bindings: Pick<SurfaceBindingStore, "channelDeleted">;
  conversations: Pick<
    ConversationStore,
    "recordChannelState" | "recordChannelName"
  >;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  const types = new Set<string>(SLACK_CHANNEL_LIFECYCLE_EVENT_TYPES);
  return async (claim) => {
    const event = (claim.payload as { event?: { type?: unknown } }).event;
    if (typeof event?.type !== "string" || !types.has(event.type)) {
      return deps.next(claim);
    }
    const parsed = channelLifecycleSchema.safeParse(event);
    // A lifecycle event in a shape Slack never sends takes no effect.
    if (!parsed.success) return;
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped") return;
    const at = lifecycleTime(claim);
    const { data } = parsed;
    const channelId =
      typeof data.channel === "string" ? data.channel : data.channel.id;
    const key = {
      kind: "channel" as const,
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      teamId: claim.teamId,
      channelId,
    };
    switch (data.type) {
      case "channel_rename":
      case "group_rename":
        if (typeof data.channel !== "string") {
          await deps.conversations.recordChannelName(
            key,
            data.channel.name,
            at,
          );
        }
        return;
      case "channel_archive":
      case "group_archive":
        await deps.conversations.recordChannelState(key, "archived", at);
        return;
      case "channel_unarchive":
      case "group_unarchive":
        await deps.conversations.recordChannelState(key, "unarchived", at);
        return;
      case "channel_deleted":
      case "group_deleted":
        await deps.bindings.channelDeleted(agent.installationId, channelId, at);
        await deps.conversations.recordChannelState(key, "deleted", at);
        return;
    }
  };
}
