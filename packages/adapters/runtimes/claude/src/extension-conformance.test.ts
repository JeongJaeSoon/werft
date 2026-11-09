import { describe, expect, test } from "bun:test";

import type { RuntimeStart } from "@werft-ai/runtime-core";

import type { ClaudeRuntimeConfig } from "./config.ts";
import { claudeStartConfig } from "./contract.ts";
import { buildSdkOptions } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

// Structural conformance for a session that carries extension bundles: what
// this adapter hands the engine, not what a live engine does with a bundle
// tree edited after launch. That runtime behavior (a hooks.json or an
// `allowed-tools` frontmatter written once the session runs) needs a real
// engine and is part of the live verification of 94S-879.

const config: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "conformance",
  mode: "new",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  identities: { plugins: { "/tenant/home/.ext/d1": "d1" } },
  plugins: [{ type: "local", path: "/tenant/home/.ext/d1" }],
  settingSources: [],
  tools: ["Read"],
};

const deps = { onPermission: async () => ({ behavior: "allow" as const }) };

describe("the options a session with extension bundles launches the engine with", () => {
  const options = buildSdkOptions(config, deps);

  test("deliver the plugins once at launch and never read the bundle's own MCP or settings", () => {
    expect(options.plugins).toEqual([
      { type: "local", path: "/tenant/home/.ext/d1", skipMcpDiscovery: true },
    ]);
    expect(options.pluginDelivery).toBe("initialize");
    expect(options.settingSources).toEqual([]);
  });

  test("pre-approve nothing on the bundle's behalf and keep the platform's permission callback", () => {
    expect(options).not.toHaveProperty("allowedTools");
    expect(typeof options.canUseTool).toBe("function");
  });

  test("a session without bundles launches exactly as before", () => {
    const { plugins: _plugins, identities: _identities, ...plain } = config;
    const bare = buildSdkOptions(plain, deps);
    expect(bare).not.toHaveProperty("plugins");
  });

  test("the platform's tool allowlist holds in every mode, so a bundle's own tool grant cannot widen it", async () => {
    for (const permissionMode of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "auto",
    ] as const) {
      const gated = buildSdkOptions(
        { ...config, permissionMode },
        deps,
        new TurnLedger(),
      );
      const pre = gated.hooks?.PreToolUse?.[0]?.hooks[0];
      if (pre === undefined) throw new Error("PreToolUse hook is required");
      const answer = await pre(
        {
          hook_event_name: "PreToolUse",
          // The profile allows Read only: a skill that names Bash in its own
          // frontmatter is still refused here.
          tool_name: "Bash",
          tool_input: {},
          tool_use_id: `toolu_${permissionMode}`,
        } as never,
        `toolu_${permissionMode}`,
        { signal: new AbortController().signal },
      );
      expect(answer).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }
  });
});

describe("the Skill tool a bundle's skills are used through", () => {
  const DIGEST = "ab".repeat(32);
  const startFor = (extensions: boolean): ClaudeRuntimeConfig =>
    claudeStartConfig(
      {
        config: {
          correlationId: "skill-tool",
          cwd: "/workspace",
          home: "/home/agent",
          model: "claude-sonnet-5",
          permissionMode: "default",
          tools: ["Read"],
          mode: "new",
        },
        bindings: {
          principal: { ownerScope: "owner-a" },
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.com",
            auth: { kind: "api_key", value: "placeholder" },
          },
        },
        bundle: {
          instructions: [],
          repoInstructions: null,
          mcpServers: [],
          ...(extensions
            ? {
                extensions: [
                  {
                    name: "demo",
                    digest: DIGEST,
                    path: `/home/agent/.ext/${DIGEST}`,
                  },
                ],
              }
            : {}),
        },
      } as RuntimeStart,
      { stateDir: "/tenant/config" },
    );
  const ask = (options: ReturnType<typeof buildSdkOptions>, tool: string) =>
    options.canUseTool?.(tool, {}, {
      signal: new AbortController().signal,
      toolUseID: `toolu_${tool}`,
      requestId: "r1",
    } as never);

  test("is in the engine's tool list and admitted by the gate, with the profile's own tools beside it", async () => {
    const options = buildSdkOptions(startFor(true), deps);
    expect(options.tools).toEqual(["Read", "Skill"]);
    expect(await ask(options, "Skill")).toMatchObject({ behavior: "allow" });
  });

  test("does not widen the surface: a tool outside the profile stays refused and nothing is pre-approved", async () => {
    const options = buildSdkOptions(startFor(true), deps);
    expect(await ask(options, "Bash")).toMatchObject({
      behavior: "deny",
      message: "Tool is outside the server allowlist",
    });
    expect(options).not.toHaveProperty("allowedTools");
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (pre === undefined) throw new Error("PreToolUse hook is required");
    const call = (tool_name: string) =>
      pre(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input: {},
          tool_use_id: `toolu_${tool_name}`,
        } as never,
        `toolu_${tool_name}`,
        { signal: new AbortController().signal },
      );
    expect(await call("Bash")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await call("Skill")).not.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  test("a session without bundles has no Skill tool and is refused it", async () => {
    const options = buildSdkOptions(startFor(false), deps);
    expect(options.tools).toEqual(["Read"]);
    expect(await ask(options, "Skill")).toMatchObject({ behavior: "deny" });
  });
});
