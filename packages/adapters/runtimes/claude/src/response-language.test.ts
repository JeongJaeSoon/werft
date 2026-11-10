import { describe, expect, test } from "bun:test";
import type { RuntimeStart } from "@werft-ai/runtime-core";

import { claudeRuntimeModule, claudeStartConfig } from "./contract.ts";

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

describe("the answer language", () => {
  test.each([
    ["ko", "Korean"],
    ["en", "English"],
    ["ja", "Japanese"],
  ] as const)(
    "%s adds one instruction that holds whatever language the person writes",
    (language, name) => {
      expect(claudeStartConfig(start(language), deps).appendSystemPrompt).toBe(
        `Always answer in ${name}, whatever language the person writes in.`,
      );
    },
  );

  test("none adds nothing: follow-user and a release before the field run as before", () => {
    expect(claudeStartConfig(start(), deps)).not.toHaveProperty(
      "appendSystemPrompt",
    );
  });

  test("follows the platform's own instructions, after a blank line", () => {
    expect(
      claudeStartConfig(start("ja", [{ text: "Platform paragraph." }]), deps)
        .appendSystemPrompt,
    ).toBe(
      "Platform paragraph.\n\nAlways answer in Japanese, whatever language the person writes in.",
    );
  });

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
