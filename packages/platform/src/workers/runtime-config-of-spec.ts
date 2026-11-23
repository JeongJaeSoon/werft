import {
  permissionModeOf,
  type RuntimeConfig,
  type SpecSource,
} from "@werft-ai/contracts";

/**
 * The runtime config a spec source means. The engine's permission mode is
 * decided again from the source's runtime, connection and model
 * (`permissionModeOf`), not read from the mode it pinned. The tools are the
 * release's list.
 */
export function runtimeConfigOfSpec(
  source: SpecSource,
  providerToken: string,
  hasRepository: boolean,
): RuntimeConfig {
  return {
    model: source.model,
    tools: [...source.tools],
    permission_mode: permissionModeOf(source),
    provider: {
      kind: source.connection.kind,
      endpoint: source.connection.endpoint,
      auth: { kind: "egress_token", token: providerToken },
    },
    ...(hasRepository && source.project_settings?.claude_md === true
      ? { project_settings: source.project_settings }
      : {}),
  };
}
