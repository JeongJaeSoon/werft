import type { SessionScope, WorkspaceRole } from "@werft-ai/contracts";
import { WORKSPACE_MANAGER_ROLES } from "@werft-ai/contracts";
import type { Principal, UsageDecision } from "@werft-ai/platform";
import { and, arrayContains, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { lockActorAccount } from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import { reachesBeforePublishNow } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agentReleases,
  agents,
  apiKeys,
  linkedAccounts,
  memberships,
  memberTeamMembers,
  memberTeams,
  sessionShares,
  sessionShareTargets,
  users,
} from "../schema.ts";
import { usageOf } from "../usage/index.ts";

// A session create, input or answer is decided by the policy before its
// write opens, so the write judges the requester and their reach again over
// share-locked rows: a revocation that commits since either waits for the
// write or is seen by it. Every such write, and every write that
// revokes what they rely on, takes rows in this one order:
//
//   user → membership → linked account → api key → session → workspace →
//   agent → agent_usage → agent_admins → member_teams (id order) →
//   agent_admin_teams · agent_usage_targets · session_shares ·
//   session_share_targets → member_team_members (id order)
//
// A team's archive takes the agent_usage rows of the agents that list it,
// in id order, before the team (member-teams.ts, delete).

const MANAGERS: readonly WorkspaceRole[] = WORKSPACE_MANAGER_ROLES;

export type Requester = {
  userId: string | null;
  apiKeyId: string | null;
  /** The person's role now: the user's, or a personal key's creator's. */
  role: WorkspaceRole | null;
  /**
   * Set for a service key bound to one agent, and for a Slack bot that
   * agent allows.
   */
  keyAgentId: string | null;
  /** The allowed Slack bot whose mention this is; no person or key. */
  slackBotUserId: string | null;
};

/**
 * Who asks, as it stands now, before the session row: the person's user and
 * membership, the Slack link they spoke through, the key they hold. Null when
 * any of them is gone.
 */
