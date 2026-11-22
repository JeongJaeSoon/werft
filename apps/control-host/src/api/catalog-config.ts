import { readFileSync } from "node:fs";
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
/** A path to a file holding the key, such as a mounted compose secret. */
export const SECRET_KEY_FILE_SETTING = "PLATFORM_SECRET_KEY_FILE";

/** The runtimes the worker image ships, as the control plane sees them. */
export const installedRuntimes = new RuntimeFeatureGate(installedDescriptors);

/** The version a new release of each installed runtime runs. */
export const installedRuntimeVersions: InstalledRuntimes = Object.fromEntries(
  installedDescriptors.map((descriptor) => [
    descriptor.kind,
    descriptor.runtimeVersion,
  ]),
);

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

/**
 * What an operator command prints when a stored secret does not open: the
 * key it was given is not the one the API sealed with. Names no value.
 */
export const MASTER_KEY_MISMATCH = `master_key_mismatch: a stored secret does not open with this ${SECRET_KEY_SETTING}; give the command the key the API runs with, in ${SECRET_KEY_SETTING} or a file named by ${SECRET_KEY_FILE_SETTING}`;

export type MasterKeyErrorCode =
  | "master_key_missing"
  | "master_key_invalid"
  | "master_key_mismatch";

/** Why no master key was loaded; the message never carries a key or a path's content. */
export class MasterKeyError extends Error {
  override name = "MasterKeyError";
  constructor(
    readonly code: MasterKeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether either setting names a key; Compose passes an unset variable through as empty. */
export function masterKeyConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(env[SECRET_KEY_SETTING] || env[SECRET_KEY_FILE_SETTING]);
}

/**
 * The one master key loader of the API, its roles and the operator commands:
 * the value in PLATFORM_SECRET_KEY, or the file PLATFORM_SECRET_KEY_FILE
 * names (one trailing newline allowed). Both set must agree.
 */
export function loadSecretKey(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SecretKey {
  const value = env[SECRET_KEY_SETTING] || undefined;
  const path = env[SECRET_KEY_FILE_SETTING] || undefined;
  let fromFile: string | undefined;
  if (path !== undefined) {
    try {
      fromFile = readFile(path).replace(/\r?\n$/, "");
    } catch {
      throw new MasterKeyError(
        "master_key_missing",
        `${SECRET_KEY_FILE_SETTING} names a file this process cannot read`,
      );
    }
    if (fromFile === "") {
      throw new MasterKeyError(
        "master_key_missing",
        `the file ${SECRET_KEY_FILE_SETTING} names is empty`,
      );
    }
  }
  if (fromFile === undefined && value === undefined) {
    throw new MasterKeyError(
      "master_key_missing",
      `${SECRET_KEY_SETTING} is required: 64 hex characters, from \`openssl rand -hex 32\` (or a file named by ${SECRET_KEY_FILE_SETTING}). Keep it with the database backup; stored credentials open only with it`,
    );
  }
  const fileKey =
    fromFile === undefined ? null : parseKey(fromFile, SECRET_KEY_FILE_SETTING);
  const envKey =
    value === undefined ? null : parseKey(value, SECRET_KEY_SETTING);
  // Compared as bytes: the same key in upper and lower case hex agrees.
  if (
    fileKey !== null &&
    envKey !== null &&
    !fileKey.bytes().equals(envKey.bytes())
  ) {
    throw new MasterKeyError(
      "master_key_mismatch",
      `${SECRET_KEY_SETTING} and the file ${SECRET_KEY_FILE_SETTING} names hold different keys; set one of them`,
    );
  }
  return (fileKey ?? envKey) as SecretKey;
}

function parseKey(hex: string, source: string): SecretKey {
  try {
    return SecretKey.fromHex(hex, source);
  } catch (error) {
    throw new MasterKeyError(
      "master_key_invalid",
      error instanceof Error ? error.message : `${source} is not a key`,
    );
  }
}
