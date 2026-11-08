import {
  canonicalJson,
  mcpNamesOf,
  OPT_IN_PERMISSION_MODES,
  type ProfileDerivationPolicy,
  WORKSPACE_PROFILE_POLICY,
} from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import type {
  CatalogProfileImport,
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogMcpServer,
  type CatalogProfileConfig,
  type CatalogProfileView,
  type CatalogRepository,
  type CatalogRepositoryView,
  type CredentialRef,
  catalogProfileConfigSchema,
  credentialRefOf,
  type InstallationProfileEntry,
  type InstallationProfileState,
  profileFingerprint,
  type RuntimeVersions,
  type SessionCatalogConfig,
  sessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
} from "./catalog.ts";
import type { SettingsSnapshot } from "./installation-settings.ts";
import type { ToolCatalogs } from "./profile-tools.ts";

// One registry for every profile a process resolves
// (docs/contributing/decisions/profile-db.md §2): the installation ceilings
// in `installation_profiles` and the workspace versions over them, read in
// one pass into one snapshot that `catalog.profiles` serves.

/** A provider an installation ceiling may run against, by connection id. */
export type Connections = Readonly<
  Record<string, CatalogProfileConfig["provider"]>
>;

/**
 * The repositories each seeded id may run against, as the `profiles` arrays
 * of the repositories named them: read only by the seed, which also fills
 * rows from before the database held them.
 */
export function catalogRepositoryIds(
  repositories: Readonly<
    Record<string, { profiles?: readonly string[] | undefined }>
  >,
): (profileId: string) => string[] {
  return (profileId) =>
    Object.entries(repositories)
      .filter(([, repository]) => repository.profiles?.includes(profileId))
      .map(([id]) => id)
      .sort();
}

export function catalogImports(
  profiles: SessionCatalogConfig["profiles"],
): CatalogProfileImport[] {
  return Object.entries(profiles).map(([id, definition]) => ({
    id,
    definition,
    permission_mode: definition.permission_mode,
    fingerprint: definitionFingerprint(id, definition),
  }));
}

export function definitionFingerprint(
  id: string,
  definition: CatalogProfileConfig,
): string {
  const view = sessionCatalogView({
    profiles: { [id]: definition },
    repositories: {},
  }).profiles[id];
  if (!view) throw new Error(`profile ${id} has no view`);
  return profileFingerprint(view);
}

export type InstallationSnapshot<P extends CatalogProfileView> = {
  /** What runs: every `usable` and `retired` ceiling. */
  profiles: Record<string, P>;
  /** Every ceiling id this replica knows, whatever its state. */
  installation: ReadonlyMap<string, InstallationProfileEntry>;
};

export type SnapshotSources<P extends CatalogProfileView> = {
  connections: Connections;
  /**
   * For a connection the console moved from a deployment reference to a
   * stored value: the provider it was, which a ceiling made before the move
   * still holds.
   */
  connection_aliases?: Connections;
  /** What `materialize` resolves a credential reference through. */
  lookup?: (ref: CredentialRef) => string | undefined;
  allowUnattended: boolean;
  runtimeSupported: (profile: CatalogProfileConfig) => boolean;
  /**
   * The profile a definition runs; may throw when a credential does not
   * resolve. `lookup`, when given, is tried before the sources' own: the
   * settings read's, for a ceiling over a connection the database holds.
   */
  materialize: (
    id: string,
    definition: CatalogProfileConfig,
    lookup?: (ref: CredentialRef) => string | undefined,
  ) => P;
};

/**
 * The ceilings `rows` run here; the database is their only record. A row
 * runs nothing when it is blocked, its provider is no connection here, it needs the
 * unattended switch this process has off, no installed runtime serves it,
 * or it no longer parses to its stored fingerprint.
 */
/**
 * Which connection a provider belongs to: the first connection by id that
 * holds it, else the one it was before a move to a stored value. The one rule
 * the snapshot and the disable warning both read, so they never disagree.
 */