export async function lockRequester(
  tx: Database,
  principal: Principal,
  scope: SessionScope,
): Promise<Requester | null> {
  const actor = principal.actor;
  const requester: Requester = {
    userId: actor?.userId?.toLowerCase() ?? null,
    apiKeyId: actor?.apiKeyId?.toLowerCase() ?? null,
    role: null,
    keyAgentId: null,
    slackBotUserId: actor?.slackBotUserId ?? null,
  };
  // AUTH_MODE=none and keys from before workspaces have no members to lose.
  if (!actor?.workspaceId) {
    return requester.slackBotUserId === null ? requester : null;
  }
  const workspaceId = actor.workspaceId;
  // A bot is no person and no key: it acts as the agent that allows it.
  // The agent row comes later in the lock order, so lockAgentUsage holds
  // the allow list; this read only turns a bot already removed away.
  if (requester.slackBotUserId !== null) {
    const agentId = actor.agentId?.toLowerCase() ?? null;
    if (
      agentId === null ||
      requester.userId !== null ||
      requester.apiKeyId !== null ||
      actor.linkedAccount !== undefined ||
      !(await allowsSlackBot(
        tx,
        workspaceId,
        agentId,
        requester.slackBotUserId,
      ))
    ) {
      return null;
    }
    requester.keyAgentId = agentId;
    return requester;
  }
  if (requester.userId !== null) {
    await lockActorAccount(tx, requester.userId);
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, requester.userId),
          isNull(memberships.disabledAt),
          isNull(users.disabledAt),
        ),
      )
      .limit(1)
      .for("share", { of: memberships });
    if (!member) return null;
    requester.role = member.role as WorkspaceRole;
  }
  if (actor.linkedAccount !== undefined) {
    const [link] = await tx
      .select({ id: linkedAccounts.id })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.id, actor.linkedAccount.id.toLowerCase()),
          eq(linkedAccounts.workspaceId, workspaceId),
          eq(linkedAccounts.userId, requester.userId ?? ""),
          eq(linkedAccounts.status, "active"),
          eq(linkedAccounts.revision, actor.linkedAccount.revision),
        ),
      )
      .limit(1)
      .for("share");
    if (!link) return null;
  }
  if (requester.apiKeyId !== null) {
    const [key] = await tx
      .select({
        kind: apiKeys.kind,
        createdByUserId: apiKeys.createdByUserId,
        agentId: apiKeys.agentId,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
        holds: arrayContains(apiKeys.scopes, [scope]),
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, requester.apiKeyId),
          eq(apiKeys.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .for("share");
    if (!key || key.revokedAt !== null || !key.holds) return null;
    // Expiry against the clock after the lock: a lock wait on a row nobody
    // changed does not re-check the WHERE, and the key may lapse meanwhile.
    if (key.expiresAt !== null && key.expiresAt <= (await dbNow(tx))) {
      return null;
    }
    const personal = key.kind === "personal";
    if (personal !== (requester.userId !== null)) return null;
    if (personal && key.createdByUserId !== requester.userId) return null;
    requester.keyAgentId = key.agentId;
  }
  return requester;
}

async function allowsSlackBot(
  tx: Database,
  workspaceId: string,
  agentId: string,
  botUserId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.id, agentId.toLowerCase()),
        ne(agents.status, "archived"),
        arrayContains(agents.slackAllowedBotUserIds, [botUserId]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether a key bound to an agent may act on what `releaseId` runs. */
export async function keyReaches(
  tx: Database,
  requester: Requester,
  releaseId: string | null,
): Promise<boolean> {
  if (requester.keyAgentId === null) return true;
  if (releaseId === null) return false;
  const [release] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  return release?.agentId === requester.keyAgentId;
}

/**
 * Whether the requester may use `releaseId`'s agent, judged again over the
 * rows the policy's usage decision rests on: agent, agent_usage,
 * every team it reads in id order, relation rows, member rows, in one pass
 * (`usageOf`). Take it before any helper that locks teams (lockAgentUse,
 * lockSessionReach): a team's archive holds agent_usage and then the team,
 * so a team lock taken first here would cross it.
 */
export async function lockAgentUsage(
  tx: Database,
  requester: Requester,
  workspaceId: string,
  releaseId: string,
): Promise<UsageDecision> {
  const [release] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  if (!release) return { allowed: false };
  const usage = await usageOf(tx, {
    workspaceId,
    agentId: release.agentId,
    who: {
      userId: requester.userId,
      role: requester.role,
      keyAgentId: requester.keyAgentId,
    },
    lock: true,
  });
  // usageOf holds the agent row now: a bot taken off its allow list since
  // waits for this write or is seen here.
  if (
    usage.allowed &&
    requester.slackBotUserId !== null &&
    !(await allowsSlackBot(
      tx,
      workspaceId,
      release.agentId,
      requester.slackBotUserId,
    ))
  ) {
    return { allowed: false };
  }
  return usage;
}

/**
 * The requester's own admin row of the agent, share-locked, and unless it is
 * there, the teams the agent lists as admins, read without a lock.
 */
async function lockDirectAdmin(
  tx: Database,
  workspaceId: string,
  agentId: string,
  userId: string,
): Promise<{ direct: boolean; adminTeams: string[] }> {
  const direct = await tx
    .select({ userId: agentAdmins.userId })
    .from(agentAdmins)
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
        eq(agentAdmins.userId, userId),
      ),
    )
    .limit(1)
    .for("share");
  if (direct.length > 0) return { direct: true, adminTeams: [] };
  const adminTeams = (
    await tx
      .select({ teamId: agentAdminTeams.teamId })
      .from(agentAdminTeams)
      .where(
        and(
          eq(agentAdminTeams.workspaceId, workspaceId),
          eq(agentAdminTeams.agentId, agentId),
        ),
      )
  ).map((row) => row.teamId);
  return { direct: false, adminTeams };
}

/** Those of `teamIds` not archived, share-locked in id order. */
async function lockLiveTeams(
  tx: Database,
  workspaceId: string,
  teamIds: string[],
): Promise<Set<string>> {
  return new Set(
    (
      await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            inArray(memberTeams.id, teamIds),
            isNull(memberTeams.archivedAt),
          ),
        )
        .orderBy(asc(memberTeams.id))
        .for("share")
    ).map((row) => row.id),
  );
}

/**
 * Those of `teamIds` the agent still lists as admins, share-locked: a team
 * removed from the agent since lockDirectAdmin read it is not lent any more.
 */
