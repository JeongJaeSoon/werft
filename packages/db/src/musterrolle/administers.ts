import { WORKSPACE_MANAGER_ROLES } from "@werft-ai/contracts";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { UUID } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  agentUsage,
  agentUsageTargets,
  memberships,
  memberTeamMembers,
  memberTeams,
  users,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

// Aliased: callers pass an outer `agents.id` as `agentId`.
const managed = alias(agents, "managed_agent");

// The agent's managing team, live, and the person's live row in it.
function inManagingTeam(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string | SQLWrapper,
  agentId: string | SQLWrapper,
  lead: boolean,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(managed)
      .innerJoin(
        memberTeams,
        and(
          eq(memberTeams.id, managed.managingTeamId),
          isNull(memberTeams.archivedAt),
        ),
      )
      .innerJoin(
        memberTeamMembers,
        and(
          eq(memberTeamMembers.teamId, managed.managingTeamId),
          isNull(memberTeamMembers.removedAt),
          lead ? eq(memberTeamMembers.role, "lead") : undefined,
        ),
      )
      .where(
        and(
          eq(managed.workspaceId, workspaceId),
          eq(managed.id, agentId),
          eq(memberTeamMembers.userId, userId),
        ),
      ),
  );
}

// Admin through a team, as two joins from agent_admin_teams: the team, live,
// and a live member row in it.
export const liveAdminTeam = () =>
  and(
    eq(memberTeams.id, agentAdminTeams.teamId),
    isNull(memberTeams.archivedAt),
  );
export const liveAdminTeamMember = () =>
  and(
    eq(memberTeamMembers.teamId, agentAdminTeams.teamId),
    isNull(memberTeamMembers.removedAt),
  );

/**
 * True where `userId` administers `agentId` in `workspaceId`: an admin row of
 * their own, a live admin team they are a live member of, or the lead of the
 * agent's live managing team. Team membership is read here, at the decision,
 * never cached. Whether the person is still a live member of the workspace is
 * the caller's to join.
 */
export function administers(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string | SQLWrapper,
  agentId: string | SQLWrapper,
): SQL {
  const direct = db
    .select({ one: sql`1` })
    .from(agentAdmins)
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
        eq(agentAdmins.userId, userId),
      ),
    );
  const viaTeam = db
    .select({ one: sql`1` })
    .from(agentAdminTeams)
    .innerJoin(memberTeams, liveAdminTeam())
    .innerJoin(memberTeamMembers, liveAdminTeamMember())
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        eq(agentAdminTeams.agentId, agentId),
        eq(memberTeamMembers.userId, userId),
      ),
    );
  return or(
    exists(direct),
    exists(viaTeam),
    inManagingTeam(db, workspaceId, userId, agentId, true),
  ) as SQL;
}

const ownerRow = alias(memberships, "owner_membership");
const ownerUser = alias(users, "owner_user");

/**
 * True where someone live administers `agentId`: an enabled user, an enabled
 * member of `workspaceId`, for whom `administers` holds. Workspace owners and
 * admins do not count unless it holds for them too. Negated, it is what makes
 * an agent ownerless.
 */
export function hasOwner(
  db: Database,
  workspaceId: string | SQLWrapper,
  agentId: string | SQLWrapper,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(ownerRow)
      .innerJoin(
        ownerUser,
        and(eq(ownerUser.id, ownerRow.userId), isNull(ownerUser.disabledAt)),
      )
      .where(
        and(
          eq(ownerRow.workspaceId, workspaceId),
          isNull(ownerRow.disabledAt),
          administers(db, workspaceId, ownerRow.userId, agentId),
        ),
      ),
  );
}

const managerRow = alias(memberships, "manager_membership");
const publishedAgent = alias(agents, "published_agent");

function workspaceManager(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(managerRow)
      .where(
        and(
          eq(managerRow.workspaceId, workspaceId),
          eq(managerRow.userId, userId),
          inArray(managerRow.role, WORKSPACE_MANAGER_ROLES),
        ),
      ),
  );
}

/** True where `agentId` has an active release: it is published. */
export function agentPublished(
  db: Database,
  agentId: string | SQLWrapper,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(publishedAgent)
      .where(
        and(
          eq(publishedAgent.id, agentId),
          isNotNull(publishedAgent.activeReleaseId),
        ),
      ),
  );
}

/**
 * The one answer to "may `userId` reach this agent at all, published or
 * not": it is published, or they administer it, or they are a workspace
 * owner or admin. `insideAgent`, `agentUsable`, the locked re-judgements
 * (requester-locks.ts) and the usage facts (agent-usage.ts) all hold to it,
 * so an unpublished agent is hidden from its managing team's members and its
 * usage teams on every path alike.
 */
export function reachesBeforePublish(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string,
  agentId: string | SQLWrapper,
): SQL {
  return or(
    agentPublished(db, agentId),
    administers(db, workspaceId, userId, agentId),
    workspaceManager(db, workspaceId, userId),
  ) as SQL;
}

/** `reachesBeforePublish` read now, over the rows the caller already holds. */
export async function reachesBeforePublishNow(
  tx: Database,
  workspaceId: string,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`select ${reachesBeforePublish(tx, workspaceId, userId, agentId)} as ok`,
  );
  return rowsOf<{ ok: boolean }>(result)[0]?.ok === true;
}

/**
 * True where `userId`, a live member of `workspaceId`, is inside `agentId`:
 * an owner or admin, one of its admins (`administers`), or a live member of
 * its live managing team once the agent is published (`reachesBeforePublish`).
 */
