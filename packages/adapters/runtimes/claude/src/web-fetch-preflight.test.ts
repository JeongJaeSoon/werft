import { describe, expect, test } from "bun:test";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeStart } from "@werft-ai/runtime-core";

import { claudeRuntimeModule, claudeStartConfig } from "./contract.ts";
import {
  buildSdkOptions,
  isWebFetchPreflightFailure,
  WEB_FETCH_PREFLIGHT_REASON,
} from "./runtime.ts";

function start(
  skipWebFetchPreflight?: true,
  permissionMode = "default",
): RuntimeStart {
  return {
    config: {
      correlationId: "web-fetch-preflight",
      cwd: "/workspace",
      home: "/home/agent",
      model: "claude-sonnet-5",
      permissionMode,
      tools: ["Read", "WebFetch"],
      mode: "new",
      ...(skipWebFetchPreflight === undefined ? {} : { skipWebFetchPreflight }),
    },
    bindings: {
      principal: { ownerScope: "owner-a" },
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
      },
    },
    bundle: { instructions: [], repoInstructions: null, mcpServers: [] },
  } as RuntimeStart;
}

const deps = { stateDir: "/tenant/config" };
const allow = { onPermission: async () => ({ behavior: "allow" as const }) };

function optionsOf(runtimeStart: RuntimeStart) {
  return buildSdkOptions(claudeStartConfig(runtimeStart, deps), allow);
}

const FAILED = "Unable to verify if domain example.com is safe to fetch";

async function afterFailure(
  tool: string,
  error: string,
): Promise<Record<string, unknown>> {
  const hook = optionsOf(start()).hooks?.PostToolUseFailure?.[0]?.hooks[0] as
    | HookCallback
    | undefined;
  if (hook === undefined) throw new Error("no PostToolUseFailure hook");
  return (await hook(
    {
      hook_event_name: "PostToolUseFailure",
      session_id: "s",
      transcript_path: "/t",
      cwd: "/workspace",
      tool_name: tool,
      tool_input: { url: "https://example.com", prompt: "p" },
      tool_use_id: "toolu_1",
      error,
    },
    "toolu_1",
    { signal: new AbortController().signal },
  )) as Record<string, unknown>;
}

describe("the WebFetch host check", () => {
  test.each(["default", "plan", "auto", "bypassPermissions"])(
    "a workspace that turned it off sets skipWebFetchPreflight in %s mode",
    (mode) => {
      expect(optionsOf(start(true, mode)).settings).toHaveProperty(
        "skipWebFetchPreflight",
        true,
      );
    },
  );

  test("left on, the engine gets no key and checks as before", () => {
    expect(optionsOf(start()).settings).not.toHaveProperty(
      "skipWebFetchPreflight",
    );
  });

  test("is outside the checkpoint fingerprint: a workspace may flip it between starts", () => {
    for (const scheme of [1, 2]) {
      expect(claudeRuntimeModule.fingerprint(start(true), scheme)).toEqual(
        claudeRuntimeModule.fingerprint(start(), scheme),
      );
    }
  });

  test("a failed check gives the model the reason to pass on", async () => {
    const output = await afterFailure("WebFetch", FAILED);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: expect.stringContaining(
          `"${WEB_FETCH_PREFLIGHT_REASON}"`,
        ),
      },
    });
  });

  test("any other failure adds nothing", async () => {
    expect(
      await afterFailure("WebFetch", "Request failed with status 404"),
    ).toEqual({});
    expect(await afterFailure("Bash", FAILED)).toEqual({});
    expect(isWebFetchPreflightFailure("WebFetch", FAILED)).toBe(true);
    expect(isWebFetchPreflightFailure("WebFetch", "Unable to verify")).toBe(
      false,
    );
  });
});