async function lockLending(
  tx: Database,
  workspaceId: string,
  agentId: string,
  teamIds: string[],
): Promise<string[]> {
  return (
    await tx
      .select({ teamId: agentAdminTeams.teamId })
      .from(agentAdminTeams)
      .where(
        and(
          eq(agentAdminTeams.workspaceId, workspaceId),
          eq(agentAdminTeams.agentId, agentId),
          inArray(agentAdminTeams.teamId, teamIds),
        ),
      )
      .orderBy(asc(agentAdminTeams.teamId))
      .for("share")
  ).map((row) => row.teamId);
}

/** The requester's live rows in `teamIds` with their roles, share-locked. */
function lockMemberRoles(tx: Database, teamIds: string[], userId: string) {
  return tx
    .select({ teamId: memberTeamMembers.teamId, role: memberTeamMembers.role })
    .from(memberTeamMembers)
    .where(
      and(
        inArray(memberTeamMembers.teamId, teamIds),
        eq(memberTeamMembers.userId, userId),
        isNull(memberTeamMembers.removedAt),
      ),
    )
    .orderBy(asc(memberTeamMembers.id))
    .for("share");
}

/**
 * The admin rows of an agent whose row the caller holds, in the documented
 * order: the requester's own admin row, the admin teams and the managing team
 * that are live (id order), then the admin teams still lent. With `direct`
 * nothing after it is read.
 */
async function lockAdminReach(
  tx: Database,
  workspaceId: string,
  agentId: string,
  managingTeamId: string,
  userId: string,
): Promise<{ direct: boolean; liveTeams: Set<string>; lending: string[] }> {
  const { direct, adminTeams } = await lockDirectAdmin(
    tx,
    workspaceId,
    agentId,
    userId,
  );
  if (direct) return { direct, liveTeams: new Set(), lending: [] };
  const teamIds = [...new Set([...adminTeams, managingTeamId])].sort();
  const liveTeams = await lockLiveTeams(tx, workspaceId, teamIds);
  if (liveTeams.size === 0) return { direct, liveTeams, lending: [] };
  const liveAdminTeams = adminTeams.filter((id) => liveTeams.has(id));
  const lending =
    liveAdminTeams.length === 0
      ? []
      : await lockLending(tx, workspaceId, agentId, liveAdminTeams);
  return { direct, liveTeams, lending };
}

/**
 * Whether the requester may start a session of `releaseId`'s agent, judged
 * again under the rows the policy's decision rests on: only those inside
 * the agent start it (agent-rbac (b)). After keyReaches, so an agent key is
 * already held to its own agent.
 */
export async function lockAgentUse(
  tx: Database,
  requester: Requester,
  workspaceId: string,
  releaseId: string,
): Promise<boolean> {
  if (requester.keyAgentId !== null) return true;
  if (requester.role !== null && MANAGERS.includes(requester.role)) {
    return true;
  }
  const { userId } = requester;
  if (userId === null) return false;
  const [agent] = await tx
    .select({
      id: agents.id,
      managingTeamId: agents.managingTeamId,
      activeReleaseId: agents.activeReleaseId,
    })
    .from(agents)
    .innerJoin(agentReleases, eq(agentReleases.agentId, agents.id))
    .where(
      and(eq(agentReleases.id, releaseId), eq(agents.workspaceId, workspaceId)),
    )
    .limit(1)
    .for("share", { of: agents });
  if (!agent) return false;
  const published = agent.activeReleaseId !== null;
  const { direct, liveTeams, lending } = await lockAdminReach(
    tx,
    workspaceId,
    agent.id,
    agent.managingTeamId,
    userId,
  );
  if (direct) return true;
  if (liveTeams.size === 0) return false;
  const reaching = [
    ...lending,
    ...(liveTeams.has(agent.managingTeamId) ? [agent.managingTeamId] : []),
  ];
  if (reaching.length === 0) return false;
  const member = await tx
    .select({ teamId: memberTeamMembers.teamId })
    .from(memberTeamMembers)
    .where(
      and(
        inArray(memberTeamMembers.teamId, [...liveTeams]),
        eq(memberTeamMembers.userId, userId),
        isNull(memberTeamMembers.removedAt),
      ),
    )
    .orderBy(asc(memberTeamMembers.id))
    .for("share");
  if (!member.some((row) => reaching.includes(row.teamId))) return false;
  // Over the rows held above: an unpublished agent lets in only its admins.
  return (
    published ||
    (await reachesBeforePublishNow(tx, workspaceId, userId, agent.id))
  );
}

