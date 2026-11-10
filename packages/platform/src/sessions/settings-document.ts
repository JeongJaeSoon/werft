import { createHash } from "node:crypto";
import { canonicalJsonOfJson } from "@werft-ai/contracts";
import { z } from "zod";
import { repoRefOf } from "../action/ports/forge.ts";
import {
  BILLING_NONE_ENDPOINT_MESSAGE,
  billingFitsEndpoint,
  type CatalogMcpServerConfig,
  type CatalogProfileConfig,
  type CatalogRepositoryConfig,
  CONNECTION_ENDPOINT_DEFAULTS,
  catalogConnectionsSchema,
  describeConfigError,
  isRegisteredGitHubApp,
  type SessionCatalogConfig,
  type StoredOwnerKind,
  safeParseCatalogConfig,
  sessionCatalogConfigSchema,
} from "./catalog.ts";

/**
 * The installation's settings as one document without a secret value
 * (settings-replace-file-catalog.md §6): connections, repositories and
 * remote MCP servers, each entry in the shape its file gave it. A value the
 * database stores is marked `stored: true` (with its `last4` on export)
 * and is never named: an imported `stored` entry always means its own row,
 * so a document cannot point one row at another's value.
 */
export const SETTINGS_DOCUMENT_VERSION = 1;

export type SettingsKind = StoredOwnerKind;

type Provider = CatalogProfileConfig["provider"];

/** The entries as rows hold them: `stored` is `<kind>:<id>`. */
export type SettingsEntries = {
  connections: Record<string, Provider>;
  repositories: Record<string, CatalogRepositoryConfig>;
  mcp_servers: Record<string, CatalogMcpServerConfig>;
};

export type SettingsDocument = {
  version: typeof SETTINGS_DOCUMENT_VERSION;
  connections: Record<string, unknown>;
  repositories: Record<string, unknown>;
  mcp_servers: Record<string, unknown>;
};

export class SettingsDocumentError extends Error {
  override name = "SettingsDocumentError";
}

const documentShape = z
  .object({
    version: z.literal(SETTINGS_DOCUMENT_VERSION),
    connections: z.record(z.string().min(1), z.unknown()).default({}),
    repositories: z.record(z.string().min(1), z.unknown()).default({}),
    mcp_servers: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .strict();

const storedMark = z
  .object({ stored: z.literal(true), last4: z.string().optional() })
  .passthrough();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The entry with its document `stored: true` turned into its own row's
 * reference. A `stored` that is not `true` is refused here, before the
 * catalog schema would take a string naming another row.
 */
function ownStored(
  kind: SettingsKind,
  id: string,
  entry: unknown,
  path: string,
): unknown {
  if (!isObject(entry) || !isObject(entry.auth)) return entry;
  if (!Object.hasOwn(entry.auth, "stored")) return entry;
  if (!storedMark.safeParse(entry.auth).success) {
    throw new SettingsDocumentError(
      `${path}.auth.stored must be true: a stored value always belongs to its own entry`,
    );
  }
  const { last4: _last4, ...auth } = entry.auth;
  return { ...entry, auth: { ...auth, stored: `${kind}:${id}` } };
}

function ownedAll(
  kind: SettingsKind,
  section: string,
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      ownStored(kind, id, entry, `${section}.${id}`),
    ]),
  );
}

/**
 * The entry with an empty endpoint given its kind's default, or left out
 * for the catalog schema to refuse when the kind has none. An endpoint the
 * entry names stays as it is, so an export reads back unchanged.
 */
function endpointOrDefault(id: string, entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const { endpoint: named, ...rest } = entry;
  const empty =
    named === undefined || (typeof named === "string" && named.trim() === "");
  if (!empty) return entry;
  const endpoint =
    typeof entry.kind === "string" &&
    Object.hasOwn(CONNECTION_ENDPOINT_DEFAULTS, entry.kind)
      ? CONNECTION_ENDPOINT_DEFAULTS[
          entry.kind as keyof typeof CONNECTION_ENDPOINT_DEFAULTS
        ]
      : undefined;
  if (endpoint === undefined) {
    // The schema would only say "expected string, received undefined".
    if (entry.kind === "litellm") {
      throw new SettingsDocumentError(
        `The settings document is invalid: connections.${id}.endpoint: a litellm connection needs an endpoint, it has no default address`,
      );
    }
    return rest;
  }
  if (!billingFitsEndpoint({ billing: entry.billing, endpoint })) {
    throw new SettingsDocumentError(
      `The settings document is invalid: connections.${id}.billing: ${BILLING_NONE_ENDPOINT_MESSAGE}`,
    );
  }
  return { ...rest, endpoint };
}

