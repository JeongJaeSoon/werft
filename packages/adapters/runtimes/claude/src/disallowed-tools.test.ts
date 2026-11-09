import { describe, expect, test } from "bun:test";
import type { ClaudeRuntimeConfig, PermissionMode } from "./config.ts";
import { validateRuntimeConfig } from "./profile.ts";
import { buildSdkOptions } from "./runtime.ts";

const MODES: (PermissionMode | undefined)[] = [
  undefined,
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "auto",
];

function configOf(
  extra: {
    cwd?: string;
    disallowedTools?: readonly string[];
    permissionMode?: PermissionMode;
    tools?: string[];
  } = {},
): ClaudeRuntimeConfig {
  return {
    claudeConfigDir: "/tenant/config",
    correlationId: "disallowed-tools",
    mode: "new",
    cwd: "/workspace",
    home: "/tenant/home",
    model: "primary",
    profile: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value: "placeholder" },
      principal: { ownerScope: "owner-a" },
    },
    tools: ["Read", "Bash", "WebFetch", "WebSearch"],
    ...extra,
  };
}

const policy = {
  endpoints: ["https://api.anthropic.com"],
  models: ["primary"],
};

const hooks = { onPermission: async () => ({ behavior: "allow" as const }) };

describe("disallowedTools", () => {
  test.each(MODES)(
    "is handed to the engine in permission mode %s",
    (mode: PermissionMode | undefined) => {
      const options = buildSdkOptions(
        configOf({
          disallowedTools: ["WebSearch", "Bash(git push:*)"],
          ...(mode === undefined ? {} : { permissionMode: mode }),
        }),
        hooks,
      );
      expect(options.disallowedTools).toEqual([
        "WebSearch",
        "Bash(git push:*)",
      ]);
    },
  );

  test("is left out when nothing is denied, so a claim without rules is what it was", () => {
    expect(buildSdkOptions(configOf(), hooks)).not.toHaveProperty(
      "disallowedTools",
    );
    expect(
      buildSdkOptions(configOf({ disallowedTools: [] }), hooks),
    ).not.toHaveProperty("disallowedTools");
  });

  test("does not change the mode's own settings", () => {
    const without = buildSdkOptions(
      configOf({ permissionMode: "auto" }),
      hooks,
    );
    const withRules = buildSdkOptions(
      configOf({ permissionMode: "auto", disallowedTools: ["WebSearch"] }),
      hooks,
    );
    expect(withRules.settings).toEqual(without.settings);
  });

  test("a start whose settings and rules do not fit the engine's arguments fails, and no rule is cut", () => {
    const rule = `Bash(${"a".repeat(240)})`;
    expect(() =>
      buildSdkOptions(
        configOf({ disallowedTools: Array.from({ length: 64 }, () => rule) }),
        hooks,
      ),
    ).not.toThrow();
    // Above the budget by size alone: the rules are not trimmed to fit.
    const huge = configOf({
      disallowedTools: Array.from({ length: 64 }, () => rule),
    });
    huge.cwd = `/${"w".repeat(100_000)}`;
    expect(() => buildSdkOptions(huge, hooks)).toThrow(/bytes of arguments/);
  });
});

describe("a rule the engine would drop does not start", () => {
  test("a well-formed list passes", () => {
    expect(() =>
      validateRuntimeConfig(
        configOf({ disallowedTools: ["WebSearch", "Read(./.env)"] }),
        policy,
      ),
    ).not.toThrow();
  });

  test.each([
    ["a tool glob", ["B*"]],
    ["an unknown tool", ["NoSuchTool"]],
    ["an argument on a tool that takes none", ["Glob(src/**)"]],
    [
      "an MCP name, which the platform's own path enforces",
      ["mcp__docs__read"],
    ],
    [
      "more rules than the list holds",
      Array.from({ length: 65 }, (_, i) => `Bash(c${i})`),
    ],
  ])("refuses %s", (_name, rules) => {
    expect(() =>
      validateRuntimeConfig(configOf({ disallowedTools: rules }), policy),
    ).toThrow(/Deny rule/);
  });
});

describe("the platform's own allow and ask rules", () => {
  test("are written whatever the tool surface, so a deny is the only thing that narrows it", () => {
    const rules = (tools: string[]) =>
      JSON.stringify(
        buildSdkOptions(configOf({ tools, permissionMode: "default" }), hooks)
          .settings,
      );
    expect(rules(["Read"])).toBe(rules(["Bash", "Edit", "Write", "Read"]));
    expect(rules(["Read"])).toContain("Bash(git *)");
  });
});