/**
 * Whether the requester may feed a preview session of `agentId` now: a
 * person signed in themselves (no key, no Slack link) who manages the agent,
 * as a workspace owner or admin or one of its admins (`administers`). The
 * admin rows are share-locked here in the documented order, so a demotion
 * that commits after this either waits for the write or is seen by it.
 */
export async function lockPreviewManager(
  tx: Database,
  principal: Principal,
  requester: Requester,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const { userId } = requester;
  if (
    userId === null ||
    requester.apiKeyId !== null ||
    principal.actor?.linkedAccount !== undefined
  ) {
    return false;
  }
  if (requester.role !== null && MANAGERS.includes(requester.role)) {
    return true;
  }
  const [agent] = await tx
    .select({ managingTeamId: agents.managingTeamId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1)
    .for("share");
  if (!agent) return false;
  const { direct, liveTeams, lending } = await lockAdminReach(
    tx,
    workspaceId,
    agentId,
    agent.managingTeamId,
    userId,
  );
  if (direct) return true;
  if (liveTeams.size === 0) return false;
  const member = await lockMemberRoles(tx, [...liveTeams], userId);
  return member.some(
    (row) =>
      lending.includes(row.teamId) ||
      (row.teamId === agent.managingTeamId && row.role === "lead"),
  );
}

/**
 * `lockPreviewManager` for a write that has not judged the requester's use of
 * the agent yet (a resume, an answer): the use rows are taken first so the
 * admin rows read are held. The caller took `lockRequester` before the
 * session row.
 */
export async function lockPreviewFeed(
  tx: Database,
  principal: Principal,
  requester: Requester | null,
  session: { workspaceId: string | null; agentReleaseId: string | null },
): Promise<boolean> {
  const { workspaceId, agentReleaseId } = session;
  if (requester === null || workspaceId === null || agentReleaseId === null) {
    return false;
  }
  if (!(await lockAgentUse(tx, requester, workspaceId, agentReleaseId))) {
    return false;
  }
  const [release] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, agentReleaseId))
    .limit(1);
  if (!release) return false;
  return lockPreviewManager(
    tx,
    principal,
    requester,
    workspaceId,
    release.agentId,
  );
}

