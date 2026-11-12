import { describe, expect, test } from "bun:test";
import { mcpValuesOfCard } from "./mcp-release-values.ts";

const card = (
  server: string | null,
  refs: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  capabilities: {
    mcp: server === null ? null : [{ server }],
    credential_refs: refs,
    forbidden: [],
    ...extra,
  },
});

const pins = (per_tool: Record<string, string>) => ({ tools: { per_tool } });

describe("the values a release carries", () => {
  test("allow pins of the card's server become the tools; ask, deny and forbidden are only counted", () => {
    const values = mcpValuesOfCard(
      card("docs", ["b-key", "docs-key", "b-key"], {
        forbidden: ["mcp__docs__drop", "Bash"],
      }),
      pins({
        mcp__docs__search: "allow",
        mcp__docs__read: "allow",
        mcp__docs__write: "ask",
        mcp__docs__drop: "deny",
        mcp__other__read: "allow",
        Read: "allow",
      }),
    );
    expect(values).toEqual({
      server: "docs",
      allowedTools: ["mcp__docs__read", "mcp__docs__search"],
      credentialRefs: ["b-key", "docs-key"],
      askCount: 1,
      denyCount: 1,
      forbiddenCount: 1,
    });
  });

  test("a card without a server still carries its credential names", () => {
    expect(mcpValuesOfCard(card(null, ["k"]), pins({}))).toMatchObject({
      server: null,
      allowedTools: [],
      credentialRefs: ["k"],
    });
  });

  test("garbage reads as nothing", () => {
    expect(mcpValuesOfCard(null, undefined).server).toBeNull();
    expect(mcpValuesOfCard({ capabilities: 3 }, 4).credentialRefs).toEqual([]);
  });
});
