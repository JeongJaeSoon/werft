import { canonicalJson } from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import type {
  CatalogMcpServer,
  CatalogRepository,
  CatalogRepositoryView,
  RuntimeVersions,
  SessionCatalog,
} from "./catalog.ts";
import type { SettingsSnapshot } from "./installation-settings.ts";
import type { ToolCatalogs } from "./tool-names.ts";

/** How often a process reads the installation's settings again. */
export const CATALOG_REFRESH_MS = 10_000;

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

/** The installation's settings and the console's repositories as last read. */
export interface CatalogRegistry {
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
  /** Reads them again unless the last read began within `maxAgeMs`. */
  refresh(maxAgeMs?: number): Promise<void>;
}

/** The settings' repositories, then each console App repository they lack. */
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
      auth: { kind: "github_app", registered: true },
    };
  }
  return merged;
}

// Kept as the same objects while nothing in them changed: claim caches key
// on the catalog's connections and repositories objects.
function keepUnchanged(
  next: SettingsSnapshot,
  previous: SettingsSnapshot | null,
): SettingsSnapshot {
  if (previous === null) return next;
  const same = <T>(a: T, b: T) => canonicalJson(a) === canonicalJson(b);
  return {
    ...next,
    connections: same(next.connections, previous.connections)
      ? previous.connections
      : next.connections,
    repositories: same(next.repositories, previous.repositories)
      ? previous.repositories
      : next.repositories,
    mcp_servers: same(next.mcp_servers, previous.mcp_servers)
      ? previous.mcp_servers
      : next.mcp_servers,
  };
}

/** Holds nothing before its first read. */
export function createCatalogRegistry(deps: {
  repositories?: Pick<CatalogRepositoryStore, "readCatalog">;
  /**
   * The installation settings (connections, MCP servers, repositories that
   * carry their own credential), credentials resolved.
   */
  settings?: { read(): Promise<SettingsSnapshot> };
  now?: () => number;
}): CatalogRegistry {
  let repositoryRows: readonly CatalogRepositoryRow[] | null = null;
  let settings: SettingsSnapshot | null = null;
  const refresh = latestReads(
    // Settings first: what is read after them is never older than their
    // generation, so a claim that trusts it fails nothing it has not seen.
    async () => {
      const read = (await deps.settings?.read()) ?? null;
      const rows = (await deps.repositories?.readCatalog()) ?? null;
      return [read, rows] as const;
    },
    ([read, rows]) => {
      settings = read === null ? null : keepUnchanged(read, settings);
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
    get repositoryRows() {
      return repositoryRows;
    },
    get settings() {
      return settings;
    },
    refresh,
  };
}

/**
 * The catalog the registry's last read makes. Read its fields each time: a
 * copy of the object keeps the read it was copied at.
 */
export function registryCatalog<R extends CatalogRepositoryView>(
  base: {
    repositories: Record<string, R>;
    mcp_servers?: Record<string, CatalogMcpServer> | undefined;
    runtime_versions?: RuntimeVersions;
    tool_catalogs?: ToolCatalogs;
  },
  registry: CatalogRegistry,
  /**
   * The repositories once the registry has read the console's rows or the
   * settings, from `base.repositories` and them (`withConsoleRepositories`).
   * Absent: `base.repositories` alone.
   */
  consoleRepositories?: (
    rows: readonly CatalogRepositoryRow[] | null,
    settings: SettingsSnapshot | null,
  ) => Record<string, R>,
): Omit<SessionCatalog, "repositories" | "mcp_servers"> & {
  readonly repositories: Record<string, R>;
  readonly mcp_servers?: Record<string, CatalogMcpServer> | undefined;
  tool_catalogs?: ToolCatalogs;
  refresh(maxAgeMs?: number): Promise<void>;
} {
  let mergedFrom: {
    rows: readonly CatalogRepositoryRow[] | null;
    settings: SettingsSnapshot["repositories"] | undefined;
  } | null = null;
  let merged = base.repositories;
  let serversFrom: SettingsSnapshot["mcp_servers"] | null = null;
  let servers = base.mcp_servers;
  const noConnections: SessionCatalog["connections"] = {};
  return {
    get connections() {
      return (registry.settings?.connections ??
        noConnections) as SessionCatalog["connections"];
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
    get unavailable_connections() {
      return registry.settings?.unavailable_connections;
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
    refresh: (maxAgeMs) => registry.refresh(maxAgeMs),
  };
}
