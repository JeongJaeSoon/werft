import { MCP_TOOL_PREFIX } from "../kollegium/agents.ts";

export type ToolBoundaryValue = "local" | "egress" | "provider";

/**
 * A built-in tool catalog as a profile's deny reads it: the runtime's
 * (with `aliases`) or the options response's (without).
 */
export type ToolCatalogView = {
  readonly id: string;
  readonly tools: readonly {
    readonly name: string;
    readonly boundary: ToolBoundaryValue;
  }[];
  /** Older names the engine still takes, keyed to the name it reports now. */
  readonly aliases?: Readonly<Record<string, string>> | undefined;
};

/** What a version weighed its tools against: its deny, when it was made with one. */
export type ToolChoice = {
  readonly tools: readonly string[];
  readonly deny?: readonly string[] | null | undefined;
};

/** Same rule as the runtime codecs' `canonicalToolName`, which contracts cannot import. */
export function canonicalTool(catalog: ToolCatalogView, name: string): string {
  const aliases = catalog.aliases ?? {};
  return Object.hasOwn(aliases, name) ? (aliases[name] ?? name) : name;
}

const namesOf = (catalog: ToolCatalogView): string[] =>
  catalog.tools.map((tool) => tool.name);

const inCatalogOrder = (
  catalog: ToolCatalogView,
  names: Iterable<string>,
): string[] => {
  const picked = new Set(names);
  return namesOf(catalog).filter((name) => picked.has(name));
};

const canonicalSet = (catalog: ToolCatalogView, names: readonly string[]) =>
  new Set(names.map((name) => canonicalTool(catalog, name)));

/**
 * The `mcp__` names among `names`, sorted and without repeats. A stored deny
 * keeps them beside the catalog's; they are matched exactly and never
 * filtered by a name rule, so one that rule would refuse is still kept.
 */
export function mcpNamesOf(
  names: readonly string[] | null | undefined,
): string[] {
  return [
    ...new Set((names ?? []).filter((n) => n.startsWith(MCP_TOOL_PREFIX))),
  ].sort();
}

/**
 * The catalog's tools that `tools` leaves out, in catalog order. An old
 * allow list may hold `mcp__*` names; they are not the catalog's to deny.
 */
export function denyOf(
  catalog: ToolCatalogView,
  tools: readonly string[],
): string[] {
  const allowed = canonicalSet(
    catalog,
    tools.filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX)),
  );
  return namesOf(catalog).filter((name) => !allowed.has(name));
}

/**
 * The names in `tools` this catalog does not hold, aliases followed and
 * `mcp__*` names left aside: what a version made with a deny no longer runs.
 */
export function unsupportedTools(
  catalog: ToolCatalogView,
  tools: readonly string[],
): string[] {
  const known = new Set(namesOf(catalog));
  return tools.filter(
    (tool) =>
      !tool.startsWith(MCP_TOOL_PREFIX) &&
      !known.has(canonicalTool(catalog, tool)),
  );
}

/**
 * What a version made with `deny` runs: the catalog tools among `allowed`
 * (every catalog tool when absent) that `deny` leaves, in `allowed`'s
 * spelling, so a workspace version stays a subset of its base. Nothing
 * outside the catalog stays.
 */
export function toolsUnder(
  catalog: ToolCatalogView,
  deny: readonly string[],
  allowed: readonly string[] = namesOf(catalog),
): string[] {
  const known = new Set(namesOf(catalog));
  const denied = canonicalSet(catalog, deny);
  return allowed.filter((tool) => {
    const name = canonicalTool(catalog, tool);
    return known.has(name) && !denied.has(name);
  });
}

/**
 * The catalog tools the previous version never weighed: with a deny it
 * weighed its tools and its deny, with an allow list only what it allowed.
 * A catalog that grew under the same id is caught too.
 */
export function addedTools(
  catalog: ToolCatalogView,
  previous: ToolChoice,
): string[] {
  const weighed = canonicalSet(catalog, [
    ...previous.tools,
    ...(previous.deny ?? []),
  ]);
  return namesOf(catalog).filter((name) => !weighed.has(name));
}

export type ToolNameRefusal = {
  readonly reason_code: "mcp_tool" | "tool_pattern" | "unknown_tool";
  readonly name: string;
  readonly message: string;
};

/**
 * `names` as catalog names, deduplicated in catalog order, or why one is
 * not a built-in tool of this catalog. Patterns such as `Bash(rm:*)` are
 * refused: nothing on the platform side would enforce them.
 */
export function parseToolNames(
  catalog: ToolCatalogView,
  names: readonly string[],
): { readonly names: string[] } | { readonly refusal: ToolNameRefusal } {
  const known = new Set(namesOf(catalog));
  for (const raw of names) {
    if (raw.startsWith(MCP_TOOL_PREFIX)) {
      return {
        refusal: {
          reason_code: "mcp_tool",
          name: raw,
          message: `${raw} is an MCP tool: a profile blocks built-in tools only`,
        },
      };
    }
    if (/[()*:\s]/.test(raw)) {
      return {
        refusal: {
          reason_code: "tool_pattern",
          name: raw,
          message: `${raw} is a pattern: name a whole built-in tool`,
        },
      };
    }
    if (!known.has(canonicalTool(catalog, raw))) {
      return {
        refusal: {
          reason_code: "unknown_tool",
          name: raw,
          message: `${raw} is not a built-in tool of ${catalog.id}`,
        },
      };
    }
  }
  return { names: inCatalogOrder(catalog, canonicalSet(catalog, names)) };
}

/**
 * The deny a first version of a ceiling starts from: the tools that run on
 * the model provider's side, where only the tool list stops them.
 */
export function firstVersionDeny(catalog: ToolCatalogView): string[] {
  return catalog.tools
    .filter((tool) => tool.boundary === "provider")
    .map((tool) => tool.name);
}

/**
 * The deny a next version starts from, in `catalog`'s names: what the
 * previous one blocked (its deny, or what its allow list leaves out) and
 * every tool it never weighed, which opens only once accepted.
 */
export function carriedDeny(
  catalog: ToolCatalogView,
  previous: ToolChoice,
): string[] {
  return inCatalogOrder(catalog, [
    ...(previous.deny ?? denyOf(catalog, previous.tools)).map((name) =>
      canonicalTool(catalog, name),
    ),
    ...addedTools(catalog, previous),
  ]);
}
