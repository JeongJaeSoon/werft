import { z } from "zod";

// A leaf with no imports of its own, so both the session contract and the
// release spec can name the kinds without importing each other.
export const RUNTIME_KIND_VALUES = [
  "claude_agent_sdk",
  "codex_app_server",
  "pi_coding_agent",
] as const;
export const runtimeKindSchema = z.enum(RUNTIME_KIND_VALUES);
type RuntimeKind = (typeof RUNTIME_KIND_VALUES)[number];

const [claudeRuntime, codexRuntime] = RUNTIME_KIND_VALUES;

/**
 * The runtime a release on each connection kind runs: the Responses API is
 * Codex's, and every other kind is spoken to over the Messages API, which
 * only the Claude runtime speaks. Keyed by the connection kinds of
 * provider-kind.ts, spelled here so this file keeps no imports.
 */
export const RUNTIME_KIND_OF_PROVIDER = {
  anthropic: claudeRuntime,
  litellm: claudeRuntime,
  openai_responses: codexRuntime,
} as const satisfies Record<string, RuntimeKind>;

/**
 * The runtimes whose engine reviews tool calls with a classifier of its own,
 * which `permission_mode: auto` needs.
 */
export const RUNTIME_KINDS_WITH_AUTO_MODE: readonly RuntimeKind[] = [
  claudeRuntime,
];
