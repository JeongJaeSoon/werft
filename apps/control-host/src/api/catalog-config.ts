import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  OPT_IN_PERMISSION_MODES,
  UNATTENDED_PERMISSION_MODES,
} from "@werft-ai/contracts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  type CatalogProfileView,
  type CatalogRepositoryStore,
  createProfileRegistry,
  type InstallationProfileStore,
  type InstallationSettingsStore,
  RuntimeFeatureGate,
  profileCatalog,
  type RuntimeVersions,
  resolveSessionCatalog,
  runtimeVersionsOf,
  SecretKey,
  type SessionCatalog,
  type SnapshotSources,
  sessionCatalogView,
  settingsView,
  type WorkspaceProfileStore,
  withConsoleRepositories,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import {
  equivalentToolCatalogVersions,
  installedDescriptors,
  installedToolCatalogs,
} from "@werft-ai/runtime-codecs";

export const ALLOW_UNATTENDED_SETTING = "PLATFORM_ALLOW_UNATTENDED_PERMISSIONS";
export const SECRET_KEY_SETTING = "PLATFORM_SECRET_KEY";
const CONFIG_DIR_SETTING = "PLATFORM_CONFIG_DIR";
const SECRET_READ_TIMEOUT_MS = 10_000;

/** The runtimes the worker image ships, as the control plane sees them. */
export const installedRuntimes = new RuntimeFeatureGate(installedDescriptors);

export type SecretReader = (secretId: string) => Promise<string | undefined>;

export function secretsManagerReader(
  env: Record<string, string | undefined>,
  timeoutMs = SECRET_READ_TIMEOUT_MS,
): SecretReader {
  let client: SecretsManagerClient | undefined;
  return async (secretId) => {
    client ??= new SecretsManagerClient({
      ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
      // Its own endpoint, never AWS_ENDPOINT_URL: locally that one is the
      // object store workers can reach, and secrets must not be.
      // The SDK would fall back to it on its own, so configured endpoints
      // are ignored and only this variable (or AWS itself) is used.
      ignoreConfiguredEndpointUrls: true,
      ...(env.AWS_ENDPOINT_URL_SECRETS_MANAGER === undefined
        ? {}
        : { endpoint: env.AWS_ENDPOINT_URL_SECRETS_MANAGER }),
      maxAttempts: 2,
    });
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    return result.SecretString;
  };
}

/** Compose passes an unset variable through as empty. */
export function refuseFileCatalog(
  env: Record<string, string | undefined>,
): void {
  const leftover = [CONFIG_DIR_SETTING, "SESSION_CATALOG_JSON"].filter(
    (name) => env[name] !== undefined && env[name] !== "",
  );
  if (leftover.length > 0) {
    throw new Error(
      `${leftover.join(" and ")} no longer read: finish the import with \`bun run settings import --from-dir <dir>\` (docs/operator/api-server.md), then unset ${leftover.length === 1 ? "it" : "them"}`,
    );
  }
}

/**
 * Whether this process may run a profile nothing judges. A catalog is
 * copied between installations and cannot vouch for the one it lands in.
 */
export function unattendedAllowed(
  env: Record<string, string | undefined>,
): boolean {
  return env[ALLOW_UNATTENDED_SETTING] === "true";
}

/** What a replica holding no provider key builds its profile snapshot from. */
export function profileViewSources(
  env: Record<string, string | undefined>,
): SnapshotSources<CatalogProfileView> {
  return {
    connections: {},
    allowUnattended: unattendedAllowed(env),
    runtimeSupported: runtimeServes,
    materialize: (id, definition) => {
      const view = sessionCatalogView({
        profiles: { [id]: definition },
        repositories: {},
      }).profiles[id];
      if (!view) throw new Error(`profile ${id} has no view`);
      return view;
    },
  };
}

export function profileSources(
  env: Record<string, string | undefined>,
): SnapshotSources<CatalogProfile> {
  return {
    connections: {},
    allowUnattended: unattendedAllowed(env),
    runtimeSupported: runtimeServes,
    materialize: (id, definition, lookup) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: definition }, repositories: {} },
        lookup ?? (() => undefined),
      ).profiles[id];
      if (!profile) throw new Error(`profile ${id} did not resolve`);
      return profile;
    },
  };
}

