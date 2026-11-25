import {
  docsPart,
  guidePart,
  statusPart,
  type WerftMcpPart,
  type WerftMcpPartContext,
} from "@werft-ai/platform";

/**
 * The parts the built-in `werft` MCP server is made of, in the order their
 * tools, resources and prompts are listed. Each part is one area's: what it
 * needs beyond the context is passed on its own line here.
 */
export function werftMcpParts(context: WerftMcpPartContext): WerftMcpPart[] {
  return [
    // The installed documentation: search, and the pages as resources.
    docsPart(context),

    // What this session's agent is connected to and may do.
    statusPart(context),

    // The usage guide, its tool for an engine that takes no skill, and the
    // prompts for common checks.
    guidePart(context),
  ];
}
