import type { RuntimeDescriptor } from "@werft-ai/runtime-core";

import { CODEX_CHECKPOINT_ENGINE } from "./checkpoint-codec.ts";
import { CODEX_CLI_VERSION } from "./versions.ts";

/**
 * What Codex's app-server offers, as 0.167.0 was seen to behave (the table
 * and probes are in the adapter's PR). A mode this engine cannot hold is
 * `none`, never an empty implementation: the host refuses it before the
 * first input.
 *
 * - `approvalCheckpoint: false`: the app-server has no point before a tool
 *   call where a host can hold admission, and a request cannot be resumed
 *   after a restart, so a turn cannot be parked at an approval.
 * - `acceptEdits` and `dontAsk` are `emulated`: the adapter runs the engine
 *   with `untrusted` approval (every command it does not know to be safe,
 *   and every file change, is asked) and answers those requests itself.
 * - `plan` and `auto`: the engine has no read-only planning mode nor a
 *   classifier the adapter could call.
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
    approvalCheckpoint: false,
    resume: true,
    mcp: "none",
    skills: "none",
    permissionModes: {
      default: "native",
      acceptEdits: "emulated",
      dontAsk: "emulated",
      plan: "none",
      bypassPermissions: "native",
      auto: "none",
    },
  },
  extraFeatures: { subagents: "none", user_hooks: "none" },
  toolEnv: "tool_scoped",
  secretEnv: "none",
  instructionFiles: ["AGENTS.md"],
};
