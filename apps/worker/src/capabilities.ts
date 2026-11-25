import type { WorkerCapabilities } from "@werft-ai/contracts";

/**
 * What this image parses beyond the protocol's first version, announced on
 * the claim and on every pending-control poll so the server shapes the answers
 * it hands this worker by it.
 */
export const WORKER_CAPABILITIES: WorkerCapabilities = {
  approval_remember: true,
  platform_tool_trust: true,
  permission_rules: true,
  // runtimeStart hands `runtime_config.env` to the engine's environment
  // (composition.ts), so the server may send it.
  user_env: true,
  // composition.ts hands `runtime_config.response_language` to the runtime,
  // and the Claude adapter appends its instruction.
  response_language: true,
  answer_surface: true,
  // GitWorkspace fetches an additional repository's `commit` by name, and
  // the host reports what it pinned (worker-host.ts `pinRepositories`).
  repository_pins: true,
  // mcpServersOf (composition.ts) routes every `mcp_servers` entry, however
  // many, through its own `/mcp/<name>` proxy path.
  workspace_mcp: true,
  // The adapters leave the built-in `werft` server out of the checkpoint
  // fingerprint and relay its instructions, resources and prompts.
  werft_mcp: true,
};
