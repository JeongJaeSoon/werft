import { describe, expect, test } from "bun:test";
import type { RuntimeStart } from "@werft-ai/runtime-core";

import {
  assertStartable,
  codexHomeOf,
  codexLaunch,
  codexProfileDigest,
  connectionOf,
  modeRunOf,
  toml,
} from "./config.ts";

const TOKEN = "egress-token-for-this-attempt";

function startOf(overrides: Record<string, unknown> = {}): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: TOKEN,
          transport: "http://egress.internal:8080/provider",
        },
      },
      principal: { ownerScope: "owner-1" },
    },
    bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
    config: {
      mode: "new",
      correlationId: "c-1",
      cwd: "/work",
      home: "/home/agent",
      model: "gpt-test",
      permissionMode: "default",
      tools: ["exec_command"],
      ...overrides,
    },
  } as unknown as RuntimeStart;
}

const DEPS = { stateDir: "/state" };

describe("codexLaunch", () => {
  test("talks to the egress route, with the token only in the engine's environment", () => {
    const launch = codexLaunch(startOf(), DEPS, {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:3128",
    });
    const provider = launch.args.find((a) =>
      a.startsWith("model_providers.werft="),
    );
    expect(provider).toContain(
      '"base_url" = "http://egress.internal:8080/provider/v1"',
    );
    expect(provider).toContain('"wire_api" = "responses"');
    expect(provider).toContain('"env_key" = "WERFT_EGRESS_TOKEN"');
    // The token is in the process environment and nowhere a person or a
    // process listing can read it from.
    expect(launch.env.WERFT_EGRESS_TOKEN).toBe(TOKEN);
    expect(launch.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(launch.threadConfig)).not.toContain(TOKEN);
    expect(launch.developerInstructions ?? "").not.toContain(TOKEN);
  });

  test("the tools' environment carries no token and no provider key", () => {
    const launch = codexLaunch(startOf(), DEPS, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-host-key",
      ANTHROPIC_API_KEY: "sk-ant-host",
    });
    const policy = launch.threadConfig.shell_environment_policy as {
      inherit: string;
      set: Record<string, string>;
    };
    expect(policy.inherit).toBe("none");
    expect(Object.keys(policy.set)).not.toContain("WERFT_EGRESS_TOKEN");
    expect(JSON.stringify(policy)).not.toContain(TOKEN);
    // Nor does the engine inherit what the worker was started with.
    expect(Object.keys(launch.env)).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(launch.env)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(launch.env)).not.toContain("sk-");
  });

  test("the egress host bypasses the forward proxy", () => {
    const launch = codexLaunch(startOf(), DEPS, { NO_PROXY: "localhost" });
    expect(launch.env.NO_PROXY).toBe("localhost,egress.internal");
  });

  test("keeps its state under the transcripts directory", () => {
    expect(codexLaunch(startOf(), DEPS, {}).home).toBe(codexHomeOf("/state"));
    expect(codexHomeOf("/state")).toBe("/state/projects/codex");
  });

  test("turns off what would reach another host or read the repository on its own", () => {
    const args = codexLaunch(startOf(), DEPS, {}).args.join(" ");
    for (const setting of [
      "check_for_update_on_startup=false",
      "analytics.enabled=false",
      "feedback.enabled=false",
      'history.persistence="none"',
      'web_search="disabled"',
      "project_doc_max_bytes=0",
    ]) {
      expect(args).toContain(setting);
    }
  });

  test("user variables reach the tools; a reserved name is refused, not overridden", () => {
    const launch = codexLaunch(
      startOf({ userEnvironment: { FOO: "1" } }),
      DEPS,
      {},
    );
    const policy = launch.threadConfig.shell_environment_policy as {
      set: Record<string, string>;
    };
    expect(policy.set.FOO).toBe("1");
    expect(policy.set.HOME).toBe("/home/agent");
    expect(() =>
      codexLaunch(startOf({ userEnvironment: { HOME: "/evil" } }), DEPS, {}),
    ).toThrow("reserved name");
  });
});

describe("modes", () => {
  test.each([
    ["default", "untrusted", "ask"],
    ["acceptEdits", "untrusted", "edits"],
    ["dontAsk", "untrusted", "none"],
    ["bypassPermissions", "never", "none"],
  ] as const)(
    "%s runs with %s approval answered by %s",
    (mode, approval, answers) => {
      const run: { approval: string; answers: string } = modeRunOf(mode);
      expect(run).toEqual({ approval, answers });
    },
  );

  test.each(["plan", "auto"] as const)("%s is refused", (mode) => {
    expect(() => modeRunOf(mode)).toThrow("does not run in");
  });
});

describe("what the engine cannot honor is refused, not dropped", () => {
  const bundle = {
    instructions: [],
    repoInstructions: null,
    mcpServers: [],
  } as unknown as RuntimeStart["bundle"];
  const base = startOf().config;

  test.each([
    ["a budget", { maxBudgetUsd: 1 }],
    ["a turn limit", { maxTurns: 3 }],
    ["deny rules", { disallowedTools: ["exec_command"] }],
    ["engine permission rules", { engineSettings: {} }],
    ["the tools Read", { tools: ["exec_command", "Read"] }],
    ["a session without exec_command", { tools: [] }],
  ])("%s", (what, change) => {
    expect(() =>
      assertStartable({ ...base, ...change } as RuntimeStart["config"], bundle),
    ).toThrow(`cannot honor ${what}`);
  });

  test("MCP servers and extension bundles", () => {
    expect(() =>
      assertStartable(base, {
        ...bundle,
        mcpServers: [{ name: "x" }],
      } as unknown as RuntimeStart["bundle"]),
    ).toThrow("MCP servers");
    expect(() =>
      assertStartable(base, {
        ...bundle,
        extensions: [{ path: "/p" }],
      } as unknown as RuntimeStart["bundle"]),
    ).toThrow("extension bundles");
  });
});

describe("providers", () => {
  test("only the Responses API with an egress token", () => {
    const start = startOf();
    expect(() =>
      connectionOf({
        ...start.bindings,
        provider: { ...start.bindings.provider, kind: "anthropic" },
      } as unknown as RuntimeStart["bindings"]),
    ).toThrow("only the Responses API");
    expect(() =>
      connectionOf({
        ...start.bindings,
        provider: {
          ...start.bindings.provider,
          auth: { kind: "api_key", key: "sk-x" },
        },
      } as unknown as RuntimeStart["bindings"]),
    ).toThrow("never a key");
  });
});

describe("codexProfileDigest", () => {
  test("ignores the credential and where the proxy listens", () => {
    const a = startOf();
    const b = startOf();
    (b.bindings.provider.auth as { token: string; transport: string }).token =
      "rotated";
    (
      b.bindings.provider.auth as { token: string; transport: string }
    ).transport = "http://elsewhere:1/provider";
    expect(codexProfileDigest(a)).toBe(codexProfileDigest(b));
  });

  test("moves with what changes how the thread replays", () => {
    const base = codexProfileDigest(startOf());
    expect(codexProfileDigest(startOf({ model: "other" }))).not.toBe(base);
    expect(codexProfileDigest(startOf({ permissionMode: "dontAsk" }))).not.toBe(
      base,
    );
    expect(codexProfileDigest(startOf({ cwd: "/elsewhere" }))).not.toBe(base);
  });
});

describe("toml", () => {
  test("renders strings, tables and arrays", () => {
    expect(toml({ a: 'x"y', b: [1, true], c: { d: 2 } })).toBe(
      '{"a" = "x\\"y", "b" = [1, true], "c" = {"d" = 2}}',
    );
  });
});
