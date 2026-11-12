import type { TeamMemberRole } from "@werft-ai/contracts";
import type {
  Team,
  TeamActor,
  TeamMember,
  TeamMembershipResult,
  TeamPage,
  TeamStore,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  containsPattern,
  findPgError,
  lockPeople,
  UUID,
} from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentAdminTeams,
  agentCallerLimits,
  agents,
  agentUsage,
  agentUsageTargets,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
} from "../schema.ts";
import {
  decodeTeamCursor,
  encodeTeamCursor,
  type TeamCursor,
} from "../sessions/cursors.ts";

// Teams (design 4.7). Lock order, everywhere here: the people
// involved (users, then memberships, in user_id order), the team, then team
// member rows — the order the rest of the identity writes take.

// Team lists page by (name, id), so a team renamed mid-walk can show again
// or not at all; the rest show exactly once.
const after = (cursor: TeamCursor | null) =>
  cursor
    ? sql`(${memberTeams.name}, ${memberTeams.id}) > (${cursor.name}::text, ${cursor.id}::uuid)`
    : undefined;

// Rows read with limit + 1: the extra one only says whether another page exists.
function pageOf<T extends { id: string; name: string }>(
  rows: T[],
  limit: number,
): TeamPage<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeTeamCursor({ name: last.name, id: last.id })
        : null,
  };
}

// The live teams a person is in now, narrowed by `also`.
function joinedTeams(
  db: Database,
  workspaceId: string,
  userId: string,
  also: SQL | undefined,
) {
  const user = userId.toLowerCase();
  return db
    .select({
      id: memberTeams.id,
      name: memberTeams.name,
      role: sql<TeamMemberRole>`${memberTeamMembers.role}`,
    })
    .from(memberTeams)
    .innerJoin(
      memberTeamMembers,
      and(
        eq(memberTeamMembers.teamId, memberTeams.id),
        eq(memberTeamMembers.userId, user),
        isNull(memberTeamMembers.removedAt),
      ),
    )
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        isNull(memberTeams.archivedAt),
        // A disabled member belongs to nothing.
        exists(
          db
            .select({ one: sql`1` })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.workspaceId, workspaceId),
                eq(memberships.userId, user),
                isNull(memberships.disabledAt),
                isNull(users.disabledAt),
              ),
            ),
        ),
        also,
      ),
    );
}

// D23: changing a team is the workspace's managers' alone.
const TEAM_MANAGERS = ["owner", "admin"];

type TeamOperation =
  | "create_team"
  | "rename_team"
  | "delete_team"
  | "add_team_member"
  | "remove_team_member"
  | "set_team_member_role";

async function actorManagesTeams(
  tx: Database,
  actor: TeamActor,
  others: readonly string[] = [],
) {
  const people = await lockPeople(tx, actor.workspaceId, [
    actor.userId,
    ...others,
  ]);
  const me = people.find((p) => p.userId === actor.userId);
  return me?.live === true && TEAM_MANAGERS.includes(me.role) ? people : null;
}

async function lockLiveTeam(tx: Database, workspaceId: string, teamId: string) {
  if (!UUID.test(teamId)) return null;
  const [row] = await tx
    .select()
    .from(memberTeams)
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        eq(memberTeams.id, teamId.toLowerCase()),
        isNull(memberTeams.archivedAt),
      ),
    )
    .for("update");
  return row ?? null;
}

// An archive races agents being given the team; past this many restarts it
// answers conflict and the caller asks again.
const ARCHIVE_ATTEMPTS = 3;

type Listing = { usage: string[]; limits: string[] };

// The agents that list the team (agent_usage_targets) and those with a caller
// limit rule for it (agent_caller_limits), each in agent id order.
async function readListing(tx: Database, teamId: string): Promise<Listing> {
  const usage = await tx
    .select({ agentId: agentUsageTargets.agentId })
    .from(agentUsageTargets)
    .where(eq(agentUsageTargets.teamId, teamId))
    .orderBy(asc(agentUsageTargets.agentId));
  const limits = await tx
    .select({ agentId: agentCallerLimits.agentId })
    .from(agentCallerLimits)
    .where(eq(agentCallerLimits.teamId, teamId))
    .orderBy(asc(agentCallerLimits.agentId));
  return {
    usage: usage.map((row) => row.agentId),
    limits: limits.map((row) => row.agentId),
  };
}