export type LockedSession = {
  id: string;
  workspaceId: string | null;
  createdByUserId: string | null;
  createdByApiKeyId: string | null;
  agentReleaseId: string | null;
};

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * After the session row: whether the requester still sees the session
 * (`sessionVisibleTo`), and with `answer`, still answers for it (the
 * policy's `mayAnswer`), over the rows those rest on.
 */
export async function lockSessionReach(
  tx: Database,
  requester: Requester,
  session: LockedSession,
  options: { answer?: boolean } = {},
): Promise<"ok" | "not_found" | "role"> {
  const { userId, apiKeyId } = requester;
  const workspaceId = session.workspaceId;
  // A session from before workspaces has no share and nobody beside its
  // owner to answer for it.
  if (workspaceId === null) return "ok";

  const creator =
    session.createdByUserId !== null
      ? same(session.createdByUserId, userId)
      : same(session.createdByApiKeyId, apiKeyId);
  const manager = requester.role !== null && MANAGERS.includes(requester.role);
  const answerer = !options.answer || manager || creator;

  // Read under the session row, which a share change now takes first.
  const [share] = await tx
    .select({ scope: sessionShares.scope })
    .from(sessionShares)
    .where(eq(sessionShares.sessionId, session.id))
    .limit(1);
  const scope = share?.scope ?? "workspace";
  const targets =
    scope === "people" || scope === "team"
      ? await tx
          .select({
            userId: sessionShareTargets.userId,
            teamId: sessionShareTargets.teamId,
          })
          .from(sessionShareTargets)
          .where(eq(sessionShareTargets.sessionId, session.id))
      : [];
  const owns =
    same(session.createdByUserId, userId) ||
    (session.createdByUserId === null &&
      same(session.createdByApiKeyId, apiKeyId));
  const named =
    scope === "people" && targets.some((t) => same(t.userId, userId));
  const shareTeams =
    !owns && !named && scope === "team" && userId !== null
      ? targets.flatMap((t) => (t.teamId === null ? [] : [t.teamId]))
      : [];
  // As sessionVisibleTo has it: a workspace-wide session of an agent reaches
  // only those inside the agent, unless the holding team of migration 0243
  // still holds it.
  let gated =
    scope === "workspace" &&
    !owns &&
    !manager &&
    session.agentReleaseId !== null;

  let agentId: string | null = null;
  let managingTeamId: string | null = null;
  let published = true;
  let directAdmin = false;
  let adminTeams: string[] = [];
  if (
    ((!answerer && userId !== null) || gated) &&
    session.agentReleaseId !== null
  ) {
    // The share lock queues this behind a change of the managing team.
    const [agent] = await tx
      .select({
        id: agents.id,
        managingTeamId: agents.managingTeamId,
        activeReleaseId: agents.activeReleaseId,
        holdsUnassigned: memberTeams.holdsUnassigned,
      })
      .from(agents)
      .innerJoin(agentReleases, eq(agentReleases.agentId, agents.id))
      .innerJoin(memberTeams, eq(memberTeams.id, agents.managingTeamId))
      .where(
        and(
          eq(agentReleases.id, session.agentReleaseId),
          eq(agents.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .for("share", { of: agents });
    agentId = agent?.id ?? null;
    managingTeamId = agent?.managingTeamId ?? null;
    published = agent?.activeReleaseId != null;
    // The holding team of migration 0243 does not limit who sees its agents'
    // workspace sessions, as sessionVisibleTo has it. A null team is no longer
    // "an agent without a team" (the column is NOT NULL): it only means the
    // release has no agent row left, and there is no team to gate on.
    if (
      managingTeamId === null ||
      agent?.holdsUnassigned ||
      same(agentId, requester.keyAgentId)
    ) {
      gated = false;
    }
  }
  if (agentId !== null && userId !== null) {
    ({ direct: directAdmin, adminTeams } = await lockDirectAdmin(
      tx,
      workspaceId,
      agentId,
      userId,
    ));
  }

  const leadTeams =
    !directAdmin && managingTeamId !== null ? [managingTeamId] : [];
  const teamIds = [
    ...new Set([...shareTeams, ...adminTeams, ...leadTeams]),
  ].sort();
  const liveTeams =
    teamIds.length === 0
      ? new Set<string>()
      : await lockLiveTeams(tx, workspaceId, teamIds);
  await tx
    .select({ sessionId: sessionShares.sessionId })
    .from(sessionShares)
    .where(eq(sessionShares.sessionId, session.id))
    .for("share");
  await tx
    .select({ id: sessionShareTargets.id })
    .from(sessionShareTargets)
    .where(eq(sessionShareTargets.sessionId, session.id))
    .orderBy(asc(sessionShareTargets.id))
    .for("share");
  const lending =
    agentId === null || adminTeams.length === 0
      ? new Set<string>()
      : new Set(
          await lockLending(
            tx,
            workspaceId,
            agentId,
            adminTeams.filter((id) => liveTeams.has(id)),
          ),
        );
  // Team id to the requester's role in it.
  const memberOf =
    userId === null || liveTeams.size === 0
      ? new Map<string, string>()
      : new Map(
          (await lockMemberRoles(tx, [...liveTeams], userId)).map((row) => [
            row.teamId,
            row.role,
          ]),
        );

  const inside =
    (directAdmin ||
      [...lending].some((id) => memberOf.has(id)) ||
      (managingTeamId !== null && memberOf.has(managingTeamId))) &&
    // Over the rows held above: an unpublished agent lets in only its admins.
    (published ||
      agentId === null ||
      userId === null ||
      (await reachesBeforePublishNow(tx, workspaceId, userId, agentId)));
  // Slack cannot be asked under the lock: a private channel's session is
  // the policy's call, made just before for this person; never a key's.
  const sees =
    scope === "private_channel"
      ? userId !== null &&
        apiKeyId === null &&
        requester.keyAgentId === null &&
        requester.slackBotUserId === null
      : owns ||
        named ||
        shareTeams.some((id) => memberOf.has(id)) ||
        (scope === "workspace" && (!gated || inside));
  if (!sees) return "not_found";
  if (answerer || directAdmin) return "ok";
  // The managing team's lead administers the agent, as administers() says.
  if (leadTeams.some((id) => memberOf.get(id) === "lead")) return "ok";
  return [...lending].some((id) => memberOf.has(id)) ? "ok" : "role";
}
