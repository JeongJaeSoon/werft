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

/**
 * The tool each runtime starts a subagent with. It is not in the built-in
 * tool catalog (a subagent cannot be checked from inside a subagent), so a
 * release adds it to the catalog's tools: subagents run on the release's own
 * tools, and a workspace or agent deny rule on it turns them off.
 */
export const RUNTIME_SUBAGENT_TOOL: Partial<Record<RuntimeKind, string>> = {
  [claudeRuntime]: "Agent",
};

/**
 * The tools of a runtime whose tool set is fixed and that has no built-in
 * tool catalog (a catalog is what deny rules name tools from, and such a
 * runtime takes none). A release on it carries exactly these. Codex's is its
 * adapter's `CODEX_BUILTIN_TOOLS`, which a codec test holds equal.
 */
export const RUNTIME_FIXED_TOOLS: Partial<
  Record<RuntimeKind, readonly string[]>
> = {
  [codexRuntime]: ["exec_command"],
};
