import { randomUUID } from "node:crypto";
import type { SessionStatus } from "@werft-ai/contracts";
import type {
  MemberStore,
  MembershipRole,
  SetAccessResult,
  TakeOverResult,
  TakeoverRecord,
} from "@werft-ai/platform";
import {
  managesMembers,
  memberVerdict,
  receiptActorOf,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { actorStillMember } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  apiKeys,
  memberships,
  receipts,
  sessions,
  users,
  webSessions,
} from "../schema.ts";
import { memberColumns, memberRecord } from "./invites.ts";
import { revokeUserLinkedAccounts } from "./linked-accounts.ts";
import { lockLoginSettings } from "./login-settings.ts";

const TAKEOVER = "takeover";

type SetAccessInput = Parameters<MemberStore["setAccess"]>[0];

const OPERATIONS = {
  membership: { true: "disable_member", false: "enable_member" },
  account: { true: "disable_user", false: "enable_user" },
} as const;

// Every web session of the user ends, whichever scope: a cookie resolves to
// the oldest live membership, so one kept alive could carry on elsewhere.
// `workspaceId` null means every workspace the account is in.
async function cutOff(
  tx: Database,
  userId: string,
  workspaceId: string | null,
) {
  const inWorkspace = (
    column: typeof apiKeys.workspaceId | typeof sessions.workspaceId,
  ) => (workspaceId === null ? undefined : eq(column, workspaceId));
  const sessionsRevoked = await tx
    .update(webSessions)
    .set({ revokedAt: DB_NOW })
    .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)))
    .returning({ id: webSessions.id });
  const keysRevoked = await tx
    .update(apiKeys)
    .set({ revokedAt: DB_NOW })
    .where(
      and(
        eq(apiKeys.kind, "personal"),
        eq(apiKeys.createdByUserId, userId),
        inWorkspace(apiKeys.workspaceId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  const linkedAccountsRevoked = await revokeUserLinkedAccounts(
    tx,
    workspaceId,
    userId,
  );
  const awaiting = await tx
    .update(sessions)
    .set({ takeoverRequiredAt: DB_NOW, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.createdByUserId, userId),
        inWorkspace(sessions.workspaceId),
        ne(sessions.admissionState, "closed"),
        isNull(sessions.takeoverRequiredAt),
      ),
    )
    .returning({ id: sessions.id });
  return {
    disabled: true as const,
    revokedWebSessions: sessionsRevoked.length,
    revokedPersonalKeys: keysRevoked.length,
    revokedLinkedAccounts: linkedAccountsRevoked,
    sessionsAwaitingTakeover: awaiting.length,
  };
}

// Sessions no owner has taken over yet go back to the person who asked for
// them, wherever they are live again; the cookies and keys stay revoked. Only
// in the workspaces whose memberships this transaction holds: elsewhere a
// disable could commit after the liveness read below.
async function release(
  tx: Database,
  userId: string,
  workspaceId: string | null,
) {
  const released = await tx
    .update(sessions)
    .set({ takeoverRequiredAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(sessions.createdByUserId, userId),
        workspaceId === null
          ? undefined
          : eq(sessions.workspaceId, workspaceId),
        isNotNull(sessions.takeoverRequiredAt),
        sql`exists (select 1 from ${memberships} join ${users} on ${users.id} = ${memberships.userId} where ${memberships.workspaceId} = ${sessions.workspaceId} and ${memberships.userId} = ${userId} and ${memberships.disabledAt} is null and ${users.disabledAt} is null)`,
      ),
    )
    .returning({ id: sessions.id });
  return { disabled: false as const, sessionsReleased: released.length };
}

async function setAccess(
  db: Database,
  input: SetAccessInput,
): Promise<SetAccessResult> {
  const { actor, scope, disabled } = input;
  const userId = input.userId.toLowerCase();
  const workspaceId = actor.workspaceId;
  return db.transaction(async (tx) => {
    // Ahead of the user rows (design 5.6): naming another emergency admin
    // waits for this, and this sees who it named.
    const settings = await lockLoginSettings(tx, "share");
    // Lock order: user, then membership, then web session. The user rows
    // come first even when only a membership changes: re-checked after a
    // membership lock wait, a joined row is still the old snapshot's, so an
    // account disabled meanwhile would read as live.
    const accounts = await tx
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(inArray(users.id, [userId, actor.userId]))
      .orderBy(asc(users.id))
      .for(scope === "account" ? "update" : "share");
    // In user_id order, as a role change and an invite take them, so two
    // owners turning each other off queue and the second sees the first.
    // The membership scope takes every owner row of the workspace to count
    // them; the account scope takes both people's rows in every workspace.
    const locked = await tx
      .select({
        ...memberColumns,
        workspaceId: memberships.workspaceId,
        membershipDisabledAt: memberships.disabledAt,
        userDisabledAt: users.disabledAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        scope === "membership"
          ? and(
              eq(memberships.workspaceId, workspaceId),
              or(
                eq(memberships.role, "owner"),
                inArray(memberships.userId, [userId, actor.userId]),
              ),
            )
          : inArray(memberships.userId, [userId, actor.userId]),
      )
      .orderBy(asc(memberships.userId), asc(memberships.workspaceId))
      .for("update", { of: memberships });
    const live = (row: (typeof locked)[number]) =>
      row.membershipDisabledAt === null && row.userDisabledAt === null;
    // The actor's role in each workspace where they may manage members.
    const managing = new Map(
      locked
        .filter(
          (row) =>
            row.userId === actor.userId &&
            managesMembers(row.role) &&
            live(row),
        )
        .map((row) => [row.workspaceId, row.role]),
    );
    const actorRole = managing.get(workspaceId) as MembershipRole | undefined;
    if (!actorRole) return { outcome: "actor_inactive" };
    const target = locked.find(
      (row) => row.userId === userId && row.workspaceId === workspaceId,
    );
    if (!target) return { outcome: "not_found" };

    let current: Date | null;
    if (scope === "membership") {
      const verdict = memberVerdict(
        { userId: actor.userId, role: actorRole },
        {
          userId,
          role: target.role as MembershipRole,
          membershipDisabled: target.membershipDisabledAt !== null,
          // From the account rows locked above, not the joined snapshot.
          accountDisabled:
            (accounts.find((row) => row.id === userId)?.disabledAt ?? null) !==
            null,
        },
        { kind: disabled ? "disable" : "enable" },
      );
      if (!verdict.allowed) {
        switch (verdict.reason) {
          case "unchanged":
            return { outcome: "unchanged", member: memberRecord(target) };
          case "owner_protected":
            return { outcome: "outranked" };
          case "self_protected":
          case "account_disabled":
          case "last_owner":
            return { outcome: verdict.reason };
          default:
            throw new Error(`no ${verdict.reason} for a membership's access`);
        }
      }
      current = target.membershipDisabledAt;
      const otherLiveOwners = locked.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.role === "owner" &&
          live(row) &&
          row.userId !== userId,
      );
      if (
        disabled &&
        current === null &&
        target.role === "owner" &&
        otherLiveOwners.length === 0
      ) {
        return { outcome: "last_owner" };
      }
    } else {
      // As memberVerdict says for a membership: it would end this session.
      if (disabled && userId === actor.userId) {
        return { outcome: "self_protected" };
      }
      // Only a live owner of a workspace changes an owner's access there,
      // whichever workspace the change starts from. Disabled memberships
      // count too: an owner whose membership is off is still an owner. Only
      // the elsewhere check needs live ones.
      const touched = locked.filter((row) => row.userId === userId);
      const outranked = touched.some(
        (row) =>
          row.role === "owner" && managing.get(row.workspaceId) !== "owner",
      );
      if (outranked) return { outcome: "outranked" };
      const reached = touched.filter(
        (row) => row.membershipDisabledAt === null,
      );
      current = accounts.find((row) => row.id === userId)?.disabledAt ?? null;
      const elsewhere = reached.some((row) => !managing.has(row.workspaceId));
      if (elsewhere) return { outcome: "elsewhere" };
    }
    if ((current !== null) === disabled) {
      return { outcome: "unchanged", member: memberRecord(target) };
    }
    // Whichever scope: either would leave nobody to sign in with a
    // password once passwords are closed (design 9.2).
    if (disabled && settings.emergencyAdminUserId === userId) {
      return { outcome: "emergency_admin" };
    }

    if (scope === "membership") {
      await tx
        .update(memberships)
        .set({ disabledAt: disabled ? DB_NOW : null })
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, userId),
          ),
        );
    } else {
      await tx
        .update(users)
        .set({ disabledAt: disabled ? DB_NOW : null })
        .where(eq(users.id, userId));
    }
    const effects = disabled
      ? await cutOff(tx, userId, scope === "membership" ? workspaceId : null)
      : await release(tx, userId, scope === "membership" ? workspaceId : null);
    const [member] = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
        ),
      );
    if (!member) throw new Error("membership vanished under its lock");
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      requestId: actor.principal.requestId ?? null,
      operation: OPERATIONS[scope][`${disabled}`],
      targetRef: { user_id: userId, workspace_id: workspaceId },
      status: "succeeded",
      result: effects.disabled
        ? {
            reason: input.reason,
            revoked_web_sessions: effects.revokedWebSessions,
            revoked_personal_keys: effects.revokedPersonalKeys,
            revoked_linked_accounts: effects.revokedLinkedAccounts,
            sessions_awaiting_takeover: effects.sessionsAwaitingTakeover,
          }
        : { reason: input.reason, sessions_released: effects.sessionsReleased },
    });
    return {
      outcome: "changed",
      member: memberRecord(member),
      receiptId: input.receiptId,
      effects,
    };
  });
}

