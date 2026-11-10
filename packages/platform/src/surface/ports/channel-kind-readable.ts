import type { SurfaceChannelKind } from "@werft-ai/contracts";

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
