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
  // The Claude adapter appends `runtime_config.engine_settings` to the
  // engine's settings (engine-settings.ts), so the server may send it.
  engine_settings: true,
  // runtimeStart hands `runtime_config.env` to the engine's environment
  // (composition.ts), so the server may send it.
  user_env: true,
};