export function createPostgresMemberStore(db: Database): MemberStore {
  return {
    setAccess: (input) => setAccess(db, input),

    async listAwaitingTakeover(
      workspaceId: string,
      limit: number,
    ): Promise<TakeoverRecord[]> {
      const rows = await db
        .select({
          sessionId: sessions.id,
          departedUserId: sessions.createdByUserId,
          status: sessions.status,
          createdAt: sessions.createdAt,
          takeoverRequiredAt: sessions.takeoverRequiredAt,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.workspaceId, workspaceId),
            isNotNull(sessions.takeoverRequiredAt),
            ne(sessions.admissionState, "closed"),
          ),
        )
        .orderBy(asc(sessions.takeoverRequiredAt), asc(sessions.id))
        .limit(limit);
      return rows.flatMap((row) =>
        row.departedUserId === null || row.takeoverRequiredAt === null
          ? []
          : [
              {
                sessionId: row.sessionId,
                departedUserId: row.departedUserId,
                status: row.status as SessionStatus,
                createdAt: row.createdAt,
                takeoverRequiredAt: row.takeoverRequiredAt,
              },
            ],
      );
    },

    takeOver(input): Promise<TakeOverResult> {
      const sessionId = input.sessionId.toLowerCase();
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        const [session] = await tx
          .select({ takeoverRequiredAt: sessions.takeoverRequiredAt })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.principal.ownerId),
              eq(sessions.workspaceId, input.workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        if (session.takeoverRequiredAt === null) {
          return { outcome: "not_awaiting" };
        }
        await tx
          .update(sessions)
          .set({
            createdByUserId: input.newRequesterId,
            takeoverRequiredAt: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          requestId: input.principal.requestId ?? null,
          operation: TAKEOVER,
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          status: "succeeded",
          result: input.justification
            ? { justification: input.justification }
            : null,
        });
        return { outcome: "taken_over", receiptId };
      });
    },
  };
}
