// The API role's GitHub forge adapters, one builder per adapter: the role
// builds each where its first consumer is, so creation order stays as it was
// and every adapter is created exactly once.
import type { StructuredLogger } from "@werft-ai/observability";
import {
  connectionsOf,
  createAppBotUsers,
  createGitHubAppDirectory,
  createGitHubManifestConverter,
  createGitPusher,
  createRegisteredGitHubConnections,
} from "./forge-github.ts";

export interface GitHubRegistryDeps {
  /** The registered GitHub App store; null when no master key is set. */
  appStore: Parameters<typeof createRegisteredGitHubConnections>[0]["store"];
  logger: StructuredLogger;
}

export type GitHubRegistry = ReturnType<
  typeof createRegisteredGitHubConnections
>;

export function wireGitHubRegistry(deps: GitHubRegistryDeps): GitHubRegistry {
  return createRegisteredGitHubConnections({
    store: deps.appStore,
    logger: deps.logger,
  });
}

export type GitHubAppDirectory = ReturnType<typeof createGitHubAppDirectory>;

export function wireGitHubAppDirectory(deps: {
  logger: StructuredLogger;
}): GitHubAppDirectory {
  return createGitHubAppDirectory({ logger: deps.logger });
}

export type GitHubManifestConverter = ReturnType<
  typeof createGitHubManifestConverter
>;

export function wireGitHubManifestConverter(deps: {
  logger: StructuredLogger;
}): GitHubManifestConverter {
  return createGitHubManifestConverter({ logger: deps.logger });
}

export interface GitHubConnectionsDeps {
  /** The catalog the per-repository connections read on every call. */
  catalog: Parameters<typeof connectionsOf>[0];
  registry: GitHubRegistry;
  logger: StructuredLogger;
}

/** One connection per repository, so one token cache. */
export type GitHubConnections = ReturnType<typeof connectionsOf>;

export function wireGitHubConnections(
  deps: GitHubConnectionsDeps,
): GitHubConnections {
  return connectionsOf(deps.catalog, {
    logger: deps.logger,
    registered: (role) => deps.registry.connections(role),
  });
}

export type GitPusher = ReturnType<typeof createGitPusher>;

export function wireGitPusher(deps: { maxGitMemoryBytes: number }): GitPusher {
  return createGitPusher({ maxGitMemoryBytes: deps.maxGitMemoryBytes });
}

export type AppBotUsers = ReturnType<typeof createAppBotUsers>;

export function wireAppBotUsers(deps: {
  logger: StructuredLogger;
}): AppBotUsers {
  return createAppBotUsers({ logger: deps.logger });
}
