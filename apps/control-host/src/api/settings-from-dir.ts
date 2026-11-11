import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CatalogProviderConfig,
  catalogConnectionsSchema,
  describeConfigError,
  type SessionCatalogConfig,
  sessionCatalogConfigSchema,
} from "@werft-ai/platform";
import { parse as parseYaml } from "yaml";

export const PROFILES_FILE = "profiles.yaml";
export const REPOSITORIES_FILE = "repositories.yaml";
export const CONNECTIONS_FILE = "connections.yaml";
export const PLATFORM_FILE = "platform.yaml";
const MCP_SERVERS_FILE = "mcp-servers.yaml";

async function readYaml(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} is missing`);
  }
  try {
    // Not Bun.YAML: it keeps the last of two equal keys, so an entry
    // defined twice would silently lose its first, reviewed definition.
    return parseYaml(await file.text(), { uniqueKeys: true });
  } catch (error) {
    throw new Error(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function section(document: unknown, key: string, path: string): unknown {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    !Object.hasOwn(document, key)
  ) {
    throw new Error(`${path} must hold exactly one top-level key: ${key}`);
  }
  return (document as Record<string, unknown>)[key];
}

/**
 * Repositories from before `auth` was required reach no GitHub App: no
 * `auth`, or a `basic` or `bearer` one. Such an entry is left out and named
 * in `notes`, so one old repository does not stop the whole import. Anything
 * else invalid still fails the schema.
 */
export function withoutLegacyRepositories(
  repositories: unknown,
  notes: string[],
  /** The ids left out, for the caller that checks sessions still on them. */
  skipped: string[] = [],
): unknown {
  if (
    repositories === null ||
    typeof repositories !== "object" ||
    Array.isArray(repositories)
  ) {
    return repositories;
  }
  const kept: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(repositories)) {
    const auth =
      entry !== null && typeof entry === "object"
        ? (entry as { auth?: unknown }).auth
        : null;
    const kind =
      auth !== null && typeof auth === "object"
        ? (auth as { kind?: unknown }).kind
        : undefined;
    const legacy =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (auth === undefined || kind === "basic" || kind === "bearer");
    if (legacy) {
      skipped.push(id);
      notes.push(
        `repository ${id} is not imported: it names no GitHub App (auth.kind github_app); add it again in the console`,
      );
    } else if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.hasOwn(entry, "profiles")
    ) {
      // A repository named the profiles it allowed; profiles are gone, so
      // the list says nothing any more.
      const { profiles: _profiles, ...rest } = entry as Record<string, unknown>;
      kept[id] = rest;
    } else {
      kept[id] = entry;
    }
  }
  return kept;
}

export async function readCatalogConfig(
  dir: string,
  notes: string[] = [],
  skipped: string[] = [],
): Promise<SessionCatalogConfig> {
  const repositoriesPath = resolve(dir, REPOSITORIES_FILE);
  const mcpServersPath = resolve(dir, MCP_SERVERS_FILE);
  const parsed = sessionCatalogConfigSchema.safeParse({
    repositories: withoutLegacyRepositories(
      section(
        await readYaml(repositoriesPath),
        "repositories",
        repositoriesPath,
      ),
      notes,
      skipped,
    ),
    ...((await Bun.file(mcpServersPath).exists())
      ? {
          mcp_servers: section(
            await readYaml(mcpServersPath),
            "mcp_servers",
            mcpServersPath,
          ),
        }
      : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog config in ${dir} is invalid: ${describeConfigError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function readConnections(
  dir: string,
): Promise<Record<string, CatalogProviderConfig>> {
  const path = resolve(dir, CONNECTIONS_FILE);
  const parsed = catalogConnectionsSchema.safeParse(
    section(await readYaml(path), "connections", path),
  );
  if (!parsed.success) {
    throw new Error(`${path} is invalid: ${describeConfigError(parsed.error)}`);
  }
  return parsed.data;
}

/** Kubernetes keeps its volume bookkeeping in dot entries. */
export async function dirIsEmpty(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return names.every((name) => name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
