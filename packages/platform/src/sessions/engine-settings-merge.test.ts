import { describe, expect, test } from "bun:test";
import type { EffectiveEngineSettings } from "./engine-settings.ts";
import {
  mcpCallDenied,
  mergeEngineSettings,
} from "./engine-settings-merge.ts";

const noAgent: EffectiveEngineSettings = {
  kind: "rules",
  permissions: { allow: [], ask: [], deny: [] },
  autoMode: { allow: [], soft_deny: [], hard_deny: [], environment: [] },
};
const agent = (
  over: Partial<{ ask: string[]; deny: string[]; allow: string[] }> = {},
  auto: Partial<{
    allow: string[];
    soft_deny: string[];
    hard_deny: string[];
  }> = {},
): EffectiveEngineSettings => ({
  kind: "rules",
  permissions: { allow: [], ask: [], deny: [], ...over },
  autoMode: {
    allow: [],
    soft_deny: [],
    hard_deny: [],
    environment: [],
    ...auto,
  },
});

describe("mergeEngineSettings", () => {
  test("nothing anywhere sends nothing", () => {
    expect(
      mergeEngineSettings({ workspace: null, agent: noAgent }),
    ).toEqual({
      kind: "rules",
      engine: undefined,
      disallowedTools: [],
      mcpDeny: [],
    });
  });

  test("denies route by kind: pattern to the engine, whole tool and mcp apart", () => {
    const merged = mergeEngineSettings({
      workspace: {
        permissions: { deny: ["Bash(rm:*)", "WebFetch"] },
        auto_mode: {},
      },
      agent: agent({ deny: ["mcp__github__delete_repo", "Read(./.env)"] }),
    });
    expect(merged).toEqual({
      kind: "rules",
      engine: { permissions: { deny: ["Bash(rm:*)", "Read(./.env)"] } },
      disallowedTools: ["WebFetch"],
      mcpDeny: ["mcp__github__delete_repo"],
    });
  });

  test("ask and classifier denies are a union; a grant needs both sides", () => {
    const merged = mergeEngineSettings({
      workspace: {
        permissions: { allow: ["Bash(ls:*)"], ask: ["Bash(git push:*)"] },
        auto_mode: { soft_deny: ["a"], allow: ["w"], environment: ["e"] },
      },
      agent: agent(
        { ask: ["Edit"], allow: ["Bash(ls:*)", "Bash(cat:*)"] },
        { soft_deny: ["b"], hard_deny: ["c"], allow: ["w"] },
      ),
    });
    if (merged.kind !== "rules") throw new Error("closed");
    // Bash(cat:*) is the agent's alone and `e` the workspace's alone: neither
    // survives. The agent can only repeat what the workspace allows.
    expect(merged.engine).toEqual({
      permissions: { allow: ["Bash(ls:*)"], ask: ["Bash(git push:*)", "Edit"] },
      autoMode: { allow: ["w"], soft_deny: ["a", "b"], hard_deny: ["c"] },
    });
  });

  test("an agent that grants nothing leaves the workspace's allow out", () => {
    const merged = mergeEngineSettings({
      workspace: {
        permissions: { allow: ["Bash(ls:*)"] },
        auto_mode: { allow: ["w"], environment: ["e"] },
      },
      agent: noAgent,
    });
    expect(merged).toEqual({
      kind: "rules",
      engine: undefined,
      disallowedTools: [],
      mcpDeny: [],
    });
  });

  test("a closed agent closes the claim instead of dropping its rules", () => {
    expect(
      mergeEngineSettings({
        workspace: null,
        agent: { kind: "closed", reason: "row_missing" },
      }),
    ).toEqual({ kind: "closed", reason: "agent_row_missing" });
  });

  test("output is sorted and deduplicated", () => {
    const merged = mergeEngineSettings({
      workspace: {
        permissions: { deny: ["Bash(b:*)", "Bash(a:*)"] },
        auto_mode: {},
      },
      agent: agent({ deny: ["Bash(a:*)"] }),
    });
    if (merged.kind !== "rules") throw new Error("closed");
    expect(merged.engine?.permissions?.deny).toEqual([
      "Bash(a:*)",
      "Bash(b:*)",
    ]);
  });
});

describe("mcpCallDenied", () => {
  test("exact tool name only", () => {
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a__b")).toBe(true);
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a__bc")).toBe(false);
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a")).toBe(false);
  });
});
