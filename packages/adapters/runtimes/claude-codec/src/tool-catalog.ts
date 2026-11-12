import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from "./versions.ts";

/**
 * Where a built-in tool's effect happens: inside the worker, out through the
 * egress proxy, or on the model provider's side, where the egress proxy only
 * counts it and the run's tool list is the one thing that stops it.
 */
export type ToolBoundary = "local" | "egress" | "provider";

export type BuiltinTool = {
  boundary: ToolBoundary;
  name: string;
};

/**
 * The built-in tools the platform supports on one engine build — not every
 * tool the engine ships. A tool is listed only once the engine harness
 * (`runtimes/claude/src/tool-catalog.integration.test.ts`) has shown that, on
 * the pinned build, it passes PreToolUse on the main loop and inside a
 * subagent (where the engine offers it there at all), that the permission
 * callback sees it wherever the engine asks one, that it does not run when
 * the run's tool list leaves it out, and that a held checkpoint lease stops it.
 */
export type BuiltinToolCatalog = {
  /** The name the engine reports for a tool once renamed, keyed by its older names. */
  aliases: Readonly<Record<string, string>>;
  engineVersion: string;
  /** Stored with what was computed from it, so a later reader knows which list it was. */
  id: string;
  runtimeKind: string;
  sdkVersion: string;
  tools: readonly BuiltinTool[];
};

const CLAUDE_RUNTIME_KIND = "claude_agent_sdk";

export const CLAUDE_TOOL_CATALOGS: readonly BuiltinToolCatalog[] = [
  {
    id: "claude_agent_sdk@0.3.270+claude-code@2.1.270",
    runtimeKind: CLAUDE_RUNTIME_KIND,
    sdkVersion: "0.3.270",
    engineVersion: "2.1.270",
    tools: [
      { name: "Read", boundary: "local" },
      { name: "Edit", boundary: "local" },
      { name: "Write", boundary: "local" },
      { name: "Glob", boundary: "local" },
      { name: "Grep", boundary: "local" },
      { name: "NotebookEdit", boundary: "local" },
      { name: "Bash", boundary: "local" },
      { name: "AskUserQuestion", boundary: "local" },
      { name: "WebFetch", boundary: "egress" },
      { name: "WebSearch", boundary: "provider" },
      { name: "Skill", boundary: "local" },
    ],
    // What `tools` accepts under an old name and turns into the new one.
    aliases: {
      BashOutput: "TaskOutput",
      KillBash: "TaskStop",
      KillShell: "TaskStop",
      Task: "Agent",
    },
  },
  {
    id: "claude_agent_sdk@0.3.319+claude-code@2.1.319",
    runtimeKind: CLAUDE_RUNTIME_KIND,
    sdkVersion: "0.3.319",
    engineVersion: "2.1.319",
    tools: [
      { name: "Read", boundary: "local" },
      { name: "Edit", boundary: "local" },
      { name: "Write", boundary: "local" },
      { name: "Glob", boundary: "local" },
      { name: "Grep", boundary: "local" },
      { name: "NotebookEdit", boundary: "local" },
      { name: "Bash", boundary: "local" },
      { name: "AskUserQuestion", boundary: "local" },
      { name: "WebFetch", boundary: "egress" },
      { name: "WebSearch", boundary: "provider" },
      { name: "Skill", boundary: "local" },
    ],
    aliases: {
      BashOutput: "TaskOutput",
      KillBash: "TaskStop",
      KillShell: "TaskStop",
      Task: "Agent",
    },
  },
];

/** The catalog of the build this package pins, which the engine harness runs against. */
export function pinnedClaudeToolCatalog(): BuiltinToolCatalog | undefined {
  return CLAUDE_TOOL_CATALOGS.find(
    (catalog) =>
      catalog.sdkVersion === CLAUDE_AGENT_SDK_VERSION &&
      catalog.engineVersion === CLAUDE_CODE_VERSION,
  );
}

/**
 * A release's runtime version names either the SDK or the engine build, the
 * same two spellings the runtime accepts for a session. No catalog for a
 * version is not an error: the caller decides what that means.
 */
export function toolCatalogFor(
  catalogs: readonly BuiltinToolCatalog[],
  runtimeKind: string,
  runtimeVersion: string,
): BuiltinToolCatalog | undefined {
  return catalogs.find(
    (catalog) =>
      catalog.runtimeKind === runtimeKind &&
      (catalog.sdkVersion === runtimeVersion ||
        catalog.engineVersion === runtimeVersion),
  );
}

// Tools as sorted [name, boundary] pairs and aliases as sorted pairs, so
// neither list order nor key order decides.
const shape = (catalog: BuiltinToolCatalog): string =>
  JSON.stringify([
    catalog.tools.map((tool) => [tool.name, tool.boundary]).sort(),
    Object.entries(catalog.aliases).sort(),
  ]);

const sameTools = (a: BuiltinToolCatalog, b: BuiltinToolCatalog): boolean =>
  shape(a) === shape(b);

/**
 * Every SDK and engine version, other than the one asked about, of a catalog
 * that lists the same tools (with their boundaries) and aliases as the catalog
 * of `runtimeVersion`. A release made at such a version holds the same tool
 * list on this build, so it may run here. A checkpoint is never judged by
 * this: its own fingerprint names the build that wrote it.
 */
export function equivalentToolCatalogVersions(
  catalogs: readonly BuiltinToolCatalog[],
  runtimeKind: string,
  runtimeVersion: string,
): string[] {
  const own = toolCatalogFor(catalogs, runtimeKind, runtimeVersion);
  if (own === undefined) return [];
  return catalogs
    .filter(
      (catalog) =>
        catalog !== own &&
        catalog.runtimeKind === runtimeKind &&
        sameTools(catalog, own),
    )
    .flatMap((catalog) => [catalog.sdkVersion, catalog.engineVersion]);
}
