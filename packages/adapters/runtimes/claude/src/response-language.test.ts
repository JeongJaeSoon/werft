import { describe, expect, test } from "bun:test";
import type { RuntimeStart } from "@werft-ai/runtime-core";

import { claudeRuntimeModule, claudeStartConfig } from "./contract.ts";
import { buildSdkOptions } from "./runtime.ts";

function start(
  responseLanguage?: "ko" | "en" | "ja",
  instructions: RuntimeStart["bundle"]["instructions"] = [],
): RuntimeStart {
  return {
    config: {
      correlationId: "response-language",
      cwd: "/workspace",
      home: "/home/agent",
      model: "claude-sonnet-5",
      permissionMode: "default",
      tools: ["Read", "Grep"],
      mode: "new",
      ...(responseLanguage === undefined ? {} : { responseLanguage }),
    },
    bindings: {
      principal: { ownerScope: "owner-a" },
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
      },
    },
    bundle: { instructions, repoInstructions: null, mcpServers: [] },
  } as RuntimeStart;
}

const deps = { stateDir: "/tenant/config" };

function engineSettings(
  responseLanguage?: "ko" | "en" | "ja",
): Record<string, unknown> {
  const { settings } = buildSdkOptions(
    claudeStartConfig(start(responseLanguage), deps),
    { onPermission: async () => ({ behavior: "allow" }) },
  );
  return typeof settings === "object" ? settings : {};
}

describe("the answer language", () => {
  test.each([
    ["ko", "korean"],
    ["en", "english"],
    ["ja", "japanese"],
  ] as const)(
    "%s goes to the engine as settings.language",
    (language, name) => {
      expect(engineSettings(language).language).toBe(name);
    },
  );

  test("none passes nothing: follow-user and a release before the field run as before", () => {
    expect(engineSettings()).not.toHaveProperty("language");
  });

  test.each(["ko", "en", "ja"] as const)(
    "%s never reaches the system prompt",
    (language) => {
      expect(claudeStartConfig(start(language), deps)).not.toHaveProperty(
        "appendSystemPrompt",
      );
      expect(
        claudeStartConfig(
          start(language, [{ text: "Platform paragraph." }]),
          deps,
        ).appendSystemPrompt,
      ).toBe("Platform paragraph.");
      const { systemPrompt } = buildSdkOptions(
        claudeStartConfig(start(language), deps),
        { onPermission: async () => ({ behavior: "allow" }) },
      );
      expect(JSON.stringify(systemPrompt)).not.toMatch(/answer in/i);
    },
  );

  test("is outside the checkpoint fingerprint: a session resumes on a worker with or without it", () => {
    for (const scheme of [1, 2]) {
      const without = claudeRuntimeModule.fingerprint(start(), scheme);
      for (const language of ["ko", "en", "ja"] as const) {
        expect(
          claudeRuntimeModule.fingerprint(start(language), scheme),
        ).toEqual(without);
      }
    }
  });
});