/**
 * The agents that list `teamId` or hold a rule for it, their agent_usage
 * rows locked in id order. Called before the team row is locked.
 */
async function lockUsageListing(
  tx: Database,
  teamId: string,
): Promise<Listing> {
  if (!UUID.test(teamId)) return { usage: [], limits: [] };
  const listing = await readListing(tx, teamId.toLowerCase());
  const ids = [...new Set([...listing.usage, ...listing.limits])].sort();
  if (ids.length > 0) {
    await tx
      .select({ id: agentUsage.agentId })
      .from(agentUsage)
      .where(inArray(agentUsage.agentId, ids))
      .orderBy(asc(agentUsage.agentId))
      .for("update");
  }
  return listing;
}

/** With the team locked: still the same agents list it. */
async function sameListing(
  tx: Database,
  teamId: string,
  locked: Listing,
): Promise<boolean> {
  const now = await readListing(tx, teamId);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  return same(now.usage, locked.usage) && same(now.limits, locked.limits);
}

async function teamOf(
  db: Database,
  row: typeof memberTeams.$inferSelect,
): Promise<Team> {
  const [counted] = await db
    .select({ n: count() })
    .from(memberTeamMembers)
    .where(
      and(
        eq(memberTeamMembers.teamId, row.id),
        isNull(memberTeamMembers.removedAt),
      ),
    );
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revision: row.revision,
    memberCount: counted?.n ?? 0,
  };
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  input: {
    id: string;
    operation: TeamOperation;
    targetRef: unknown;
    result: unknown;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation: input.operation,
    targetRef: input.targetRef,
    result: input.result,
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
}

function teamTarget(teamId: string, workspaceId: string) {
  return { resource: { kind: "team", id: teamId }, workspace_id: workspaceId };
}

// Two renames racing to one free name: the live-name index refuses the
// second. Any other unique violation (a reused receipt id) is not a name clash.
function isLiveNameTaken(error: unknown): boolean {
  return (
    findPgError(error, "23505")?.constraint === "member_teams_live_name_uniq"
  );
}

async function bumpRevision(tx: Database, teamId: string) {
  await tx
    .update(memberTeams)
    .set({ revision: sql`${memberTeams.revision} + 1` })
    .where(eq(memberTeams.id, teamId));
}