export function connectionMatcher(
  sources: Pick<SnapshotSources<CatalogProfileView>, "connection_aliases"> & {
    connections: Connections;
  },
) {
  const connections = new Map<string, string>();
  for (const id of Object.keys(sources.connections).sort()) {
    const key = canonicalJson(sources.connections[id]);
    if (!connections.has(key)) connections.set(key, id);
  }
  // A former provider names one connection, and only while no connection
  // holds it as its current provider: two keys never get mixed up.
  const former = new Map<string, string>();
  for (const id of Object.keys(sources.connection_aliases ?? {}).sort()) {
    const key = canonicalJson(sources.connection_aliases?.[id]);
    if (!connections.has(key) && !former.has(key)) former.set(key, id);
  }
  const connectionOf = (provider: CatalogProfileConfig["provider"]) => {
    const key = canonicalJson(provider);
    return connections.get(key) ?? former.get(key) ?? null;
  };
  return { connections, former, connectionOf };
}

export function installationProfileSnapshot<P extends CatalogProfileView>(
  sources: SnapshotSources<P>,
  rows: readonly InstallationProfileRecord[],
): InstallationSnapshot<P> {
  const { connections, former, connectionOf } = connectionMatcher(sources);
  // Over a former provider the ceiling still names the old reference; the
  // value is the one the connection holds now.
  const lookupFor = (provider: CatalogProfileConfig["provider"]) => {
    const base = sources.lookup;
    const id = former.get(canonicalJson(provider));
    const current = id === undefined ? undefined : sources.connections[id];
    if (
      base === undefined ||
      current === undefined ||
      connections.has(canonicalJson(provider))
    ) {
      return undefined;
    }
    const { kind: _old, ...oldFields } = provider.auth;
    const { kind: _new, ...newFields } = current.auth;
    const oldRef = canonicalJson(credentialRefOf(oldFields));
    const newRef = credentialRefOf(newFields);
    return (ref: CredentialRef) =>
      base(canonicalJson(ref) === oldRef ? newRef : ref);
  };
  const profiles: Record<string, P> = {};
  const installation = new Map<string, InstallationProfileEntry>();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const stored of rows) {
    const row = { ...stored, repository_ids: stored.repository_ids ?? [] };
    const { id } = row;
    const parsed = parsedDefinition(row);
    const definition = storedDefinition(id, row, parsed);
    const entry = (state: InstallationProfileState, blockedSource?: string) => {
      installation.set(id, {
        id,
        origin: row.origin,
        state,
        ...(blockedSource === undefined
          ? {}
          : { blocked_source: blockedSource }),
        repository_ids: [...row.repository_ids],
        github_app_repositories: row.github_app_repositories,
        repository_scope: row.repository_scope,
        record: row,
        definition: parsed ?? undefined,
        connection_id: parsed === null ? null : connectionOf(parsed.provider),
      });
    };
    // Before every state a replica decides for itself: a block is the same
    // everywhere, so a claim may fail what it stops.
    if (row.blocked_at !== null) {
      entry("blocked");
      continue;
    }
    // A version stops with the one it derives from, and is left out of
    // `profiles` like any blocked row, so no path can still resolve it.
    const blockedSource = blockedSourceOf(row, byId);
    if (blockedSource !== undefined) {
      entry("blocked", blockedSource);
      continue;
    }
    if (definition === null) {
      entry("definition_drift");
      continue;
    }
    if (connectionOf(definition.provider) === null) {
      entry("connection_missing");
      continue;
    }
    if (
      (OPT_IN_PERMISSION_MODES as readonly string[]).includes(
        definition.permission_mode,
      ) &&
      !sources.allowUnattended
    ) {
      entry("unattended_off");
      continue;
    }
    if (!sources.runtimeSupported(definition)) {
      entry("runtime_unsupported");
      continue;
    }
    let profile: P;
    try {
      profile = sources.materialize(
        id,
        definition,
        lookupFor(definition.provider),
      );
    } catch {
      entry("connection_missing");
      continue;
    }
    // The deny column holds `mcp__` names beside the catalog's; the release
    // carries them as `mcp_deny`.
    const mcpDeny = mcpNamesOf(row.deny);
    profiles[id] =
      mcpDeny.length > 0 ? { ...profile, mcp_deny: mcpDeny } : profile;
    entry(row.retired_at !== null ? "retired" : "usable");
  }
  return { profiles, installation };
}

