import { describe, expect, test } from "bun:test";

import {
  type BuiltinToolCatalog,
  CLAUDE_TOOL_CATALOGS,
  canonicalToolName,
  equivalentToolCatalogVersions,
  legacyToolNames,
  pinnedClaudeToolCatalog,
  toolCatalogFor,
} from "./tool-catalog.ts";
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./versions.ts";

describe("the pinned engine build", () => {
  // Bumping the SDK changes versions.ts; without a catalog for the new build
  // this fails, and the engine harness has nothing to run against.
  test("has a built-in tool catalog of its own", () => {
    const pinned = CLAUDE_TOOL_CATALOGS.filter(
      (catalog) =>
        catalog.sdkVersion === CLAUDE_AGENT_SDK_VERSION &&
        catalog.engineVersion === CLAUDE_CODE_VERSION,
    );
    expect(pinned).toHaveLength(1);
    expect(pinnedClaudeToolCatalog()).toBe(pinned[0]);
  });

  test("is found under either version a profile may name", () => {
    const pinned = pinnedClaudeToolCatalog();
    for (const version of [CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION]) {
      expect(
        toolCatalogFor(CLAUDE_TOOL_CATALOGS, "claude_agent_sdk", version),
      ).toBe(pinned);
    }
  });
});

describe("equivalent builds", () => {
  const base: BuiltinToolCatalog = {
    id: "a",
    runtimeKind: "claude_agent_sdk",
    sdkVersion: "1.0.0",
    engineVersion: "2.0.0",
    aliases: { Task: "Agent" },
    tools: [{ name: "Read", boundary: "local" }],
  };
  const other = (patch: Partial<BuiltinToolCatalog>): BuiltinToolCatalog => ({
    ...base,
    id: "b",
    sdkVersion: "1.1.0",
    engineVersion: "2.1.0",
    ...patch,
  });
  const versionsOf = (catalogs: readonly BuiltinToolCatalog[]) =>
    equivalentToolCatalogVersions(catalogs, "claude_agent_sdk", "1.0.0");

  test("name both spellings of a catalog with the same tools and aliases", () => {
    expect(versionsOf([base, other({})])).toEqual(["1.1.0", "2.1.0"]);
  });

  test("leave out a catalog whose tool, boundary or alias differs", () => {
    const widened = other({
      tools: [...base.tools, { name: "Write", boundary: "local" }],
    });
    const moved = other({ tools: [{ name: "Read", boundary: "egress" }] });
    const renamed = other({ aliases: { Task: "Subagent" } });
    expect(versionsOf([base, widened, moved, renamed])).toEqual([]);
  });

  test("leave out another runtime kind, and answer nothing for an unknown version", () => {
    expect(
      versionsOf([base, other({ runtimeKind: "codex_app_server" })]),
    ).toEqual([]);
    expect(
      equivalentToolCatalogVersions([base, other({})], "claude_agent_sdk", "9"),
    ).toEqual([]);
  });

  test("today the shipped catalogs make 0.3.270 equivalent to the pinned build", () => {
    expect(
      equivalentToolCatalogVersions(
        CLAUDE_TOOL_CATALOGS,
        "claude_agent_sdk",
        CLAUDE_AGENT_SDK_VERSION,
      ),
    ).toContain("0.3.270");
  });
});

describe("every catalog", () => {
  test("has its own id and its own versions", () => {
    const ids = CLAUDE_TOOL_CATALOGS.map((catalog) => catalog.id);
    expect(new Set(ids).size).toBe(ids.length);
    const versions = CLAUDE_TOOL_CATALOGS.flatMap((catalog) => [
      `${catalog.runtimeKind} ${catalog.sdkVersion}`,
      `${catalog.runtimeKind} ${catalog.engineVersion}`,
    ]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test.each(
    CLAUDE_TOOL_CATALOGS.map((catalog) => [catalog.id, catalog] as const),
  )(
    "%s names each tool once, by its current name, and no MCP tool",
    (_id, catalog) => {
      const names = catalog.tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name.startsWith("mcp__")).toBe(false);
        expect(Object.hasOwn(catalog.aliases, name)).toBe(false);
      }
      for (const canonical of Object.values(catalog.aliases)) {
        expect(Object.hasOwn(catalog.aliases, canonical)).toBe(false);
      }
    },
  );
});

describe("tool catalog lookup", () => {
  const catalog: BuiltinToolCatalog = {
    id: "claude_agent_sdk@9.9.9+claude-code@9.9.9",
    runtimeKind: "claude_agent_sdk",
    sdkVersion: "9.9.9",
    engineVersion: "9.9.9",
    tools: [{ name: "Read", boundary: "local" }],
    aliases: { KillBash: "TaskStop", KillShell: "TaskStop", Task: "Agent" },
  };

  test("an unknown version or another runtime has no catalog", () => {
    expect(
      toolCatalogFor([catalog], "claude_agent_sdk", "0.0.1"),
    ).toBeUndefined();
    expect(toolCatalogFor([catalog], "other_runtime", "9.9.9")).toBeUndefined();
  });

  test("an old name maps forward to the name the build uses now", () => {
    expect(canonicalToolName(catalog, "Task")).toBe("Agent");
    expect(canonicalToolName(catalog, "KillShell")).toBe("TaskStop");
    expect(canonicalToolName(catalog, "Agent")).toBe("Agent");
    expect(canonicalToolName(catalog, "Read")).toBe("Read");
    expect(canonicalToolName(catalog, "constructor")).toBe("constructor");
  });

  test("a current name maps back to every old name of it", () => {
    expect(legacyToolNames(catalog, "TaskStop")).toEqual([
      "KillBash",
      "KillShell",
    ]);
    expect(legacyToolNames(catalog, "Agent")).toEqual(["Task"]);
    expect(legacyToolNames(catalog, "Read")).toEqual([]);
    expect(legacyToolNames(catalog, "Task")).toEqual([]);
  });

  test("the pinned build carries the renames its engine accepts", () => {
    const pinned = pinnedClaudeToolCatalog();
    if (pinned === undefined) throw new Error("no pinned catalog");
    expect(canonicalToolName(pinned, "Task")).toBe("Agent");
    expect(canonicalToolName(pinned, "BashOutput")).toBe("TaskOutput");
    expect(legacyToolNames(pinned, "TaskStop")).toEqual([
      "KillBash",
      "KillShell",
    ]);
  });
});
