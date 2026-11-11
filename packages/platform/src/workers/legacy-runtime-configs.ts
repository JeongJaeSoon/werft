import {
  canonicalJsonOfJson,
  MAX_RESTORE_CONFIGS,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "@werft-ai/contracts";

/**
 * Stands in for the egress token in a stored config. The digest leaves the
 * credential out, and a claim puts its own token back (`servedLegacyConfig`),
 * so a table never holds one that could be replayed.
 */
export const LEGACY_CONFIG_TOKEN = "legacy-config-carries-no-credential";

/**
 * What a session keeps in `sessions.legacy_runtime_configs`: the configs it
 * ran before its model moved, newest first, so a checkpoint made under one
 * of them still restores. Stored without the credentials, MCP servers and
 * variables a claim sets itself, none of which a digest reads.
 */
export function withEarlierConfig(
  stored: unknown,
  earlier: RuntimeConfig,
): RuntimeConfig[] {
  return dedupe([
    storableLegacyConfig(earlier),
    ...legacyConfigsFromRow(stored),
  ]).slice(0, MAX_RESTORE_CONFIGS);
}

export function storableLegacyConfig(config: RuntimeConfig): RuntimeConfig {
  const {
    disallowed_tools: _denied,
    // Re-merged at every claim from the rules saved then, like the denies.
    engine_settings: _settings,
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
    .slice(0, MAX_RESTORE_CONFIGS);
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
