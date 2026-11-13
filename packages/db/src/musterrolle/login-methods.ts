import type { ReceiptOperation } from "@werft-ai/contracts";
import type {
  LinkLoginMethodInput,
  LinkLoginMethodResult,
  LoginMethodStore,
  LoginMethodsRecord,
  UnlinkLoginMethodInput,
  UnlinkLoginMethodResult,
} from "@werft-ai/platform";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  invites,
  loginMethods,
  loginProviders,
  loginSettings,
  receipts,
  users,
  webSessions,
} from "../schema.ts";
import { signUpWithInvite } from "./identity.ts";
import { lockLoginSettings, passwordOpenTo } from "./login-settings.ts";

async function writeReceipt(
  tx: Database,
  audit: { userId: string; workspaceId: string; receiptId: string },
  operation: ReceiptOperation,
  result: Record<string, unknown>,
): Promise<void> {
  await tx.insert(receipts).values({
    id: audit.receiptId,
    ownerId: audit.workspaceId,
    operation,
    targetRef: {
      // The person is the actor; a receipt has no target kind for one.
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

/**
 * Links the external account to the user of the session the link was
 * started from (design 6.4). The provider's word is who the account is;
 * its address is not read. Locks run subject, provider row, user, login
 * methods (design 5.6).
 */
async function linkLoginMethod(
  db: Database,
  input: LinkLoginMethodInput,
): Promise<LinkLoginMethodResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`login:oidc:${input.issuer}:${input.subject}`}))`,
    );
    const [provider] = await tx
      .select({ id: loginProviders.id })
      .from(loginProviders)
      .where(
        and(
          eq(loginProviders.id, input.provider.id),
          eq(loginProviders.enabled, true),
          eq(loginProviders.issuer, input.issuer),
          eq(loginProviders.configRevision, input.provider.configRevision),
        ),
      )
      .for("share");
    if (!provider) return { outcome: "provider_off" };
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
      .for("update");
    // Under the user lock: a sign-out or a revoke that landed while the
    // person was at the provider ends the link with it.
    const live =
      user !== undefined &&
      (await tx.$count(
        webSessions,
        and(
          eq(webSessions.id, input.sessionId),
          eq(webSessions.userId, input.userId),
          isNull(webSessions.revokedAt),
          gt(webSessions.expiresAt, DB_NOW),
        ),
      )) > 0;
    if (!live) return { outcome: "session_gone" };
    const [taken] = await tx
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(
        and(
          eq(loginMethods.kind, "oidc"),
          eq(loginMethods.issuer, input.issuer),
          eq(loginMethods.subject, input.subject),
        ),
      );
    if (taken) return { outcome: "already_linked" };
    const [sameIssuer] = await tx
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(
        and(
          eq(loginMethods.userId, input.userId),
          eq(loginMethods.kind, "oidc"),
          eq(loginMethods.issuer, input.issuer),
        ),
      );
    if (sameIssuer) return { outcome: "issuer_linked" };
    await tx.insert(loginMethods).values({
      id: input.newLoginMethodId,
      userId: input.userId,
      kind: "oidc",
      issuer: input.issuer,
      subject: input.subject,
      emailAtLink: input.vouchedEmail,
    });
    await writeReceipt(tx, input, "link_login_method", {
      login_method_id: input.newLoginMethodId,
      provider_id: input.provider.id,
      issuer: input.issuer,
    });
    return { outcome: "linked", loginMethodId: input.newLoginMethodId };
  });
}

/** Whether a method is one its user can sign in with now. */
const usable = (
  method: { kind: string; issuer: string | null },
  hasPassword: boolean,
  enabledIssuers: ReadonlySet<string>,
) =>
  method.kind === "password"
    ? hasPassword
    : method.issuer !== null && enabledIssuers.has(method.issuer);

async function listLoginMethods(
  db: Database,
  userId: string,
): Promise<LoginMethodsRecord> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  const providers = await db
    .select({
      id: loginProviders.id,
      displayName: loginProviders.displayName,
      issuer: loginProviders.issuer,
      enabled: loginProviders.enabled,
    })
    .from(loginProviders)
    .orderBy(asc(loginProviders.displayName), asc(loginProviders.id));
  const rows = await db
    .select()
    .from(loginMethods)
    .where(eq(loginMethods.userId, userId))
    .orderBy(asc(loginMethods.createdAt), asc(loginMethods.id));
  const byIssuer = new Map(providers.map((row) => [row.issuer, row]));
  const enabledIssuers = new Set(
    providers.filter((row) => row.enabled).map((row) => row.issuer),
  );
  const linkedIssuers = new Set(rows.map((row) => row.issuer));
  const [settings] = await db
    .select({
      passwordLogin: loginSettings.passwordLogin,
      emergencyAdminUserId: loginSettings.emergencyAdminUserId,
    })
    .from(loginSettings);
  const hasPassword =
    user?.passwordHash != null &&
    settings !== undefined &&
    passwordOpenTo(settings, userId);
  return {
    methods: rows.map((row) => {
      const provider = row.issuer === null ? null : byIssuer.get(row.issuer);
      return {
        id: row.id,
        kind: row.kind,
        provider: provider
          ? {
              id: provider.id,
              displayName: provider.displayName,
              enabled: provider.enabled,
            }
          : null,
        issuer: row.issuer,
        emailAtLink: row.emailAtLink,
        createdAt: row.createdAt,
        lastLoginAt: row.lastLoginAt,
        usable: usable(row, hasPassword, enabledIssuers),
      };
    }),
    linkable: providers
      .filter((row) => row.enabled && !linkedIssuers.has(row.issuer))
      .map((row) => ({ id: row.id, displayName: row.displayName })),
  };
}

/**
 * Removes one of the user's ways to sign in, unless none they could use
 * would be left (design 6.4). The sessions made with it end in the same
 * transaction, and a password goes with its method: a password sign-in
 * reads the hash, not the method row.
 *
 * Only for the session that asks, read again under the user lock and once
 * more after the last wait: still live, and still within the age a change
 * is allowed from.
 *
 * The providers that are on are held FOR SHARE first (design 5.6: provider
 * rows come before the user row), so the count of what is left cannot be
 * undone by a provider being turned off while this runs. The user row is
 * the line a sign-in with the method stands in: it comes first and this
 * ends its session, or it comes second and finds no method.
 */
async function unlinkLoginMethod(
  db: Database,
  input: UnlinkLoginMethodInput,
): Promise<UnlinkLoginMethodResult> {
  return db.transaction(async (tx) => {
    // Ahead of the provider rows (design 5.6). Closing passwords and naming
    // an emergency admin wait for this; this counts by what they left.
    const settings = await lockLoginSettings(tx, "share");
    const on = await tx
      .select({ issuer: loginProviders.issuer })
      .from(loginProviders)
      .where(eq(loginProviders.enabled, true))
      .for("share");
    const [user] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
      .for("update");
    // Under the user lock: a password reset or a sign-out everywhere that
    // held it first has ended the session this was asked from, and what it
    // set must not be undone by a request made before it.
    const asking = user && (await liveSession(tx, input));
    if (!user || !asking) return { outcome: "session_gone" };
    if (!asking.fresh) return { outcome: "session_too_old" };
    const methods = await tx
      .select({
        id: loginMethods.id,
        kind: loginMethods.kind,
        issuer: loginMethods.issuer,
      })
      .from(loginMethods)
      .where(eq(loginMethods.userId, input.userId))
      .for("update");
    const target = methods.find((method) => method.id === input.loginMethodId);
    if (!target) return { outcome: "not_found" };
    // The emergency admin is whoever still has a password (design 9.2).
    if (
      target.kind === "password" &&
      settings.emergencyAdminUserId === input.userId
    ) {
      return { outcome: "emergency_admin" };
    }
    const enabledIssuers = new Set(on.map((row) => row.issuer));
    const left = methods.filter(
      (method) =>
        method.id !== target.id &&
        usable(
          method,
          user.passwordHash !== null && passwordOpenTo(settings, input.userId),
          enabledIssuers,
        ),
    );
    if (left.length === 0) return { outcome: "last_method" };
    // The sessions this ends, locked ahead of the last look at the asking
    // one: a renewal or a sign-out can hold one of them, and that wait is
    // the last one here. What is written below waits for nothing.
    await tx
      .select({ id: webSessions.id })
      .from(webSessions)
      .where(
        and(
          eq(webSessions.loginMethodId, target.id),
          isNull(webSessions.revokedAt),
        ),
      )
      .for("update");
    const still = await liveSession(tx, input);
    if (!still) return { outcome: "session_gone" };
    if (!still.fresh) return { outcome: "session_too_old" };
    const revoked = await tx
      .update(webSessions)
      .set({ revokedAt: DB_NOW })
      .where(
        and(
          eq(webSessions.loginMethodId, target.id),
          isNull(webSessions.revokedAt),
        ),
      )
      .returning({ id: webSessions.id });
    if (target.kind === "password") {
      await tx
        .update(users)
        .set({ passwordHash: null })
        .where(eq(users.id, input.userId));
    }
    await tx.delete(loginMethods).where(eq(loginMethods.id, target.id));
    await writeReceipt(tx, input, "unlink_login_method", {
      login_method_id: target.id,
      kind: target.kind,
      issuer: target.issuer,
      sessions_revoked: revoked.length,
    });
    return { outcome: "unlinked", sessionsRevoked: revoked.length };
  });
}

/** The user's own live session, and whether it is no older than asked. */
async function liveSession(
  db: Database,
  input: { sessionId: string; userId: string; maxAgeMs: number },
): Promise<{ fresh: boolean } | undefined> {
  const [row] = await db
    .select({
      fresh: sql<boolean>`${webSessions.createdAt} >= ${DB_NOW} - ${input.maxAgeMs}::double precision * interval '1 millisecond'`,
    })
    .from(webSessions)
    .where(
      and(
        eq(webSessions.id, input.sessionId),
        eq(webSessions.userId, input.userId),
        isNull(webSessions.revokedAt),
        gt(webSessions.expiresAt, DB_NOW),
      ),
    );
  return row;
}

async function sessionIsFresh(
  db: Database,
  input: { sessionId: string; userId: string; maxAgeMs: number },
): Promise<boolean> {
  return (await liveSession(db, input))?.fresh === true;
}

async function inviteForSignUp(
  db: Database,
  tokenHash: Uint8Array,
): ReturnType<LoginMethodStore["inviteForSignUp"]> {
  const [row] = await db
    .select({
      id: invites.id,
      acceptedAt: invites.acceptedAt,
      revokedAt: invites.revokedAt,
      live: sql<boolean>`${invites.expiresAt} > ${DB_NOW}`,
    })
    .from(invites)
    .where(eq(invites.tokenHash, tokenHash));
  if (!row) return { outcome: "unknown" };
  if (row.acceptedAt !== null) return { outcome: "used" };
  if (row.revokedAt !== null || !row.live) return { outcome: "expired" };
  return { outcome: "pending", inviteId: row.id };
}

export function createPostgresLoginMethodStore(db: Database): LoginMethodStore {
  return {
    inviteForSignUp: (tokenHash) => inviteForSignUp(db, tokenHash),
    signUpWithInvite: (input) => signUpWithInvite(db, input),
    sessionIsFresh: (input) => sessionIsFresh(db, input),
    link: (input) => linkLoginMethod(db, input),
    list: (userId) => listLoginMethods(db, userId),
    unlink: (input) => unlinkLoginMethod(db, input),
  };
}
