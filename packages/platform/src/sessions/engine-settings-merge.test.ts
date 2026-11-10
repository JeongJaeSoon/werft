import { describe, expect, test } from "bun:test";
import type { EffectiveEngineSettings } from "./engine-settings.ts";
import {
  applicableAdminDeny,
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
  auto: Partial<{ soft_deny: string[]; hard_deny: string[] }> = {},
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
      mergeEngineSettings({ workspace: null, agent: noAgent, adminDeny: [] }),
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
      adminDeny: [
        {
          exempt_release_ids: [],
          permissions_deny: ["Skill"],
          mcp_deny: ["mcp__x__y"],
        },
      ],
    });
    expect(merged).toEqual({
      kind: "rules",
      engine: { permissions: { deny: ["Bash(rm:*)", "Read(./.env)"] } },
      disallowedTools: ["Skill", "WebFetch"],
      mcpDeny: ["mcp__github__delete_repo", "mcp__x__y"],
    });
  });

  test("ask and classifier denies are a union; the agent's allow changes nothing", () => {
    const merged = mergeEngineSettings({
      workspace: {
        permissions: { allow: ["Bash(ls:*)"], ask: ["Bash(git push:*)"] },
        auto_mode: { soft_deny: ["a"], allow: ["w"] },
      },
      agent: agent(
        { ask: ["Edit"], allow: ["Bash(ls:*)", "Bash(cat:*)"] },
        { soft_deny: ["b"], hard_deny: ["c"] },
      ),
      adminDeny: [],
    });
    if (merged.kind !== "rules") throw new Error("closed");
    expect(merged.engine).toEqual({
      permissions: { allow: ["Bash(ls:*)"], ask: ["Bash(git push:*)", "Edit"] },
      autoMode: { allow: ["w"], soft_deny: ["a", "b"], hard_deny: ["c"] },
    });
  });

  test("a closed agent closes the claim instead of dropping its rules", () => {
    expect(
      mergeEngineSettings({
        workspace: null,
        agent: { kind: "closed", reason: "row_missing" },
        adminDeny: [],
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
      adminDeny: [],
    });
    if (merged.kind !== "rules") throw new Error("closed");
    expect(merged.engine?.permissions?.deny).toEqual([
      "Bash(a:*)",
      "Bash(b:*)",
    ]);
  });
});

describe("applicableAdminDeny", () => {
  const entries = [
    { exempt_release_ids: ["r1"], permissions_deny: ["Skill"], mcp_deny: [] },
    { exempt_release_ids: [], permissions_deny: ["Task"], mcp_deny: [] },
  ];
  test("an exempt release skips only its entry", () => {
    expect(applicableAdminDeny(entries, "r1")).toEqual([entries[1]]);
    expect(applicableAdminDeny(entries, "r2")).toEqual(entries);
  });
  test("no release means no inherited entry applies", () => {
    expect(applicableAdminDeny(entries, null)).toEqual([]);
  });
});

describe("mcpCallDenied", () => {
  test("exact tool name only", () => {
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a__b")).toBe(true);
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a__bc")).toBe(false);
    expect(mcpCallDenied(["mcp__a__b"], "mcp__a")).toBe(false);
  });
});
