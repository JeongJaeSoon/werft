import { describe, expect, test } from "bun:test";
import type { RuntimeStart } from "@werft-ai/runtime-core";
import {
  ADAPTER_CONFORMANCE,
  type AdapterConformanceHarness,
} from "@werft-ai/runtime-core/testing/conformance";

import { codexLaunch } from "./config.ts";

function startOf(overrides: {
  permissionMode?: string;
  gitEnvironment?: unknown;
  mcp?: boolean;
}): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: "placeholder",
          transport: "http://egress.internal:8080/provider",
        },
      },
      principal: { ownerScope: "owner-a" },
    },
    bundle: {
      instructions: [],
      repoInstructions: null,
      mcpServers: overrides.mcp === true ? [{ name: "github" }] : [],
    },
    config: {
      mode: "new",
      correlationId: "conformance",
      cwd: "/tenant/workspace",
      home: "/tenant/home",
      model: "primary",
      permissionMode: overrides.permissionMode ?? "default",
      tools: ["exec_command"],
      ...(overrides.gitEnvironment === undefined
        ? {}
        : { gitEnvironment: overrides.gitEnvironment }),
    },
  } as unknown as RuntimeStart;
}

const DEPS = { stateDir: "/state" };

const harness: AdapterConformanceHarness = {
  // The engine's own commit and PR text is a Codex setting this adapter does
  // not pass; whatever the launch carries is searched for it.
  engineSignature(permissionMode) {
    const modes = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
    // A mode the engine does not run in has no launch to read; it cannot
    // sign what it never writes.
    const launch = modes.includes(permissionMode)
      ? codexLaunch(startOf({ permissionMode }), DEPS, {})
      : undefined;
    const text = JSON.stringify(launch?.args ?? []);
    expect(text).not.toMatch(/attribution|co-authored|generated with/i);
    return { commit: "", pr: "" };
  },
  engineLaunch(gitEnvironment) {
    const launch = codexLaunch(startOf({ gitEnvironment }), DEPS, {});
    return {
      environment: (
        launch.threadConfig.shell_environment_policy as {
          set: Record<string, string>;
        }
      ).set,
      rest: { args: launch.args, processEnv: launch.env },
    };
  },
  async mcpBundle() {
    try {
      codexLaunch(startOf({ mcp: true }), DEPS, {});
      return "started";
    } catch {
      return "refused";
    }
  },
};

describe("Codex adapter conformance", () => {
  for (const item of ADAPTER_CONFORMANCE) {
    test(item.name, () => item.check(harness));
  }

  test("item 3 is not satisfied by a harness that shows nothing", async () => {
    const empty: AdapterConformanceHarness = {
      engineSignature: harness.engineSignature,
      engineLaunch: harness.engineLaunch,
    };
    const item = ADAPTER_CONFORMANCE[2];
    await expect(Promise.resolve(item?.check(empty))).rejects.toThrow(
      "mcpBundle",
    );
  });
});
