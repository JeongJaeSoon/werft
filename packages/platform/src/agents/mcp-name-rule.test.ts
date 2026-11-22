import { describe, expect, test } from "bun:test";
import { mcpToolOfServer } from "@werft-ai/contracts";
import { mcpToolDenied } from "../catalog/index.ts";
import { effectiveMcp } from "../sessions/mcp-settings.ts";

// What a save that adds `name` to the server `docs` takes: a whole tool of
// the server that the release's deny does not block.
const allowed = async (name: string, lockedDeny: string[] = []) =>
  mcpToolOfServer(name, "docs") && !mcpToolDenied(lockedDeny, "docs", name);

// The names of NAMES that are a whole tool of the listed server `docs`: the
// only ones a deny has anything to block for.
const BLOCKABLE = new Set([
  "mcp__docs__read",
  "mcp__docs__read:all",
  "mcp__docs__a__b",
  "mcp__docs__Bash(rm:*)",
]);
const blockable = (name: string) => BLOCKABLE.has(name);

const runs = (name: string, deny: string[]) =>
  effectiveMcp({
    start: null,
    row: null,
    release: { server: "docs", tools: [name], deny },
  }).tools.includes(name);

const NAMES = [
  "mcp__docs__read",
  "mcp__docs__read:all",
  "mcp__docs__a__b",
  "mcp__docs__Bash(rm:*)",
  "mcp__docs__",
  "mcp__docs__read all",
  "mcp__docs__tab\there",
  "mcp__docs__nul\u0000l",
  `mcp__docs__${"x".repeat(200)}`,
  "mcp__wiki__read",
  "docs__read",
];

describe("one rule for allowing, blocking and running an mcp__ name", () => {
  test("the save rule accepts exactly the names that are a whole tool of the listed server", async () => {
    for (const name of NAMES) {
      expect({ name, allowed: await allowed(name) }).toEqual({
        name,
        allowed: blockable(name) && name.startsWith("mcp__docs__"),
      });
    }
    // The pin the issue named: a `:` in the tool part is allowable.
    expect(await allowed("mcp__docs__read:all")).toBe(true);
  });

  test("an accepted name is exact for the run: its deny removes it, any other deny leaves it", () => {
    for (const name of NAMES.filter(blockable)) {
      expect(runs(name, [])).toBe(true);
      expect(runs(name, [name])).toBe(false);
      expect(runs(name, [`${name}x`, name.slice(0, -1)])).toBe(true);
    }
  });

  test("a deny just written but not yet rolled out does not stop the save, and still keeps the tool from running", async () => {
    const name = "mcp__docs__write";
    // The active release's snapshot has no deny yet, so the save passes...
    expect(await allowed(name, [])).toBe(true);
    // ...and the release that carries the deny runs without the tool.
    expect(runs(name, [name])).toBe(false);
    // Once the release carries it, the writer refuses to add it.
    expect(await allowed(name, [name])).toBe(false);
  });
});
