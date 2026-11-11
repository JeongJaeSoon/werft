import { describe, expect, test } from "bun:test";
import type { RuntimeDescriptor } from "@werft-ai/runtime-core";

import { RuntimeFeatureGate } from "./feature-gate.ts";

const full: RuntimeDescriptor = {
  contractVersion: "runtime-contract/v1",
  kind: "claude_agent_sdk",
  checkpointEngine: "claude",
  runtimeVersion: "1",
  engineVersion: "1",
  capabilities: {
    interrupt: true,
    checkpoint: true,
    approvalCheckpoint: false,
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
  extraFeatures: {},
  toolEnv: "engine_inherited",
  secretEnv: "none",
  instructionFiles: [],
};
// No classifier, and MCP only by emulation.
const partial: RuntimeDescriptor = {
  ...full,
  kind: "pi_coding_agent",
  capabilities: {
    ...full.capabilities,
    mcp: "emulated",
    permissionModes: { ...full.capabilities.permissionModes, auto: "none" },
  },
};
const mcpServer = {
  name: "docs",
  endpoint: "https://mcp.example.invalid/mcp",
  binding: `sha256:${"0".repeat(64)}`,
  access: { kind: "egress_token", token: "t" },
} as const;

describe("RuntimeFeatureGate", () => {
  const gate = new RuntimeFeatureGate([full, partial]);

  test("passes settings the runtime supports", () => {
    expect(
      gate.refusal("claude_agent_sdk", {
        permission_mode: "auto",
        mcp_servers: [mcpServer],
      }),
    ).toBeNull();
  });

  test("passes a feature the runtime only emulates", () => {
    expect(
      gate.refusal("pi_coding_agent", {
        permission_mode: "default",
        mcp_servers: [mcpServer],
      }),
    ).toBeNull();
  });

  test("refuses a feature the runtime declares none, naming it", () => {
    expect(
      gate.refusal("pi_coding_agent", {
        permission_mode: "auto",
        mcp_servers: [mcpServer],
      }),
    ).toBe("Runtime pi_coding_agent does not support classifier_review");
  });

  test("refuses a kind no installed runtime serves", () => {
    expect(
      gate.refusal("codex_app_server", { permission_mode: "default" }),
    ).toBe(
      "Runtime codex_app_server is not installed (installed: claude_agent_sdk, pi_coding_agent)",
    );
  });
});
