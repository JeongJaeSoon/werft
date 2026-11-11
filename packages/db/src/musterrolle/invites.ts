import type {
  AcceptInviteInput,
  AcceptInviteResult,
  ActingOwner,
  ChangeRoleResult,
  CreateInviteResult,
  InvitePeek,
  InviteRecord,
  InviteStore,
  MemberRecord,
  MemberRowRecord,
  MembershipRole,
  RevokeInviteResult,
} from "@werft-ai/platform";
import {
  InvalidCursorError,
  MEMBER_MANAGER_ROLES,
  managesMembers,
  mayGrantRole,
  memberVerdict,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  containsPattern,
  lockActorAccount,
  receiptActorOf,
} from "../control-shared.ts";
import { DB_NOW, dbNow, fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  invites,
  loginMethods,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
  webSessions,
} from "../schema.ts";
import { decodeMemberCursor, encodeMemberCursor } from "../sessions/cursors.ts";
import { createWebSession } from "./identity.ts";

// Invites and roles (94S-153). Lock order, everywhere here: invite, then
// user, then membership, then web session — the user -> link -> session
// order of identity.ts with the invite in front of it.

type InviteRow = typeof invites.$inferSelect;

function statusOf(row: InviteRow, now: Date): InviteRecord["status"] {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt <= now ? "expired" : "pending";
}

function inviteRecord(row: InviteRow, now: Date): InviteRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role as MembershipRole,
    invitedBy: row.invitedBy,
    status: statusOf(row, now),
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export const memberColumns = {
  userId: users.id,
  email: users.email,
  displayName: users.displayName,
  role: memberships.role,
  disabledAt: sql<Date | null>`least(${memberships.disabledAt}, ${users.disabledAt})`,
  createdAt: memberships.createdAt,
};

export function memberRecord(row: {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  disabledAt: Date | string | null;
  createdAt: Date;
}): MemberRecord {
  return {
    ...row,
    role: row.role as MembershipRole,
    // A raw SQL expression comes back from the driver as text.
    disabledAt: row.disabledAt === null ? null : new Date(row.disabledAt),
  };
}

const liveMember = and(
  isNull(memberships.disabledAt),
  isNull(users.disabledAt),
);

/**
 * The actor's role while they still manage members, else null. FOR SHARE, so
 * a demotion or offboarding of the actor waits for this write.
 */
async function liveManagerRole(
  tx: Database,
  actor: ActingOwner,
): Promise<MembershipRole | null> {
  await lockActorAccount(tx, actor.userId);
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, actor.workspaceId),
        eq(memberships.userId, actor.userId),
        inArray(memberships.role, [...MEMBER_MANAGER_ROLES]),
        liveMember,
      ),
    )
    .for("share", { of: memberships });
  return (row?.role as MembershipRole | undefined) ?? null;
}

async function writeReceipt(
  tx: Database,
  input: {
    id: string;
    ownerId: string;
    actor: ReturnType<typeof receiptActorOf>;
    operation:
      | "invite_member"
      | "accept_invite"
      | "revoke_invite"
      | "change_member_role";
    targetRef: unknown;
    result: unknown;
  },
) {
  await tx.insert(receipts).values({ ...input, status: "succeeded" });
}

function inviteTarget(id: string, workspaceId: string) {
  return { resource: { kind: "invite", id }, workspace_id: workspaceId };
}

