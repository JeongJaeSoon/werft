import { describe, expect, test } from "bun:test";
import type { RuntimeStart } from "@werft-ai/runtime-core";

import { claudeRuntimeModule, claudeStartConfig } from "./contract.ts";

const DIGEST = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function start(
  bundle: Partial<RuntimeStart["bundle"]> = {},
  home = "/home/agent",
): RuntimeStart {
  return {
    config: {
      correlationId: "extensions",
      cwd: "/workspace",
      home,
      model: "claude-sonnet-5",
      permissionMode: "default",
      tools: ["Read", "Grep"],
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
      ...bundle,
    },
  } as RuntimeStart;
}

const bundleAt = (home: string, digest = DIGEST) => ({
  extensions: [{ name: "lint", digest, path: `${home}/.ext/${digest}` }],
});

const deps = { stateDir: "/tenant/config" };
const fingerprintOf = (s: RuntimeStart) =>
  claudeRuntimeModule.fingerprint(s).profileSha256;

// Captured from this code before the extension change: a session without
// bundles must keep the digest its checkpoints were taken under.
const WITHOUT_EXTENSIONS =
  "392b57a17b51d67fb27a1f5c8890b5a0633753ff3e8aeb96e41eaff03167f190";
const WITHOUT_EXTENSIONS_WITH_REPOSITORY =
  "8fd83a68c2d3ba8403d7d3d2394f3bfb8c229ff2fc3254092bd74c4a1e02fc2b";
const repository = { files: ["AGENTS.md"], text: "rules" };

describe("a session without extensions", () => {
  test("keeps its checkpoint fingerprint, with a repository and without", () => {
    expect(fingerprintOf(start())).toBe(WITHOUT_EXTENSIONS);
    expect(fingerprintOf(start({ repoInstructions: repository }))).toBe(
      WITHOUT_EXTENSIONS_WITH_REPOSITORY,
    );
  });

  test("an empty list is the same as none", () => {
    expect(fingerprintOf(start({ extensions: [] }))).toBe(WITHOUT_EXTENSIONS);
    const config = claudeStartConfig(start({ extensions: [] }), deps);
    expect(config).not.toHaveProperty("plugins");
    expect(config.identities?.plugins).toBeUndefined();
  });
});

describe("a session with extensions", () => {
  test("hands each published tree to the engine as a local plugin named by its digest", () => {
    const config = claudeStartConfig(start(bundleAt("/home/agent")), deps);
    expect(config.plugins).toEqual([
      { path: `/home/agent/.ext/${DIGEST}`, type: "local" },
    ]);
    expect(config.identities?.plugins).toEqual({
      [`/home/agent/.ext/${DIGEST}`]: DIGEST,
    });
  });

  test("names the Skill tool in the profile's tool list, once, and only then", () => {
    const withBundle = claudeStartConfig(start(bundleAt("/home/agent")), deps);
    expect(withBundle.tools).toEqual(["Read", "Grep", "Skill"]);
    const named = start(bundleAt("/home/agent"));
    named.config.tools = ["Read", "Skill"];
    expect(claudeStartConfig(named, deps).tools).toEqual(["Read", "Skill"]);
    expect(claudeStartConfig(start(), deps).tools).toEqual(["Read", "Grep"]);
    expect(claudeStartConfig(start({ extensions: [] }), deps).tools).toEqual([
      "Read",
      "Grep",
    ]);
  });

  test("keeps the MCP servers' identities next to the plugins'", () => {
    const server = {
      name: "notion",
      binding: "sha256:notion",
      url: "http://egress.invalid/mcp",
      token: "x",
      tools: ["mcp__notion__search"],
    };
    const config = claudeStartConfig(
      start({ ...bundleAt("/home/agent"), mcpServers: [server as never] }),
      deps,
    );
    expect(config.identities?.mcpServers).toEqual({ notion: "sha256:notion" });
    expect(Object.keys(config.identities?.plugins ?? {})).toHaveLength(1);
  });

  test("moves the fingerprint with the bundle's digest, not with HOME", () => {
    const here = fingerprintOf(start(bundleAt("/home/agent"), "/home/agent"));
    const elsewhere = fingerprintOf(
      start(bundleAt("/srv/other"), "/srv/other"),
    );
    expect(elsewhere).toBe(here);
    expect(
      fingerprintOf(start(bundleAt("/home/agent", OTHER), "/home/agent")),
    ).not.toBe(here);
    expect(here).not.toBe(WITHOUT_EXTENSIONS);
  });
});
