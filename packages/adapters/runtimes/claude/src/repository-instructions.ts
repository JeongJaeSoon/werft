import type { InstructionPart } from "@werft-ai/runtime-core";

import type { ClaudeRuntimeConfig } from "./config.ts";

/** How an instruction part reads in the appended prompt: as it is. */
export function instructionText(part: InstructionPart): string {
  return part.text;
}

/**
 * The text appended to the engine's preset system prompt: the caller's own
 * addition first, then the repository's instructions under a heading that
 * says where they came from.
 */
export function systemPromptAppend(
  config: Pick<
    ClaudeRuntimeConfig,
    "appendSystemPrompt" | "repositoryClaudeMd"
  >,
): string | undefined {
  const instructions = config.repositoryClaudeMd?.contents ?? null;
  const parts = [
    config.appendSystemPrompt,
    instructions === null || instructions.trim() === ""
      ? undefined
      : `Contents of the instruction file (AGENTS.md, else CLAUDE.md) at the root of the repository you are working in (project instructions checked into it):\n\n${instructions}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
