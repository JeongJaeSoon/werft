// The API role's GitHub forge adapters. The factories are lazy (no I/O at
// construction), so building them together is the same as building them where
// each is first used; every adapter is still created exactly once.
import type { StructuredLogger } from "@werft-ai/observability";
import {
  connectionsOf,
  createAppBotUsers,
  createGitHubAppDirectory,
  createGitHubManifestConverter,
  createGitPusher,
  createRegisteredGitHubConnections,
} from "./forge-github.ts";

type Param<F extends (...args: never[]) => unknown> = Parameters<F>[0];

export interface GitHubApiWiringDeps {
  /** The registered GitHub App store; null when no master key is set. */
  appStore: Param<typeof createRegisteredGitHubConnections>["store"];
  /** The catalog the per-repository connections read on every call. */
  catalog: Parameters<typeof connectionsOf>[0];
  logger: StructuredLogger;
  maxGitMemoryBytes: number;
}

export interface GitHubApiWiring {
  registered: ReturnType<typeof createRegisteredGitHubConnections>;
  directory: ReturnType<typeof createGitHubAppDirectory>;
  manifestConverter: ReturnType<typeof createGitHubManifestConverter>;
  /** One connection per repository, so one token cache. */
  connections: ReturnType<typeof connectionsOf>;
  pusher: ReturnType<typeof createGitPusher>;
  appBotUsers: ReturnType<typeof createAppBotUsers>;
}

export function wireGitHubApi(deps: GitHubApiWiringDeps): GitHubApiWiring {
  const { logger } = deps;
  const registered = createRegisteredGitHubConnections({
    store: deps.appStore,
    logger,
  });
  return {
    registered,
    directory: createGitHubAppDirectory({ logger }),
    manifestConverter: createGitHubManifestConverter({ logger }),
    connections: connectionsOf(deps.catalog, {
      logger,
      registered: (role) => registered.connections(role),
    }),
    pusher: createGitPusher({ maxGitMemoryBytes: deps.maxGitMemoryBytes }),
    appBotUsers: createAppBotUsers({ logger }),
  };
}
