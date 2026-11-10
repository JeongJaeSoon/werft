import { describe, expect, test } from "bun:test";
import {
  ADMIN_DENY_RULES_BYTES_MAX,
  ENGINE_SETTINGS_LIMITS,
  type EngineSettings,
} from "@werft-ai/contracts";
import { PLATFORM_AUTO_MODE } from "./auto-mode.ts";
import type { ClaudeRuntimeConfig, PermissionMode } from "./config.ts";
import { claudeProfileConfig } from "./contract.ts";
import { modeSettings } from "./engine-settings.ts";
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
    engineSettings?: EngineSettings;
    permissionMode?: PermissionMode;
  } = {},
): ClaudeRuntimeConfig {
  return {
    claudeConfigDir: "/tenant/config",
    correlationId: "engine-settings",
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
    tools: ["Read", "Bash"],
    ...extra,
  };
}

const policy = {
  endpoints: ["https://api.anthropic.com"],
  models: ["primary"],
};
const hooks = { onPermission: async () => ({ behavior: "allow" as const }) };

const claim: EngineSettings = {
  permissions: {
    allow: ["Bash(make test)"],
    ask: ["Bash(make deploy)"],
    deny: ["Bash(rm:*)", "Read(./.env)"],
  },
  autoMode: {
    allow: ["Agent rule: reading logs is fine."],
    hard_deny: ["Agent rule: never touch billing."],
  },
};

type Settings = {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  autoMode?: Record<string, string[]>;
};
const settingsOf = (config: ClaudeRuntimeConfig) =>
  buildSdkOptions(config, hooks).settings as Settings;

