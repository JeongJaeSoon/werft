import { describe, expect, test } from "bun:test";
import { mcpDenyDropped, narrowOnlyPolicy } from "./profile-derivation.ts";
import {
  addedTools,
  carriedDeny,
  denyOf,
  firstVersionDeny,
  isMcpToolName,
  mcpNamesOf,
  mcpToolNameSchema,
  mcpToolOfServer,
  parseToolNames,
  type ToolCatalogView,
  toolsUnder,
  unsupportedTools,
} from "./profile-tools.ts";

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
// The options response carries no aliases.
const LISTED: ToolCatalogView = { id: CATALOG.id, tools: CATALOG.tools };

describe("a deny against a tool catalog", () => {
  test("reads an allow list as what it leaves out, through aliases, with mcp__ names left aside", () => {
    expect(denyOf(CATALOG, ["Read", "Task", "mcp__github__get_file"])).toEqual([
      "Edit",
      "Bash",
      "WebFetch",
      "WebSearch",
    ]);
    expect(denyOf(CATALOG, [])).toEqual(CATALOG.tools.map((t) => t.name));
    expect(unsupportedTools(CATALOG, ["Read", "Task", "TodoWrite"])).toEqual([
      "TodoWrite",
    ]);
    expect(unsupportedTools(CATALOG, ["mcp__github__get_file"])).toEqual([]);
  });

  test("runs the catalog less the deny, nothing outside the catalog, in the allowed list's spelling", () => {
    expect(toolsUnder(CATALOG, ["Bash", "WebSearch"])).toEqual([
      "Read",
      "Edit",
      "Agent",
      "WebFetch",
    ]);
    expect(toolsUnder(CATALOG, [])).toEqual(CATALOG.tools.map((t) => t.name));
    expect(
      toolsUnder(CATALOG, ["Edit"], ["Task", "Edit", "TodoWrite", "mcp__x__y"]),
    ).toEqual(["Task"]);
    expect(toolsUnder(CATALOG, ["Task"], ["Agent", "Read"])).toEqual(["Read"]);
  });

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

  test("a first version starts with the provider-side tools blocked", () => {
    expect(firstVersionDeny(CATALOG)).toEqual(["WebSearch"]);
  });
});

