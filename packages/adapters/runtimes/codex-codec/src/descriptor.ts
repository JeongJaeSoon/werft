import type { RuntimeDescriptor } from "@werft-ai/runtime-core";

import { CODEX_CHECKPOINT_ENGINE } from "./checkpoint-codec.ts";
import { CODEX_CLI_VERSION } from "./versions.ts";

/**
 * What Codex's app-server offers, as 0.167.0 was seen to behave (the table
 * and probes are in the adapter's PR). A mode this engine cannot hold is
 * `none`, never an empty implementation: the host refuses it before the
 * first input.
 */
export const CODEX_DESCRIPTOR: RuntimeDescriptor = {
  contractVersion: "runtime-contract/v1",
  kind: "codex_app_server",
  checkpointEngine: CODEX_CHECKPOINT_ENGINE,
  runtimeVersion: CODEX_CLI_VERSION,
  engineVersion: CODEX_CLI_VERSION,
  capabilities: {
    interrupt: true,
    checkpoint: true,
    // The app-server has no point before a tool call where a host can hold
    // admission, and a request cannot be resumed after a restart, so a turn
    // cannot be parked at an approval. The adapter's real-binary test pins
    // what a resume does with a pending approval: it is not asked again, and
    // the call reads as aborted.
    approvalCheckpoint: false,
    resume: true,
    mcp: "native",
    skills: "none",
    permissionModes: {
      default: "native",
      // Both emulated: the adapter runs the engine with `untrusted` approval
      // (every command it does not know to be safe, and every file change,
      // is asked) and answers those requests itself.
      acceptEdits: "emulated",
      dontAsk: "emulated",
      // The engine has no read-only planning mode.
      plan: "none",
      bypassPermissions: "native",
      // Commands run in the engine's bubblewrap sandbox and its `auto_review`
      // reviewer judges each request to leave it. A worker whose sandbox
      // cannot start refuses the session instead.
      auto: "native",
    },
  },
  extraFeatures: { subagents: "none", user_hooks: "none" },
  // Codex names a skill in the prompt; no tool stands between.
  skillCalling: { tool: null, names: "skill_only" },
  toolEnv: "tool_scoped",
  secretEnv: "none",
  instructionFiles: ["AGENTS.md"],
};
