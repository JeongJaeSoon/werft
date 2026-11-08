import {
  type CatalogProfileView,
  catalogProfile,
  type ProfileLookup,
} from "./catalog.ts";
import { type Connections, connectionMatcher } from "./profile-registry.ts";

export type ConnectionImpact = {
  /**
   * Every profile id that stops running when the connection goes: the
   * installation's versions, past ones included (a release may still sit on
   * one), and the workspace versions over them that run now.
   */
  profile_ids: string[];
  /** Installation versions still current (not retired), what a person counts. */
  current_profile_count: number;
};

function without(connections: Connections, id: string): Connections {
  return Object.fromEntries(
    Object.entries(connections).filter(([key]) => key !== id),
  );
}

/**
 * The profiles left with no connection once `connectionId` is disabled. A
 * profile is counted when it runs now and the same match, made over the
 * connections without this one, finds none: a second connection holding the
 * same provider keeps it running, a moved connection's former provider goes
 * with it. The whole installation is read, whatever workspace made a version.
 */
export function connectionImpact(
  catalog: ProfileLookup<CatalogProfileView>,
  settings: { connections: Connections; connection_aliases: Connections },
  connectionId: string,
): ConnectionImpact {
  const now = connectionMatcher(settings);
  const left = connectionMatcher({
    connections: without(settings.connections, connectionId),
    connection_aliases: without(settings.connection_aliases, connectionId),
  });
  const ids = new Set<string>();
  let current = 0;
  for (const entry of catalog.installation?.values() ?? []) {
    if (entry.state !== "usable" && entry.state !== "retired") continue;
    if (entry.definition === undefined) continue;
    const { provider } = entry.definition;
    if (now.connectionOf(provider) === null) continue;
    if (left.connectionOf(provider) !== null) continue;
    ids.add(entry.id);
    if (entry.state === "usable") current += 1;
  }
  // A workspace version follows its base, and only while it still resolves.
  for (const record of catalog.workspace_profiles?.records.values() ?? []) {
    if (!ids.has(record.base_profile_id)) continue;
    if (catalogProfile(catalog, record.id) !== undefined) ids.add(record.id);
  }
  return { profile_ids: [...ids].sort(), current_profile_count: current };
}
