import { describe, expect, test } from "bun:test";
import {
  ceiling,
  denyFor,
  imported,
  OPTIONS,
  version,
} from "../test-support/profiles.ts";
import { ceilingTools, workspaceTools } from "./profile-tools-model.ts";

const DOCS = "mcp__docs__delete";
const WIKI = "mcp__wiki__write";
const mcpNames = (names: readonly string[]) =>
  names.filter((name) => name.startsWith("mcp__"));

/** A profile as the listing returns it when `mcp__` names sit in its stored deny. */
const holding = (tools: readonly string[], mcp: readonly string[]) =>
  imported("coding-claude", {
    tools: [...tools],
    deny: [...denyFor(tools), ...mcp],
    mcp_deny: [...mcp],
  });

describe("the tool checklist never lists an mcp__ name as a catalog tool", () => {
  test("a workspace form over a base that blocks mcp__ names reads the catalog from the built-in names only", () => {
    const base = holding(["Read", "Bash"], [DOCS]);
    const model = workspaceTools(base, undefined, undefined);
    const names = model?.catalog.tools.map((tool) => tool.name) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(mcpNames(names)).toEqual([]);
    expect(mcpNames(model?.start ?? [])).toEqual([]);
    expect(model?.mcp.fixed).toEqual([DOCS]);
  });

  test("a base whose allow list names an mcp__ tool does not put it in the catalog either", () => {
    const base = imported("coding-claude", {
      tools: ["Read", DOCS],
      deny: denyFor(["Read"]),
    });
    const names =
      workspaceTools(base, undefined, undefined)?.catalog.tools.map(
        (tool) => tool.name,
      ) ?? [];
    expect(mcpNames(names)).toEqual([]);
  });

  test("a version the new one follows leaves its mcp__ blocks out of the catalog deny and out of what needs accepting", () => {
    const base = holding(["Read", "Bash"], [DOCS]);
    const from = version(1, "usable", {
      tools: ["Read"],
      deny: [...denyFor(["Read"]), DOCS, WIKI],
      mcp_deny: [DOCS, WIKI],
    });
    const model = workspaceTools(base, from, from);
    expect(mcpNames(model?.start ?? [])).toEqual([]);
    expect(mcpNames(model?.added ?? [])).toEqual([]);
    expect(model?.mcp.start).toEqual([WIKI]);
  });

  test("a ceiling's next version keeps the earlier mcp__ blocks apart from the catalog deny", () => {
    const previous = ceiling("coding", 1, {
      tools: ["Read", "Edit"],
      deny: [...denyFor(["Read", "Edit"]), DOCS],
      mcp_deny: [DOCS],
    });
    const model = ceilingTools(OPTIONS, "claude_agent_sdk", "0.3.270", {
      previous,
    });
    expect(mcpNames(model?.start ?? [])).toEqual([]);
    expect(mcpNames(model?.added ?? [])).toEqual([]);
    expect(model?.mcp).toEqual({ fixed: [], start: [DOCS], lifts: true });
  });

  test("a copy keeps its source's mcp__ blocks apart too, and sends no lift", () => {
    const template = ceiling("coding", 1, {
      tools: ["Read"],
      deny: [...denyFor(["Read"]), DOCS],
      mcp_deny: [DOCS],
    });
    const model = ceilingTools(OPTIONS, "claude_agent_sdk", "0.3.270", {
      template,
    });
    expect(mcpNames(model?.start ?? [])).toEqual([]);
    expect(model?.mcp).toEqual({ fixed: [], start: [DOCS], lifts: false });
  });
});
