import { createHash } from "node:crypto";
import {
  type AgentCard,
  type AgentRelease,
  canonicalJsonOfJson,
  DEFAULT_TOOL_POLICY,
  type EffectiveTools,
  GITHUB_MCP_SERVER,
  MCP_TOOL_PREFIX,
  type PolicyPins,
  type ToolPolicy,
} from "@werft-ai/contracts";
import {
  type CatalogProfile,
  pinnedMcpTools,
  profileFingerprint,
  profileModels,
  type SessionCatalog,
} from "../sessions/catalog.ts";

// The model a release's sessions run unless they name another: its card's.
export function releaseModel(
  release: Pick<AgentRelease, "runtime_config_snapshot"> | null,
): string | undefined {
  const model = release?.runtime_config_snapshot.model;
  return typeof model === "string" ? model : undefined;
}

// Ported from Kollegium v1 `packages/core/src/ids.ts` (Apache-2.0,
// JeongJaeSoon/kollegium @ d711706).

// Bumped when the hashed shape changes, so an old id can never equal a new
// one by accident. 2: `policy_pins` went from a placeholder `{}` to the
// resolved tool policy. A stored `{}` release keeps hashing as 1, so its id
// still verifies. 3: the release names a repository; one without keeps
// hashing as 2, so releases from before the column keep their ids. 4: the
// release pins GitHub settings; one without keeps hashing as before.
export function releaseIdVersion(identity: ReleaseIdentity): number {
  if (identity.policy_pins.github !== undefined) return 4;
  if (identity.policy_pins.tools === undefined) return 1;
  return identity.repository_id === null ? 2 : 3;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function cardContentSha256(card: AgentCard): string {
  return sha256Hex(canonicalJsonOfJson(card));
}

export type ReleaseIdentity = Pick<
  AgentRelease,
  | "agent_id"
  | "card_sha256"
  | "runtime_profile_id"
  | "repository_id"
  | "profile_digest"
  | "runtime_config_snapshot"
  | "effective_tools"
  | "policy_pins"
>;

export function deriveReleaseId(identity: ReleaseIdentity): string {
  return `sha256:${sha256Hex(
    canonicalJsonOfJson({
      release_id_version: releaseIdVersion(identity),
      agent_id: identity.agent_id,
      card_sha256: identity.card_sha256,
      runtime_profile_id: identity.runtime_profile_id,
      ...(identity.repository_id === null
        ? {}
        : { repository_id: identity.repository_id }),
      profile_digest: identity.profile_digest,
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
 * What a card runs as under a profile: the profile's tools in its order.
 * An error when the card's model falls outside the profile.
 */
export function resolveReleaseContent(
  card: AgentCard,
  profileId: string,
  profile: CatalogProfile,
  mcpServers: SessionCatalog["mcp_servers"] = {},
):
  | {
      ok: true;
      content: Omit<
        ReleaseIdentity,
        "agent_id" | "card_sha256" | "repository_id"
      >;
    }
  | { ok: false; error: ReleaseCompatibilityError } {
  if (!profileModels(profile).includes(card.model)) {
    return {
      ok: false,
      error: {
        field: "card.model",
        // apps/web parses this wording; it means none of the profile's models.
        message: `model ${card.model} is not the model of runtime profile ${profileId}`,
      },
    };
  }
  const tools = [...profile.tools];
  const policy = resolveToolPolicy(card, tools);
  if (!policy.ok) return policy;
  const policy_pins = policy.pins;
  const mcp = resolveMcpServer(card, policy_pins, mcpServers);
  if (!mcp.ok) return mcp;
  const effective_tools: EffectiveTools = { tools, mcp: mcp.tools };
  return {
    ok: true,
    content: {
      runtime_profile_id: profileId,
      profile_digest: profileFingerprint(profile),
      // No credential here, not even the attempt's egress token: the worker
      // gets that at claim.
      runtime_config_snapshot: {
        model: card.model,
        tools,
        permission_mode: profile.permission_mode,
        provider: {
          kind: profile.provider.kind,
          endpoint: profile.provider.endpoint,
        },
        // Pinned with the release: a card edit never reaches a session that
        // already opened it. A release made before the field has none, and
        // the claim reads that as asking for nothing.
        language: card.language,
        ...(profile.project_settings?.claude_md === true
          ? { project_settings: profile.project_settings }
          : {}),
        // Absent, not empty, so a release of a profile with none keeps its id.
        ...(profile.mcp_deny !== undefined && profile.mcp_deny.length > 0
          ? { mcp_deny: [...profile.mcp_deny].sort() }
          : {}),
      },
      effective_tools,
      policy_pins,
    },
  };
}

function resolveMcpServer(
  card: AgentCard,
  pins: PolicyPins,
  mcpServers: NonNullable<SessionCatalog["mcp_servers"]>,
):
  | { ok: true; tools: string[] }
  | { ok: false; error: ReleaseCompatibilityError } {
  const named = card.capabilities.mcp?.[0];
  if (named === undefined) return { ok: true, tools: [] };
  const server = Object.hasOwn(mcpServers, named.server)
    ? mcpServers[named.server]
    : undefined;
  if (server === undefined) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.mcp",
        message: `MCP server ${named.server} is not in the catalog`,
      },
    };
  }
  if (
    !(card.capabilities.credential_refs ?? []).includes(server.credential_ref)
  ) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.credential_refs",
        message: `MCP server ${named.server} calls as ${server.credential_ref}, which the card must name`,
      },
    };
  }
  const tools = pinnedMcpTools(named.server, pins.tools?.per_tool ?? {});
  // The pin is what the relay and the authorizer read, so a forbidden tool
  // must never get one.
  const forbidden = tools.filter((tool) =>
    card.capabilities.forbidden.includes(tool),
  );
  if (forbidden.length > 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.forbidden",
        message: `${forbidden.join(", ")} is both forbidden and allowed`,
      },
    };
  }
  if (tools.length === 0) {
    return {
      ok: false,
      error: {
        field: "card.capabilities.tool_policy.per_tool",
        message: `no ${MCP_TOOL_PREFIX}${named.server}__ tool is allowed`,
      },
    };
  }
  return { ok: true, tools };
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
