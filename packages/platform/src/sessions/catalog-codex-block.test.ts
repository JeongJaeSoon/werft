import { describe, expect, test } from "bun:test";

import { catalogProfileConfigSchema } from "./catalog.ts";

const claude = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY" },
  },
};

const codex = {
  runtime_kind: "codex_app_server",
  runtime_version: "0.167.0",
  model: "gpt-5.1-codex",
  tools: ["exec_command"],
  permission_mode: "default",
  provider: {
    kind: "openai_responses",
    endpoint: "https://api.openai.com",
    auth: { kind: "api_key", value_env: "OPENAI_KEY" },
  },
};

const issues = (profile: unknown) => {
  const result = catalogProfileConfigSchema.safeParse(profile);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
};

describe("the Codex block of a catalog profile", () => {
  test("a Codex profile on an openai_responses connection with its one tool is accepted", () => {
    expect(issues(codex)).toEqual([]);
  });

  test("an existing Claude profile is unchanged", () => {
    expect(issues(claude)).toEqual([]);
  });

  test("Codex on a connection that is not openai_responses is refused", () => {
    expect(issues({ ...codex, provider: claude.provider })).toEqual([
      expect.objectContaining({ path: "provider.kind" }),
    ]);
  });

  test("an openai_responses connection under another engine is refused", () => {
    expect(issues({ ...claude, provider: codex.provider })).toEqual([
      expect.objectContaining({ path: "provider.kind" }),
    ]);
  });

  test.each([[[]], [["Read"]], [["exec_command", "Read"]]])(
    "a Codex tool list of %j is refused",
    (tools) => {
      expect(issues({ ...codex, tools })).toEqual([
        expect.objectContaining({ path: "tools" }),
      ]);
    },
  );
});
