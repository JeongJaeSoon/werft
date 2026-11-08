import {
  addedTools,
  canonicalTool,
  denyOf,
  MCP_TOOL_PREFIX,
  mcpDenyDropped,
  mcpNamesOf,
  parseToolNames,
  type ToolCatalogView,
  type ToolChoice,
  toolsUnder,
} from "@werft-ai/contracts";
import { SessionServiceError } from "./session-service.ts";

/** A runtime's built-in tool catalog as the runtime codecs install it. */
export type InstalledToolCatalog = ToolCatalogView & {
  readonly runtimeKind: string;
  readonly sdkVersion: string;
  readonly engineVersion: string;
};

/**
 * The installed catalogs, and the runtime codecs' rule for which one a
 * profile's runtime version reads (it may name the SDK or the engine build).
 */
export type ToolCatalogs = {
  readonly all: readonly InstalledToolCatalog[];
  for(
    runtimeKind: string,
    runtimeVersion: string,
  ): InstalledToolCatalog | undefined;
};

/** The deny columns of a stored version; absent or null on one made from an allow list. */
export type StoredDeny = {
  readonly deny?: readonly string[] | null | undefined;
  readonly tool_catalog_id?: string | null | undefined;
};

/**
 * A version made with a deny, read against the catalog it names: `deny` is
 * what its `tools` leave out of that catalog, and `drift` says the column
 * no longer says so. Null for a version made from an allow list. A catalog
 * this image no longer installs leaves the column as stored.
 */
export function recordedDeny(
  catalogs: ToolCatalogs | undefined,
  stored: StoredDeny,
  tools: readonly string[],
): { deny: string[]; drift: boolean } | null {
  if (stored.deny === null || stored.deny === undefined) return null;
  const catalog = catalogs?.all.find(
    (entry) => entry.id === stored.tool_catalog_id,
  );
  // `mcp__` names share the column but are not the catalog's: they neither
  // show in a catalog deny nor count as drift.
  const catalogNames = stored.deny.filter(
    (name) => !name.startsWith(MCP_TOOL_PREFIX),
  );
  if (!catalog) return { deny: catalogNames, drift: false };
  const deny = denyOf(catalog, tools);
  const column = new Set(catalogNames);
  return {
    deny,
    drift:
      column.size !== deny.length || deny.some((name) => !column.has(name)),
  };
}

/**
 * The deny a listing shows: a deny-made version's as read against its
 * catalog, else what the allow list leaves out of its runtime version's
 * catalog, else null when no catalog lists that version.
 */
export function shownDeny(
  catalogs: ToolCatalogs | undefined,
  stored: StoredDeny,
  tools: readonly string[],
  runtime: { readonly kind: string; readonly version: string },
): string[] | null {
  const recorded = recordedDeny(catalogs, stored, tools);
  if (recorded) return recorded.deny;
  const catalog = catalogs?.for(runtime.kind, runtime.version);
  return catalog ? denyOf(catalog, tools) : null;
}

/**
 * What an earlier version weighed, for the added-tools check: a deny-made
 * one its tools and the blocks its column and its tools agree on (a tool
 * the column lacks was never weighed, even when its catalog has it now),
 * one from an allow list only its tools.
 */
export function previousChoice(
  catalogs: ToolCatalogs | undefined,
  stored: StoredDeny,
  tools: readonly string[],
): ToolChoice & { drift: boolean } {
  const recorded = recordedDeny(catalogs, stored, tools);
  const column = new Set(stored.deny ?? []);
  return {
    tools,
    deny: recorded ? recorded.deny.filter((name) => column.has(name)) : null,
    drift: recorded?.drift ?? false,
  };
}

const badRequest = (message: string, reason_code: string, field: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code,
    field,
  });

/**
 * Carries the previous version's `mcp__` blocks into the deny a save stores,
 * whichever way the request spelled its tools: a deny request, or an allow
 * list (which then also stores the catalog deny it leaves out, as `mcp__`
 * names have no other column to live in). A version over a base that blocks
 * `mcp__` names must hold all of them, else `base_mcp_deny_dropped`. With
 * nothing to carry, `denied` is returned as it came.
 */
export function withKeptMcpDeny<
  D extends { deny: string[]; toolCatalogId: string },
