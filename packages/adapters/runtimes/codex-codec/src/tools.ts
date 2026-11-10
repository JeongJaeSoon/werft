/**
 * The tools a Codex session can be given. The engine's tool set is fixed:
 * commands (file changes ride on them as `apply_patch`) are the one thing a
 * session can do, so a tool list is either this or a request the engine
 * cannot honor. Its other tools (web search, sub-agents, goals) are switched
 * off by the adapter, and what stays (`write_stdin`, `view_image`,
 * `request_user_input`) is not a separate capability.
 */
export const CODEX_BUILTIN_TOOLS = ["exec_command"] as const;
