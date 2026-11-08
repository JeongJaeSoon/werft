import { describe, expect, test } from "bun:test";
import {
  agentMcpResponseSchema,
  agentMcpSettingsSchema,
  putAgentMcpSettingsRequestSchema,
} from "./agent-mcp.ts";

const settings = {
  server: "docs",
  allowed_tools: ["mcp__docs__read"],
  credential_refs: ["docs-key"],
};

describe("the agent MCP contracts", () => {
  test("a settings value is names only and strict", () => {
    expect(agentMcpSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      agentMcpSettingsSchema.safeParse({ ...settings, token: "x" }).success,
    ).toBe(false);
    expect(
      agentMcpSettingsSchema.safeParse({ ...settings, server: "a__b" }).success,
    ).toBe(false);
    expect(
      agentMcpSettingsSchema.safeParse({
        ...settings,
        credential_refs: ["Has Spaces"],
      }).success,
    ).toBe(false);
  });

  test("the credential names stop at 32, as the table does; tools have no count limit", () => {
    const refs = (n: number) =>
      Array.from({ length: n }, (_, index) => `key-${index}`);
    expect(
      agentMcpSettingsSchema.safeParse({
        ...settings,
        credential_refs: refs(32),
      }).success,
    ).toBe(true);
    expect(
      agentMcpSettingsSchema.safeParse({
        ...settings,
        credential_refs: refs(33),
      }).success,
    ).toBe(false);
    expect(
      agentMcpSettingsSchema.safeParse({
        ...settings,
        allowed_tools: Array.from(
          { length: 300 },
          (_, index) => `mcp__docs__tool-${index}`,
        ),
      }).success,
    ).toBe(true);
  });

  test("a save names the revision it read, or null for no row", () => {
    const request = (expected_revision: unknown) =>
      putAgentMcpSettingsRequestSchema.safeParse({
        expected_revision,
        settings,
      }).success;
    expect(request(null)).toBe(true);
    expect(request(3)).toBe(true);
    expect(request(0)).toBe(false);
    expect(request("3")).toBe(false);
  });

  test("a response says where its values come from", () => {
    const response = (source: string, settings_revision: number | null) =>
      agentMcpResponseSchema.safeParse({
        source,
        settings,
        settings_revision,
        active_release_id: null,
        bound_credential_refs: [],
      }).success;
    expect(response("agent", 1)).toBe(true);
    expect(response("release", null)).toBe(true);
    expect(response("elsewhere", null)).toBe(false);
  });
});
