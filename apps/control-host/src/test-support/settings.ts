import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationSettingsStore,
  createPostgresSettingsDocumentStore,
  type Database,
} from "@werft-ai/db";
import { parseSettingsDocument, type SessionCatalog } from "@werft-ai/platform";
import { parse } from "yaml";
import { databaseCatalog } from "../api/catalog-config.ts";

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

export function settingsCatalog(
  db: Database,
  env: Record<string, string | undefined> = {},
): Promise<SessionCatalog> {
  return databaseCatalog({
    repositories: createPostgresCatalogRepositoryStore(db),
    settings: createPostgresInstallationSettingsStore(db, null),
    credential: () => "api-side-only",
    env,
  });
}
