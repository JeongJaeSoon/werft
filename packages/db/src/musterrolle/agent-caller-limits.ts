import { randomUUID } from "node:crypto";
import {
  type AgentCallerLimitRule,
  type AgentCallerLimits,
  type AuthorizationSubject,
  effectiveGitHubPolicy,
  effectiveToolsSchema,
  GITHUB_MCP_SERVER,
  type McpStart,
  mcpStartSchema,
} from "@werft-ai/contracts";
import {
  type AgentCallerLimitsStore,
  type CallerLimit,
  type CallerLimitDimension,
  type CallerLimitGate,
  type CallerLimitRuleFacts,
  type CallerLimitsFacts,
  callerLimitedEntry,
  callerLimitRefusal,
  mergeCallerLimit,
  narrowReach,
  type PutAgentCallerLimitsResult,
  receiptActorOf,
  type SessionReach,
  withLiveRepositories,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { captureMcpStart } from "../agents/mcp-settings.ts";
import { lockPeople, UUID } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import { sessionGitHubMcpOf, sessionMcpOf } from "../github/mcp-egress.ts";
import { agentGitHubSettingsOf } from "../github-settings.ts";
import type { Database } from "../queries.ts";
import {
  agentCallerLimits,
  agentReleases,
  agents,
  agentUsage,
  agentVersions,
  catalogRepositories,
  memberTeamMembers,
  memberTeams,
  receipts,
} from "../schema.ts";
import { lockEditRight } from "../usage/agent-usage.ts";
import { createPostgresDecisionLog } from "./authz-decisions.ts";

// An edit takes rows in the order of agent-usage.ts: user → membership →
// agent → agent_usage → admin rows → teams (id order) → relation rows → the
// actor's member rows. Whoever writes this agent's rules holds its
// agent_usage row (this edit, a team's archive), so the rules need no lock of
// their own. The v1 API never sees a `user` rule, and an edit leaves those rows
// as they are.

type Reader = Pick<Database, "select">;
type Row = typeof agentCallerLimits.$inferSelect;

const sorted = (list: readonly string[] | null) =>
  list === null ? null : [...list].sort();

function ruleOf(row: Row): CallerLimitRuleFacts {
  const target: CallerLimitRuleFacts["target"] =
    row.targetKind === "team"
      ? { kind: "team", id: row.teamId as string }
      : row.targetKind === "channel"
        ? { kind: "channel", id: row.channelId as string }
        : row.targetKind === "user"
          ? { kind: "user", id: row.userId as string }
          : { kind: "workspace" };
  return {
    target,
    tools_deny: sorted(row.toolsDeny) ?? [],
    repositories: sorted(row.repositories),
    mcp_servers: sorted(row.mcpServers),
    credentials_deny: sorted(row.credentialsDeny) ?? [],
  };
}

const KIND_ORDER = { workspace: 0, team: 1, channel: 2, user: 3 } as const;

// A channel id is stored as sent and Slack's differ by case; only a uuid is lowered.
function keyOf(target: CallerLimitRuleFacts["target"]): string {
  if (target.kind === "workspace") return "workspace";
  return `${target.kind}:${target.kind === "channel" ? target.id : target.id.toLowerCase()}`;
}

function inOrder(rules: CallerLimitRuleFacts[]): CallerLimitRuleFacts[] {
  return rules.sort(
    (a, b) =>
      KIND_ORDER[a.target.kind] - KIND_ORDER[b.target.kind] ||
      keyOf(a.target).localeCompare(keyOf(b.target)),
  );
}

/** The rules, `user` rows included when asked, read in one statement with the revision. */
async function readFacts(
  tx: Reader,
  agentId: string,
  withUsers: boolean,
): Promise<CallerLimitsFacts | null> {
  // One statement, so the revision belongs to the rules beside it.
  const rows = await tx
    .select({
      revision: agentUsage.limitsRevision,
      rule: agentCallerLimits,
    })
    .from(agentUsage)
    .leftJoin(
      agentCallerLimits,
      and(
        eq(agentCallerLimits.agentId, agentUsage.agentId),
        withUsers ? undefined : ne(agentCallerLimits.targetKind, "user"),
      ),
    )
    .where(eq(agentUsage.agentId, agentId))
    .orderBy(asc(agentCallerLimits.id));
  const first = rows[0];
  if (!first) return null;
  return {
    rules: inOrder(
      rows.flatMap((row) => (row.rule === null ? [] : [ruleOf(row.rule)])),
    ),
    revision: first.revision,
  };
}

/**
 * The rules the enforcement layer reads in its own transaction.
 * Take it after the agent row, as `usageOf` does; with `lock` the agent_usage
 * row is held FOR SHARE, so an edit or a team's archive waits for this
 * transaction or is seen by it.
 */
export async function callerLimitsOf(
  tx: Reader,
  input: { workspaceId: string; agentId: string; lock: boolean },
): Promise<CallerLimitsFacts> {
  const base = tx
    .select({ agentId: agentUsage.agentId })
    .from(agentUsage)
    .where(
      and(
        eq(agentUsage.workspaceId, input.workspaceId),
        eq(agentUsage.agentId, input.agentId),
      ),
    );
  if (input.lock) await base.for("share");
  // An agent made by hand without its row reads as no rules.
  return (
    (await readFacts(tx, input.agentId, true)) ?? { rules: [], revision: 1 }
  );
}

type Caller = {
  workspaceId: string;
  agentId: string;
  userId: string | null;
  channelId: string | null;
};

async function liveRepositoryIds(
  tx: Reader,
  rules: readonly CallerLimitRuleFacts[],
): Promise<Set<string>> {
  const named = [...new Set(rules.flatMap((rule) => rule.repositories ?? []))];
  if (named.length === 0) return new Set();
  const rows = await tx
    .select({ id: catalogRepositories.id })
    .from(catalogRepositories)
    .where(
      and(
        inArray(catalogRepositories.id, named),
        isNull(catalogRepositories.removedAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * The limit that reaches the caller, merged from the agent's rules. With
 * `lock`, after callerLimitsOf's agent_usage share lock come the live teams
 * the rules name (id order) and then the caller's member rows of them, FOR
 * SHARE: the order of P1.6c, so a team's archive (agent_usage first) and a
 * member's removal (team, then member rows) either wait for this transaction
 * or are seen by it.
 */
async function callerLimitOf(
  tx: Reader,
  input: Caller,
  lock: boolean,
): Promise<CallerLimit | null> {
  const facts = await callerLimitsOf(tx, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    lock,
  });
  const named = [
    ...new Set(
      facts.rules.flatMap((rule) =>
        rule.target.kind === "team" ? [rule.target.id.toLowerCase()] : [],
      ),
    ),
  ].sort();
  let teamIds: string[] = [];
  if (input.userId !== null && named.length > 0) {
    const teams = tx
      .select({ id: memberTeams.id })
      .from(memberTeams)
      .where(
        and(
          eq(memberTeams.workspaceId, input.workspaceId),
          inArray(memberTeams.id, named),
          isNull(memberTeams.archivedAt),
        ),
      )
      .orderBy(asc(memberTeams.id));
    const live = (lock ? await teams.for("share") : await teams).map(
      (row) => row.id,
    );
    if (live.length > 0) {
      const mine = tx
        .select({ teamId: memberTeamMembers.teamId })
        .from(memberTeamMembers)
        .where(
          and(
            inArray(memberTeamMembers.teamId, live),
            eq(memberTeamMembers.userId, input.userId.toLowerCase()),
            isNull(memberTeamMembers.removedAt),
          ),
        )
        .orderBy(asc(memberTeamMembers.teamId), asc(memberTeamMembers.id));
      teamIds = (lock ? await mine.for("share") : await mine).map(
        (row) => row.teamId,
      );
    }
  }
  const live = await liveRepositoryIds(tx, facts.rules);
  return mergeCallerLimit(
    withLiveRepositories(facts.rules, (id) => live.has(id)),
    { teamIds, channelId: input.channelId },
    facts.revision,
  );
}

/**
 * A session create's or input's own read of the limit, inside its
 * transaction and after `lockAgentUsage` (the agent and agent_usage rows come
 * first, then the teams and members read here).
 */
export function lockCallerLimit(
  tx: Database,
  input: Caller,
): Promise<CallerLimit | null> {
  return callerLimitOf(tx, input, true);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

type ReleaseFacts = {
  agentId: string;
  credentialRefs: string[];
  server: string | null;
  snapshot: unknown;
  effectiveTools: unknown;
};

async function releaseFacts(
  tx: Reader,
  releaseId: string,
): Promise<ReleaseFacts | null> {
  const [row] = await tx
    .select({
      agentId: agentReleases.agentId,
      card: agentVersions.card,
      snapshot: agentReleases.runtimeConfigSnapshot,
      effectiveTools: agentReleases.effectiveTools,
    })
    .from(agentReleases)
    .innerJoin(agentVersions, eq(agentVersions.id, agentReleases.versionId))
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  if (!row) return null;
  const capabilities = (
    row.card as {
      capabilities?: { credential_refs?: unknown; mcp?: unknown };
    } | null
  )?.capabilities;
  const first = Array.isArray(capabilities?.mcp)
    ? (capabilities.mcp[0] as { server?: unknown } | undefined)
    : undefined;
  return {
    agentId: row.agentId,
    credentialRefs: strings(capabilities?.credential_refs),
    server: typeof first?.server === "string" ? first.server : null,
    snapshot: row.snapshot,
    effectiveTools: row.effectiveTools,
  };
}

// The union of what the card and the release declare and what the MCP route
// and the built-in GitHub server expose to the session: a tool or server any
// of them reaches counts.
async function reachOf(
  tx: Database,
  releaseId: string,
  release: ReleaseFacts,
  input: {
    builtinTools: readonly string[];
    mcpStart: McpStart | null;
    githubPolicySource: string;
    repositories: readonly string[];
  },
): Promise<SessionReach> {
  const exposed = await sessionMcpOf(tx, {
    agentReleaseId: releaseId,
    mcpStart: input.mcpStart,
  });
  const github = await sessionGitHubMcpOf(tx, {
    agentReleaseId: releaseId,
    githubPolicySource: input.githubPolicySource,
  });
  const declared =
    input.mcpStart === null ? release.server : input.mcpStart.server;
  const servers = new Set<string>();
  for (const server of [declared, exposed?.server ?? null]) {
    if (server !== null) servers.add(server);
  }
  if (github !== null && github.tools.length > 0)
    servers.add(GITHUB_MCP_SERVER);
  const effective = effectiveToolsSchema.safeParse(release.effectiveTools);
  return {
    tools: [
      ...new Set([
        ...input.builtinTools,
        ...(effective.success ? effective.data.mcp : []),
        ...(exposed?.tools ?? []),
        ...(github?.tools ?? []),
      ]),
    ],
    repositories: input.repositories,
    mcp_servers: [...servers],
    credentials:
      input.mcpStart === null
        ? release.credentialRefs
        : input.mcpStart.credential_refs,
  };
}

function releaseBuiltinTools(release: ReleaseFacts): string[] {
  const effective = effectiveToolsSchema.safeParse(release.effectiveTools);
  return effective.success ? effective.data.tools : [];
}

// A session started on a release always runs that release's tools.
export async function startReach(
  tx: Database,
  input: {
    releaseId: string;
    mcpStart: McpStart | null;
    githubPolicySource: string;
    repositoryIds: readonly string[];
  },
): Promise<SessionReach | null> {
  const release = await releaseFacts(tx, input.releaseId);
  if (!release) return null;
  return reachOf(tx, input.releaseId, release, {
    builtinTools: releaseBuiltinTools(release),
    mcpStart: input.mcpStart,
    githubPolicySource: input.githubPolicySource,
    repositories: input.repositoryIds,
  });
}

// A session whose attached list is null may attach any repository its GitHub
// policy lists, so those count as its reach.
async function policyRepositories(
  tx: Database,
  releaseId: string,
  agentId: string,
  session: { githubPolicySource: unknown; githubPolicyStart: unknown },
): Promise<string[]> {
  const [pinned] = await tx
    .select({ pin: sql<unknown>`${agentReleases.policyPins} -> 'github'` })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  const policy = effectiveGitHubPolicy({
    source: session.githubPolicySource,
    releasePin: pinned?.pin ?? null,
    agentRow: await agentGitHubSettingsOf(tx, agentId),
    start: session.githubPolicyStart,
    attachedRepositoryIds: null,
  });
  return policy.settings === null || policy.settings === "invalid"
    ? []
    : policy.settings.repositories;
}

export async function sessionReach(
  tx: Database,
  session: {
    agentReleaseId: string | null;
    repositoryId: string | null;
    attachedRepositoryIds: readonly string[] | null;
    mcpStart: unknown;
    githubPolicySource: string;
    githubPolicyStart: unknown;
  },
): Promise<SessionReach | null> {
  if (session.agentReleaseId === null) return null;
  const release = await releaseFacts(tx, session.agentReleaseId);
  if (!release) return null;
  const attached =
    session.attachedRepositoryIds ??
    (await policyRepositories(
      tx,
      session.agentReleaseId,
      release.agentId,
      session,
    ));
  return reachOf(tx, session.agentReleaseId, release, {
    builtinTools: releaseBuiltinTools(release),
    mcpStart: mcpStartSchema.safeParse(session.mcpStart).data ?? null,
    githubPolicySource: session.githubPolicySource,
    repositories: [
      ...(session.repositoryId === null ? [] : [session.repositoryId]),
      ...attached,
    ],
  });
}

export function pinnedLimitOf(value: unknown): CallerLimit | null {
  const pinned = value as Partial<CallerLimit> | null;
  return pinned !== null &&
    typeof pinned === "object" &&
    pinned.v === 1 &&
    Array.isArray(pinned.tools_deny) &&
    Array.isArray(pinned.credentials_deny)
    ? (pinned as CallerLimit)
    : null;
}

/**
 * The built-in tools a session's pinned limit denies. `mcp__` names are left
 * to the MCP paths. Only a session with no limit at all (null, from before
 * limits were pinned) denies nothing; a limit this image cannot read throws,
 * so the claim fails rather than run the session without its limit.
 */
export function builtinToolsDenyOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const deny = (value as { v?: unknown; tools_deny?: unknown }).tools_deny;
  if (
    typeof value !== "object" ||
    (value as { v?: unknown }).v !== 1 ||
    !Array.isArray(deny) ||
    !deny.every((tool) => typeof tool === "string")
  ) {
    throw new Error("sessions.caller_limit is not a readable v1 limit");
  }
  return deny.filter((tool: string) => !tool.startsWith("mcp__"));
}

export function inputRefusal(
  sender: CallerLimit | null,
  reach: SessionReach,
  pinned: CallerLimit | null,
): CallerLimitDimension | null {
  return callerLimitRefusal(sender, narrowReach(reach, pinned));
}

export async function recordCallerLimited(
  tx: Database,
  input: {
    subject: AuthorizationSubject;
    ownerId: string;
    requestId: string;
    agentId: string;
    releaseId: string;
    sessionId: string | null;
  },
): Promise<void> {
  await createPostgresDecisionLog(tx).record(
    callerLimitedEntry({ ...input, decisionId: randomUUID() }),
  );
}

export function createPostgresCallerLimitGate(db: Database): CallerLimitGate {
  return {
    async startRefusal(input) {
      const limit = await callerLimitOf(db, input, false);
      if (limit === null) return null;
      const reach = await startReach(db, {
        releaseId: input.releaseId,
        mcpStart: await captureMcpStart(db, input.releaseId),
        githubPolicySource: input.githubPolicySource,
        repositoryIds: input.repositoryIds,
      });
      const dimension =
        reach === null ? null : callerLimitRefusal(limit, reach);
      if (dimension !== null) {
        await recordCallerLimited(db, {
          subject: input.subject,
          ownerId: input.workspaceId,
          requestId: input.requestId,
          agentId: input.agentId,
          releaseId: input.releaseId,
          sessionId: null,
        }).catch(() => undefined);
      }
      return dimension;
    },
  };
}

function sameRule(a: CallerLimitRuleFacts, b: CallerLimitRuleFacts): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function put(
  db: Database,
  input: Parameters<AgentCallerLimitsStore["put"]>[0],
): Promise<PutAgentCallerLimitsResult> {
  const { actor } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  const agentId = input.agentId.toLowerCase();
  const workspaceId = actor.workspaceId;
  const wanted = inOrder(
    input.rules.map((rule) => ({
      target:
        rule.target.kind === "team"
          ? { kind: "team" as const, id: rule.target.id.toLowerCase() }
          : rule.target,
      tools_deny: sorted(rule.tools_deny) ?? [],
      repositories: sorted(rule.repositories),
      mcp_servers: sorted(rule.mcp_servers),
      credentials_deny: sorted(rule.credentials_deny) ?? [],
    })),
  );
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, workspaceId, [actor.userId]);
    const me = people.find((p) => p.userId === actor.userId);
    if (!me?.live) return { outcome: "actor_inactive" };
    const manager = (input.managerRoles as readonly string[]).includes(me.role);

    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
      .for("no key update");
    if (!agent) return { outcome: manager ? "not_found" : "actor_inactive" };

    await tx
      .insert(agentUsage)
      .values({ agentId, workspaceId })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.agentId, agentId))
      .for("update");
    if (!usage) throw new Error(`agent_usage ${agentId} vanished under a lock`);

    const stored = await readFacts(tx, agentId, false);
    if (!stored) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    const before = new Map(stored.rules.map((r) => [keyOf(r.target), r]));
    const added = wanted.flatMap((rule) =>
      rule.target.kind === "team" && !before.has(keyOf(rule.target))
        ? [rule.target.id]
        : [],
    );

    const right = await lockEditRight(tx, {
      workspaceId,
      agentId,
      actorUserId: actor.userId,
      manager,
      added,
    });
    if (!right) return { outcome: "actor_inactive" };
    if (usage.limitsRevision !== input.ifMatch) {
      return { outcome: "version_mismatch", current: usage.limitsRevision };
    }
    if (added.some((id) => !right.liveTeams.has(id))) {
      return { outcome: "team_not_found" };
    }
    if (!manager && added.some((id) => !right.roleIn.has(id))) {
      return { outcome: "team_not_allowed" };
    }

    // Only an id this edit adds to its target is looked up: one the target
    // already holds passes after the catalog dropped it, so the rule's other
    // fields stay editable.
    const newRepositories = [
      ...new Set(
        wanted.flatMap((rule) => {
          const held = before.get(keyOf(rule.target))?.repositories ?? [];
          return (rule.repositories ?? []).filter((id) => !held.includes(id));
        }),
      ),
    ];
    if (newRepositories.length > 0) {
      const live = new Set(
        (
          await tx
            .select({ id: catalogRepositories.id })
            .from(catalogRepositories)
            .where(
              and(
                inArray(catalogRepositories.id, newRepositories),
                isNull(catalogRepositories.removedAt),
              ),
            )
        ).map((row) => row.id),
      );
      const missing = newRepositories.filter((id) => !live.has(id)).sort();
      if (missing.length > 0) {
        return { outcome: "repository_not_in_catalog", repositoryIds: missing };
      }
    }

    const unchanged =
      wanted.length === stored.rules.length &&
      wanted.every((rule) => {
        const held = before.get(keyOf(rule.target));
        return held !== undefined && sameRule(held, rule);
      });
    if (unchanged) {
      return { outcome: "unchanged", limits: toLimits(stored) };
    }

    await tx
      .delete(agentCallerLimits)
      .where(
        and(
          eq(agentCallerLimits.agentId, agentId),
          ne(agentCallerLimits.targetKind, "user"),
        ),
      );
    if (wanted.length > 0) {
      await tx.insert(agentCallerLimits).values(
        wanted.map((rule) => ({
          agentId,
          workspaceId,
          targetKind: rule.target.kind as "workspace" | "team" | "channel",
          teamId: rule.target.kind === "team" ? rule.target.id : null,
          channelId: rule.target.kind === "channel" ? rule.target.id : null,
          toolsDeny: rule.tools_deny,
          repositories: rule.repositories,
          mcpServers: rule.mcp_servers,
          credentialsDeny: rule.credentials_deny,
          createdBy: actor.userId,
        })),
      );
    }
    await tx
      .update(agentUsage)
      .set({
        limitsRevision: sql`${agentUsage.limitsRevision} + 1`,
        updatedBy: actor.userId,
        updatedAt: DB_NOW,
      })
      .where(eq(agentUsage.agentId, agentId));
    const next = await readFacts(tx, agentId, false);
    if (!next) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "set_agent_caller_limits",
      targetRef: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
      result: {
        from: { rules: stored.rules },
        to: { rules: next.rules },
        revision: next.revision,
      },
      status: "succeeded",
      requestId: actor.principal.requestId ?? null,
    });
    return { outcome: "set", limits: toLimits(next) };
  });
}

// The API's rules never name a person.
function toLimits(facts: CallerLimitsFacts): AgentCallerLimits {
  return {
    rules: facts.rules.filter(
      (rule): rule is AgentCallerLimitRule => rule.target.kind !== "user",
    ),
    revision: facts.revision,
  };
}

export function createPostgresAgentCallerLimitsStore(
  db: Database,
): AgentCallerLimitsStore {
  return {
    async get(workspaceId, agentId) {
      if (!UUID.test(workspaceId) || !UUID.test(agentId)) return null;
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      if (!agent) return null;
      // An agent without a row reads as the default it would be given.
      const facts = (await readFacts(db, id, false)) ?? {
        rules: [],
        revision: 1,
      };
      return toLimits(facts);
    },
    put: (input) => put(db, input),
  };
}
