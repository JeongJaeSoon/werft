import { randomUUID } from "node:crypto";
import type { ReceiptOperation } from "@werft-ai/contracts";
import type {
  LoginSettingsAudit,
  LoginSettingsRecord,
  LoginSettingsStore,
  PasswordLogin,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import type { Database } from "../queries.ts";
import {
  loginMethods,
  loginProviders,
  loginSettings,
  memberships,
  receipts,
  users,
  webSessions,
} from "../schema.ts";

export type LockedLoginSettings = {
  passwordLogin: PasswordLogin;
  emergencyAdminUserId: string | null;
};

/**
 * The settings row, locked ahead of every provider, user, membership and
 * session row the transaction touches (design 5.6). `share` for a change
 * that only depends on the settings, `update` for one that changes them or
 * what they rest on. Everything that could take the emergency admin's
 * password or ownership away takes this first, so those who hold it for
 * update need no lock on that person's rows.
 */
export async function lockLoginSettings(
  tx: Database,
  strength: "share" | "update",
): Promise<LockedLoginSettings> {
  const [row] = await tx
    .select({
      passwordLogin: loginSettings.passwordLogin,
      emergencyAdminUserId: loginSettings.emergencyAdminUserId,
    })
    .from(loginSettings)
    .for(strength);
  if (!row) throw new Error("login_settings has no row");
  return row;
}

/**
 * Whether a password sign-in is open to this user: to everyone while
 * passwords are on, to the emergency admin alone otherwise.
 */
export const passwordOpenTo = (
  settings: LockedLoginSettings,
  userId: string,
): boolean =>
  settings.passwordLogin === "on" || settings.emergencyAdminUserId === userId;

/**
 * Whether the user is an owner who can sign in with a password: account and
 * membership on, a password set (design 9.2).
 */
async function ownerWithPassword(
  db: Database,
  userId: string,
  workspaceId?: string,
): Promise<boolean> {
  const owner = await ownerBySignIn(db, userId);
  if (!owner?.hasPassword) return false;
  return workspaceId === undefined || owner.workspaceId === workspaceId;
}

/**
 * The workspace a sign-in makes this user an owner of, or null. A session
 * acts through the oldest live membership (findLiveMembership), so an owner
 * membership behind an older one gives nobody an owner's powers: whoever is
 * to recover the installation must be an owner by this rule.
 */
export async function ownerBySignIn(
  db: Database,
  userId: string,
): Promise<{ workspaceId: string; hasPassword: boolean } | null> {
  const [first] = await db
    .select({
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.userId, userId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return first?.role === "owner"
    ? { workspaceId: first.workspaceId, hasPassword: first.hasPassword }
    : null;
}

/**
 * Whether the user's sign-in stays where it lands once their membership of
 * `workspaceId`, now off, is on again with `role`. A membership older than
 * the one they sign in through takes its place (ownerBySignIn), so one that
 * is not an owner's does not come back to the emergency admin.
 */
export async function keepsOwnerSignIn(
  db: Database,
  userId: string,
  revived: { workspaceId: string; role: string },
): Promise<boolean> {
  const [landing] = await db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        or(
          isNull(memberships.disabledAt),
          eq(memberships.workspaceId, revived.workspaceId),
        ),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return (
    landing?.workspaceId !== revived.workspaceId || revived.role === "owner"
  );
}

/** The providers that are on, held so none goes off under the caller. */
const enabledIssuers = async (tx: Database): Promise<string[]> =>
  (
    await tx
      .select({ issuer: loginProviders.issuer })
      .from(loginProviders)
      .where(eq(loginProviders.enabled, true))
      .for("share")
  ).map((row) => row.issuer);

/** Whether the user has an account of a provider that is on. */
async function signsInThroughProvider(
  tx: Database,
  userId: string,
  issuers: string[],
): Promise<boolean> {
  if (issuers.length === 0) return false;
  const [row] = await tx
    .select({ id: loginMethods.id })
    .from(loginMethods)
    .where(
      and(
        eq(loginMethods.userId, userId),
        eq(loginMethods.kind, "oidc"),
        inArray(loginMethods.issuer, issuers),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Ends the live password sessions of everyone but `keep`, or of `only`. A
 * session with no method recorded was made with a password before sessions
 * recorded one.
 */
export async function revokePasswordSessions(
  tx: Database,
  who: { keep: string } | { only: string },
): Promise<number> {
  const revoked = await tx
    .update(webSessions)
    .set({ revokedAt: DB_NOW })
    .where(
      and(
        isNull(webSessions.revokedAt),
        "keep" in who
          ? ne(webSessions.userId, who.keep)
          : eq(webSessions.userId, who.only),
        or(
          isNull(webSessions.loginMethodId),
          inArray(
            webSessions.loginMethodId,
            tx
              .select({ id: loginMethods.id })
              .from(loginMethods)
              .where(eq(loginMethods.kind, "password")),
          ),
        ),
      ),
    )
    .returning({ id: webSessions.id });
  return revoked.length;
}

async function writeReceipt(
  tx: Database,
  audit: LoginSettingsAudit,
  operation: ReceiptOperation,
  result: Record<string, unknown>,
): Promise<void> {
  await tx.insert(receipts).values({
    id: audit.receiptId,
    ownerId: audit.workspaceId,
    operation,
    targetRef: {
      resource: { kind: "workspace", id: audit.workspaceId },
      workspace_id: audit.workspaceId,
    },
    status: "succeeded",
    result,
    actor: {
      principal: { kind: "user", id: audit.userId },
      actor_user_id: audit.userId,
      agent_id: null,
    },
  });
}

async function recordOf(
  db: Database,
  settings: LockedLoginSettings,
): Promise<LoginSettingsRecord> {
  const adminId = settings.emergencyAdminUserId;
  const [admin] =
    adminId === null
      ? []
      : await db
          .select({ email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, adminId));
  return {
    passwordLogin: settings.passwordLogin,
    emergencyAdmin:
      adminId !== null && admin
        ? {
            userId: adminId,
            ...admin,
            eligible: await ownerWithPassword(db, adminId),
          }
        : null,
    enabledProviders: await db.$count(
      loginProviders,
      eq(loginProviders.enabled, true),
    ),
  };
}

/**
 * The receipt of a change the operator CLI made (design 9.3). It has no
 * actor: a receipt's actor is a principal, and whoever runs the CLI is
 * whoever holds the database.
 */
export async function writeOperatorReceipt(
  tx: Database,
  operation: ReceiptOperation,
  result: Record<string, unknown>,
): Promise<void> {
  const workspaceId = await secretOwnerWorkspace(tx);
  if (workspaceId === null) {
    throw new Error("no workspace to keep the receipt under");
  }
  await tx.insert(receipts).values({
    id: randomUUID(),
    ownerId: workspaceId,
    operation,
    targetRef: {
      resource: { kind: "workspace", id: workspaceId },
      workspace_id: workspaceId,
    },
    status: "succeeded",
    result: { ...result, by: "operator_cli" },
  });
}

/** For a caller that holds the settings for update and found them closed. */
export async function openPasswordsAsOperator(tx: Database): Promise<void> {
  await tx
    .update(loginSettings)
    .set({ passwordLogin: "on", updatedAt: DB_NOW });
  await writeOperatorReceipt(tx, "set_password_login", {
    password_login: "on",
    sessions_revoked: 0,
  });
}

/** Opens password sign-in to everyone again, from the operator CLI. */
export async function enablePasswordLoginAsOperator(
  db: Database,
): Promise<{ outcome: "changed" | "unchanged" }> {
  return db.transaction(async (tx) => {
    const settings = await lockLoginSettings(tx, "update");
    if (settings.passwordLogin === "on") return { outcome: "unchanged" };
    await openPasswordsAsOperator(tx);
    return { outcome: "changed" };
  });
}

export function createPostgresLoginSettingsStore(
  db: Database,
): LoginSettingsStore {
  return {
    async read() {
      const [row] = await db
        .select({
          passwordLogin: loginSettings.passwordLogin,
          emergencyAdminUserId: loginSettings.emergencyAdminUserId,
        })
        .from(loginSettings);
      if (!row) throw new Error("login_settings has no row");
      return recordOf(db, row);
    },

    setPasswordLogin({ value, audit }) {
      return db.transaction(async (tx) => {
        const settings = await lockLoginSettings(tx, "update");
        if (settings.passwordLogin === value) {
          return {
            outcome: "unchanged" as const,
            settings: await recordOf(tx, settings),
          };
        }
        let sessionsRevoked = 0;
        if (value === "emergency_only") {
          const issuers = await enabledIssuers(tx);
          if (issuers.length === 0) return { outcome: "no_provider" as const };
          const admin = settings.emergencyAdminUserId;
          if (admin === null || !(await ownerWithPassword(tx, admin))) {
            return { outcome: "no_emergency_admin" as const };
          }
          if (
            audit.userId !== admin &&
            !(await signsInThroughProvider(tx, audit.userId, issuers))
          ) {
            return { outcome: "locks_out_actor" as const };
          }
          // A password sign-in holds the settings for share until its
          // session is in, so none is missed here.
          sessionsRevoked = await revokePasswordSessions(tx, { keep: admin });
        }
        await tx
          .update(loginSettings)
          .set({ passwordLogin: value, updatedAt: DB_NOW });
        await writeReceipt(tx, audit, "set_password_login", {
          password_login: value,
          sessions_revoked: sessionsRevoked,
        });
        return {
          outcome: "changed" as const,
          settings: await recordOf(tx, { ...settings, passwordLogin: value }),
          sessionsRevoked,
        };
      });
    },

    setEmergencyAdmin({ userId, audit }) {
      return db.transaction(async (tx) => {
        const settings = await lockLoginSettings(tx, "update");
        const previous = settings.emergencyAdminUserId;
        if (previous === userId) {
          return {
            outcome: "unchanged" as const,
            settings: await recordOf(tx, settings),
          };
        }
        if (!(await ownerWithPassword(tx, userId, audit.workspaceId))) {
          return { outcome: "not_eligible" as const };
        }
        let sessionsRevoked = 0;
        if (settings.passwordLogin === "emergency_only" && previous !== null) {
          // The one who was the emergency admin is now like everyone else:
          // their password sessions end, and the owner asking must still
          // have a way back in.
          if (
            audit.userId !== userId &&
            !(await signsInThroughProvider(
              tx,
              audit.userId,
              await enabledIssuers(tx),
            ))
          ) {
            return { outcome: "locks_out_actor" as const };
          }
          sessionsRevoked = await revokePasswordSessions(tx, {
            only: previous,
          });
        }
        await tx
          .update(loginSettings)
          .set({ emergencyAdminUserId: userId, updatedAt: DB_NOW });
        await writeReceipt(tx, audit, "set_emergency_admin", {
          user_id: userId,
          previous_user_id: previous,
          sessions_revoked: sessionsRevoked,
        });
        return {
          outcome: "changed" as const,
          settings: await recordOf(tx, {
            ...settings,
            emergencyAdminUserId: userId,
          }),
          sessionsRevoked,
        };
      });
    },
  };
}
