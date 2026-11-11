import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  type CatalogRepositoryStore,
  createCatalogRegistry,
  type InstallationSettingsStore,
  type InstalledRuntimes,
  RuntimeFeatureGate,
  type RuntimeVersions,
  registryCatalog,
  runtimeVersionsOf,
  SecretKey,
  type SessionCatalog,
  settingsView,
  withConsoleRepositories,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import {
  equivalentToolCatalogVersions,
  installedDescriptors,
  installedToolCatalogs,
} from "@werft-ai/runtime-codecs";

export const SECRET_KEY_SETTING = "PLATFORM_SECRET_KEY";
const CONFIG_DIR_SETTING = "PLATFORM_CONFIG_DIR";
const SECRET_READ_TIMEOUT_MS = 10_000;

/** The runtimes the worker image ships, as the control plane sees them. */
export const installedRuntimes = new RuntimeFeatureGate(installedDescriptors);

/** The version a new release of each installed runtime runs. */
export const installedRuntimeVersions: InstalledRuntimes = Object.fromEntries(
  installedDescriptors.map((descriptor) => [
    descriptor.kind,
    descriptor.runtimeVersion,
  ]),
);

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
 * The configured worker images' engine versions; undefined without them.
 * `current` and `accepted` also name the older builds whose tool catalog is
 * an image's own: a release made on one of them still runs.
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

/** The catalog a one-off job reads: the installation's settings, read once. */
export async function databaseCatalog(options: {
  repositories: Pick<CatalogRepositoryStore, "readCatalog">;
  settings: Pick<InstallationSettingsStore, "read">;
  credential: () => string;
  env: Record<string, string | undefined>;
}): Promise<SessionCatalog> {
  const runtimeVersions = runtimeVersionsFromEnv(options.env);
  const { settings, credential } = options;
  const registry = createCatalogRegistry({
    repositories: options.repositories,
    settings: {
      read: async () => settingsView(await settings.read(), credential),
    },
  });
  await registry.refresh();
  return registryCatalog(
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
