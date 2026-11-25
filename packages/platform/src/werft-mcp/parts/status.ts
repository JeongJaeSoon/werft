import type { WerftMcpPart, WerftMcpPartContext } from "../part.ts";

/** What this session's agent is connected to and may do, read only. */
export function statusPart(_context: WerftMcpPartContext): WerftMcpPart {
  return {};
}
