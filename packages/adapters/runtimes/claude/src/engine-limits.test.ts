import { describe, expect, test } from "bun:test";
import { pinnedClaudeToolCatalog } from "@werft-ai/runtime-claude-codec";
import { claudeRuntimeModule, claudeStartConfig } from "./contract.ts";
import { runtimeEnvironment } from "./profile.ts";

const base = {
  claudeConfigDir: "/topic/home/.claude",
  home: "/topic/home",
  profile: {
    kind: "anthropic" as const,
    endpoint: "https://api.anthropic.com",
    auth: {
      kind: "egress_token" as const,
      token: ["wec", "one-call"].join("_"),
      transport: "http://egress-proxy:3129/provider",
    },
    principal: { ownerScope: "owner" },
  },
};

describe("the engine's output cap and temporary directory", () => {
  test("are the engine's own unless the config names them", () => {
    const environment = runtimeEnvironment(base, { TMPDIR: "/host-tmp" });
    expect(environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(environment.TMPDIR).toBe("/host-tmp");
  });

  test("go into the engine's environment when named, over the host's", () => {
    const environment = runtimeEnvironment(
      { ...base, maxOutputTokens: 2_048, tmpDir: "/topic/tmp" },
      { TMPDIR: "/host-tmp" },
    );
    expect(environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(environment.TMPDIR).toBe("/topic/tmp");
  });

  test("a start carries them to the engine's config", () => {
    const config = claudeStartConfig(
      {
        config: {
          mode: "new",
          correlationId: "turn",
          cwd: "/topic/work",
          home: "/topic/home",
          model: "claude-haiku-5",
          permissionMode: "dontAsk",
          tools: [],
          maxOutputTokens: 2_048,
          tmpDir: "/topic/tmp",
        },
        bindings: {
          principal: base.profile.principal,
          provider: {
            kind: "anthropic",
            endpoint: base.profile.endpoint,
            auth: base.profile.auth,
          },
        },
        bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
      },
      { stateDir: base.claudeConfigDir },
    );
    expect(config).toMatchObject({
      maxOutputTokens: 2_048,
      tmpDir: "/topic/tmp",
    });
  });
});

describe("the engine's compaction", () => {
  test("is the engine's own unless the config turns it off", () => {
    expect(runtimeEnvironment(base, {}).DISABLE_COMPACT).toBeUndefined();
  });

  test("is off, automatic and asked for alike, when the config says so", () => {
    expect(
      runtimeEnvironment({ ...base, compactionOff: true }, {}).DISABLE_COMPACT,
    ).toBe("1");
  });

  test("a start carries the switch to the engine's config", () => {
    const config = claudeStartConfig(
      {
        config: {
          mode: "new",
          correlationId: "turn",
          cwd: "/topic/work",
          home: "/topic/home",
          model: "claude-haiku-5",
          permissionMode: "dontAsk",
          tools: [],
          compactionOff: true,
        },
        bindings: {
          principal: base.profile.principal,
          provider: {
            kind: "anthropic",
            endpoint: base.profile.endpoint,
            auth: base.profile.auth,
          },
        },
        bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
      },
      { stateDir: base.claudeConfigDir },
    );
    expect(config.compactionOff).toBe(true);
  });
});

describe("the module's built-in tools", () => {
  test("are every tool of the pinned build's catalog, by name", () => {
    const catalog = pinnedClaudeToolCatalog();
    expect(catalog).toBeDefined();
    expect(claudeRuntimeModule.builtinTools).toEqual(
      (catalog?.tools ?? []).map((tool) => tool.name),
    );
    expect(claudeRuntimeModule.builtinTools?.length).toBeGreaterThan(0);
  });
});
