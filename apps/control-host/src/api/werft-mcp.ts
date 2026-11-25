import type { Database } from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  docsPart,
  guidePart,
  statusPart,
  type WerftMcpPart,
  type WerftMcpPartContext,
} from "@werft-ai/platform";
import { installedWerftDocs } from "./werft-docs.ts";

/** What a part may read beyond the context. */
export type WerftMcpPartDeps = {
  db: Database;
  authorization: AuthorizationPolicy;
};

/**
 * The parts the built-in `werft` MCP server is made of, in the order their
 * tools, resources and prompts are listed. Each part is one area's: what it
 * takes from `deps` is passed on its own line here.
 */
export function werftMcpParts(
  context: WerftMcpPartContext,
  _deps: WerftMcpPartDeps,
): WerftMcpPart[] {
  return [
    // The installed documentation: search, and the pages as resources.
    docsPart(context, installedWerftDocs()),

    // What this session's agent is connected to and may do.
    statusPart(context),

    // The usage guide, its tool for an engine that takes no skill, and the
    // prompts for common checks.
    guidePart(context),
  ];
}