async function createInvite(
  db: Database,
  input: Parameters<InviteStore["createInvite"]>[0],
): Promise<CreateInviteResult> {
  const { actor } = input;
  return db.transaction(async (tx) => {
    // The live-invite unique index would turn two owners inviting the same
    // address at once into a 500; this makes the second one wait and
    // replace the first instead. Taken before any row lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`invite:${actor.workspaceId}:${input.email}`}))`,
    );
    const live = and(
      eq(invites.workspaceId, actor.workspaceId),
      eq(invites.email, input.email),
      isNull(invites.acceptedAt),
      isNull(invites.revokedAt),
    );
    // Invite rows before the actor's membership: the lock order above.
    await tx.select({ id: invites.id }).from(invites).where(live).for("update");
    const actorRole = await liveManagerRole(tx, actor);
    if (actorRole === null) return { outcome: "actor_inactive" };
    if (!mayGrantRole(actorRole, input.role)) {
      return { outcome: "owner_protected" };
    }
    const [member] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, actor.workspaceId),
          eq(users.email, input.email),
          isNull(memberships.disabledAt),
        ),
      )
      .limit(1);
    if (member) return { outcome: "already_member" };
    const replaced = await tx
      .update(invites)
      .set({ revokedAt: DB_NOW })
      .where(live)
      .returning({ id: invites.id });
    const [row] = await tx
      .insert(invites)
      .values({
        id: input.id,
        workspaceId: actor.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedBy: actor.userId,
        expiresAt: fromDbNow(input.ttlMs),
        createdAt: DB_NOW,
      })
      .returning();
    if (!row) throw new Error("invite insert returned no row");
    await writeReceipt(tx, {
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "invite_member",
      targetRef: inviteTarget(row.id, actor.workspaceId),
      result: {
        role: input.role,
        replaced_invite_ids: replaced.map((invite) => invite.id),
      },
    });
    return { outcome: "created", invite: inviteRecord(row, row.createdAt) };
  });
}

async function revokeInvite(
  db: Database,
  input: Parameters<InviteStore["revokeInvite"]>[0],
): Promise<RevokeInviteResult> {
  const { actor } = input;
  const id = input.id.toLowerCase();
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(
        and(eq(invites.id, id), eq(invites.workspaceId, actor.workspaceId)),
      )
      .for("update");
    if ((await liveManagerRole(tx, actor)) === null) {
      return { outcome: "actor_inactive" };
    }
    if (!invite) return { outcome: "not_found" };
    if (invite.acceptedAt) return { outcome: "accepted" };
    if (invite.revokedAt) return { outcome: "already_revoked" };
    await tx
      .update(invites)
      .set({ revokedAt: DB_NOW })
      .where(eq(invites.id, id));
    await writeReceipt(tx, {
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "revoke_invite",
      targetRef: inviteTarget(id, actor.workspaceId),
      result: null,
    });
    return { outcome: "revoked" };
  });
}

async function peekInvite(
  db: Database,
  tokenHash: Uint8Array,
): Promise<InvitePeek> {
  const [row] = await db
    .select({
      invite: invites,
      userId: users.id,
      passwordHash: users.passwordHash,
    })
    .from(invites)
    .leftJoin(users, eq(users.email, invites.email))
    .where(eq(invites.tokenHash, tokenHash))
    .limit(1);
  if (!row) return { outcome: "unknown" };
  const status = statusOf(row.invite, await dbNow(db));
  if (status === "accepted") return { outcome: "used" };
  if (status !== "pending") return { outcome: "expired" };
  return {
    outcome: "pending",
    email: row.invite.email,
    existingUser:
      row.userId === null || row.passwordHash === null
        ? null
        : { id: row.userId, passwordHash: row.passwordHash },
  };
}

class ExpiredWhileWaiting extends Error {}

async function acceptInvite(
  db: Database,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  return acceptInviteOnce(db, input).catch((error: unknown) => {
    if (error instanceof ExpiredWhileWaiting) return { outcome: "expired" };
    throw error;
  });
}

