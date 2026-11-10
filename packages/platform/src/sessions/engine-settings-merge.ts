import type {
  AdminDenyEntry,
  EngineSettings,
  StoredEngineSettings,
} from "@werft-ai/contracts";

import type { EffectiveEngineSettings } from "./engine-settings.ts";

/**
 * What one claim sends: the engine's settings, the whole-tool denies that ride
 * as `disallowed_tools`, and the `mcp__` denies the platform enforces itself
 * at call time (the engine adapter refuses an `mcp__` rule in deny or ask).
 * `closed` means some source cannot be trusted; the claim is refused, never
 * sent without rules.
 */
export type MergedEngineSettings =
  | {
      kind: "rules";
      engine: EngineSettings | undefined;
      disallowedTools: string[];
      mcpDeny: string[];
    }
  | { kind: "closed"; reason: string };

const MCP_PREFIX = "mcp__";
const BARE_TOOL = /^[A-Za-z][A-Za-z0-9_]*$/;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
/**
 * A grant needs both sides: the workspace's list and what the agent started
 * with and still has (`effectiveEngineSettings` already intersected those two
 * for the agent). An agent that grants nothing leaves nothing granted.
 */
const intersect = (
  workspace: readonly string[] = [],
  agent: readonly string[] = [],
) => {
  const inAgent = new Set(agent);
  return sorted(workspace.filter((rule) => inAgent.has(rule)));
};
const isMcp = (rule: string) => rule.startsWith(MCP_PREFIX);
/** A rule naming a whole tool has no parenthesised argument pattern. */
const isWholeTool = (rule: string) => BARE_TOOL.test(rule) && !isMcp(rule);

/**
 * The admin entries that bind a session of `releaseId`. A session without a
 * release is not bound (restrict-only data must never invent a release); a
 * release the caller could not resolve is the caller's `closed`.
 */
export function applicableAdminDeny(
  entries: readonly AdminDenyEntry[],
  releaseId: string | null,
): AdminDenyEntry[] {
  if (releaseId === null) return [];
  return entries.filter(
    (entry) => !entry.exempt_release_ids.includes(releaseId),
  );
}

const nonEmpty = <T extends Record<string, string[]>>(lists: T) => {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(lists)) {
    if (value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Workspace, agent and inherited rules for one claim.
 *
 * Restrictions (ask, deny, the classifier's soft and hard deny) are the union
 * of every source. A grant (allow, environment) is the intersection of the
 * workspace's list and the agent's, so an agent can only repeat what the
 * workspace allows and never widen it.
 */
export function mergeEngineSettings(input: {
  workspace: StoredEngineSettings | null;
  agent: EffectiveEngineSettings;
  adminDeny: readonly AdminDenyEntry[];
}): MergedEngineSettings {
  if (input.agent.kind === "closed") {
    return { kind: "closed", reason: `agent_${input.agent.reason}` };
  }
  const ws = input.workspace;
  const wsPerm = ws?.permissions ?? {};
  const wsAuto = ws?.auto_mode ?? {};
  const agentPerm = input.agent.permissions;
  const agentAuto = input.agent.autoMode;

  const denyAll = [
    ...(wsPerm.deny ?? []),
    ...agentPerm.deny,
    ...input.adminDeny.flatMap((entry) => entry.permissions_deny),
  ];
  const mcpDeny = sorted([
    ...denyAll.filter(isMcp),
    ...input.adminDeny.flatMap((entry) => entry.mcp_deny),
  ]);
  const disallowedTools = sorted(denyAll.filter(isWholeTool));
  const patternDeny = sorted(
    denyAll.filter((rule) => !isMcp(rule) && !isWholeTool(rule)),
  );

  const permissions = nonEmpty({
    allow: intersect(wsPerm.allow, agentPerm.allow),
    ask: sorted([...(wsPerm.ask ?? []), ...agentPerm.ask]),
    deny: patternDeny,
  });
  const autoMode = nonEmpty({
    allow: intersect(wsAuto.allow, agentAuto.allow),
    soft_deny: sorted([...(wsAuto.soft_deny ?? []), ...agentAuto.soft_deny]),
    hard_deny: sorted([...(wsAuto.hard_deny ?? []), ...agentAuto.hard_deny]),
    environment: intersect(wsAuto.environment, agentAuto.environment),
  });

  const engine: EngineSettings | undefined =
    permissions || autoMode
      ? ({
          ...(permissions ? { permissions } : {}),
          ...(autoMode ? { autoMode } : {}),
        } as EngineSettings)
      : undefined;
  return { kind: "rules", engine, disallowedTools, mcpDeny };
}

/**
 * Whether a call to `toolName` is denied by an `mcp__` rule. A rule names one
 * whole tool, so the match is exact: a prefix would deny a server's other
 * tools.
 */
export function mcpCallDenied(
  mcpDeny: readonly string[],
  toolName: string,
): boolean {
  return mcpDeny.includes(toolName);
}
