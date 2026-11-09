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
};
