import { describe, expect, test } from "bun:test";
import {
  isMcpToolName,
  mcpToolNameSchema,
  mcpToolOfServer,
  parseToolNames,
  type ToolCatalogView,
} from "./tool-names.ts";

const CATALOG: ToolCatalogView = {
  id: "engine@2",
  tools: [
    { name: "Read", boundary: "local" },
    { name: "Edit", boundary: "local" },
    { name: "Bash", boundary: "local" },
    { name: "Agent", boundary: "local" },
    { name: "WebFetch", boundary: "egress" },
    { name: "WebSearch", boundary: "provider" },
  ],
  aliases: { Task: "Agent" },
};

describe("a deny against a tool catalog", () => {
  test("takes whole catalog names only, aliases turned into the current name", () => {
    expect(parseToolNames(CATALOG, ["WebSearch", "Task", "Agent"])).toEqual({
      names: ["Agent", "WebSearch"],
      mcp: [],
    });
    for (const [name, reason] of [
      ["mcp__github__get_file", "mcp_tool"],
      ["Bash(rm:*)", "tool_pattern"],
      ["Bash(*)", "tool_pattern"],
      ["Bash ", "tool_pattern"],
      ["TodoWrite", "unknown_tool"],
      ["bash", "unknown_tool"],
    ] as const) {
      const parsed = parseToolNames(CATALOG, ["Read", name]);
      expect("refusal" in parsed && parsed.refusal.reason_code).toBe(reason);
    }
  });
});

describe("mcp__ names beside a catalog deny", () => {
  test("a list that cannot block them (accept_added_tools) still refuses them as mcp_tool", () => {
    expect(parseToolNames(CATALOG, ["Bash", "mcp__docs__read"])).toMatchObject({
      refusal: { reason_code: "mcp_tool", name: "mcp__docs__read" },
    });
  });
});

describe("the mcp__ name rule", () => {
  const SERVERS = { servers: new Set(["docs", "docs_", "wiki"]) };
  const reason = (name: string, mcp = SERVERS) => {
    const parsed = parseToolNames(CATALOG, ["Read", name], mcp);
    return "refusal" in parsed ? parsed.refusal.reason_code : "ok";
  };

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
    expect(reason("mcp__docs___read", { servers: new Set(["docs_"]) })).toBe(
      "ok",
    );
  });

  test("a name past an id ending in _ must leave a tool of its own", () => {
    expect(mcpToolOfServer("mcp__docs___", "docs_")).toBe(false);
    expect(mcpToolOfServer("mcp__docs___", "docs")).toBe(true);
    expect(reason("mcp__docs___", { servers: new Set(["docs_"]) })).toBe(
      "unknown_mcp_server",
    );
  });

  test("a listed server whose id starts like github keeps its own tools blockable", () => {
    const scope = { servers: new Set(["github_"]) };
    expect(reason("mcp__github___read", scope)).toBe("ok");
    expect(reason("mcp__github__read", scope)).toBe("github_server");
    expect(reason("mcp__github___read")).toBe("github_server");
  });

  test("a deny names tools of listed servers, sorted, once, matched exactly", () => {
    expect(
      parseToolNames(
        CATALOG,
        ["WebSearch", "mcp__wiki__b", "mcp__docs__read:all", "mcp__wiki__b"],
        SERVERS,
      ),
    ).toEqual({
      names: ["WebSearch"],
      mcp: ["mcp__docs__read:all", "mcp__wiki__b"],
    });
  });

  test("refuses a bad shape, the built-in server, and a server the installation does not list", () => {
    expect(reason("mcp__docs__read all")).toBe("mcp_tool_name");
    expect(reason("mcp__docs")).toBe("mcp_tool_name");
    expect(reason("mcp__github__get_file")).toBe("github_server");
    expect(reason("mcp__github__*")).toBe("github_server");
    expect(reason("mcp__gitub__get_file")).toBe("unknown_mcp_server");
    expect(reason("mcp__docs__x", { servers: new Set() })).toBe(
      "unknown_mcp_server",
    );
  });

  test("a name already blocked is not judged again, so a removed server does not strand it", () => {
    const scope = {
      servers: new Set<string>(),
      existing: new Set(["mcp__gone__read"]),
    };
    expect(reason("mcp__gone__read", scope)).toBe("ok");
    expect(reason("mcp__gone__write", scope)).toBe("unknown_mcp_server");
  });

  test("built-in names keep their pattern refusal beside mcp names", () => {
    expect(reason("Bash(rm:*)")).toBe("tool_pattern");
    expect(reason("Bash ")).toBe("tool_pattern");
  });
});