describe("engine_settings from a claim", () => {
  test.each(MODES)(
    "without it, permission mode %s gets the baseline settings it always had",
    (mode) => {
      const bare = configOf(mode === undefined ? {} : { permissionMode: mode });
      const { attribution: _attribution, ...rest } = settingsOf(
        bare,
      ) as Settings & {
        attribution: unknown;
      };
      expect(rest).toEqual(
        modeSettings({
          cwd: "/workspace",
          permissionMode: mode,
          trusted: false,
        }),
      );
    },
  );

  test("the claim's rules come after the baseline's and the baseline keeps every one", () => {
    const baseline = settingsOf(configOf({ permissionMode: "default" }));
    const merged = settingsOf(
      configOf({ permissionMode: "default", engineSettings: claim }),
    );
    expect(baseline.permissions?.allow?.length).toBeGreaterThan(0);
    expect(merged.permissions?.allow).toEqual([
      ...(baseline.permissions?.allow ?? []),
      "Bash(make test)",
    ]);
    expect(merged.permissions?.ask).toEqual([
      ...(baseline.permissions?.ask ?? []),
      "Bash(make deploy)",
    ]);
    expect(merged.permissions?.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
  });

  test("bypass takes the claim's deny, which is the point of sending it there", () => {
    const merged = settingsOf(
      configOf({ permissionMode: "bypassPermissions", engineSettings: claim }),
    );
    expect(merged.permissions?.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
  });

  test("auto mode appends the claim's classifier rules after the platform's", () => {
    const merged = settingsOf(
      configOf({ permissionMode: "auto", engineSettings: claim }),
    );
    expect(merged.autoMode?.allow).toEqual([
      ...PLATFORM_AUTO_MODE.allow,
      "Agent rule: reading logs is fine.",
    ]);
    expect(merged.autoMode?.soft_deny).toEqual(PLATFORM_AUTO_MODE.soft_deny);
    expect(merged.autoMode?.environment).toEqual(
      PLATFORM_AUTO_MODE.environment,
    );
    // The baseline sets no hard_deny; without "$defaults" first the engine
    // would take the claim's rule as its whole HARD BLOCK section.
    expect(merged.autoMode?.hard_deny).toEqual([
      "$defaults",
      "Agent rule: never touch billing.",
    ]);
    expect(merged.permissions?.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
  });

  test("a mode other than auto is given no classifier rules", () => {
    for (const permissionMode of [
      "default",
      "bypassPermissions",
      "plan",
    ] as const) {
      expect(
        settingsOf(configOf({ permissionMode, engineSettings: claim })),
      ).not.toHaveProperty("autoMode");
    }
  });

  test("plan mode takes ask and deny and still pre-approves nothing", () => {
    const merged = settingsOf(
      configOf({ permissionMode: "plan", engineSettings: claim }),
    );
    expect(merged.permissions).toEqual({
      ask: ["Bash(make deploy)"],
      deny: ["Bash(rm:*)", "Read(./.env)"],
    });
  });

  test("a claim with only a deny leaves the baseline allow and ask as they were", () => {
    const baseline = settingsOf(configOf({ permissionMode: "default" }));
    const merged = settingsOf(
      configOf({
        permissionMode: "default",
        engineSettings: { permissions: { deny: ["Bash(rm:*)"] } },
      }),
    );
    expect(merged.permissions?.allow).toEqual(baseline.permissions?.allow);
    expect(merged.permissions?.ask).toEqual(baseline.permissions?.ask);
  });

  test("rules that do not fit the engine's arguments fail the start, none is cut", () => {
    const rule = `Bash(${"a".repeat(240)})`;
    const big = configOf({
      permissionMode: "default",
      engineSettings: {
        permissions: { allow: Array.from({ length: 128 }, () => rule) },
      },
    });
    big.cwd = `/${"w".repeat(100_000)}`;
    expect(() => buildSdkOptions(big, hooks)).toThrow(/bytes of arguments/);
  });

  // The saved-rule byte limits are chosen so the most a claim can merge
  // (workspace + agent twice + inherited) still starts: this composes those
  // maxima from the limits themselves, so raising one limit fails here first.
  test("the largest merge the saved-rule limits allow still starts in every mode", () => {
    const { workspace, agent } = ENGINE_SETTINGS_LIMITS;
    const permissionBytes =
      workspace.permissionBytes +
      2 * agent.permissionBytes +
      ADMIN_DENY_RULES_BYTES_MAX;
    const autoBytes = workspace.autoModeBytes + 2 * agent.autoModeBytes;
    const unique = (count: number, make: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => make(i));
    // 256-character rules, the longest one list entry may be.
    const rule = (i: number) =>
      `Bash(${String(i).padStart(4, "0")}${"a".repeat(246)})`;
    const rules = Math.ceil(permissionBytes / 260);
    const sentence = (i: number) =>
      `${String(i).padStart(4, "0")}${"s".repeat(1019)}`;
    const sentences = Math.ceil(autoBytes / 1030);
    const half = (n: number) => Math.ceil(n / 2);
    const settings: EngineSettings = {
      permissions: {
        ask: unique(half(rules), rule),
        deny: unique(rules - half(rules), (i) => rule(i + 1000)),
      },
      autoMode: {
        soft_deny: unique(half(sentences), sentence),
        hard_deny: unique(sentences - half(sentences), (i) =>
          sentence(i + 1000),
        ),
      },
    };
    const written = Buffer.byteLength(JSON.stringify(settings), "utf8");
    expect(written).toBeGreaterThan(permissionBytes + autoBytes);
    for (const permissionMode of MODES) {
      const config = configOf({ engineSettings: settings });
      if (permissionMode !== undefined) config.permissionMode = permissionMode;
      config.disallowedTools = unique(64, (i) => `Tool${i}`);
      expect(() => buildSdkOptions(config, hooks)).not.toThrow();
    }
  });

  test("it is not in the checkpoint fingerprint's input", () => {
    const start = (engineSettings?: EngineSettings) =>
      claudeProfileConfig({
        config: {
          cwd: "/workspace",
          home: "/tenant/home",
          model: "primary",
          permissionMode: "default",
          tools: ["Read"],
          ...(engineSettings === undefined ? {} : { engineSettings }),
        },
        bindings: {
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.com",
            auth: { kind: "api_key", value: "placeholder" },
          },
          principal: { ownerScope: "owner-a" },
        },
        bundle: {
          instructions: [],
          repoInstructions: null,
          mcpServers: [],
        },
      } as never);
    expect(start(claim)).toEqual(start());
  });
});

describe("a deny the engine would drop does not start", () => {
  test("a well-formed deny passes", () => {
    expect(() =>
      validateRuntimeConfig(configOf({ engineSettings: claim }), policy),
    ).not.toThrow();
  });

  test.each([
    ["an unknown tool", "NoSuchTool"],
    ["a tool glob", "B*"],
    ["an MCP name, which the platform's own path enforces", "mcp__docs__read"],
  ])("refuses %s", (_name, rule) => {
    expect(() =>
      validateRuntimeConfig(
        configOf({ engineSettings: { permissions: { deny: [rule] } } }),
        policy,
      ),
    ).toThrow(/Deny rule/);
  });

  // `Write(path)` matches nothing in the engine, so the baseline's Edit allow
  // would run that write unasked: an ask it drops widens what runs.
  test.each([
    ["an unknown tool", "NoSuchTool"],
    ["a tool glob", "B*"],
  ])("refuses an ask over %s", (_name, rule) => {
    expect(() =>
      validateRuntimeConfig(
        configOf({ engineSettings: { permissions: { ask: [rule] } } }),
        policy,
      ),
    ).toThrow(/Ask rule/);
  });

  test("an allow the engine may read differently is not checked: it only narrows", () => {
    expect(() =>
      validateRuntimeConfig(
        configOf({
          engineSettings: { permissions: { allow: ["whatever(x)"] } },
        }),
        policy,
      ),
    ).not.toThrow();
  });

  test("a workspace list and an agent list merged past one list's cap still start", () => {
    const deny = Array.from({ length: 128 }, (_, i) => `Bash(command${i}:*)`);
    expect(() =>
      validateRuntimeConfig(
        configOf({ engineSettings: { permissions: { deny } } }),
        policy,
      ),
    ).not.toThrow();
  });

  test("a bad rule in the second list is still refused", () => {
    const deny = [
      ...Array.from({ length: 64 }, (_, i) => `Bash(command${i}:*)`),
      "NoSuchTool",
    ];
    expect(() =>
      validateRuntimeConfig(
        configOf({ engineSettings: { permissions: { deny } } }),
        policy,
      ),
    ).toThrow(/Deny rule/);
  });
});