export function createPostgresTeamStore(db: Database): TeamStore {
  return {
    async create(input) {
      const { actor } = input;
      try {
        return await db.transaction(async (tx) => {
          if (!(await actorManagesTeams(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [row] = await tx
            .insert(memberTeams)
            .values({
              id: input.teamId,
              workspaceId: actor.workspaceId,
              name: input.name,
              createdBy: actor.userId,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) return { outcome: "name_taken" as const };
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "create_team",
            targetRef: teamTarget(row.id, actor.workspaceId),
            result: { name: row.name },
          });
          return { outcome: "created" as const, team: await teamOf(tx, row) };
        });
      } catch (error) {
        if (isLiveNameTaken(error)) return { outcome: "name_taken" };
        throw error;
      }
    },

    async rename(input) {
      const { actor } = input;
      try {
        return await db.transaction(async (tx) => {
          if (!(await actorManagesTeams(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
          if (!team) return { outcome: "not_found" as const };
          if (team.name === input.name) {
            return {
              outcome: "unchanged" as const,
              team: await teamOf(tx, team),
            };
          }
          const [taken] = await tx
            .select({ id: memberTeams.id })
            .from(memberTeams)
            .where(
              and(
                eq(memberTeams.workspaceId, actor.workspaceId),
                eq(memberTeams.name, input.name),
                isNull(memberTeams.archivedAt),
              ),
            );
          if (taken) return { outcome: "name_taken" as const };
          const [row] = await tx
            .update(memberTeams)
            .set({
              name: input.name,
              revision: sql`${memberTeams.revision} + 1`,
            })
            .where(eq(memberTeams.id, team.id))
            .returning();
          if (!row) throw new Error(`team ${team.id} vanished under its lock`);
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "rename_team",
            targetRef: teamTarget(team.id, actor.workspaceId),
            result: { from: team.name, to: row.name },
          });
          return { outcome: "renamed" as const, team: await teamOf(tx, row) };
        });
      } catch (error) {
        if (isLiveNameTaken(error)) return { outcome: "name_taken" };
        throw error;
      }
    },

    async delete(input) {
      // The agents that list the team are known only once its row is locked,
      // yet their agent_usage rows come before the team in the lock order. So
      // an attempt names them, locks them, locks the team and reads again; a
      // change in between ends the attempt (nothing written, every lock
      // released) and the next one starts from the new list.
      const { actor } = input;
      for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS; attempt++) {
        const result = await db.transaction(async (tx) => {
          if (!(await actorManagesTeams(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const listing = await lockUsageListing(tx, input.teamId);
          const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
          if (!team) return { outcome: "not_found" as const };
          if (!(await sameListing(tx, team.id, listing))) {
            return { outcome: "restart" as const };
          }
          // Not locked: naming a managing team share-locks this team row, so a
          // naming in flight committed before the lock above or reads the
          // archive after it.
          const managed = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.managingTeamId, team.id),
                ne(agents.status, "archived"),
              ),
            )
            .orderBy(asc(agents.id));
          if (managed.length > 0) {
            return {
              outcome: "manages_agents" as const,
              agentIds: managed.map((row) => row.id),
            };
          }
          // The authority a team lent ends with it; the member rows stay as
          // history behind an archived team that no decision reads.
          const dropped = await tx
            .delete(agentAdminTeams)
            .where(eq(agentAdminTeams.teamId, team.id))
            .returning({ agentId: agentAdminTeams.agentId });
          // The agents' usage lists lose the team; their revisions move so an
          // If-Match read before the archive no longer matches.
          if (listing.usage.length > 0) {
            await tx
              .delete(agentUsageTargets)
              .where(eq(agentUsageTargets.teamId, team.id));
            await tx
              .update(agentUsage)
              .set({
                revision: sql`${agentUsage.revision} + 1`,
                updatedAt: DB_NOW,
              })
              .where(inArray(agentUsage.agentId, listing.usage));
          }
          // Likewise the rules for the team, and the revision their edits
          // are matched against; an agent with no rule for it keeps its own.
          if (listing.limits.length > 0) {
            await tx
              .delete(agentCallerLimits)
              .where(eq(agentCallerLimits.teamId, team.id));
            await tx
              .update(agentUsage)
              .set({
                limitsRevision: sql`${agentUsage.limitsRevision} + 1`,
                updatedAt: DB_NOW,
              })
              .where(inArray(agentUsage.agentId, listing.limits));
          }
          await tx
            .update(memberTeams)
            .set({
              archivedAt: sql`now()`,
              revision: sql`${memberTeams.revision} + 1`,
            })
            .where(eq(memberTeams.id, team.id));
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "delete_team",
            targetRef: teamTarget(team.id, actor.workspaceId),
            result: {
              name: team.name,
              agent_ids: dropped.map((row) => row.agentId),
              usage_agent_ids: listing.usage,
              limits_agent_ids: listing.limits,
            },
          });
          return { outcome: "deleted" as const };
        });
        if (result.outcome !== "restart") return result;
      }
      return { outcome: "conflict" };
    },

    addMember(input) {
      return changeMember(db, input, true);
    },

    removeMember(input) {
      return changeMember(db, input, false);
    },

    setMemberRole(input) {
      const { actor } = input;
      if (!UUID.test(input.userId))
        return Promise.resolve({ outcome: "not_found" });
      const userId = input.userId.toLowerCase();
      return db.transaction(async (tx) => {
        const people = await actorManagesTeams(tx, actor, [userId]);
        if (!people) return { outcome: "actor_inactive" };
        const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
        if (!team) return { outcome: "not_found" };
        const [current] = await tx
          .select({ id: memberTeamMembers.id, role: memberTeamMembers.role })
          .from(memberTeamMembers)
          .where(
            and(
              eq(memberTeamMembers.teamId, team.id),
              eq(memberTeamMembers.userId, userId),
              isNull(memberTeamMembers.removedAt),
            ),
          )
          .for("update");
        if (!current) return { outcome: "not_found" };
        if (!people.some((p) => p.userId === userId && p.live)) {
          return { outcome: "member_disabled" };
        }
        if (current.role === input.role) {
          return { outcome: "unchanged", team: await teamOf(tx, team) };
        }
        await tx
          .update(memberTeamMembers)
          .set({ role: input.role })
          .where(eq(memberTeamMembers.id, current.id));
        await bumpRevision(tx, team.id);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "set_team_member_role",
          targetRef: { user_id: userId, workspace_id: actor.workspaceId },
          result: {
            team_id: team.id,
            team_name: team.name,
            from: current.role,
            to: input.role,
          },
        });
        const [after] = await tx
          .select()
          .from(memberTeams)
          .where(eq(memberTeams.id, team.id));
        if (!after) throw new Error(`team ${team.id} vanished under its lock`);
        return { outcome: "changed", team: await teamOf(tx, after) };
      });
    },

    async list(workspaceId, query) {
      const cursor = query.cursor ? decodeTeamCursor(query.cursor) : null;
      if (!UUID.test(workspaceId)) return { items: [], nextCursor: null };
      // Inside a select list drizzle renders a column without its table, so a
      // bare "id" here would bind to member_team_members.id.
      const outerTeamId = sql`${memberTeams}.${sql.identifier(memberTeams.id.name)}`;
      const rows = await db
        .select({
          team: memberTeams,
          memberCount: sql<number>`(
            SELECT count(*)::int FROM ${memberTeamMembers}
            WHERE ${memberTeamMembers.teamId} = ${outerTeamId}
              AND ${memberTeamMembers.removedAt} IS NULL
          )`,
        })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            isNull(memberTeams.archivedAt),
            query.q === undefined
              ? undefined
              : sql`${memberTeams.name} ILIKE ${containsPattern(query.q)}`,
            after(cursor),
          ),
        )
        .orderBy(asc(memberTeams.name), asc(memberTeams.id))
        .limit(query.limit + 1);
      return pageOf(
        rows.map(({ team, memberCount }) => ({
          id: team.id,
          workspaceId: team.workspaceId,
          name: team.name,
          createdBy: team.createdBy,
          createdAt: team.createdAt,
          revision: team.revision,
          memberCount,
        })),
        query.limit,
      );
    },

    async listJoined(workspaceId, userId, query) {
      const cursor = query.cursor ? decodeTeamCursor(query.cursor) : null;
      if (!UUID.test(workspaceId) || !UUID.test(userId)) {
        return { items: [], nextCursor: null };
      }
      const rows = await joinedTeams(db, workspaceId, userId, after(cursor))
        .orderBy(asc(memberTeams.name), asc(memberTeams.id))
        .limit(query.limit + 1);
      return pageOf(rows, query.limit);
    },

    async isMember(workspaceId, teamId, userId) {
      if (!UUID.test(workspaceId) || !UUID.test(teamId) || !UUID.test(userId))
        return false;
      const rows = await joinedTeams(
        db,
        workspaceId,
        userId,
        eq(memberTeams.id, teamId.toLowerCase()),
      ).limit(1);
      return rows.length > 0;
    },

    async get(workspaceId, teamId) {
      if (!UUID.test(workspaceId) || !UUID.test(teamId)) return null;
      // One snapshot, so the revision, the count and the members agree.
      return db.transaction(
        async (tx) => {
          const [row] = await tx
            .select()
            .from(memberTeams)
            .where(
              and(
                eq(memberTeams.workspaceId, workspaceId),
                eq(memberTeams.id, teamId.toLowerCase()),
                isNull(memberTeams.archivedAt),
              ),
            );
          if (!row) return null;
          const rows = await tx
            .select({
              userId: memberTeamMembers.userId,
              email: users.email,
              displayName: users.displayName,
              role: sql<TeamMemberRole>`${memberTeamMembers.role}`,
              addedBy: memberTeamMembers.addedBy,
              addedAt: memberTeamMembers.addedAt,
              membershipDisabledAt: memberships.disabledAt,
              accountDisabledAt: users.disabledAt,
            })
            .from(memberTeamMembers)
            .innerJoin(users, eq(users.id, memberTeamMembers.userId))
            .leftJoin(
              memberships,
              and(
                eq(memberships.workspaceId, workspaceId),
                eq(memberships.userId, memberTeamMembers.userId),
              ),
            )
            .where(
              and(
                eq(memberTeamMembers.teamId, row.id),
                isNull(memberTeamMembers.removedAt),
              ),
            )
            .orderBy(
              asc(memberTeamMembers.addedAt),
              asc(memberTeamMembers.userId),
            );
          // Off in the workspace or suspended account-wide: either way the
          // row is inactive, as the member list reads it.
          const members: TeamMember[] = rows.map(
            ({ membershipDisabledAt, accountDisabledAt, ...member }) => ({
              ...member,
              disabledAt: membershipDisabledAt ?? accountDisabledAt,
            }),
          );
          return { ...(await teamOf(tx, row)), members };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}

async function changeMember(
  db: Database,
  input: Parameters<TeamStore["addMember"]>[0],
  add: boolean,
): Promise<TeamMembershipResult> {
  const { actor } = input;
  if (!UUID.test(input.userId)) {
    return { outcome: add ? "not_member" : "not_found" };
  }
  const userId = input.userId.toLowerCase();
  return db.transaction(async (tx) => {
    const people = await actorManagesTeams(tx, actor, [userId]);
    if (!people) return { outcome: "actor_inactive" };
    const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
    if (!team) return { outcome: "not_found" };
    const [current] = await tx
      .select({ id: memberTeamMembers.id })
      .from(memberTeamMembers)
      .where(
        and(
          eq(memberTeamMembers.teamId, team.id),
          eq(memberTeamMembers.userId, userId),
          isNull(memberTeamMembers.removedAt),
        ),
      )
      .for("update");
    if (add) {
      if (current) {
        return { outcome: "unchanged", team: await teamOf(tx, team) };
      }
      // A disabled member stays out: they would hold nothing through the
      // team, and adding them would read as if they did.
      if (!people.some((p) => p.userId === userId && p.live)) {
        return { outcome: "not_member" };
      }
      await tx.insert(memberTeamMembers).values({
        id: crypto.randomUUID(),
        workspaceId: actor.workspaceId,
        teamId: team.id,
        userId,
        addedBy: actor.userId,
      });
    } else {
      if (!current) {
        return { outcome: "unchanged", team: await teamOf(tx, team) };
      }
      // A disabled member's row stays as it was until they are reactivated.
      if (!people.some((p) => p.userId === userId && p.live)) {
        return { outcome: "member_disabled" };
      }
      await tx
        .update(memberTeamMembers)
        .set({ removedAt: sql`now()` })
        .where(eq(memberTeamMembers.id, current.id));
    }
    await bumpRevision(tx, team.id);
    // Written on the person, not the team: their receipt list is where they
    // learn which team they were put in or taken out of.
    await writeReceipt(tx, actor, {
      id: input.receiptId,
      operation: add ? "add_team_member" : "remove_team_member",
      targetRef: { user_id: userId, workspace_id: actor.workspaceId },
      result: { team_id: team.id, team_name: team.name },
    });
    const [after] = await tx
      .select()
      .from(memberTeams)
      .where(eq(memberTeams.id, team.id));
    if (!after) throw new Error(`team ${team.id} vanished under its lock`);
    return {
      outcome: add ? "added" : "removed",
      team: await teamOf(tx, after),
    };
  });
}