describe("tools a previous version never weighed", () => {
  test("an allow list weighed only what it allowed", () => {
    expect(addedTools(CATALOG, { tools: ["Read", "Edit"] })).toEqual([
      "Bash",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(
      addedTools(CATALOG, { tools: ["Read", "Task"], deny: null }),
    ).toEqual(["Edit", "Bash", "WebFetch", "WebSearch"]);
  });

  test("a deny weighed its tools and its deny, so a catalog grown under the same id is caught", () => {
    expect(
      addedTools(CATALOG, {
        tools: ["Read", "Edit", "Agent", "WebFetch"],
        deny: ["Bash", "WebSearch"],
      }),
    ).toEqual([]);
    expect(
      addedTools(CATALOG, {
        tools: ["Read", "Edit", "Bash"],
        deny: ["WebSearch"],
      }),
    ).toEqual(["Agent", "WebFetch"]);
  });

  test("a next version starts from the previous blocks plus every added tool", () => {
    expect(
      carriedDeny(CATALOG, { tools: ["Read", "Edit", "Bash"], deny: ["Task"] }),
    ).toEqual(["Agent", "WebFetch", "WebSearch"]);
    expect(carriedDeny(CATALOG, { tools: ["Read", "Bash"] })).toEqual([
      "Edit",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(carriedDeny(CATALOG, { tools: [], deny: [] })).toEqual(
      CATALOG.tools.map((t) => t.name),
    );
  });
});

describe("the workspace derivation with a catalog", () => {
  const base = {
    model: "m",
    tools: ["Read", "Edit", "Bash", "TodoWrite"],
    permission_mode: "default" as const,
  };

  test("starts from the base's blocks, and leaves names outside the catalog out of tools", () => {
    expect(narrowOnlyPolicy.initial(base, LISTED)).toMatchObject({
      tools: ["Read", "Edit", "Bash"],
      deny: ["Agent", "WebFetch", "WebSearch"],
    });
    expect(narrowOnlyPolicy.initial(base)).toMatchObject({
      tools: base.tools,
    });
    expect("deny" in narrowOnlyPolicy.initial(base)).toBe(false);
  });

  test("offers every catalog tool to block and fixes the base's", () => {
    expect(narrowOnlyPolicy.choices(base, LISTED).deny).toEqual({
      names: ["Read", "Edit", "Bash", "Agent", "WebFetch", "WebSearch"],
      fixed: ["Agent", "WebFetch", "WebSearch"],
    });
    expect(narrowOnlyPolicy.choices(base).deny).toBeUndefined();
  });

  test("carries the previous version's blocks, the base's, and what it never weighed", () => {
    const previous = {
      model: "m",
      models: ["m"],
      tools: ["Read"],
      permission_mode: "default" as const,
    };
    const carried = narrowOnlyPolicy.carry(previous, base, LISTED);
    expect(carried.deny).toEqual([
      "Edit",
      "Bash",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(carried.tools).toEqual(["Read"]);
    expect(narrowOnlyPolicy.refusal(base, carried)).toBeNull();
    const weighed = narrowOnlyPolicy.carry(
      { ...previous, tools: ["Read", "Edit"], deny: ["Bash", "Agent"] },
      base,
      LISTED,
    );
    expect(weighed.deny).toEqual(["Bash", "Agent", "WebFetch", "WebSearch"]);
    expect(weighed.tools).toEqual(["Read", "Edit"]);
    expect(narrowOnlyPolicy.carry(previous, base).tools).toEqual(["Read"]);
  });
});

describe("mcp__ names beside a catalog deny", () => {
  const MCP = ["mcp__docs__read", "mcp__a__b"];

  test("mcpNamesOf keeps only mcp__ names, sorted and once", () => {
    expect(
      mcpNamesOf(["Bash", ...MCP, "mcp__a__b", "mcp__docs__read:all"]),
    ).toEqual(["mcp__a__b", "mcp__docs__read", "mcp__docs__read:all"]);
    expect(mcpNamesOf(null)).toEqual([]);
    expect(mcpNamesOf(undefined)).toEqual([]);
    expect(mcpNamesOf(["Bash"])).toEqual([]);
  });

  test("the catalog reads leave them aside in a deny, an allow list and a carried deny", () => {
    const names = CATALOG.tools.map((t) => t.name);
    expect(denyOf(CATALOG, ["Read", ...MCP])).toEqual(
      names.filter((n) => n !== "Read"),
    );
    expect(unsupportedTools(CATALOG, ["Read", ...MCP])).toEqual([]);
    expect(
      toolsUnder(CATALOG, [...MCP, "Bash"], ["Read", "Bash", ...MCP]),
    ).toEqual(["Read"]);
    const carried = carriedDeny(CATALOG, {
      tools: ["Read"],
      deny: ["Bash", ...MCP],
    });
    expect(carried).not.toContain("mcp__a__b");
    expect(carried).toContain("Bash");
  });

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

describe("a version over a base that blocks mcp__ names", () => {
  const base = {
    model: "m",
    tools: ["Read"],
    permission_mode: "default" as const,
    mcp_deny: ["mcp__a__b"],
  };
  const version = {
    model: "m",
    models: ["m"],
    tools: ["Read"],
    permission_mode: "default" as const,
  };

  test("mcpDenyDropped is true unless the stored deny holds every base name", () => {
    expect(mcpDenyDropped(base, {})).toBe(true);
    expect(mcpDenyDropped(base, { deny: ["Bash"] })).toBe(true);
    expect(mcpDenyDropped(base, { deny: ["mcp__a__b", "Bash"] })).toBe(false);
    expect(mcpDenyDropped({}, {})).toBe(false);
  });

  test("apply runs with the base's names and the version's own, sorted", () => {
    const applied = narrowOnlyPolicy.apply(base, {
      ...version,
      deny: ["Bash", "mcp__z__y"],
    });
    expect(applied.mcp_deny).toEqual(["mcp__a__b", "mcp__z__y"]);
    // The base's names bind even when the version never listed them.
    expect(narrowOnlyPolicy.apply(base, version).mcp_deny).toEqual([
      "mcp__a__b",
    ]);
  });

  test("apply leaves the key out when nothing is blocked", () => {
    const { mcp_deny: _none, ...plain } = base;
    expect(Object.keys(narrowOnlyPolicy.apply(plain, version))).not.toContain(
      "mcp_deny",
    );
    expect(
      Object.keys(narrowOnlyPolicy.apply({ ...plain, mcp_deny: [] }, version)),
    ).not.toContain("mcp_deny");
  });
});
