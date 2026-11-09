import { describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  narrowingRefusal,
  type ProfileNarrowing,
} from "./catalog.ts";

const ceiling: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.319",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-4-5"],
  tools: ["Read", "Write", "Bash", "Edit"],
  permission_mode: "default",
  project_settings: { claude_md: true },
  provider: {
    kind: "anthropic",
    endpoint: "https://provider.invalid",
    auth: {
      kind: "api_key",
      value: "fixture-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const narrow: ProfileNarrowing = {
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "default",
};

describe("operator profile narrowing", () => {
  test.each<{
    name: string;
    change: Partial<ProfileNarrowing>;
    field: keyof ProfileNarrowing | null;
  }>([
    { name: "a narrower profile runs", change: {}, field: null },
    {
      name: "an unoffered model is refused",
      change: { models: ["claude-sonnet-5", "claude-opus-5"] },
      field: "models",
    },
    {
      name: "an unoffered tool is refused",
      change: { tools: ["Read", "Glob"] },
      field: "tools",
    },
    {
      name: "bypass outside the ceiling is refused",
      change: { permission_mode: "bypassPermissions" },
      field: "permission_mode",
    },
    {
      name: "model refusal precedes tool and permission refusals",
      change: {
        models: ["claude-opus-5"],
        tools: ["Glob"],
        permission_mode: "bypassPermissions",
      },
      field: "models",
    },
    {
      name: "tool refusal precedes permission refusal",
      change: { tools: ["Glob"], permission_mode: "bypassPermissions" },
      field: "tools",
    },
  ])("$name", ({ change, field }) => {
    expect(
      narrowingRefusal(ceiling, { ...narrow, ...change })?.field ?? null,
    ).toBe(field);
  });
});
