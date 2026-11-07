import type {
  InstallationProfileOptionsResponse,
  ProfileSummary,
  RuntimeKind,
  ToolBoundaryValue,
  ToolCatalogView,
} from "@werft-ai/contracts";
import {
  addedTools,
  canonicalTool,
  carriedDeny,
  firstVersionDeny,
  MCP_TOOL_PREFIX,
  WORKSPACE_PROFILE_POLICY,
} from "@werft-ai/core/forms";

/**
 * A profile form's built-in tool checklist before anyone clicks: what it
 * lists, what starts blocked, and what the previous version never had.
 */
export type ToolChoiceModel = {
  /** A workspace form's is its base's tools, under the base's id. */
  readonly catalog: ToolCatalogView;
  /** Null where the options are not readable: a workspace form. */
  readonly boundaries: ReadonlyMap<string, ToolBoundaryValue> | null;
  readonly start: readonly string[];
  /** The base's blocks, which a workspace version keeps. */
  readonly fixed: readonly string[];
  /**
   * Tools the previous version's catalog did not list. Read from a listing,
   * whose deny is worked out for allow-list rows too, so the server may name
   * more: those arrive as `ToolPicks.asked` after its refusal.
   */
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** A next version: its added tools open only once accepted. */
  readonly versioned: boolean;
};

/** What the person changed: a box they ticked or cleared, a tool accepted. */
export type ToolPicks = {
  readonly blocked: Readonly<Record<string, boolean>>;
  readonly accepted: readonly string[];
  /** Tools the server said need accepting, beyond `added`. */
  readonly asked: readonly string[];
};

export const NO_PICKS: ToolPicks = { blocked: {}, accepted: [], asked: [] };

type ToolCatalogOption = NonNullable<
  InstallationProfileOptionsResponse["tool_catalogs"]
>[number];

/** The options list a catalog under its SDK and its engine version alike. */
export function catalogOf(
  options: InstallationProfileOptionsResponse,
  kind: RuntimeKind,
  version: string,
): ToolCatalogOption | undefined {
  return options.tool_catalogs?.find(
    (catalog) =>
      catalog.runtime_kind === kind && catalog.runtime_version === version,
  );
}

/** Each catalog once, by id, in the order listed: one entry per version spelling. */
function catalogsOf(
  options: InstallationProfileOptionsResponse,
  kind: RuntimeKind,
): ToolCatalogOption[] {
  const byId = new Map<string, ToolCatalogOption>();
  for (const catalog of options.tool_catalogs ?? [])
    if (catalog.runtime_kind === kind && !byId.has(catalog.id))
      byId.set(catalog.id, catalog);
  return [...byId.values()];
}

const namesOf = (catalog: ToolCatalogView) =>
  catalog.tools.map((tool) => tool.name);

/** What a listed version weighed: its tools, and its blocks when a catalog knew them. */
const choiceOf = (profile: ProfileSummary) => ({
  tools: profile.tools,
  deny: profile.deny ?? null,
});

/**
 * An installation ceiling's checklist on the runtime version typed now, or
 * null when no catalog lists that version: a deny cannot be saved there.
 * A first version blocks the provider-side tools; a next one, and a copy,
 * what the one before blocked plus every tool it never had. A copy sends
 * no previous, so the server checks nothing it opens.
 */
export function ceilingTools(
  options: InstallationProfileOptionsResponse,
  kind: RuntimeKind,
  version: string,
  from: {
    readonly previous?: ProfileSummary | undefined;
    readonly template?: ProfileSummary | undefined;
  },
): ToolChoiceModel | null {
  const catalog = catalogOf(options, kind, version);
  if (catalog === undefined) return null;
  const boundaries = new Map(
    catalog.tools.map((tool) => [tool.name, tool.boundary]),
  );
  const { previous, template } = from;
  if (previous === undefined) {
    return {
      catalog,
      boundaries,
      start:
        template === undefined
          ? firstVersionDeny(catalog)
          : carriedDeny(catalog, choiceOf(template)),
      fixed: [],
      added: [],
      removed: [],
      versioned: false,
    };
  }
  const before = catalogOf(
    options,
    previous.runtime_kind,
    previous.runtime_version,
  );
  const known = new Set(namesOf(catalog));
  return {
    catalog,
    boundaries,
    start: carriedDeny(catalog, choiceOf(previous)),
    fixed: [],
    added: addedTools(catalog, choiceOf(previous)),
    removed:
      before === undefined
        ? []
        : namesOf(before).filter(
            (name) => !known.has(canonicalTool(catalog, name)),
          ),
    versioned: true,
  };
}

/**
 * A base's tools as a catalog under the base's id: what it runs and what it
 * blocks. A workspace form cannot read the options, so the boundaries stay
 * unknown; the derivation reads names only.
 */
