import type {
  PermissionMode,
  RuntimeConfig,
  SpecSource,
} from "@werft-ai/contracts";

/**
 * The runtime config a spec source means. The engine's own permission mode is
 * the source's: `bypassPermissions`, `auto`, or `default` on a connection
 * whose classifier does not work. The tools are the release's list.
 */
export function runtimeConfigOfSpec(
  source: SpecSource,
  providerToken: string,
  hasRepository: boolean,
): RuntimeConfig {
  return {
    model: source.model,
    tools: [...source.tools],
    permission_mode: source.permission_mode as PermissionMode,
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
