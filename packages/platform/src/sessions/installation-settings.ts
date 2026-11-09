import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import {
  type CatalogMcpServer,
  type CatalogProfileConfig,
  type CatalogRepository,
  type ConnectionAutoMode,
  type CredentialRef,
  catalogCredentialRefs,
  credentialRefOf,
  describeConfigError,
  GITHUB_API_BASE,
  resolveCredential,
  resolveSessionCatalog,
} from "./catalog.ts";

type Provider = CatalogProfileConfig["provider"];

/**
 * What the registry runs from one read of the installation's settings
 * (settings-replace-file-catalog.md §1), credentials resolved.
 */
export type SettingsSnapshot = {
  generation: number;
  /** The connections whose credential resolves. */
  connections: Readonly<Record<string, Provider>>;
  /**
   * For a connection the console moved from a deployment reference to a
   * stored value: the provider it was. A ceiling made before the move holds
   * that provider and still belongs to the connection.
   */
  connection_aliases: Readonly<Record<string, Provider>>;
  /** Whether the classifier works over each connection; beside, never in, the provider. */
  connection_auto_modes: Readonly<Record<string, ConnectionAutoMode>>;
  repositories: Readonly<Record<string, CatalogRepository>>;
  mcp_servers: Readonly<Record<string, CatalogMcpServer>>;
  /** What a ceiling over one of these connections resolves through. */
  lookup: (ref: CredentialRef) => string | undefined;
  /** Rows this read leaves out, each with why; never a value. */
  left_out: ReadonlyArray<{ entry: string; reason: string }>;
  /**
   * Repository ids a row holds that this read could not resolve: another
   * replica may resolve them, so a session on one is not failed here.
   */
  unavailable_repositories: ReadonlySet<string>;
};

function invalidRepositoryIds(settings: InstallationSettings): Set<string> {
  return new Set(
    settings.invalid
      .filter((entry) => entry.startsWith("repository:"))
      .map((entry) => entry.slice("repository:".length)),
  );
}

/** Every external reference the settings name, for fetching before they resolve. */
export function settingsCredentialRefs(
  settings: InstallationSettings,
): CredentialRef[] {
  return catalogCredentialRefs(
    {
      profiles: {},
      repositories: Object.fromEntries(
        settings.repositories.map(({ id, repository }) => [id, repository]),
      ),
      mcp_servers: Object.fromEntries(
        settings.mcpServers.map(({ id, server }) => [id, server]),
      ),
    },
    Object.fromEntries(
      settings.connections.map(({ id, provider }) => [id, provider]),
    ),
  ).map(({ ref }) => ref);
}

/**
 * The settings with each credential resolved: a `stored` one from the
 * values the read opened, any other through `external`. A row whose
 * credential does not resolve is left out on its own, so one missing value
 * never stops the rest.
 */
export function settingsSnapshot(
  settings: InstallationSettings,
  external: (ref: CredentialRef) => string | undefined,
): SettingsSnapshot {
  const lookup = (ref: CredentialRef) =>
    "stored" in ref ? settings.stored.get(ref.stored) : external(ref);
  const left_out = settings.invalid.map((entry) => ({
    entry,
    reason: "does not parse",
  }));
  const unavailable = invalidRepositoryIds(settings);
  const connections: Record<string, Provider> = {};
  const connection_aliases: Record<string, Provider> = {};
  const connection_auto_modes: Record<string, ConnectionAutoMode> = {};
  for (const { id, provider, replaces, auto_mode } of settings.connections) {
    const { kind: _kind, ...fields } = provider.auth;
    try {
      resolveCredential(
        `connections.${id}.auth`,
        credentialRefOf(fields),
        lookup,
      );
      connections[id] = provider;
      connection_auto_modes[id] = auto_mode ?? "unknown";
      if (replaces) connection_aliases[id] = replaces;
    } catch (error) {
      left_out.push({
        entry: `connection:${id}`,
        reason: describeConfigError(error),
      });
    }
  }
  const repositories: Record<string, CatalogRepository> = {};
  for (const { id, repository } of settings.repositories) {
    try {
      const resolved = resolveSessionCatalog(
        { profiles: {}, repositories: { [id]: repository } },
        lookup,
      ).repositories[id];
      if (resolved) repositories[id] = resolved;
    } catch (error) {
      unavailable.add(id);
      left_out.push({
        entry: `repository:${id}`,
        reason: describeConfigError(error),
      });
    }
  }
  const mcp_servers: Record<string, CatalogMcpServer> = {};
  for (const { id, server } of settings.mcpServers) {
    try {
      const resolved = resolveSessionCatalog(
        { profiles: {}, repositories: {}, mcp_servers: { [id]: server } },
        lookup,
      ).mcp_servers?.[id];
      if (resolved) mcp_servers[id] = resolved;
    } catch (error) {
      left_out.push({ entry: `mcp:${id}`, reason: describeConfigError(error) });
    }
  }
  return {
    generation: settings.generation,
    connections,
    connection_aliases,
    connection_auto_modes,
    repositories,
    mcp_servers,
    lookup,
    left_out,
    unavailable_repositories: unavailable,
  };
}

/**
 * The settings with `credential` standing in for every value, nothing
 * checked: for a process that holds no credential and only checks what a
 * release or claim would name. References and every other field are the
 * rows', so bindings come out as the api's.
 */
export function settingsView(
  settings: InstallationSettings,
  credential: () => string,
): SettingsSnapshot {
  const repositories: Record<string, CatalogRepository> = {};
  for (const { id, repository } of settings.repositories) {
    const { auth, ...rest } = repository;
    const ref = credentialRefOf(auth);
    const value = credential();
    repositories[id] = {
      ...rest,
      auth: {
        kind: "github_app",
        app_id: auth.app_id as number,
        installation_id: auth.installation_id as number,
        api_base: auth.api_base ?? GITHUB_API_BASE,
        value,
        ref,
      },
    };
  }
  return {
    generation: settings.generation,
    connections: Object.fromEntries(
      settings.connections.map(({ id, provider }) => [id, provider]),
    ),
    connection_aliases: Object.fromEntries(
      settings.connections.flatMap(({ id, replaces }) =>
        replaces ? [[id, replaces]] : [],
      ),
    ),
    connection_auto_modes: Object.fromEntries(
      settings.connections.map(({ id, auto_mode }) => [
        id,
        auto_mode ?? "unknown",
      ]),
    ),
    repositories,
    mcp_servers: Object.fromEntries(
      settings.mcpServers.map(({ id, server }) => [
        id,
        {
          ...server,
          auth: {
            kind: "bearer" as const,
            value: credential(),
            ref: credentialRefOf(server.auth),
          },
        },
      ]),
    ),
    lookup: credential,
    left_out: settings.invalid.map((entry) => ({
      entry,
      reason: "does not parse",
    })),
    unavailable_repositories: invalidRepositoryIds(settings),
  };
}