function baseCatalog(base: ProfileSummary): ToolCatalogView | null {
  if (base.deny == null) return null;
  const names = [
    ...new Set([
      ...base.tools.filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX)),
      ...base.deny,
    ]),
  ];
  return {
    id: base.id,
    tools: names.map((name) => ({ name, boundary: "local" as const })),
  };
}

/** The latest version under `name`, which the server weighs new tools against. */
export const latestVersion = (
  items: readonly ProfileSummary[],
  name: string,
): ProfileSummary | undefined =>
  items
    .filter((item) => item.installation?.name === name)
    .sort(
      (a, b) => (b.installation?.version ?? 0) - (a.installation?.version ?? 0),
    )[0];

/**
 * A workspace version's checklist over `base`, or null when no catalog
 * lists the base's runtime version. It starts from `from`, the version it
 * follows, when there is one; what needs accepting is read against
 * `latest`, the name's latest version, which is what the server checks,
 * and starts blocked like an installation version's added tools.
 */
export function workspaceTools(
  base: ProfileSummary,
  from: ProfileSummary | undefined,
  latest: ProfileSummary | undefined,
): ToolChoiceModel | null {
  const catalog = baseCatalog(base);
  if (catalog === null) return null;
  const derived =
    from === undefined
      ? WORKSPACE_PROFILE_POLICY.initial(base, catalog)
      : WORKSPACE_PROFILE_POLICY.carry(from, base, catalog);
  const added =
    latest === undefined ? [] : addedTools(catalog, choiceOf(latest));
  return {
    catalog,
    boundaries: null,
    start: [...new Set([...(derived.deny ?? []), ...added])],
    fixed: WORKSPACE_PROFILE_POLICY.choices(base, catalog).deny?.fixed ?? [],
    added,
    removed: [],
    versioned: latest !== undefined,
  };
}

/** The tools blocked now, in catalog order. */
export function blockedOf(model: ToolChoiceModel, picks: ToolPicks): string[] {
  const fixed = new Set(model.fixed);
  const start = new Set(model.start);
  return namesOf(model.catalog).filter(
    (name) =>
      fixed.has(name) ||
      (Object.hasOwn(picks.blocked, name)
        ? picks.blocked[name] === true
        : start.has(name)),
  );
}

/** Tools that open only once accepted: the counted ones and the server's. */
export function needsAccepting(
  model: ToolChoiceModel,
  picks: ToolPicks,
): string[] {
  if (!model.versioned) return [];
  const names = new Set([...model.added, ...picks.asked]);
  return namesOf(model.catalog).filter((name) => names.has(name));
}

/**
 * The deny fields a save sends, or the tools it would open unaccepted:
 * the same check the server makes, so it is caught before the request.
 */
export function denyRequest(
  model: ToolChoiceModel,
  picks: ToolPicks,
):
  | { readonly deny: string[]; readonly accept_added_tools?: string[] }
  | { readonly unaccepted: string[] } {
  const deny = blockedOf(model, picks);
  const blocked = new Set(deny);
  const accepted = new Set(picks.accepted);
  const pending = needsAccepting(model, picks).filter(
    (name) => !blocked.has(name),
  );
  const unaccepted = pending.filter((name) => !accepted.has(name));
  if (unaccepted.length > 0) return { unaccepted };
  return pending.length === 0
    ? { deny }
    : { deny, accept_added_tools: pending };
}

/**
 * After the server refused tools the previous version never weighed: ask
 * about every tool this save opens that `latest`, the version the server
 * checked against, did not run. Its refusal names them only in prose, so
 * the form does not read it; this set holds the server's.
 */
export function askAgain(
  model: ToolChoiceModel,
  picks: ToolPicks,
  latest: ProfileSummary,
): ToolPicks {
  const ran = new Set(
    latest.tools.map((tool) => canonicalTool(model.catalog, tool)),
  );
  const blocked = new Set(blockedOf(model, picks));
  const opened = namesOf(model.catalog).filter(
    (name) => !blocked.has(name) && !ran.has(name),
  );
  return { ...picks, asked: [...new Set([...picks.asked, ...opened])] };
}

/**
 * Tools the runtime's newest catalog lists that this version never weighed:
 * a new version would start with them blocked. The options list catalogs
 * oldest first, the order the runtime codecs install them. Empty when this
 * version already is on that catalog.
 */
export function blockedNewTools(
  options: InstallationProfileOptionsResponse,
  profile: ProfileSummary,
): { readonly catalog: string; readonly tools: string[] } {
  const own = catalogOf(options, profile.runtime_kind, profile.runtime_version);
  const latest = catalogsOf(options, profile.runtime_kind).at(-1);
  if (latest === undefined || latest.id === own?.id)
    return { catalog: own?.id ?? "", tools: [] };
  const weighed = new Set(
    [...profile.tools, ...(profile.deny ?? [])].map((name) =>
      canonicalTool(latest, name),
    ),
  );
  return {
    catalog: latest.id,
    tools: namesOf(latest).filter((name) => !weighed.has(name)),
  };
}
