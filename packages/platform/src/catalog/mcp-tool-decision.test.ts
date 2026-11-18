import { describe, expect, test } from "bun:test";
import { deniedMcpTools } from "./catalog.ts";
import {
  mcpToolDenied,
  mcpToolPermitted,
  visibleMcpTools,
} from "./mcp-tool-decision.ts";

const allow = ["mcp__docs__search", "mcp__docs__read", "mcp__wiki__read"];

describe("visibleMcpTools", () => {
  test("allow alone shows the server's tools, sorted and unique", () => {
    expect(visibleMcpTools("docs", [...allow, "mcp__docs__read"])).toEqual([
      "mcp__docs__read",
      "mcp__docs__search",
    ]);
  });

  test("a deny removes one tool and leaves its sibling", () => {
    expect(visibleMcpTools("docs", allow, ["mcp__docs__search"])).toEqual([
      "mcp__docs__read",
    ]);
  });

  test("a name both allowed and denied is denied", () => {
    const pins = { mcp__docs__read: "deny", mcp__docs__search: "allow" };
    expect(
      visibleMcpTools(
        "docs",
        [...allow, "mcp__docs__read"],
        deniedMcpTools(pins),
      ),
    ).toEqual(["mcp__docs__search"]);
  });

  test("every deny source counts: release pins and engine rules", () => {
    expect(
      visibleMcpTools(
        "docs",
        allow,
        ["mcp__docs__read"],
        ["mcp__docs__search"],
      ),
    ).toEqual([]);
  });

  test("a deny is exact: a prefix does not close the server's other tools", () => {
    expect(visibleMcpTools("docs", allow, ["mcp__docs__"])).toEqual([
      "mcp__docs__read",
      "mcp__docs__search",
    ]);
  });

  test("mcp__<server>__* closes every tool of that server and no other", () => {
    expect(visibleMcpTools("docs", allow, ["mcp__docs__*"])).toEqual([]);
    expect(visibleMcpTools("wiki", allow, ["mcp__docs__*"])).toEqual([
      "mcp__wiki__read",
    ]);
  });

  test("an empty visible set denies", () => {
    expect(mcpToolPermitted([], "docs", "read")).toBe(false);
  });
});

describe("mcpToolPermitted", () => {
  const visible = visibleMcpTools("docs", allow, ["mcp__docs__search"]);
  test("passes a visible tool and refuses a denied or unknown one", () => {
    expect(mcpToolPermitted(visible, "docs", "read")).toBe(true);
    expect(mcpToolPermitted(visible, "docs", "search")).toBe(false);
    expect(mcpToolPermitted(visible, "docs", "other")).toBe(false);
    expect(mcpToolPermitted(visible, "wiki", "read")).toBe(false);
  });
});

describe("mcpToolDenied", () => {
  test("a whole name is matched exactly", () => {
    expect(mcpToolDenied(["mcp__a__b"], "a", "mcp__a__b")).toBe(true);
    expect(mcpToolDenied(["mcp__a__b"], "a", "mcp__a__bc")).toBe(false);
    expect(mcpToolDenied(["mcp__a__b"], "a", "mcp__a")).toBe(false);
  });

  test("the wildcard is judged on the server the call goes to", () => {
    // `mcp__docs___read` is the tool `_read` of `docs` or `read` of `docs_`.
    expect(mcpToolDenied(["mcp__docs_a__*"], "docs", "mcp__docs_a__x")).toBe(
      false,
    );
    expect(mcpToolDenied(["mcp__docs___*"], "docs", "mcp__docs___read")).toBe(
      false,
    );
    expect(mcpToolDenied(["mcp__docs___*"], "docs_", "mcp__docs___read")).toBe(
      true,
    );
    expect(mcpToolDenied(["mcp__docs__*"], "docs", "mcp__docs___read")).toBe(
      true,
    );
  });
});

describe("deniedMcpTools", () => {
  test("keeps every mcp__ deny pin, whichever server it names", () => {
    expect(
      deniedMcpTools({
        mcp__docs__a: "deny",
        mcp__docs__b: "allow",
        mcp__docs__c: "ask",
        mcp__wiki__d: "deny",
        Bash: "deny",
      }),
    ).toEqual(["mcp__docs__a", "mcp__wiki__d"]);
  });
});