function resolvedConnections(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      endpointOrDefault(id, entry),
    ]),
  );
}

/** A document under the file catalog's rules, entries as rows hold them. */
export function parseSettingsDocument(input: unknown): SettingsEntries {
  const shape = documentShape.safeParse(input);
  if (!shape.success) {
    throw new SettingsDocumentError(
      `The settings document is invalid: ${describeConfigError(shape.error)}`,
    );
  }
  const document = shape.data;
  const connections = catalogConnectionsSchema.safeParse(
    resolvedConnections(
      ownedAll("connection", "connections", document.connections),
    ),
  );
  if (!connections.success) {
    throw new SettingsDocumentError(
      `The settings document is invalid: connections.${describeConfigError(connections.error)}`,
    );
  }
  const catalog = sessionCatalogConfigSchema.safeParse({
    profiles: {},
    repositories: ownedAll("repository", "repositories", document.repositories),
    mcp_servers: ownedAll("mcp", "mcp_servers", document.mcp_servers),
  });
  if (!catalog.success) {
    throw new SettingsDocumentError(
      `The settings document is invalid: ${describeConfigError(catalog.error)}`,
    );
  }
  return {
    connections: connections.data,
    repositories: catalog.data.repositories,
    mcp_servers: catalog.data.mcp_servers ?? {},
  };
}

export type SeedDocument = {
  entries: SettingsEntries;
  profiles: SessionCatalogConfig["profiles"] | null;
};

/**
 * `tolerateNoRepositories`: the caller left out old repository entries, so
 * the ceilings may find none left. They then run on no repository until one
 * is registered.
 */
export function parseSeedDocument(
  input: unknown,
  tolerateNoRepositories = false,
): SeedDocument {
  if (!isObject(input) || !Object.hasOwn(input, "profiles")) {
    return { entries: parseSettingsDocument(input), profiles: null };
  }
  const { profiles, ...document } = input;
  const entries = parseSettingsDocument(document);
  const seed = safeParseCatalogConfig(
    { profiles, repositories: entries.repositories },
    tolerateNoRepositories,
  );
  if (!seed.success) {
    throw new SettingsDocumentError(
      `The settings document is invalid: ${describeConfigError(seed.error)}`,
    );
  }
  return { entries, profiles: seed.data.profiles };
}

function exported(
  entry: { auth?: unknown },
  last4: string | undefined,
): Record<string, unknown> {
  const { auth, ...rest } = entry as Record<string, unknown>;
  if (!isObject(auth) || typeof auth.stored !== "string") return { ...entry };
  return {
    ...rest,
    auth: {
      ...auth,
      stored: true,
      ...(last4 === undefined ? {} : { last4 }),
    },
  };
}

/**
 * The document for `entries`; `last4` gives a stored value's last four
 * characters by its reference, for the reader to tell values apart.
 */
export function settingsDocumentOf(
  entries: SettingsEntries,
  last4: ReadonlyMap<string, string> = new Map(),
): SettingsDocument {
  const section = <T extends { auth?: unknown }>(
    values: Record<string, T>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.keys(values)
        .sort()
        .map((id) => {
          const entry = values[id] as T;
          const auth = entry.auth as { stored?: unknown } | undefined;
          return [
            id,
            exported(
              entry,
              typeof auth?.stored === "string"
                ? last4.get(auth.stored)
                : undefined,
            ),
          ];
        }),
    );
  return {
    version: SETTINGS_DOCUMENT_VERSION,
    connections: section(entries.connections),
    repositories: section(entries.repositories),
    mcp_servers: section(entries.mcp_servers),
  };
}