function parsedDefinition(
  row: InstallationProfileRecord,
): CatalogProfileConfig | null {
  const parsed = catalogProfileConfigSchema.safeParse(row.definition);
  if (!parsed.success) return null;
  // A row with no repository scope names no repository: `optional` neither
  // asks for one nor refuses one, and keeps `sessionCatalogView` from
  // reading the missing key as `required`. Only in memory; the stored
  // definition and its fingerprint are untouched.
  return row.repository_scope === null
    ? { ...parsed.data, repository: parsed.data.repository ?? "optional" }
    : parsed.data;
}

/**
 * The version up the `derived_from` chain that is blocked, or the one the
 * chain breaks at (a missing version or a loop), which stops it as well.
 * Retiring a version does not stop what derives from it.
 */
function blockedSourceOf(
  row: InstallationProfileRecord,
  byId: ReadonlyMap<string, InstallationProfileRecord>,
): string | undefined {
  const seen = new Set([row.id]);
  let next = row.derived_from ?? null;
  while (next !== null) {
    const source = byId.get(next);
    if (source === undefined || seen.has(next) || source.blocked_at !== null) {
      return next;
    }
    seen.add(next);
    next = source.derived_from ?? null;
  }
  return undefined;
}

// A row runs only while it parses as written and hashes as it did then.
function storedDefinition(
  id: string,
  row: InstallationProfileRecord,
  parsed: CatalogProfileConfig | null,
): CatalogProfileConfig | null {
  if (parsed === null) return null;
  return definitionFingerprint(id, parsed) === row.fingerprint &&
    parsed.permission_mode === row.permission_mode
    ? parsed
    : null;
}

export function catalogRows(
  profiles: SessionCatalogConfig["profiles"],
  repositories: Parameters<typeof catalogRepositoryIds>[0] = {},
): InstallationProfileRecord[] {
  const repositoryIdsOf = catalogRepositoryIds(repositories);
  return catalogImports(profiles).map((entry) => ({
    ...entry,
    name: null,
    version: 1,
    origin: "catalog",
    repository_ids: repositoryIdsOf(entry.id),
    github_app_repositories: "listed",
    previous_id: null,
    created_by: null,
    created_at: new Date(0),
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
  }));
}

/**
 * `catalog` with the ceilings seeding an empty database from it would give:
 * each profile usable, on the repositories whose `profiles` name it. For a
 * catalog put together in memory instead of read through the registry.
 */
export function withSeededInstallation<
  C extends {
    profiles: Readonly<Record<string, unknown>>;
    repositories: Parameters<typeof catalogRepositoryIds>[0];
  },
>(
  catalog: C,
): C & { installation: ReadonlyMap<string, InstallationProfileEntry> } {
  const repositoryIdsOf = catalogRepositoryIds(catalog.repositories);
  return {
    ...catalog,
    installation: new Map(
      Object.keys(catalog.profiles).map((id) => [
        id,
        {
          id,
          origin: "catalog",
          state: "usable",
          repository_ids: repositoryIdsOf(id),
        },
      ]),
    ),
  };
}

/** Ids among `snapshot` that this replica leaves out, with why. */
export function unrunnableProfiles(
  snapshot: Pick<InstallationSnapshot<CatalogProfileView>, "installation">,
): Array<{ id: string; state: InstallationProfileState }> {
  return [...snapshot.installation.values()]
    .filter(({ state }) => state !== "usable" && state !== "retired")
    .map(({ id, state }) => ({ id, state }));
}

/**
 * The newest read wins and a refresh joins one begun within `maxAgeMs`;
 * a failed read keeps what was read before.
 */
export function latestReads<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  now: () => number,
): (maxAgeMs?: number) => Promise<void> {
  let readAt = Number.NEGATIVE_INFINITY;
  let begun = 0;
  let applied = 0;
  let latest: { startedAt: number; done: Promise<void> } | null = null;
  return (maxAgeMs = 0) => {
    const oldest = now() - maxAgeMs;
    if (maxAgeMs > 0 && readAt >= oldest) return Promise.resolve();
    if (latest !== null && latest.startedAt > oldest) return latest.done;
    const startedAt = now();
    begun += 1;
    const order = begun;
    const done = read().then(
      (value) => {
        if (order < applied) return;
        apply(value);
        applied = order;
        readAt = startedAt;
      },
      (error: unknown) => {
        if (latest?.done === done) latest = null;
        throw error;
      },
    );
    latest = { startedAt, done };
    return done;
  };
}

