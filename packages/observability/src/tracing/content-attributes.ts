// Which span attributes carry prompts, answers and tool I/O. The worker's
// emitter and the ingest listener share this list, so `metadata` mode means
// the same thing on both sides. No imports.

const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

// `gen_ai.prompt.0.content` and the like: indexed content from older conventions.
const CONTENT_PREFIXES = ["gen_ai.prompt.", "gen_ai.completion."] as const;

export function isContentAttribute(key: string): boolean {
  return (
    CONTENT_KEYS.has(key) ||
    CONTENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
