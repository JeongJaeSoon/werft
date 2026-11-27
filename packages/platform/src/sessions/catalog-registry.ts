import { canonicalJson } from "@werft-ai/contracts";
import type {
  CatalogMcpServer,
  CatalogRepository,
  CatalogRepositoryView,
  RuntimeVersions,
  SessionCatalog,
  ToolCatalogs,
} from "../catalog/index.ts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import type { SettingsSnapshot } from "./installation-settings.ts";

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
  /**
   * Resolves once `settings` is at least the generation stored now, reading
   * them again first if not. A failed read rejects with its own error: what
   * was read before is never taken for current. Resolves at once for a
   * registry given no generation.
   */
  caughtUp(): Promise<void>;
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
  /** `settings_generation` as stored now. */
  generation?: { read(): Promise<number> };
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
  // Those catching up share one read at a time. Only a read begun after a
  // caller saw the generation is sure to hold it: one begun before may have
  // opened its snapshot before that generation committed.
  let catchUp: { order: number; done: Promise<void> } | null = null;
  let catchUps = 0;
  const readAgain = () => {
    if (catchUp !== null) return catchUp;
    catchUps += 1;
    const read = {
      order: catchUps,
      done: refresh().finally(() => {
        if (catchUp === read) catchUp = null;
      }),
    };
    catchUp = read;
    return read;
  };
  const behind = (generation: number) =>
    settings === null || settings.generation < generation;
  return {
    get repositoryRows() {
      return repositoryRows;
    },
    get settings() {
      return settings;
    },
    refresh,
    async caughtUp() {
      if (deps.generation === undefined) return;
      const generation = await deps.generation.read();
      const seenAfter = catchUps;
      while (behind(generation)) {
        const read = readAgain();
        await read.done;
        if (read.order > seenAfter) break;
      }
      if (behind(generation)) {
        throw new Error(
          "The installation settings read is older than their generation",
        );
      }
    },
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
  const noServers: Record<string, CatalogMcpServer> = {};
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
    // The installation catalog MCP is retired: neither the settings nor
    // `base.mcp_servers` gives a server.
    get mcp_servers() {
      return noServers;
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
