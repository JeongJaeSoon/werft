import {
  type AgentCard,
  type AgentRelease,
  canonicalJsonOfJson,
  DEFAULT_TOOL_POLICY,
  type EffectiveTools,
  GITHUB_MCP_SERVER,
  MCP_TOOL_PREFIX,
  type PolicyPins,
  permissionModeOf,
  RETIRED_CATALOG_MCP_MESSAGE,
  type RuntimeKind,
  type ToolPolicy,
} from "@werft-ai/contracts";
import { sha256Hex } from "@werft-ai/runtime-core";
import {
  type CatalogConnectionView,
  connectionModels,
} from "../catalog/index.ts";

// Ported from Kollegium v1 `packages/core/src/ids.ts` (Apache-2.0,
// JeongJaeSoon/kollegium @ d711706).

// Bumped when the hashed shape changes, so an old id can never equal a new
// one by accident. 5: the release names its connection and the runtime its
// snapshot holds.
export const RELEASE_ID_VERSION = 5;

export function cardContentSha256(card: AgentCard): string {
  return sha256Hex(canonicalJsonOfJson(card));
}

export type ReleaseIdentity = Pick<
  AgentRelease,
  | "agent_id"
  | "card_sha256"
  | "connection_id"
  | "repository_id"
  | "runtime_config_snapshot"
  | "effective_tools"
  | "policy_pins"
>;

export function deriveReleaseId(identity: ReleaseIdentity): string {
  return `sha256:${sha256Hex(
    canonicalJsonOfJson({
      release_id_version: RELEASE_ID_VERSION,
      agent_id: identity.agent_id,
      card_sha256: identity.card_sha256,
      connection_id: identity.connection_id,
      ...(identity.repository_id === null
        ? {}
        : { repository_id: identity.repository_id }),
      runtime_config_snapshot: identity.runtime_config_snapshot,
      effective_tools: identity.effective_tools,
      policy_pins: identity.policy_pins,
    }),
  )}`;
}

export class ReleaseIdentityError extends Error {
  constructor(readonly releaseId: string) {
    super(`agent release ${releaseId} does not hash to its id`);
  }
}

export function assertReleaseIdentity(release: AgentRelease): void {
  if (deriveReleaseId(release) !== release.id) {
    throw new ReleaseIdentityError(release.id);
  }
}

export type ReleaseCompatibilityError = { field: string; message: string };

/**
 * What a release on a connection runs, apart from its card: the runtime the
 * image ships for the connection's kind, its built-in tools, the engine's
 * permission mode and whether the repository's CLAUDE.md is read.
 */
export type ReleaseRun = {
  connection_id: string;
  connection: CatalogConnectionView;
  runtime: { kind: RuntimeKind; version: string };
  tools: readonly string[];
  project_settings: { claude_md: boolean };
};

/**
 * What a card runs as on a connection: the runtime's tools in its order.
 * An error when the card's model is not one the connection offers.
 */
export function resolveReleaseContent(
  card: AgentCard,
  run: ReleaseRun,
):
  | {
      ok: true;
      content: Omit<
        ReleaseIdentity,
        "agent_id" | "card_sha256" | "repository_id"
      >;
    }
  | { ok: false; error: ReleaseCompatibilityError } {
  if (!connectionModels(run.connection).includes(card.model)) {
    return {
      ok: false,
      error: {
        field: "card.model",
        // apps/web parses this wording; it means none of the connection's models.
        message: `model ${card.model} is not a model of connection ${run.connection_id}`,
      },
    };
  }
  if (
    card.judgment_model !== undefined &&
    !connectionModels(run.connection).includes(card.judgment_model)
  ) {
    return {
      ok: false,
      error: {
        field: "card.judgment_model",
        // apps/web parses this wording too.
        message: `model ${card.judgment_model} is not a model of connection ${run.connection_id}`,
      },
    };
  }
  const tools = [...run.tools];
  const policy = resolveToolPolicy(card, tools);
  if (!policy.ok) return policy;
  const policy_pins = policy.pins;
  // Migration 0304 refuses the same version or release at the database.
  if (card.capabilities.mcp !== undefined && card.capabilities.mcp !== null) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.mcp",
        message: RETIRED_CATALOG_MCP_MESSAGE,
      },
    };
  }
  const effective_tools: EffectiveTools = { tools, mcp: [] };
  return {
    ok: true,
    content: {
      connection_id: run.connection_id,
      // No credential here, not even the attempt's egress token: the worker
      // gets that at claim.
      runtime_config_snapshot: {
        model: card.model,
        // Absent leaves the snapshot, and so the release id, as before.
        ...(card.judgment_model === undefined
          ? {}
          : { judgment_model: card.judgment_model }),
        tools,
        permission_mode: permissionModeOf({
          runtime: run.runtime,
          connection: run.connection.provider,
          model: card.model,
        }),
        provider: {
          kind: run.connection.provider.kind,
          endpoint: run.connection.provider.endpoint,
        },
        runtime: { kind: run.runtime.kind, version: run.runtime.version },
        // Pinned with the release: a card edit never reaches a session that
        // already opened it.
        language: card.language,
        ...(run.project_settings.claude_md
          ? { project_settings: run.project_settings }
          : {}),
      },
      effective_tools,
      policy_pins,
    },
  };
}

/**
 * Pins a policy for every tool the release runs, so a later change to the
 * defaults cannot move a release that already exists. Built-in tools take
 * the default; only the card's MCP entries are read, since they name the
 * MCP tools the release may call.
 */
function resolveToolPolicy(
  card: AgentCard,
  tools: string[],
):
  | { ok: true; pins: PolicyPins }
  | { ok: false; error: ReleaseCompatibilityError } {
  const named = card.capabilities.tool_policy?.per_tool ?? {};
  // The built-in server's tools are judged by the agent's GitHub settings
  // (their action class), so a policy here would read as a permission the
  // release does not give. Releases made before this check keep what they
  // have; only a new release is refused.
  const builtinServer = `${MCP_TOOL_PREFIX}${GITHUB_MCP_SERVER}__`;
  const platformNamed = Object.keys(named).filter((tool) =>
    tool.startsWith(builtinServer),
  );
  if (platformNamed.length > 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.tool_policy.per_tool",
        message: `${platformNamed.join(", ")} belongs to the built-in ${GITHUB_MCP_SERVER} server, whose tools follow the agent's GitHub settings, not this policy`,
      },
    };
  }
  // Entries, not property writes: a tool named `__proto__` stays a tool.
  const per_tool: [string, ToolPolicy][] = [
    ...tools.map((tool): [string, ToolPolicy] => [
      tool,
      DEFAULT_TOOL_POLICY.builtin,
    ]),
    ...Object.entries(named).filter(([tool]) =>
      tool.startsWith(MCP_TOOL_PREFIX),
    ),
  ];
  return {
    ok: true,
    pins: {
      tools: {
        default: { ...DEFAULT_TOOL_POLICY },
        per_tool: Object.fromEntries(per_tool),
      },
    },
  };
}
