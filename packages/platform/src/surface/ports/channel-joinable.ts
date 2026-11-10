import type { SurfaceMembership } from "@werft-ai/contracts";
import type { SurfaceBindingRecord } from "../../ports/surface-binding-store.ts";

/**
 * Joins a live channel binding's channel and answers what the channel said.
 * Null when there was nothing to ask: the DM row, a binding that is off, no
 * bot token, or a channel that did not answer.
 */
export type ChannelJoinable = (
  binding: SurfaceBindingRecord,
) => Promise<SurfaceMembership | null>;
