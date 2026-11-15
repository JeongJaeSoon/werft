import {
  type CatalogRepositoryStore,
  configuredImageRuntimesFromEnv,
  createCatalogRegistry,
  type InstallationSettingsStore,
  type InstalledRuntimes,
  imagesOfEngine,
  launchableImagesFor,
  RuntimeFeatureGate,
  type RuntimeVersions,
  registryCatalog,
  runtimeVersionsOf,
  SecretKey,
  type SessionCatalog,
  settingsView,
  withConsoleRepositories,
} from "@werft-ai/platform";
import {
  equivalentToolCatalogVersions,
  installedDescriptors,
  installedToolCatalogs,
} from "@werft-ai/runtime-codecs";

export const SECRET_KEY_SETTING = "PLATFORM_SECRET_KEY";
const CONFIG_DIR_SETTING = "PLATFORM_CONFIG_DIR";

/** The runtimes the worker image ships, as the control plane sees them. */
export const installedRuntimes = new RuntimeFeatureGate(installedDescriptors);

/** The version a new release of each installed runtime runs. */
export const installedRuntimeVersions: InstalledRuntimes = Object.fromEntries(
  installedDescriptors.map((descriptor) => [
    descriptor.kind,
    descriptor.runtimeVersion,
  ]),
);

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
 * The configured worker images' runtimes; undefined without them. Each kind
 * also names its older builds whose tool catalog is an image's own: a
 * release made on one of them still runs.
 */
export function runtimeVersionsFromEnv(
  env: Record<string, string | undefined>,
): RuntimeVersions | undefined {
  const runtimes = configuredImageRuntimesFromEnv(env);
  if (runtimes === null) return undefined;
  const listed = runtimeVersionsOf(runtimes, installedDescriptors).accepted;
  const accepted = new Map(
    listed.flatMap(({ kind, version, engine }) =>
      [
        version,
        ...equivalentToolCatalogVersions(installedToolCatalogs, kind, version),
      ].map(
        (each) =>
          [`${kind}\n${each}`, { kind, version: each, engine }] as const,
      ),
    ),
  );
  return { accepted: [...accepted.values()] };
}

/**
 * Whether a session of a runtime kind has an unretracted listed image of
 * its engine to launch on, by the scheduler's engine rule (the descriptor's
 * `checkpointEngine`). Always with the single-image settings, which retract
 * nothing. A kind with no listed image at all is not in the catalog either:
 * that session reads CATALOG_MISMATCH first.
 */
export function launchableKindsFromEnv(
  env: Record<string, string | undefined>,
): (kind: string) => boolean {
  const images = launchableImagesFor(env);
  return (kind) =>
    images === null ||
    imagesOfEngine(
      images,
      installedDescriptors.find((descriptor) => descriptor.kind === kind)
        ?.checkpointEngine ?? null,
    ).length > 0;
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
