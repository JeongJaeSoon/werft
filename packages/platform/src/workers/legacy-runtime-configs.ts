import {
  canonicalJsonOfJson,
  MAX_RESTORE_PROFILES,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "@werft-ai/contracts";
import type { WorkerBinding } from "../ports/worker-unit-of-work.ts";
import {
  acceptedRuntimeVersions,
  type CatalogProfile,
  catalogProfile,
  modelMovePins,
  type SessionCatalog,
  sessionProfile,
} from "../sessions/catalog.ts";

/**
 * Stands in for the egress token in a stored config. The digest leaves the
 * credential out, and a claim puts its own token back (`servedLegacyConfig`),
 * so a table never holds one that could be replayed.
 */
export const LEGACY_CONFIG_TOKEN = "legacy-config-carries-no-credential";

/**
 * The profiles a session's checkpoints were made under other than the one it
 * runs now, newest first, as `restoreRuntimesOf` offers them: only a profile
 * the catalog still holds as it was is rebuilt, so a checkpoint made under
 * another one is refused as incompatible. `build` is the claim's own way of
 * turning a profile into its run configs.
 */
export function earlierProfileConfigs<T>(
  binding: Pick<
    WorkerBinding,
    "profileId" | "profileFingerprint" | "model" | "restoreProfiles"
  >,
  catalog: SessionCatalog,
  build: (profile: CatalogProfile) => T,
): T[] {
  return binding.restoreProfiles.flatMap((made) => {
    if (
      made.profileId === binding.profileId &&
      made.profileFingerprint === binding.profileFingerprint &&
      (made.model === null || made.model === binding.model)
    ) {
      return [];
    }
    const listed = catalogProfile(catalog, made.profileId);
    const moved = listed
      ? (modelMovePins(listed, acceptedRuntimeVersions(catalog)).find(
          (pin) =>
            pin.fromFingerprint === made.profileFingerprint &&
            // A version 1 pin names its model, so its column may be empty.
            (made.model === pin.from ||
              (made.model === null &&
                pin.fromFingerprint !== pin.toFingerprint)) &&
            pin.to === binding.model,
        )?.asFrom ?? null)
      : null;
    const profile = listed
      ? (sessionProfile(
          listed,
          { fingerprint: made.profileFingerprint, model: made.model },
          acceptedRuntimeVersions(catalog),
        ) ?? moved)
      : null;
    return profile ? [build(profile)] : [];
  });
}

/**
 * What a session keeps in `sessions.legacy_runtime_configs`: the config of
 * each earlier profile for each tool list the claim would run, profile lists
 * before release lists as the claim orders them, so the cap drops the oldest.
 * Taken while the profiles still exist; the profile removal fills the column
 * from this before it deletes them. Stored without the credentials, MCP
 * servers and variables a claim sets itself, none of which a digest reads.
 */
export function reconstructLegacyRuntimeConfigs(
  binding: Pick<
    WorkerBinding,
    "profileId" | "profileFingerprint" | "model" | "restoreProfiles"
  >,
  catalog: SessionCatalog,
  configsOf: (profile: CatalogProfile) => {
    profile: RuntimeConfig;
    release: RuntimeConfig | null;
  },
): RuntimeConfig[] {
  const earlier = earlierProfileConfigs(binding, catalog, configsOf);
  const configs = (["profile", "release"] as const).flatMap((list) =>
    earlier.flatMap((found) => {
      const config = found[list];
      return config === null ? [] : [storableLegacyConfig(config)];
    }),
  );
  return dedupe(configs).slice(0, MAX_RESTORE_PROFILES);
}

export function storableLegacyConfig(config: RuntimeConfig): RuntimeConfig {
  const {
    disallowed_tools: _denied,
    env: _env,
    extensions: _extensions,
    mcp_servers: _mcp,
    ...kept
  } = config;
  return {
    ...kept,
    provider: {
      ...config.provider,
      auth: { kind: "egress_token", token: LEGACY_CONFIG_TOKEN },
    },
  };
}

/** The column read back; an entry that no longer parses is left out. */
export function legacyConfigsFromRow(value: unknown): RuntimeConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const parsed = runtimeConfigSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_RESTORE_PROFILES);
}

/** A stored config as a claim offers it: this claim's own provider token. */
export function servedLegacyConfig(
  config: RuntimeConfig,
  providerToken: string,
): RuntimeConfig {
  return {
    ...config,
    provider: {
      ...config.provider,
      auth: { kind: "egress_token", token: providerToken },
    },
  };
}

/**
 * `base` as it is, then the `extra` entries it does not already hold. `base`
 * keeps its repeats: the claim lists a config once per tool list it may run.
 */
export function appendNew(
  base: readonly RuntimeConfig[],
  extra: readonly RuntimeConfig[],
): RuntimeConfig[] {
  const held = new Set(base.map((config) => canonicalJsonOfJson(config)));
  return [
    ...base,
    ...dedupe([...extra]).filter(
      (config) => !held.has(canonicalJsonOfJson(config)),
    ),
  ];
}

export function dedupe(configs: RuntimeConfig[]): RuntimeConfig[] {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const key = canonicalJsonOfJson(config);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