export function insideAgent(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string,
  agentId: string | SQLWrapper,
): SQL {
  return and(
    liveMember(db, workspaceId, userId),
    or(
      workspaceManager(db, workspaceId, userId),
      administers(db, workspaceId, userId, agentId),
      inManagingTeam(db, workspaceId, userId, agentId, false),
    ),
    reachesBeforePublish(db, workspaceId, userId, agentId),
  ) as SQL;
}

const usageScope = alias(agentUsage, "usage_scope");
const usageTarget = alias(agentUsageTargets, "usage_target");
const usageTeam = alias(memberTeams, "usage_team");
const usageMember = alias(memberTeamMembers, "usage_member");

/**
 * The one SQL answer to "may this requester use this agent": the
 * session start's re-decision (`usageOf` in agent-usage.ts, which parity
 * tests run against this on the same rows), `GET /v1/usable-agents` and the
 * hiding of a private agent all read it.
 *
 * True where the key is bound to this very agent; or the agent is published
 * and open to the workspace (no usage row reads as open); or the requester is
 * a live member of the workspace and is inside the agent (`insideAgent`) or,
 * the agent published, in a live team the agent lists. A usage row without a team (a user row) lists no one. A
 * requester with no person and no matching key uses nothing private.
 */
export function agentUsable(
  db: Database,
  workspaceId: string | SQLWrapper,
  who: { userId: string | null; keyAgentId: string | null },
  agentId: string | SQLWrapper,
): SQL {
  const closed = exists(
    db
      .select({ one: sql`1` })
      .from(usageScope)
      .where(
        and(eq(usageScope.agentId, agentId), ne(usageScope.scope, "workspace")),
      ),
  );
  // An unpublished agent is open to no one by its usage (agent key aside):
  // only those `insideAgent` lets through, who reach it before publish.
  const branches: SQL[] = [
    and(sql`NOT ${closed}`, agentPublished(db, agentId)) as SQL,
  ];
  // A malformed id names nobody; it must not reach a uuid comparison.
  if (who.keyAgentId !== null && UUID.test(who.keyAgentId)) {
    branches.push(sql`${agentId} = ${who.keyAgentId.toLowerCase()}::uuid`);
  }
  if (who.userId !== null && UUID.test(who.userId)) {
    const userId = who.userId.toLowerCase();
    const listed = exists(
      db
        .select({ one: sql`1` })
        .from(usageTarget)
        .innerJoin(
          usageTeam,
          and(
            eq(usageTeam.id, usageTarget.teamId),
            isNull(usageTeam.archivedAt),
          ),
        )
        .innerJoin(
          usageMember,
          and(
            eq(usageMember.teamId, usageTarget.teamId),
            isNull(usageMember.removedAt),
          ),
        )
        .where(
          and(eq(usageTarget.agentId, agentId), eq(usageMember.userId, userId)),
        ),
    );
    branches.push(
      insideAgent(db, workspaceId, userId, agentId),
      and(
        liveMember(db, workspaceId, userId),
        listed,
        agentPublished(db, agentId),
      ) as SQL,
    );
  }
  return or(...branches) as SQL;
}

/**
 * `agentUsable` for someone who is also inside the agent: what hides an
 * agent's name and filter from a session reader. A key bound to the agent is
 * inside it.
 */
export function agentReachable(
  db: Database,
  workspaceId: string | SQLWrapper,
  who: { userId: string | null; keyAgentId: string | null },
  agentId: string | SQLWrapper,
): SQL {
  const inside: SQL[] = [];
  if (who.keyAgentId !== null && UUID.test(who.keyAgentId)) {
    inside.push(sql`${agentId} = ${who.keyAgentId.toLowerCase()}::uuid`);
  }
  if (who.userId !== null && UUID.test(who.userId)) {
    inside.push(
      insideAgent(db, workspaceId, who.userId.toLowerCase(), agentId),
    );
  }
  if (inside.length === 0) return sql`false`;
  return and(agentUsable(db, workspaceId, who, agentId), or(...inside)) as SQL;
}

export function credentialsAllowed(
  workspaceId: string | SQLWrapper,
  userId: string | null,
  agentId: string | SQLWrapper,
): SQL {
  const teams =
    userId !== null && UUID.test(userId)
      ? sql`l.team_id IN (
          SELECT m.team_id FROM member_team_members m
          JOIN member_teams t ON t.id = m.team_id
          WHERE m.user_id = ${userId.toLowerCase()}::uuid
            AND m.removed_at IS NULL AND t.archived_at IS NULL
            AND t.workspace_id = ${workspaceId})`
      : sql`false`;
  return sql`NOT EXISTS (
    SELECT 1 FROM agent_caller_limits l
    WHERE l.agent_id = ${agentId}
      AND l.workspace_id = ${workspaceId}
      AND (l.target_kind = 'workspace' OR (l.target_kind = 'team' AND ${teams}))
      AND l.credentials_deny && ARRAY(
        SELECT jsonb_array_elements_text(
          CASE WHEN s.agent_id IS NOT NULL THEN s.credential_refs
               ELSE coalesce(v.card -> 'capabilities' -> 'credential_refs', '[]'::jsonb) END)
        FROM agents a
        JOIN agent_releases r ON r.id = a.active_release_id
        JOIN agent_versions v ON v.id = r.version_id
        LEFT JOIN agent_mcp_settings s ON s.agent_id = a.id
        WHERE a.id = ${agentId}))`;
}

/** True while `userId` is an enabled member of `workspaceId`: a disabled member administers nothing. */
export function liveMember(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
          isNull(users.disabledAt),
        ),
      ),
  );
}