export function runtimeServes(profile: CatalogProfileConfig): boolean {
  try {
    installedRuntimes.assertProfiles({ profile });
    return true;
  } catch {
    return false;
  }
}

/**
 * The configured worker images' engine versions; undefined without them.
 * `current` and `accepted` also name the older builds whose tool catalog is
 * an image's own: a worker runs a profile row left at one of them, and a
 * session pinned under that row keeps its profile when the row moves on.
 */
export function runtimeVersionsFromEnv(
  env: Record<string, string | undefined>,
): RuntimeVersions | undefined {
  const images = workerImageRuntimesFromEnv(env);
  if (images === null) return undefined;
  const versions = runtimeVersionsOf(images);
  const withEquivalents = (listed: readonly string[]) => [
    ...new Set([
      ...listed,
      ...installedDescriptors.flatMap(({ kind }) =>
        listed.flatMap((version) =>
          equivalentToolCatalogVersions(installedToolCatalogs, kind, version),
        ),
      ),
    ]),
  ];
  return {
    accepted: withEquivalents(versions.accepted),
    current: withEquivalents(versions.current),
  };
}

export async function databaseCatalog(options: {
  installations: Pick<InstallationProfileStore, "listAll">;
  workspaces: Pick<WorkspaceProfileStore, "listAll">;
  repositories: Pick<CatalogRepositoryStore, "readCatalog">;
  settings: Pick<InstallationSettingsStore, "read">;
  credential: () => string;
  env: Record<string, string | undefined>;
}): Promise<SessionCatalog> {
  const runtimeVersions = runtimeVersionsFromEnv(options.env);
  const { settings, credential } = options;
  const registry = createProfileRegistry({
    workspaces: options.workspaces,
    installations: options.installations,
    repositories: options.repositories,
    settings: {
      read: async () => settingsView(await settings.read(), credential),
    },
    sources: {
      connections: {},
      allowUnattended: true,
      runtimeSupported: () => true,
      materialize: (id, definition) => {
        const profile = resolveSessionCatalog(
          { profiles: { [id]: definition }, repositories: {} },
          options.credential,
        ).profiles[id];
        if (!profile) throw new Error(`profile ${id} did not resolve`);
        return profile;
      },
    },
  });
  await registry.refresh();
  return profileCatalog(
    {
      repositories: {},
      ...(runtimeVersions === undefined
        ? {}
        : { runtime_versions: runtimeVersions }),
    },
    registry,
    (rows, read) => withConsoleRepositories(rows, read?.repositories),
  );
}

/** Compose passes an unset variable through as empty. */
export function loadSecretKey(
  env: Record<string, string | undefined>,
): SecretKey {
  const value = env[SECRET_KEY_SETTING];
  if (value === undefined || value === "") {
    throw new Error(
      `${SECRET_KEY_SETTING} is required: 64 hex characters, from \`openssl rand -hex 32\`. Keep it with the database backup; stored credentials open only with it`,
    );
  }
  return SecretKey.fromHex(value, SECRET_KEY_SETTING);
}

const profilesIn =
  (modes: readonly string[]) =>
  (catalog: {
    profiles: Record<string, { permission_mode: string }>;
  }): string[] =>
    Object.entries(catalog.profiles)
      .filter(([, profile]) => modes.includes(profile.permission_mode))
      .map(([id]) => id);

/** Profiles whose tools run without a person answering; logged at startup. */
export const unattendedProfiles = profilesIn(UNATTENDED_PERMISSION_MODES);

/**
 * Profiles whose tool calls nothing judges. That leaves the container, the
 * egress allowlist, the tool list and the cost limit as the only bounds, so
 * the installation has to opt in: a catalog is copied between installations
 * and cannot vouch for the one it lands in. `auto` is not among them: its
 * classifier still refuses a call.
 */
export const optInProfiles = profilesIn(OPT_IN_PERMISSION_MODES);
