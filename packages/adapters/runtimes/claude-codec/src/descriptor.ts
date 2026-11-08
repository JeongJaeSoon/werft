import type { RuntimeDescriptor } from "@werft-ai/runtime-core";

import { CLAUDE_CHECKPOINT_ENGINE } from "./checkpoint-codec.ts";
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./versions.ts";

export const CLAUDE_DESCRIPTOR: RuntimeDescriptor = {
  contractVersion: "runtime-contract/v1",
  kind: "claude_agent_sdk",
  checkpointEngine: CLAUDE_CHECKPOINT_ENGINE,
  runtimeVersion: CLAUDE_AGENT_SDK_VERSION,
  engineVersion: CLAUDE_CODE_VERSION,
  capabilities: {
    interrupt: true,
    checkpoint: true,
    approvalCheckpoint: true,
    resume: true,
    mcp: "native",
    skills: "none",
    permissionModes: {
      default: "native",
      acceptEdits: "native",
      dontAsk: "native",
      plan: "native",
      bypassPermissions: "native",
      auto: "native",
    },
  },
  // Spelled out: the platform runs no user hooks through Claude's own settings yet.
  extraFeatures: { subagents: "native", user_hooks: "none" },
  toolEnv: "engine_inherited",
  secretEnv: "none",
  instructionFiles: ["AGENTS.md", "CLAUDE.md"],
};