/** What a reviewer compares two exports by. */
export function settingsDocumentDigest(document: SettingsDocument): string {
  return `sha256:${createHash("sha256").update(canonicalJsonOfJson(document)).digest("hex")}`;
}

/** Persisted discriminators also identify legacy rows without authenticating them. */
export type RepositoryAuthKind =
  | "github_app"
  | "none"
  | "basic"
  | "bearer"
  | "github_app_explicit";

export function repositoryAuthKindOf(repository: {
  auth?: { kind: string } | undefined;
}): RepositoryAuthKind {
  const { auth } = repository;
  if (auth === undefined) return "none";
  if (auth.kind === "basic" || auth.kind === "bearer") return auth.kind;
  return isRegisteredGitHubApp(auth) ? "github_app" : "github_app_explicit";
}

/**
 * Where an entry's credential comes from: null for none (a public
 * repository, the console's App), `stored` for the database's own value,
 * `external` for the deployment's env or Secrets Manager.
 */
export function credentialSourceOf(entry: {
  auth?: unknown;
}): "stored" | "external" | null {
  const auth = entry.auth;
  if (!isObject(auth)) return null;
  if (typeof auth.stored === "string") return "stored";
  if (auth.value_env !== undefined || auth.secret_id !== undefined) {
    return "external";
  }
  return null;
}

/**
 * A repository row's `owner`/`name`: a GitHub App row's is the GitHub
 * repository it is found by; any other row's is the URL's last two path
 * segments, or empty, and only labels it.
 */
export function repositoryNameOf(repository: CatalogRepositoryConfig): {
  owner: string;
  name: string;
} {
  if (repository.auth?.kind === "github_app") {
    return repoRefOf(repository.url) ?? { owner: "", name: "" };
  }
  const segments = new URL(repository.url).pathname
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  const [owner, name] = segments.slice(-2);
  return owner !== undefined && name !== undefined
    ? { owner, name }
    : { owner: "", name: "" };
}

export type ExistingSettingsEntry = {
  /** The row as an entry would be: compared with the document's. */
  entry: unknown;
  /** Disabled or removed rows count as taken: an id is never reused. */
  active: boolean;
  /** For a stored row: whether its value is set. */
  has_value: boolean;
  /**
   * For a connection the console moved to a stored value: the entry it was.
   * A document that still names that entry leaves the row as it is.
   */
  replaces?: unknown;
};

export type ExistingSettings = {
  connections: ReadonlyMap<string, ExistingSettingsEntry>;
  repositories: ReadonlyMap<string, ExistingSettingsEntry>;
  mcp_servers: ReadonlyMap<string, ExistingSettingsEntry>;
  /**
   * Stored values already sealed under a `<kind>:<id>`: a new row on that
   * id would take a value someone set for another destination.
   */
  stored_values: ReadonlySet<string>;
};

export type SettingsImportAdd =
  | { kind: "connection"; id: string; entry: Provider }
  | { kind: "repository"; id: string; entry: CatalogRepositoryConfig }
  | { kind: "mcp"; id: string; entry: CatalogMcpServerConfig };

export type SettingsImportPlan = {
  add: SettingsImportAdd[];
  /** `<kind>:<id>`, as for every list below. Active rows only. */
  unchanged: string[];
  /** Same content as a disabled or removed row, which stays so. */
  inactive: string[];
  /** Stored entries with no value yet: they run once the console sets one. */
  needs_value: string[];
  /**
   * Same id, other content; a GitHub repository another id already holds;
   * or a new stored entry whose id already has a value.
   */
  conflicts: string[];
  /** New external references, where the caller may not bring one. */
  refused_external: string[];
  /**
   * From an old catalog directory: repositories that differ from their row,
   * and second names of a GitHub repository that already has a row. The API
   * accepted both while the files stood still, so the row stays and neither
   * is a conflict.
   */
  kept?: string[];
};

const withoutSeed = (entry: unknown) => {
  if (!isObject(entry)) return entry;
  const { profiles: _seed, ...kept } = entry;
  return kept;
};

