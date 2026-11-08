import { describe, expect, test } from "bun:test";
import { effectiveMcp, mcpDenyOf } from "./mcp-settings.ts";

const release = {
  server: "docs",
  tools: ["mcp__docs__read", "mcp__docs__search"],
  deny: [] as string[],
};
const start = (over: Record<string, unknown> = {}) => ({
  server: "docs",
  allowed_tools: ["mcp__docs__read", "mcp__docs__search"],
  credential_refs: ["docs-key"],
  revision: 1,
  ...over,
});
const row = (
  over: Partial<Parameters<typeof effectiveMcp>[0]["row"]> = {},
) => ({
  server: "docs" as string | null,
  allowedTools: ["mcp__docs__read", "mcp__docs__search"],
  updatedBy: "user-1" as string | null,
  ...over,
});

describe("effectiveMcp, a session without a snapshot", () => {
  test("with no row it is the release's server and pins, as before", () => {
    expect(effectiveMcp({ start: null, row: null, release })).toEqual({
      server: "docs",
      tools: ["mcp__docs__read", "mcp__docs__search"],
    });
  });

  test("a release with no server has none", () => {
    expect(
      effectiveMcp({
        start: null,
        row: row(),
        release: { server: null, tools: [], deny: [] },
      }),
    ).toEqual({ server: null, tools: [] });
  });

  test("a row copied from a release (no person) does not narrow it", () => {
    expect(
      effectiveMcp({
        start: null,
        row: row({ updatedBy: null, allowedTools: [] }),
        release,
      }).tools,
    ).toEqual(["mcp__docs__read", "mcp__docs__search"]);
  });

  test("a row a person saved narrows it to the tools both allow", () => {
    expect(
      effectiveMcp({
        start: null,
        row: row({ allowedTools: ["mcp__docs__read", "mcp__docs__write"] }),
        release,
      }).tools,
    ).toEqual(["mcp__docs__read"]);
  });

  test("a person's row naming another server closes it, keeping the server", () => {
    expect(
      effectiveMcp({ start: null, row: row({ server: "wiki" }), release }),
    ).toEqual({ server: "docs", tools: [] });
  });
});

describe("effectiveMcp, a session with a snapshot", () => {
  test("is the tools the snapshot and the row both allow", () => {
    expect(
      effectiveMcp({
        start: start(),
        row: row({ allowedTools: ["mcp__docs__read"] }),
        release,
      }),
    ).toEqual({ server: "docs", tools: ["mcp__docs__read"] });
  });

  test("a tool the row gained after the start stays closed for it", () => {
    expect(
      effectiveMcp({
        start: start({ allowed_tools: ["mcp__docs__read"] }),
        row: row({ allowedTools: ["mcp__docs__read", "mcp__docs__search"] }),
        release,
      }).tools,
    ).toEqual(["mcp__docs__read"]);
  });

  test("a row that is gone or names another server closes it", () => {
    expect(effectiveMcp({ start: start(), row: null, release })).toEqual({
      server: "docs",
      tools: [],
    });
    expect(
      effectiveMcp({ start: start(), row: row({ server: null }), release }),
    ).toEqual({ server: "docs", tools: [] });
  });

  test("a snapshot that does not parse closes the session's MCP", () => {
    expect(effectiveMcp({ start: { server: 3 }, row: row(), release })).toEqual(
      { server: null, tools: [] },
    );
  });

  test("a snapshot with no server has none whatever the release says", () => {
    expect(
      effectiveMcp({ start: start({ server: null }), row: row(), release }),
    ).toEqual({ server: null, tools: [] });
  });

  test("the row's migrated flag does not matter: a snapshot always follows the row", () => {
    expect(
      effectiveMcp({
        start: start(),
        row: row({ updatedBy: null, allowedTools: ["mcp__docs__read"] }),
        release,
      }).tools,
    ).toEqual(["mcp__docs__read"]);
  });
});

describe("effectiveMcp, the release's deny", () => {
  const deny = ["mcp__docs__search"];
  test("is taken out of a release session", () => {
    expect(
      effectiveMcp({ start: null, row: null, release: { ...release, deny } })
        .tools,
    ).toEqual(["mcp__docs__read"]);
  });
  test("is taken out of a snapshot session", () => {
    expect(
      effectiveMcp({
        start: start(),
        row: row(),
        release: { ...release, deny },
      }).tools,
    ).toEqual(["mcp__docs__read"]);
  });
  test("names of another server are never allowed", () => {
    expect(
      effectiveMcp({
        start: start({ allowed_tools: ["mcp__wiki__read", "mcp__docs__"] }),
        row: row({ allowedTools: ["mcp__wiki__read", "mcp__docs__"] }),
        release,
      }).tools,
    ).toEqual([]);
  });
});

describe("mcpDenyOf", () => {
  test("reads the snapshot key and ignores anything else", () => {
    expect(mcpDenyOf({ mcp_deny: ["mcp__docs__x", 3] })).toEqual([
      "mcp__docs__x",
    ]);
    expect(mcpDenyOf({})).toEqual([]);
    expect(mcpDenyOf(null)).toEqual([]);
    expect(mcpDenyOf({ mcp_deny: "mcp__docs__x" })).toEqual([]);
  });
});