>(input: {
  catalog: InstalledToolCatalog | undefined;
  tools: readonly string[];
  denied: D | undefined;
  previous: StoredDeny | undefined;
  baseMcpDeny: readonly string[] | undefined;
}): D | { deny: string[]; toolCatalogId: string } | undefined {
  const kept = mcpNamesOf(input.previous?.deny);
  // The request itself must name the base's `mcp__` blocks, not lean on the
  // previous version; a write cannot carry `mcp__` names yet, so over such a
  // base every request is refused until it can.
  if (mcpDenyDropped({ mcp_deny: input.baseMcpDeny }, { deny: [] })) {
    throw badRequest(
      "The base profile blocks MCP tools this version would leave open: a version keeps the base's blocks",
      "base_mcp_deny_dropped",
      "deny",
    );
  }
  if (kept.length === 0) return input.denied;
  if (input.denied) {
    return { ...input.denied, deny: [...input.denied.deny, ...kept] };
  }
  if (!input.catalog) {
    // Nothing to work the catalog deny out against: the previous version's
    // stays as it was stored, under the catalog id it named.
    const toolCatalogId = input.previous?.tool_catalog_id;
    if (toolCatalogId === null || toolCatalogId === undefined) {
      throw badRequest(
        "No tool catalog lists this runtime version: name its tools instead of a deny",
        "no_tool_catalog",
        "deny",
      );
    }
    return { deny: [...(input.previous?.deny ?? [])], toolCatalogId };
  }
  return {
    deny: [...denyOf(input.catalog, input.tools), ...kept],
    toolCatalogId: input.catalog.id,
  };
}

/**
 * The `tools`, deny column and catalog id a deny request saves, worked out
 * on the write path only: what runs is the catalog less `deny`, within
 * `allowed` (a workspace version's base) when given. Refuses a runtime
 * version no catalog lists, a name that is not one of its tools, a base
 * block the request leaves out, and a tool the previous version never
 * weighed that would run without being accepted.
 */
export function deniedTools(input: {
  catalog: InstalledToolCatalog | undefined;
  deny: readonly string[];
  accept: readonly string[] | undefined;
  /** A workspace version's base: its tools, and whether its deny counts. */
  base?: {
    readonly tools: readonly string[];
    /** False when the base was worked out against another catalog. */
    readonly sameCatalog: boolean;
  };
  previous: ToolChoice | undefined;
}): { tools: string[]; deny: string[]; toolCatalogId: string } {
  const { catalog } = input;
  if (!catalog) {
    throw badRequest(
      "No tool catalog lists this runtime version: name its tools instead of a deny",
      "no_tool_catalog",
      "deny",
    );
  }
  const deny = parseToolNames(catalog, input.deny);
  if ("refusal" in deny) {
    throw badRequest(deny.refusal.message, deny.refusal.reason_code, "deny");
  }
  const accept = parseToolNames(catalog, input.accept ?? []);
  if ("refusal" in accept) {
    throw badRequest(
      accept.refusal.message,
      accept.refusal.reason_code,
      "accept_added_tools",
    );
  }
  if (input.base?.sameCatalog) {
    const asked = new Set(deny.names);
    const kept = denyOf(catalog, input.base.tools).filter(
      (name) => !asked.has(name),
    );
    if (kept.length > 0) {
      throw badRequest(
        `The base profile blocks ${kept.join(", ")}: a version keeps the base's blocks`,
        "base_denies",
        "deny",
      );
    }
  }
  const tools = toolsUnder(catalog, deny.names, input.base?.tools);
  if (input.previous) {
    const accepted = new Set(accept.names);
    const running = new Set(tools.map((tool) => canonicalTool(catalog, tool)));
    const unaccepted = addedTools(catalog, input.previous).filter(
      (name) => running.has(name) && !accepted.has(name),
    );
    if (unaccepted.length > 0) {
      throw badRequest(
        `The previous version never weighed ${unaccepted.join(", ")}: deny them or name them in accept_added_tools`,
        "added_tool_not_accepted",
        "accept_added_tools",
      );
    }
  }
  return {
    tools,
    deny: denyOf(catalog, tools),
    toolCatalogId: catalog.id,
  };
}
