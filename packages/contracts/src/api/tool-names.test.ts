import { describe, expect, test } from "bun:test";
import {
  isMcpToolName,
  mcpToolNameSchema,
  mcpToolOfServer,
} from "./tool-names.ts";

describe("the mcp__ name rule", () => {
  test("one shape: the prefix, a server id, a tool without spaces or control characters, 128 characters", () => {
    for (const name of [
      "mcp__docs__read",
      "mcp__docs__read:all",
      "mcp__docs__a__b",
      "mcp__docs__Bash(rm:*)",
      `mcp__docs__${"x".repeat(128 - 11)}`,
    ]) {
      expect(isMcpToolName(name)).toBe(true);
      expect(mcpToolNameSchema.safeParse(name).success).toBe(true);
    }
    for (const name of [
      "docs__read",
      "mcp__docs",
      "mcp__docs__",
      "mcp____read",
      "mcp__Docs__read",
      "mcp__docs__read all",
      "mcp__docs__a\tb",
      "mcp__docs__a\u0000b",
      `mcp__docs__${"x".repeat(128 - 10)}`,
    ]) {
      expect(isMcpToolName(name)).toBe(false);
      expect(mcpToolNameSchema.safeParse(name).success).toBe(false);
    }
  });

  test("an id ending in _ makes a name read two ways, so the server is asked about, not split out", () => {
    expect(mcpToolOfServer("mcp__docs___read", "docs")).toBe(true);
    expect(mcpToolOfServer("mcp__docs___read", "docs_")).toBe(true);
    expect(mcpToolOfServer("mcp__docs__read", "docs_")).toBe(false);
    expect(mcpToolOfServer("mcp__docs__", "docs")).toBe(false);
  });

  test("a name past an id ending in _ must leave a tool of its own", () => {
    expect(mcpToolOfServer("mcp__docs___", "docs_")).toBe(false);
    expect(mcpToolOfServer("mcp__docs___", "docs")).toBe(true);
  });
});