/** The workspace versions and the ceiling snapshot, read together. */
export interface ProfileRegistry<P extends CatalogProfileView>
  extends WorkspaceProfiles {
  readonly profiles: Readonly<Record<string, P>>;
  readonly installation: ReadonlyMap<string, InstallationProfileEntry>;
  /**
   * The console's repositories as last read, or null before the first read,
   * before the table was ever seeded, or for a registry given no store.
   */
  readonly repositoryRows: readonly CatalogRepositoryRow[] | null;
  /**
   * The installation settings as last read, or null before the first read
   * or for a registry given none.
   */
  readonly settings: SettingsSnapshot | null;
  readonly connections: Connections;
}

export function withConsoleRepositories(
  rows: readonly CatalogRepositoryRow[] | null,
  settings: Readonly<Record<string, CatalogRepository>> = {},
): Record<string, CatalogRepository> {
  const merged: Record<string, CatalogRepository> = { ...settings };
  for (const row of rows ?? []) {
    if (Object.hasOwn(merged, row.id)) continue;
    merged[row.id] = {
      url: row.url,
      branch: row.branch,
      ...(row.profiles === null ? {} : { profiles: row.profiles }),
      auth: { kind: "github_app", registered: true },
    };
  }
  return merged;
}

function withSettings<P extends CatalogProfileView>(
  sources: SnapshotSources<P>,
  settings: SettingsSnapshot | null,
): SnapshotSources<P> {
  if (settings === null) return sources;
  return {
    ...sources,
    connections: settings.connections,
    connection_aliases: settings.connection_aliases,
    lookup: settings.lookup,
    materialize: (id, definition, lookup) =>
      sources.materialize(id, definition, lookup ?? settings.lookup),
  };
}

// Kept as the same objects while nothing in them changed: claim caches key
// on the catalog's repositories object.
function keepUnchanged(
  next: SettingsSnapshot,
  previous: SettingsSnapshot | null,
): SettingsSnapshot {
  if (previous === null) return next;
  const same = <T>(a: T, b: T) => canonicalJson(a) === canonicalJson(b);
  return {
    ...next,
    repositories: same(next.repositories, previous.repositories)
      ? previous.repositories
      : next.repositories,
    mcp_servers: same(next.mcp_servers, previous.mcp_servers)
      ? previous.mcp_servers
      : next.mcp_servers,
  };
}

/**
 * Runs no ceiling before its first read: the snapshot holds only the rows
 * `installations` last listed.
 */
export function createProfileRegistry<P extends CatalogProfileView>(deps: {
  workspaces: Pick<WorkspaceProfileStore, "listAll">;
  installations: Pick<InstallationProfileStore, "listAll">;
  repositories?: Pick<CatalogRepositoryStore, "readCatalog">;
  /**
   * The installation settings (connections, MCP servers, repositories that
   * carry their own credential), credentials resolved.
   */
  settings?: { read(): Promise<SettingsSnapshot> };
  sources: SnapshotSources<P>;
  now?: () => number;
  policy?: ProfileDerivationPolicy;
}): ProfileRegistry<P> {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  let snapshot = installationProfileSnapshot(deps.sources, []);
  let repositoryRows: readonly CatalogRepositoryRow[] | null = null;
  let settings: SettingsSnapshot | null = null;
  let sources = deps.sources;
  const refresh = latestReads(
    // Settings first: what is read after them is never older than their
    // generation, so a claim that trusts it fails nothing it has not seen.
    async () => {
      const read = (await deps.settings?.read()) ?? null;
      return Promise.all([
        deps.workspaces.listAll(),
        deps.installations.listAll(),
        deps.repositories?.readCatalog() ?? Promise.resolve(null),
        read,
      ]);
    },
    ([workspaceRows, installationRows, rows, read]) => {
      settings = read === null ? null : keepUnchanged(read, settings);
      sources = withSettings(deps.sources, settings);
      snapshot = installationProfileSnapshot(sources, installationRows);
      records = new Map(workspaceRows.map((row) => [row.id, row]));
      // Kept when unchanged: the catalog's repositories object, which claim
      // caches key on, then stays the same object too.
      if (
        rows === null ||
        repositoryRows === null ||
        canonicalJson(rows) !== canonicalJson(repositoryRows)
      ) {
        repositoryRows = rows;
      }
    },
    deps.now ?? Date.now,
  );
  return {
    policy: deps.policy ?? WORKSPACE_PROFILE_POLICY,
    get records() {
      return records;
    },
    get profiles() {
      return snapshot.profiles;
    },
    get installation() {
      return snapshot.installation;
    },
    get repositoryRows() {
      return repositoryRows;
    },
    get settings() {
      return settings;
    },
    get connections() {
      return sources.connections;
    },
    refresh,
  };
}

