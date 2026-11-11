import { createHash } from "node:crypto";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationSubject,
} from "@werft-ai/contracts";
import type { CallerLimitRuleFacts } from "../ports/agent-caller-limits-store.ts";
import { POLICY_VERSION } from "./policy.ts";

export const CALLER_LIMIT_DIMENSION_VALUES = [
  "repository",
  "credential",
  "mcp_server",
  "tool",
] as const;
export type CallerLimitDimension =
  (typeof CALLER_LIMIT_DIMENSION_VALUES)[number];

export type CallerLimit = {
  v: 1;
  tools_deny: string[];
  repositories: string[] | null;
  mcp_servers: string[] | null;
  credentials_deny: string[];
  revision: number;
};

export type CallerLimitSubject = {
  teamIds: readonly string[];
  channelId: string | null;
};

export type SessionReach = {
  tools: readonly string[];
  repositories: readonly string[];
  mcp_servers: readonly string[];
  credentials: readonly string[];
};

const sortedUnique = (list: readonly string[]) => [...new Set(list)].sort();

function intersect(lists: readonly (readonly string[])[]): string[] | null {
  if (lists.length === 0) return null;
  const [first, ...rest] = lists as [
    readonly string[],
    ...(readonly string[])[],
  ];
  return sortedUnique(first).filter((item) =>
    rest.every((list) => list.includes(item)),
  );
}

export function withLiveRepositories(
  rules: readonly CallerLimitRuleFacts[],
  isLive: (repositoryId: string) => boolean,
): CallerLimitRuleFacts[] {
  return rules.map((rule) =>
    rule.repositories === null
      ? rule
      : { ...rule, repositories: rule.repositories.filter(isLive) },
  );
}

export function mergeCallerLimit(
  rules: readonly CallerLimitRuleFacts[],
  subject: CallerLimitSubject,
  revision: number,
): CallerLimit | null {
  const teams = new Set(subject.teamIds.map((id) => id.toLowerCase()));
  const channel = subject.channelId?.toLowerCase() ?? null;
  const matching = rules.filter((rule) => {
    switch (rule.target.kind) {
      case "workspace":
        return true;
      case "team":
        return teams.has(rule.target.id.toLowerCase());
      case "channel":
        return channel !== null && rule.target.id.toLowerCase() === channel;
      default:
        return false;
    }
  });
  if (matching.length === 0) return null;
  const allowed = (pick: (rule: CallerLimitRuleFacts) => string[] | null) =>
    intersect(
      matching.flatMap((rule) => {
        const list = pick(rule);
        return list === null ? [] : [list];
      }),
    );
  return {
    v: 1,
    tools_deny: sortedUnique(matching.flatMap((rule) => rule.tools_deny)),
    repositories: allowed((rule) => rule.repositories),
    mcp_servers: allowed((rule) => rule.mcp_servers),
    credentials_deny: sortedUnique(
      matching.flatMap((rule) => rule.credentials_deny),
    ),
    revision,
  };
}

export function callerLimitDigest(limit: CallerLimit): string {
  const canonical = JSON.stringify({
    tools_deny: limit.tools_deny,
    repositories: limit.repositories,
    mcp_servers: limit.mcp_servers,
    credentials_deny: limit.credentials_deny,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function narrowReach(
  reach: SessionReach,
  pinned: CallerLimit | null,
): SessionReach {
  if (pinned === null) return reach;
  const kept = (list: readonly string[], allow: readonly string[] | null) =>
    allow === null ? list : list.filter((item) => allow.includes(item));
  return {
    tools: reach.tools.filter((tool) => !pinned.tools_deny.includes(tool)),
    repositories: kept(reach.repositories, pinned.repositories),
    mcp_servers: kept(reach.mcp_servers, pinned.mcp_servers),
    credentials: reach.credentials.filter(
      (name) => !pinned.credentials_deny.includes(name),
    ),
  };
}

export function callerLimitRefusal(
  limit: CallerLimit | null,
  reach: SessionReach,
): CallerLimitDimension | null {
  if (limit === null) return null;
  const outside = (list: readonly string[], allow: readonly string[] | null) =>
    allow !== null && list.some((item) => !allow.includes(item));
  if (outside(reach.repositories, limit.repositories)) return "repository";
  if (reach.credentials.some((name) => limit.credentials_deny.includes(name))) {
    return "credential";
  }
  if (outside(reach.mcp_servers, limit.mcp_servers)) return "mcp_server";
  if (reach.tools.some((tool) => limit.tools_deny.includes(tool))) {
    return "tool";
  }
  return null;
}

export function callerLimitedEntry(input: {
  subject: AuthorizationSubject;
  ownerId: string;
  requestId: string;
  agentId: string;
  releaseId: string;
  sessionId: string | null;
  decisionId: string;
}): { request: AuthorizationRequest; decision: AuthorizationDecision } {
  return {
    request: {
      subject: input.subject,
      action: "session.submit",
      resource: {
        kind: "session",
        id: input.sessionId,
        owner_scope: input.ownerId,
        agent_id: input.agentId,
        release_id: input.releaseId,
      },
      request_id: input.requestId,
    },
    decision: {
      outcome: "deny",
      reason_code: "caller_limited",
      effective_scopes: [],
      policy_version: POLICY_VERSION,
      decision_id: input.decisionId,
    },
  };
}
