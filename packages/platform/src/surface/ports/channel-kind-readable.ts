import type {
  SlackChannelSharing,
  SurfaceChannelKind,
} from "@werft-ai/contracts";

/**
 * What the channel provider says a channel of the agent's install is. Throws
 * a SessionServiceError the route answers with.
 */
export interface ChannelKindReadable {
  kindOf(
    workspaceId: string,
    agentId: string,
    channelId: string,
  ): Promise<SurfaceChannelKind>;
}

/**
 * Whether another organization shares a channel of the agent's install;
 * null when the channel provider could not tell. Never throws for that.
 */
export interface ChannelSharingReadable {
  sharingOf(
    workspaceId: string,
    agentId: string,
    channelId: string,
  ): Promise<SlackChannelSharing | null>;
}
