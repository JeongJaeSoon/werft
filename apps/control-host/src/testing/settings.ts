import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationSettingsStore,
  createPostgresSettingsDocumentStore,
  type Database,
} from "@werft-ai/db";
import {
  parseSettingsDocument,
  type SessionCatalog,
  type ToolCatalogs,
} from "@werft-ai/platform";
import { parse } from "yaml";
import { databaseCatalog } from "../api/catalog-config.ts";
import { installedToolCatalogView } from "../api/tool-catalogs.ts";

export function settingsDocument(...sections: readonly string[]) {
  return Object.assign(
    { version: 1, connections: {}, repositories: {}, mcp_servers: {} },
    ...sections.map((section) => parse(section)),
  );
}

export async function seedSettings(
  db: Database,
  document: unknown,
): Promise<void> {
  const result = await createPostgresSettingsDocumentStore(db).importEntries(
    parseSettingsDocument(document),
    { dryRun: false, allowExternal: true, actor: null },
  );
  if (result.outcome !== "applied") {
    throw new Error(`settings import ${result.outcome}`);
  }
}

/**
 * The catalog the API reads from the seeded settings, with this image's tool
 * catalogs so the agent service can release on it.
 */
export async function settingsCatalog(
  db: Database,
  env: Record<string, string | undefined> = {},
): Promise<SessionCatalog & { tool_catalogs: ToolCatalogs }> {
  const catalog = await databaseCatalog({
    repositories: createPostgresCatalogRepositoryStore(db),
    settings: createPostgresInstallationSettingsStore(db, null),
    credential: () => "api-side-only",
    env,
  });
  // Assigned, not spread: the catalog's fields are getters over its read.
  return Object.assign(catalog, { tool_catalogs: installedToolCatalogView });
}