const sameEntry = (a: unknown, b: unknown) =>
  canonicalJsonOfJson(a) === canonicalJsonOfJson(b);

/**
 * What importing `incoming` over `existing` does. Nothing is written when
 * `conflicts` or `refused_external` is non-empty: the caller applies `add`
 * only when both are empty.
 */
export function planSettingsImport(
  incoming: SettingsEntries,
  existing: ExistingSettings,
  rules: { allowExternal: boolean; databaseOwnsRepositories?: boolean },
): SettingsImportPlan {
  const kept: string[] = [];
  const plan: SettingsImportPlan = {
    add: [],
    unchanged: [],
    inactive: [],
    needs_value: [],
    conflicts: [],
    refused_external: [],
  };
  const visit = (
    kind: SettingsImportAdd["kind"],
    entries: Record<string, { auth?: unknown }>,
    rows: ReadonlyMap<string, ExistingSettingsEntry>,
  ) => {
    for (const [id, entry] of Object.entries(entries).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const ref = `${kind}:${id}`;
      const source = credentialSourceOf(entry);
      const row = rows.get(id);
      if (row !== undefined) {
        const same =
          kind === "repository"
            ? sameEntry(withoutSeed(row.entry), withoutSeed(entry))
            : sameEntry(row.entry, entry);
        if (!same) {
          if (row.replaces !== undefined && sameEntry(row.replaces, entry)) {
            kept.push(ref);
            continue;
          }
          const ownedByDatabase =
            rules.databaseOwnsRepositories === true &&
            kind === "repository" &&
            repositoryAuthKindOf(entry as CatalogRepositoryConfig) ===
              repositoryAuthKindOf(row.entry as CatalogRepositoryConfig);
          (ownedByDatabase ? kept : plan.conflicts).push(ref);
          continue;
        }
        if (!row.active) {
          plan.inactive.push(ref);
          continue;
        }
        plan.unchanged.push(ref);
        if (source === "stored" && !row.has_value) plan.needs_value.push(ref);
        continue;
      }
      // A profile ceiling still reaches the row that moved off this definition;
      // a second connection holding it would make that match depend on which
      // rows are usable at the moment.
      if (
        kind === "connection" &&
        [...rows.values()].some(
          (other) =>
            other.replaces !== undefined && sameEntry(other.replaces, entry),
        )
      ) {
        plan.conflicts.push(ref);
        continue;
      }
      if (source === "external" && !rules.allowExternal) {
        plan.refused_external.push(ref);
        continue;
      }
      if (source === "stored") {
        if (existing.stored_values.has(ref)) {
          plan.conflicts.push(ref);
          continue;
        }
        plan.needs_value.push(ref);
      }
      plan.add.push({ kind, id, entry } as SettingsImportAdd);
    }
  };
  visit("connection", incoming.connections, existing.connections);
  visit("repository", incoming.repositories, existing.repositories);
  visit("mcp", incoming.mcp_servers, existing.mcp_servers);

  // The console App's rows are found by owner/name, one row each.
  const appNames = new Map<string, string>();
  for (const [id, row] of existing.repositories) {
    const entry = row.entry as CatalogRepositoryConfig;
    if (!row.active || !isObject(entry) || typeof entry.url !== "string") {
      continue;
    }
    if (repositoryAuthKindOf(entry) !== "github_app") continue;
    appNames.set(githubFullName(entry.url), id);
  }
  plan.add = plan.add.filter((add) => {
    if (add.kind !== "repository") return true;
    if (repositoryAuthKindOf(add.entry) !== "github_app") return true;
    const fullName = githubFullName(add.entry.url);
    if (appNames.has(fullName)) {
      (rules.databaseOwnsRepositories === true ? kept : plan.conflicts).push(
        `repository:${add.id}`,
      );
      return false;
    }
    appNames.set(fullName, add.id);
    return true;
  });
  plan.conflicts.sort();
  return kept.length === 0 ? plan : { ...plan, kept: kept.sort() };
}

function githubFullName(url: string): string {
  const { owner, name } = repoRefOf(url) ?? { owner: "", name: "" };
  return `${owner}/${name}`.toLowerCase();
}
