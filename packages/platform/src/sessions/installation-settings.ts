import {
  type CatalogConnection,
  type CatalogMcpServer,
  type CatalogRepository,
  type CredentialRef,
  credentialRefOf,
  describeConfigError,
  GITHUB_API_BASE,
  type JudgeProvider,
  resolveProvider,
  resolveSessionCatalog,
} from "../catalog/index.ts";
import type { InstallationSettings } from "./ports/installation-settings-store.ts";

/**
 * What the registry runs from one read of the installation's settings,
 * credentials resolved.
 */
export type SettingsSnapshot = {
  generation: number;
  /** The connections whose credential resolves, credential included. */
  connections: Readonly<Record<string, CatalogConnection>>;
  /**
   * The `openai_decisions` connections whose credential resolves: the
   * achievement judge's, never in `connections`, so no agent runs on one.
   */
  judge_connections: Readonly<Record<string, JudgeProvider>>;
  repositories: Readonly<Record<string, CatalogRepository>>;
  mcp_servers: Readonly<Record<string, CatalogMcpServer>>;
  /** Rows this read leaves out, each with why; never a value. */
  left_out: ReadonlyArray<{ entry: string; reason: string }>;
  /**
   * Repository ids a row holds that this read could not resolve: another
   * replica may resolve them, so a session on one is not failed here.
   */
  unavailable_repositories: ReadonlySet<string>;
  /** Connection ids a row holds that this read could not resolve. */
  unavailable_connections: ReadonlySet<string>;
};

function invalidIds(
  settings: InstallationSettings,
  kind: "repository" | "connection",
): Set<string> {
  return new Set(
    settings.invalid
      .filter((entry) => entry.startsWith(`${kind}:`))
      .map((entry) => entry.slice(kind.length + 1)),
  );
}

/**
 * The settings with each credential resolved from the stored values the
 * read opened. A row whose credential does not resolve is left out on its
 * own, so one missing value never stops the rest.
 */
export function settingsSnapshot(
  settings: InstallationSettings,
): SettingsSnapshot {
  const lookup = (ref: CredentialRef) => settings.stored.get(ref.stored);
  const left_out = settings.invalid.map((entry) => ({
    entry,
    reason: "does not parse",
  }));
  const unavailable = invalidIds(settings, "repository");
  const unavailableConnections = invalidIds(settings, "connection");
  const connections: Record<string, CatalogConnection> = {};
  const judge_connections: Record<string, JudgeProvider> = {};
  for (const {
    id,
    provider,
    models,
    model_families,
    network,
  } of settings.connections) {
    try {
      const resolved = resolveProvider(id, provider, lookup);
      if (resolved.kind === "openai_decisions") {
        judge_connections[id] = {
          ...resolved,
          ...(network === undefined ? {} : { network }),
        };
        continue;
      }
      connections[id] = {
        provider: resolved,
        models: models ?? [],
        ...(model_families === undefined ? {} : { model_families }),
        ...(network === undefined ? {} : { network }),
      };
    } catch (error) {
      unavailableConnections.add(id);
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
        { repositories: { [id]: repository } },
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
  return {
    generation: settings.generation,
    connections,
    judge_connections,
    repositories,
    // The installation catalog MCP is retired: no host reads one.
    mcp_servers: {},
    left_out,
    unavailable_repositories: unavailable,
    unavailable_connections: unavailableConnections,
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
    // Such a process never judges; a judge connection is no agent's.
    connections: Object.fromEntries(
      settings.connections.flatMap(
        ({ id, provider, models, model_families }) => {
          if (provider.kind === "openai_decisions") return [];
          const { kind: authKind, ...fields } = provider.auth;
          const { billing, ...rest } = provider;
          const entry: [string, CatalogConnection] = [
            id,
            {
              provider: {
                ...rest,
                ...(billing === "none" ? { billing } : {}),
                auth: {
                  kind: authKind,
                  value: credential(),
                  ref: credentialRefOf(fields),
                },
              } as CatalogConnection["provider"],
              models: models ?? [],
              ...(model_families === undefined ? {} : { model_families }),
            },
          ];
          return [entry];
        },
      ),
    ),
    judge_connections: {},
    repositories,
    mcp_servers: {},
    left_out: settings.invalid.map((entry) => ({
      entry,
      reason: "does not parse",
    })),
    unavailable_repositories: invalidIds(settings, "repository"),
    unavailable_connections: invalidIds(settings, "connection"),
  };
}
