import { describe, expect, test } from "bun:test";
import type {
  InstructionPart,
  RuntimeProfileInput,
} from "@werft-ai/runtime-core";

import { claudeProfileConfig } from "./contract.ts";
import { systemPromptAppend } from "./repository-instructions.ts";

describe("the appended system prompt of a profile", () => {
  const PLATFORM = "platform words";
  const REPO_HEADING =
    "Contents of the instruction file (AGENTS.md, else CLAUDE.md) at the root of the repository you are working in (project instructions checked into it):";
  const appended = (
    instructions: InstructionPart[],
    repoText: string | null = "repo rules",
  ) => {
    const profile: RuntimeProfileInput = {
      config: {
        cwd: "/workspace",
        home: "/home/worker",
        model: "claude-sonnet-5",
        permissionMode: "default",
        tools: ["Read"],
      },
      bindings: {
        principal: { ownerScope: "owner-a" },
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: {
            kind: "egress_token",
            token: "stand-in",
            transport: "http://egress-proxy.invalid",
          },
        },
      },
      bundle: {
        instructions,
        repoInstructions: { files: ["AGENTS.md", "CLAUDE.md"], text: repoText },
        mcpServers: [],
      },
    };
    return systemPromptAppend(claudeProfileConfig(profile));
  };

  test("it is the platform's words and then the repository's", () => {
    expect(appended([{ text: PLATFORM }])).toBe(
      `${PLATFORM}\n\n${REPO_HEADING}\n\nrepo rules`,
    );
    expect(appended([])).toBe(`${REPO_HEADING}\n\nrepo rules`);
    expect(appended([], null)).toBeUndefined();
  });
});

describe("systemPromptAppend", () => {
  test("adds nothing of the repository's unless the config lets it in", () => {
    expect(systemPromptAppend({})).toBeUndefined();
    expect(systemPromptAppend({ appendSystemPrompt: "platform" })).toBe(
      "platform",
    );
  });

  test("puts the caller's addition first and the repository's under its heading", () => {
    expect(
      systemPromptAppend({
        appendSystemPrompt: "platform",
        repositoryClaudeMd: { contents: "repo rules" },
      }),
    ).toBe(
      "platform\n\nContents of the instruction file (AGENTS.md, else CLAUDE.md) at the root of the repository you are working in (project instructions checked into it):\n\nrepo rules",
    );
  });

  test("an empty or missing file adds nothing", () => {
    expect(
      systemPromptAppend({ repositoryClaudeMd: { contents: null } }),
    ).toBeUndefined();
    expect(
      systemPromptAppend({ repositoryClaudeMd: { contents: "  \n" } }),
    ).toBeUndefined();
  });
});
