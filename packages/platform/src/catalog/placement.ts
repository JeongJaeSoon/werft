import {
  type CatalogConnectionView,
  connectionModels,
  modelMoves,
  type RuntimeAtVersion,
  type RuntimeVersions,
  runtimeListed,
} from "./catalog.ts";

/**
 * What this host can run: the connections it holds with the models each
 * offers, the repositories it holds as they are registered now, and the
 * runtime kinds at the versions its images ship (null: any). A session binds only when
 * its spec's connection runs its model here, its runtime ships, and its
 * repository row matches one exactly, so a repository id re-pointed at
 * another URL does not carry the old grant to the new one.
 */
export type ClaimCatalog = {
  connections: ReadonlyArray<{ id: string; models: readonly string[] }>;
  repositories: ReadonlyArray<{
    repositoryId: string;
    url: string;
    branch: string;
  }>;
  /** `engine`: the engine of the image that ships the pair. */
  runtimeVersions: ReadonlyArray<{
    kind: string;
    version: string;
    engine?: string;
  }> | null;
};

/** A session on `from` over the connection moves to `to` at its claim. */
export type ModelMove = {
  connectionId: string;
  from: string;
  to: string;
};

type CatalogSource = {
  connections: Readonly<Record<string, CatalogConnectionView>>;
  repositories: Readonly<Record<string, { url: string; branch: string }>>;
  runtime_versions?: RuntimeVersions | undefined;
};

type Projected = { runnable: ClaimCatalog; modelMoves: ModelMove[] };

// A settings reload replaces the catalog's fields, never edits them, so a
// projection holds while the three fields it read are the same objects.
const projections = new WeakMap<
  CatalogSource,
  { of: readonly unknown[]; projected: Projected }
>();

/** This host's catalog as a claim reads it, with the moves its series offer. */
export function claimCatalogOf(catalog: CatalogSource): Projected {
  const of = [
    catalog.connections,
    catalog.repositories,
    catalog.runtime_versions,
  ];
  const held = projections.get(catalog);
  if (held?.of.every((field, i) => field === of[i])) return held.projected;
  const projected = project(catalog);
  projections.set(catalog, { of, projected });
  return projected;
}

function project(catalog: CatalogSource): Projected {
  const connections = Object.entries(catalog.connections);
  return {
    runnable: {
      connections: connections.map(([id, connection]) => ({
        id,
        models: connectionModels(connection),
      })),
      repositories: Object.entries(catalog.repositories).map(
        ([repositoryId, repository]) => ({
          repositoryId,
          url: repository.url,
          branch: repository.branch,
        }),
      ),
      runtimeVersions: catalog.runtime_versions?.accepted ?? null,
    },
    modelMoves: connections.flatMap(([id, connection]) =>
      modelMoves(connection).map(({ from, to }) => ({
        connectionId: id,
        from,
        to,
      })),
    ),
  };
}

/**
 * The pairs a worker of `engine` runs: the one it reports, else the one its
 * launch was reserved for. With neither, every pair, as on a host of one
 * engine.
 */
export function runnableOfEngine(
  runnable: ClaimCatalog,
  engine: string | null | undefined,
): ClaimCatalog {
  if (typeof engine !== "string" || runnable.runtimeVersions === null) {
    return runnable;
  }
  return {
    ...runnable,
    runtimeVersions: runnable.runtimeVersions.filter(
      (pair) => pair.engine === engine,
    ),
  };
}

/** What a session needs from a host, as it was created. */
export type SessionPlacement = {
  connectionId: string | null;
  model: string | null;
  runtime: RuntimeAtVersion | null;
  /** Null for a session with no repository. */
  repository: {
    id: string | null;
    url: string | null;
    branch: string | null;
  } | null;
};

export type PlacementRefusal =
  | "connection_missing"
  | "model_removed"
  | "runtime_unshipped"
  | "repository_moved";

export function runtimeShipped(
  runnable: Pick<ClaimCatalog, "runtimeVersions">,
  runtime: RuntimeAtVersion,
): boolean {
  return (
    runnable.runtimeVersions === null ||
    runtimeListed(runnable.runtimeVersions, runtime)
  );
}

/**
 * Why this host does not run the session, or null when it does. A model
 * that left its connection's list still runs when the session follows a
 * move off it (`followed`). db's `runnableCondition` is its SQL form, held
 * to it by a test.
 */
export function placementRefusal(
  session: SessionPlacement,
  runnable: ClaimCatalog,
  followed: readonly ModelMove[] = [],
): PlacementRefusal | null {
  const connection = runnable.connections.find(
    (candidate) => candidate.id === session.connectionId,
  );
  if (connection === undefined) return "connection_missing";
  const { model, runtime, repository } = session;
  if (
    model === null ||
    (!connection.models.includes(model) &&
      !followed.some(
        (move) => move.connectionId === connection.id && move.from === model,
      ))
  ) {
    return "model_removed";
  }
  if (runtime === null || !runtimeShipped(runnable, runtime)) {
    return "runtime_unshipped";
  }
  if (
    repository !== null &&
    !runnable.repositories.some(
      (held) =>
        held.repositoryId === repository.id &&
        held.url === repository.url &&
        held.branch === repository.branch,
    )
  ) {
    return "repository_moved";
  }
  return null;
}