async function acceptInviteOnce(
  db: Database,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    // External first sign-in creates accounts under this lock, then takes
    // invites; taking it first keeps the same order. An invite's email
    // never changes, so reading it unlocked is enough to name the lock.
    const [named] = await tx
      .select({ email: invites.email })
      .from(invites)
      .where(eq(invites.tokenHash, input.tokenHash));
    if (!named) return { outcome: "expired" };
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`login-email:${named.email}`}))`,
    );
    // The invite's row lock is what makes a token redeem once: a second tab,
    // a revoke or a re-issue racing this one waits here, then sees the
    // outcome this transaction wrote.
    const [invite] = await tx
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, input.tokenHash))
      .for("update");
    if (!invite) return { outcome: "expired" };
    const status = statusOf(invite, await dbNow(tx));
    if (status === "accepted") return { outcome: "used" };
    if (status !== "pending") return { outcome: "expired" };

    const [account] = await tx
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.email, invite.email))
      .for("update");
    const { account: expected } = input;
    let userId: string;
    let verifiedPasswordHash: string;
    if (expected.kind === "existing") {
      // Checked against what the caller's password was verified with, so a
      // password reset or disable in between is not bypassed.
      if (
        account?.id !== expected.userId ||
        account.disabledAt !== null ||
        account.passwordHash !== expected.verifiedPasswordHash
      ) {
        return { outcome: "account_changed" };
      }
      userId = account.id;
      verifiedPasswordHash = account.passwordHash;
    } else {
      if (account) return { outcome: "account_changed" };
      // No row to lock yet: another path creating this address at the same
      // time (a second workspace's invite, an external sign-in) wins here.
      const created = await tx
        .insert(users)
        .values({
          id: expected.userId,
          email: invite.email,
          passwordHash: expected.passwordHash,
          displayName: expected.displayName,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (created.length === 0) return { outcome: "account_changed" };
      await tx.insert(loginMethods).values({
        id: expected.loginMethodId,
        userId: expected.userId,
        kind: "password",
      });
      userId = expected.userId;
      verifiedPasswordHash = expected.passwordHash;
    }

    const [membership] = await tx
      .select({ role: memberships.role, disabledAt: memberships.disabledAt })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, invite.workspaceId),
          eq(memberships.userId, userId),
        ),
      )
      .for("update");
    // A member who joined some other way since the invite was issued keeps
    // their role: an invite never demotes anyone.
    const role =
      membership && membership.disabledAt === null
        ? (membership.role as MembershipRole)
        : (invite.role as MembershipRole);
    if (!membership) {
      await tx
        .insert(memberships)
        .values({ workspaceId: invite.workspaceId, userId, role });
    } else if (membership.disabledAt !== null) {
      await tx
        .update(memberships)
        .set({ role, disabledAt: null })
        .where(
          and(
            eq(memberships.workspaceId, invite.workspaceId),
            eq(memberships.userId, userId),
          ),
        );
    }
    // The invite was live when locked; the row and unique-index waits since
    // then can outlast it, so the spend re-reads the clock.
    const spent = await tx
      .update(invites)
      .set({ acceptedAt: DB_NOW })
      .where(and(eq(invites.id, invite.id), gt(invites.expiresAt, DB_NOW)))
      .returning({ id: invites.id });
    if (spent.length === 0) throw new ExpiredWhileWaiting();
    const session = await createWebSession(tx, {
      ...input.session,
      userId,
      verifiedPasswordHash,
    });
    if (!session) throw new Error("web session refused under the user lock");
    await writeReceipt(tx, {
      id: input.receiptId,
      ownerId: invite.workspaceId,
      actor: {
        principal: { kind: "user", id: userId },
        actor_user_id: userId,
        agent_id: null,
      },
      operation: "accept_invite",
      targetRef: inviteTarget(invite.id, invite.workspaceId),
      result: {
        user_id: userId,
        role,
        new_account: expected.kind === "new",
      },
    });
    return {
      outcome: "accepted",
      userId,
      workspaceId: invite.workspaceId,
      role,
      sessionExpiresAt: session.expiresAt,
    };
  });
}

async function changeMemberRole(
  db: Database,
  input: Parameters<InviteStore["changeMemberRole"]>[0],
): Promise<ChangeRoleResult> {
  const { actor } = input;
  const userId = input.userId.toLowerCase();
  return db.transaction(async (tx) => {
    // Both people's user rows first, as setAccess takes them: re-checked
    // after a membership lock wait, a joined user row is still the old
    // snapshot's, so a target suspended meanwhile would read as live.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [userId, actor.userId]))
      .orderBy(asc(users.id))
      .for("share");
    // Every owner row, the target and the actor, locked in user_id order —
    // the order offboarding takes its two rows in — so two owners demoting
    // each other queue, and the second one counts what the first left.
    const locked = await tx
      .select({
        ...memberColumns,
        membershipDisabledAt: memberships.disabledAt,
        userDisabledAt: users.disabledAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, actor.workspaceId),
          or(
            eq(memberships.role, "owner"),
            eq(memberships.userId, userId),
            eq(memberships.userId, actor.userId),
          ),
        ),
      )
      .orderBy(asc(memberships.userId))
      .for("update", { of: memberships });
    const live = (row: (typeof locked)[number]) =>
      row.membershipDisabledAt === null && row.userDisabledAt === null;
    const acting = locked.find((row) => row.userId === actor.userId);
    if (!acting || !live(acting) || !managesMembers(acting.role)) {
      return { outcome: "actor_inactive" };
    }
    const target = locked.find((row) => row.userId === userId);
    if (!target) return { outcome: "not_found" };
    const member = memberRecord(target);
    const verdict = memberVerdict(
      { userId: acting.userId, role: acting.role as MembershipRole },
      {
        userId: target.userId,
        role: target.role as MembershipRole,
        membershipDisabled: target.membershipDisabledAt !== null,
        accountDisabled: target.userDisabledAt !== null,
      },
      { kind: "change_role", role: input.role },
    );
    if (!verdict.allowed) {
      return verdict.reason === "unchanged"
        ? { outcome: "unchanged", member }
        : { outcome: verdict.reason };
    }
    const otherLiveOwners = locked.filter(
      (row) => row.role === "owner" && live(row) && row.userId !== userId,
    );
    if (target.role === "owner" && otherLiveOwners.length === 0) {
      return { outcome: "last_owner" };
    }
    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(
        and(
          eq(memberships.workspaceId, actor.workspaceId),
          eq(memberships.userId, userId),
        ),
      );
    await writeReceipt(tx, {
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "change_member_role",
      targetRef: { user_id: userId, workspace_id: actor.workspaceId },
      result: { from: target.role, to: input.role },
    });
    return { outcome: "changed", member: { ...member, role: input.role } };
  });
}

type AdministeredAgent = MemberRowRecord["administeredAgents"][number];

// Mirrors `administers`: a direct admin row, or a live membership of a live
// team that is admin. Direct wins when both hold.
async function administeredAgents(
  db: Database,
  workspaceId: string,
  userIds: string[],
): Promise<Map<string, AdministeredAgent[]>> {
  if (userIds.length === 0) return new Map();
  const live = and(
    eq(agents.workspaceId, workspaceId),
    ne(agents.status, "archived"),
  );
  const [direct, viaTeam] = await Promise.all([
    db
      .select({ userId: agentAdmins.userId, id: agents.id, name: agents.name })
      .from(agentAdmins)
      .innerJoin(
        agents,
        and(
          eq(agents.workspaceId, agentAdmins.workspaceId),
          eq(agents.id, agentAdmins.agentId),
        ),
      )
      .where(
        and(
          eq(agentAdmins.workspaceId, workspaceId),
          inArray(agentAdmins.userId, userIds),
          live,
        ),
      ),
    db
      .selectDistinct({
        userId: memberTeamMembers.userId,
        id: agents.id,
        name: agents.name,
      })
      .from(agentAdminTeams)
      .innerJoin(
        memberTeams,
        and(
          eq(memberTeams.id, agentAdminTeams.teamId),
          isNull(memberTeams.archivedAt),
        ),
      )
      .innerJoin(
        memberTeamMembers,
        and(
          eq(memberTeamMembers.teamId, agentAdminTeams.teamId),
          isNull(memberTeamMembers.removedAt),
        ),
      )
      .innerJoin(
        agents,
        and(
          eq(agents.workspaceId, agentAdminTeams.workspaceId),
          eq(agents.id, agentAdminTeams.agentId),
        ),
      )
      .where(
        and(
          eq(agentAdminTeams.workspaceId, workspaceId),
          inArray(memberTeamMembers.userId, userIds),
          live,
        ),
      ),
  ]);
  const byUser = new Map<string, Map<string, AdministeredAgent>>();
  for (const [via, rows] of [
    ["user", direct],
    ["team", viaTeam],
  ] as const) {
    for (const row of rows) {
      const held = byUser.get(row.userId) ?? new Map();
      byUser.set(row.userId, held);
      if (!held.has(row.id)) {
        held.set(row.id, { id: row.id, name: row.name, via });
      }
    }
  }
  return new Map(
    [...byUser].map(([userId, held]) => [
      userId,
      [...held.values()].sort((a, b) =>
        a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
      ),
    ]),
  );
}

// A login prunes only older rows of the same user, so the newest last touch
// survives in the table.
async function lastActivity(
  db: Database,
  userIds: string[],
): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: webSessions.userId,
      at: max(webSessions.lastSeenAt),
    })
    .from(webSessions)
    .where(inArray(webSessions.userId, userIds))
    .groupBy(webSessions.userId);
  return new Map(
    rows.flatMap((row) => (row.at === null ? [] : [[row.userId, row.at]])),
  );
}

export function createPostgresInviteStore(db: Database): InviteStore {
  return {
    createInvite: (input) => createInvite(db, input),
    async listInvites(workspaceId, limit) {
      const rows = await db
        .select()
        .from(invites)
        .where(eq(invites.workspaceId, workspaceId))
        .orderBy(desc(invites.createdAt), desc(invites.id))
        .limit(limit);
      const now = await dbNow(db);
      return rows.map((row) => inviteRecord(row, now));
    },
    revokeInvite: (input) => revokeInvite(db, input),
    peekInvite: (tokenHash) => peekInvite(db, tokenHash),
    acceptInvite: (input) => acceptInvite(db, input),
    async listMembers(workspaceId, query) {
      const cursor = query.cursor ? decodeMemberCursor(query.cursor) : null;
      const pattern = query.q === undefined ? null : containsPattern(query.q);
      const rows = await db
        .select({
          ...memberColumns,
          membershipDisabledAt: memberships.disabledAt,
          userDisabledAt: users.disabledAt,
          cursorAt: sql<string>`${memberships.createdAt}::text`,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            pattern === null
              ? undefined
              : or(
                  sql`${users.displayName} ILIKE ${pattern}`,
                  sql`${users.email} ILIKE ${pattern}`,
                ),
            query.user_ids === undefined
              ? undefined
              : inArray(
                  memberships.userId,
                  query.user_ids.map((id) => id.toLowerCase()),
                ),
            cursor
              ? sql`(${memberships.createdAt}, ${memberships.userId}) > (${cursor.created_at}::timestamptz, ${cursor.user_id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.userId))
        .limit(query.limit + 1)
        .catch((error: unknown) => {
          // Same as sessions: a well-formed out-of-range timestamp only
          // fails at the cast.
          const code = (error as { cause?: { code?: unknown } })?.cause?.code;
          if (code === "22007" || code === "22008") {
            throw new InvalidCursorError();
          }
          throw error;
        });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const userIds = page.map((row) => row.userId);
      const [administered, activity] = await Promise.all([
        administeredAgents(db, workspaceId, userIds),
        lastActivity(db, userIds),
      ]);
      return {
        items: page.map(
          ({ cursorAt: _, membershipDisabledAt, userDisabledAt, ...row }) => ({
            ...memberRecord(row),
            membershipDisabled: membershipDisabledAt !== null,
            accountDisabled: userDisabledAt !== null,
            administeredAgents: administered.get(row.userId) ?? [],
            lastActiveAt: activity.get(row.userId) ?? null,
          }),
        ),
        next_cursor:
          rows.length > query.limit && last
            ? encodeMemberCursor({
                created_at: last.cursorAt,
                user_id: last.userId,
              })
            : null,
      };
    },
    changeMemberRole: (input) => changeMemberRole(db, input),
  };
}