/**
 * The catalog whose profiles are the registry's current snapshot. Read
 * `profiles` each time: a copy of the object keeps the snapshot it was
 * copied at.
 */
export function profileCatalog<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  base: {
    repositories: Record<string, R>;
    mcp_servers?: Record<string, CatalogMcpServer> | undefined;
    runtime_versions?: RuntimeVersions;
    tool_catalogs?: ToolCatalogs;
  },
  registry: ProfileRegistry<P>,
  /**
   * The repositories once the registry has read the console's rows or the
   * settings, from `base.repositories` and them (`withConsoleRepositories`).
   * Absent: `base.repositories` alone.
   */
  consoleRepositories?: (
    rows: readonly CatalogRepositoryRow[] | null,
    settings: SettingsSnapshot | null,
  ) => Record<string, R>,
): {
  readonly profiles: Record<string, P>;
  readonly repositories: Record<string, R>;
  readonly mcp_servers?: Record<string, CatalogMcpServer> | undefined;
  readonly installation: ReadonlyMap<string, InstallationProfileEntry>;
  /** The settings generation the catalog was read at; absent before. */
  readonly settings_generation?: number | undefined;
  /** Repository ids the settings hold that did not resolve here. */
  readonly unavailable_repositories?: ReadonlySet<string> | undefined;
  workspace_profiles: ProfileRegistry<P>;
  runtime_versions?: RuntimeVersions;
  tool_catalogs?: ToolCatalogs;
} {
  let mergedFrom: {
    rows: readonly CatalogRepositoryRow[] | null;
    settings: SettingsSnapshot["repositories"] | undefined;
  } | null = null;
  let merged = base.repositories;
  let serversFrom: SettingsSnapshot["mcp_servers"] | null = null;
  let servers = base.mcp_servers;
  return {
    get profiles() {
      return registry.profiles as Record<string, P>;
    },
    get installation() {
      return registry.installation;
    },
    get repositories() {
      const rows = registry.repositoryRows;
      const settings = registry.settings;
      if (
        consoleRepositories === undefined ||
        (rows === null && settings === null)
      ) {
        return base.repositories;
      }
      if (
        mergedFrom === null ||
        rows !== mergedFrom.rows ||
        settings?.repositories !== mergedFrom.settings
      ) {
        merged = consoleRepositories(rows, settings);
        mergedFrom = { rows, settings: settings?.repositories };
      }
      return merged;
    },
    get mcp_servers() {
      const settings = registry.settings;
      if (settings === null) return base.mcp_servers;
      if (settings.mcp_servers !== serversFrom) {
        servers = { ...settings.mcp_servers, ...base.mcp_servers };
        serversFrom = settings.mcp_servers;
      }
      return servers;
    },
    get settings_generation() {
      return registry.settings?.generation;
    },
    get unavailable_repositories() {
      return registry.settings?.unavailable_repositories;
    },
    ...(base.runtime_versions === undefined
      ? {}
      : { runtime_versions: base.runtime_versions }),
    ...(base.tool_catalogs === undefined
      ? {}
      : { tool_catalogs: base.tool_catalogs }),
    workspace_profiles: registry,
  };
}
