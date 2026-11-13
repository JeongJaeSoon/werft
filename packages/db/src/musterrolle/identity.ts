import type { UserLocale } from "@werft-ai/contracts";
import {
  BootstrapDoneError,
  type BootstrapInput,
  type BootstrapResult,
  BootstrapTokenSpentError,
  type ConsumePasswordResetInput,
  type ExternalSignInInput,
  type ExternalSignInResult,
  type IdentityUser,
  type IdentityWorkspace,
  type InviteSignUpInput,
  type InviteSignUpResult,
  type IssuePasswordResetInput,
  type IssuePasswordResetResult,
  type LiveMembership,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DB_NOW, fromDbNow } from "../db-clock.ts";
import { ensureInstalledRepositoryCeiling } from "../github-settings.ts";
import type { Database } from "../queries.ts";
import {
  bootstrapTokenUses,
  invites,
  loginMethods,
  loginProviders,
  memberships,
  passwordResets,
  receipts,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import { insertBuiltinAchievementTypes } from "../sessions/achievement-rules.ts";
import { rowsOf } from "../statement-rows.ts";

// Identity queries for the cookie-session path. API keys keep
// their own helpers in queries.ts so that path is untouched.

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(users);
  return Number(row?.count ?? 0);
}

// A disabled account and a disabled membership both leave nobody able to
// act as owner, so either one makes the owner "not live".
export async function countLiveOwners(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.role, "owner"),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * First owner + default workspace on an empty install; once users exist and
 * no live owner remains, the owner is added to (or restored in) the existing
 * workspace instead and every session in it ends (03 §3.1: one workspace).
 * The advisory lock serialises racing installers; the owner count is re-read
 * under it so the loser gets BootstrapDoneError, not a unique violation.
 */
export async function bootstrapOwner(
  db: Database,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('auth.bootstrap'))`,
    );
    if ((await countLiveOwners(tx)) > 0) {
      throw new BootstrapDoneError();
    }
    const [spent] = await tx
      .insert(bootstrapTokenUses)
      .values({ tokenHash: input.bootstrapTokenHash })
      .onConflictDoNothing()
      .returning({ tokenHash: bootstrapTokenUses.tokenHash });
    if (!spent) {
      throw new BootstrapTokenSpentError();
    }
    const [existing] = await tx
      .select()
      .from(workspaces)
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    const recovered = (await countUsers(tx)) > 0;
    if (recovered && existing) {
      // An invite issued before recovery would let its holder in as whatever
      // role the lost owners chose. Revoked before any user row is locked:
      // accepting and issuing take the invite before the user.
      await tx
        .update(invites)
        .set({ revokedAt: DB_NOW })
        .where(
          and(
            eq(invites.workspaceId, existing.id),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        );
      // That update may have waited on an accept that made a live owner.
      if ((await countLiveOwners(tx)) > 0) {
        throw new BootstrapDoneError();
      }
      // Every user this transaction will write, in id order, before the
      // first write: a reset issue locks its issuer and target the same way,
      // so restoring one of them cannot hold a row the issue needs while
      // waiting on the one it holds.
      const members = tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.workspaceId, existing.id));
      await tx
        .select({ id: users.id })
        .from(users)
        .where(or(inArray(users.id, members), eq(users.email, input.email)))
        .orderBy(asc(users.id))
        .for("no key update");
    }
    const workspace =
      existing ??
      (
        await tx
          .insert(workspaces)
          .values({
            id: input.workspaceId,
            slug: input.workspaceSlug,
            name: input.workspaceName,
          })
          .returning()
      )[0];
    // The recovering operator proves control of the install, not of the
    // address; an existing account with this email gets the new password,
    // the same power a password reset would give.
    const [restored] = recovered
      ? await tx
          .update(users)
          .set({ passwordHash: input.passwordHash, disabledAt: null })
          .where(eq(users.email, input.email))
          .returning()
      : [];
    const user =
      restored ??
      (
        await tx
          .insert(users)
          .values({
            id: input.userId,
            email: input.email,
            passwordHash: input.passwordHash,
            displayName: input.displayName,
          })
          .returning()
      )[0];
    if (!user || !workspace) {
      throw new Error("bootstrap insert returned no row");
    }
    if (!existing) {
      await insertBuiltinAchievementTypes(tx, workspace.id);
      // A workspace is born with its repository ceiling written, so a null
      // ceiling (which rejects everything) never reaches a new workspace.
      await ensureInstalledRepositoryCeiling(tx, workspace.id);
    }
    await tx
      .insert(loginMethods)
      .values({ id: input.loginMethodId, userId: user.id, kind: "password" })
      .onConflictDoNothing();
    await tx
      .insert(memberships)
      .values({ workspaceId: workspace.id, userId: user.id, role: "owner" })
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.userId],
        set: { role: "owner", disabledAt: null },
      });
    if (recovered) {
      const members = tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.workspaceId, workspace.id));
      // Every member's row, in id order, before links and sessions: a login
      // holds its user's row while it inserts a session, so this waits for
      // it to commit and the revocation below sees that session too. NO KEY
      // UPDATE still waits for that FOR UPDATE but not for the KEY SHARE an
      // in-flight reset issue holds on its issuer through the FK.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, members))
        .orderBy(asc(users.id))
        .for("no key update");
      // A link issued before recovery would let its holder take the
      // recovered account straight back. Links before sessions: the same
      // user -> link -> session lock order consumePasswordReset takes.
      await tx
        .update(passwordResets)
        .set({ revokedAt: DB_NOW })
        .where(
          and(
            eq(passwordResets.workspaceId, workspace.id),
            isNull(passwordResets.usedAt),
            isNull(passwordResets.revokedAt),
          ),
        );
      const revoked = await tx
        .update(webSessions)
        .set({ revokedAt: DB_NOW })
        .where(
          and(
            isNull(webSessions.revokedAt),
            inArray(webSessions.userId, members),
          ),
        )
        .returning({ id: webSessions.id });
      await tx.insert(receipts).values({
        id: input.receiptId,
        ownerId: workspace.id,
        operation: "recover_owner",
        targetRef: {
          resource: { kind: "workspace", id: workspace.id },
          workspace_id: workspace.id,
        },
        status: "succeeded",
        result: {
          user_id: user.id,
          existing_user: restored !== undefined,
          sessions_revoked: revoked.length,
        },
      });
    }
    return { user, workspace, recovered };
  });
}

export async function retireBootstrapToken(
  db: Database,
  tokenHash: Uint8Array,
): Promise<void> {
  await db
    .insert(bootstrapTokenUses)
    .values({ tokenHash })
    .onConflictDoNothing();
}

/**
 * Replaces the user's open link, if any, and records the issue. The issuer
 * and target rows are locked together in id order, ahead of the target's
 * links (user -> link, as consumePasswordReset and recovery take them), so
 * a reset or disable landing on either one after the route checked them is
 * seen here.
 */
export async function issuePasswordReset(
  db: Database,
  input: IssuePasswordResetInput,
): Promise<IssuePasswordResetResult> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          inArray(users.id, [input.issuedBy, input.userId]),
          isNull(users.disabledAt),
        ),
      )
      .orderBy(asc(users.id))
      .for("update");
    const roles = await tx
      .select({
        userId: memberships.userId,
        workspaceId: memberships.workspaceId,
        role: memberships.role,
      })
      .from(memberships)
      .where(
        and(
          inArray(memberships.userId, [input.issuedBy, input.userId]),
          isNull(memberships.disabledAt),
        ),
      );
    const issuer = locked.find((row) => row.id === input.issuedBy);
    const issuerOwns = roles.some(
      (row) =>
        row.userId === input.issuedBy &&
        row.workspaceId === input.workspaceId &&
        row.role === "owner",
    );
    if (
      !issuer ||
      issuer.passwordHash !== input.issuerPasswordHash ||
      !issuerOwns
    ) {
      return { outcome: "issuer_changed" };
    }
    const target = roles.find(
      (row) =>
        row.userId === input.userId && row.workspaceId === input.workspaceId,
    );
    if (
      !target ||
      !locked.some(
        (row) => row.id === input.userId && row.passwordHash !== null,
      )
    ) {
      return { outcome: "not_found" };
    }
    // Accounts are global but this power is per workspace: a link would
    // hand the issuer an owner of a workspace they have no role in.
    if (
      roles.some(
        (row) =>
          row.userId === input.userId &&
          row.workspaceId !== input.workspaceId &&
          row.role === "owner",
      )
    ) {
      return { outcome: "owner_elsewhere" };
    }
    await tx
      .update(passwordResets)
      .set({ revokedAt: DB_NOW })
      .where(
        and(
          eq(passwordResets.userId, input.userId),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.revokedAt),
        ),
      );
    const [row] = await tx
      .insert(passwordResets)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        issuedBy: input.issuedBy,
        expiresAt: fromDbNow(input.ttlMs),
      })
      .returning({ expiresAt: passwordResets.expiresAt });
    if (!row) {
      throw new Error("password reset insert returned no row");
    }
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: input.workspaceId,
      operation: "issue_password_reset",
      targetRef: { user_id: input.userId, workspace_id: input.workspaceId },
      status: "succeeded",
      // A link for another owner is the one that can take over the
      // workspace, so it is told apart from a member's.
      result: {
        target_role: target.role,
        expires_at: row.expiresAt.toISOString(),
      },
      actor: {
        principal: { kind: "user", id: input.issuedBy },
        actor_user_id: input.issuedBy,
        agent_id: null,
      },
    });
    return { outcome: "issued", expiresAt: row.expiresAt };
  });
}

/**
 * Spends the link, sets the password and ends every live session of the
 * user in one transaction. Locks run user row first, then the link, the same
 * order as issuePasswordReset and recovery, so neither can deadlock this.
 * The link's lock makes a second redemption wait and then miss on
 * `used_at`, so a token sets a password at most once.
 */
export async function consumePasswordReset(
  db: Database,
  input: ConsumePasswordResetInput,
): Promise<{ userId: string; workspaceId: string } | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ userId: passwordResets.userId })
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, input.tokenHash));
    if (!candidate) {
      return null;
    }
    // Disabled after the link was issued: the link dies with the account.
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, candidate.userId),
          isNull(users.disabledAt),
          isNotNull(users.passwordHash),
        ),
      )
      .for("update");
    if (!user) {
      return null;
    }
    const [reset] = await tx
      .select({
        id: passwordResets.id,
        userId: passwordResets.userId,
        workspaceId: passwordResets.workspaceId,
        issuedBy: passwordResets.issuedBy,
      })
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, input.tokenHash),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.revokedAt),
          gt(passwordResets.expiresAt, DB_NOW),
        ),
      )
      .for("update");
    if (!reset) {
      return null;
    }
    // A password nobody can log in with is not worth setting. Read without a
    // lock: recovery holds the membership before the user row, the reverse
    // of this transaction.
    const [member] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, reset.workspaceId),
          eq(memberships.userId, reset.userId),
          isNull(memberships.disabledAt),
        ),
      );
    if (!member) {
      return null;
    }
    await tx
      .update(users)
      .set({ passwordHash: input.passwordHash })
      .where(eq(users.id, reset.userId));
    await tx
      .update(passwordResets)
      .set({ usedAt: DB_NOW })
      .where(eq(passwordResets.id, reset.id));
    const revoked = await revokeUserWebSessions(tx, reset.userId);
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: reset.workspaceId,
      operation: "reset_password",
      targetRef: { user_id: reset.userId, workspace_id: reset.workspaceId },
      status: "succeeded",
      result: { issued_by: reset.issuedBy, sessions_revoked: revoked },
    });
    return { userId: reset.userId, workspaceId: reset.workspaceId };
  });
}

/** Ends every live session of the user; walks web_sessions_user_live_idx. */
async function revokeUserWebSessions(
  db: Database,
  userId: string,
): Promise<number> {
  const rows = await db
    .update(webSessions)
    .set({ revokedAt: DB_NOW })
    .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)))
    .returning({ id: webSessions.id });
  return rows.length;
}

/** Login lookup; a disabled account is indistinguishable from a missing one. */
export async function findUserForLogin(
  db: Database,
  email: string,
): Promise<IdentityUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.disabledAt)))
    .limit(1);
  return row ?? null;
}

// One workspace per installation for now (03 §3.1); with several the oldest
// membership wins so the choice is stable across logins.
export async function findLiveMembership(
  db: Database,
  userId: string,
): Promise<LiveMembership | null> {
  const [row] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), isNull(memberships.disabledAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return row ? { ...row, role: row.role as MembershipRole } : null;
}

export async function findWorkspace(
  db: Database,
  workspaceId: string,
): Promise<IdentityWorkspace | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

/**
 * Inserts the session and keeps the user's rows bounded in the same
 * transaction: expired and revoked rows are deleted, and only the newest
 * `maxLive` live sessions survive, so the table holds at most users x
 * maxLive rows however often anyone logs in. The user row is locked first
 * so two concurrent logins cannot both leave maxLive + 1, and so a password
 * reset that lands between the login's check and this insert is seen here:
 * the verified hash must still be the stored one, or no session is made.
 */
export async function createWebSession(
  db: Database,
  input: {
    id: string;
    userId: string;
    verifiedPasswordHash: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  },
): Promise<{ expiresAt: Date } | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
      .for("update");
    if (current?.passwordHash !== input.verifiedPasswordHash) {
      return null;
    }
    // Every account with a password has this row since 0138; the insert
    // only repairs one that lost it, so no session goes without its method.
    await tx.execute(
      sql`INSERT INTO ${loginMethods} ("id", "user_id", "kind")
          VALUES (gen_random_uuid(), ${input.userId}, 'password')
          ON CONFLICT DO NOTHING`,
    );
    const [method] = await tx
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(
        and(
          eq(loginMethods.userId, input.userId),
          eq(loginMethods.kind, "password"),
        ),
      );
    if (!method) {
      throw new Error("password login method is missing after its insert");
    }
    return insertWebSession(tx, { ...input, loginMethodId: method.id });
  });
}

type WebSessionInput = {
  id: string;
  userId: string;
  /** The login_methods row the user signed in with. */
  loginMethodId: string;
  tokenHash: Uint8Array;
  ttlMs: number;
  userAgent: string | null;
  maxLive: number;
};

// The caller holds the user's row lock, so two logins cannot both leave
// maxLive + 1 live sessions.
async function insertWebSession(
  tx: Database,
  input: WebSessionInput,
): Promise<{ expiresAt: Date }> {
  await tx
    .delete(webSessions)
    .where(
      and(
        eq(webSessions.userId, input.userId),
        or(
          lte(webSessions.expiresAt, DB_NOW),
          isNotNull(webSessions.revokedAt),
        ),
      ),
    );
  const [row] = await tx
    .insert(webSessions)
    .values({
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      // Not the column default now(): that is the transaction start, and
      // a login that waited longest for the user lock would sort oldest.
      createdAt: DB_NOW,
      expiresAt: fromDbNow(input.ttlMs),
      lastSeenAt: DB_NOW,
      userAgent: input.userAgent,
      loginMethodId: input.loginMethodId,
    })
    .returning({ expiresAt: webSessions.expiresAt });
  if (!row) {
    throw new Error("web session insert returned no row");
  }
  const keep = tx
    .select({ id: webSessions.id })
    .from(webSessions)
    .where(
      and(eq(webSessions.userId, input.userId), ne(webSessions.id, input.id)),
    )
    .orderBy(desc(webSessions.createdAt), desc(webSessions.id))
    .limit(Math.max(0, input.maxLive - 1));
  await tx
    .delete(webSessions)
    .where(
      and(
        eq(webSessions.userId, input.userId),
        ne(webSessions.id, input.id),
        notInArray(webSessions.id, keep),
      ),
    );
  return row;
}

/**
 * The first-entry rules for an external login (design 3.1, A.7), first
 * match wins: a linked (issuer, subject) signs in as its user; otherwise an
 * address that already has an account is never joined to it by email, and
 * only an address with no account may be admitted by a live invite or by
 * JIT. Concurrent first logins of one external account are serialised by
 * the advisory lock, so the second one finds the link the first made.
 *
 * Locks run subject, then provider row, then email, invite, user, login
 * method, session. The provider row is held FOR SHARE to the end, so
 * turning the provider off waits for this session and then ends it
 * (disableLoginProvider), or comes first and this makes none.
 */
export async function signInWithExternalIdentity(
  db: Database,
  input: ExternalSignInInput,
): Promise<ExternalSignInResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`login:${input.kind}:${input.issuer}:${input.subject}`}))`,
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
    if (!provider) {
      return { outcome: "provider_off" };
    }
    const [linked] = await tx
      .select({ id: loginMethods.id, userId: loginMethods.userId })
      .from(loginMethods)
      .where(
        and(
          eq(loginMethods.kind, input.kind),
          eq(loginMethods.issuer, input.issuer),
          eq(loginMethods.subject, input.subject),
        ),
      );
    if (linked) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, linked.userId), isNull(users.disabledAt)))
        .for("update");
      const membership = user ? await findLiveMembership(tx, user.id) : null;
      if (!membership) {
        return { outcome: "rejected" };
      }
      // The link was read before the user lock; it may have been removed
      // while this waited.
      const [stillLinked] = await tx
        .update(loginMethods)
        .set({ lastLoginAt: DB_NOW })
        .where(eq(loginMethods.id, linked.id))
        .returning({ id: loginMethods.id });
      if (!stillLinked) {
        return { outcome: "rejected" };
      }
      const { expiresAt } = await insertWebSession(tx, {
        ...input.session,
        userId: linked.userId,
        loginMethodId: linked.id,
      });
      return {
        outcome: "signed_in",
        via: "linked",
        userId: linked.userId,
        ...membership,
        expiresAt,
      };
    }
    // Past this point everything is decided by the address.
    const email = input.email;
    if (email === null) {
      return { outcome: "rejected" };
    }
    // Two subjects may claim one address; the second must see the first's
    // account. Always taken after the subject lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`login-email:${email}`}))`,
    );
    const [existing] = await tx
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.email, email));
    if (existing) {
      // Only someone the provider says owns the address now may learn it
      // has one.
      return existing.disabledAt === null && input.ownsEmail
        ? { outcome: "link_required" }
        : { outcome: "rejected" };
    }
    const [invite] = !input.ownsEmail
      ? []
      : await tx
          .select({
            id: invites.id,
            workspaceId: invites.workspaceId,
            role: invites.role,
          })
          .from(invites)
          .where(
            and(
              eq(invites.email, email),
              isNull(invites.acceptedAt),
              isNull(invites.revokedAt),
              gt(invites.expiresAt, DB_NOW),
            ),
          )
          .orderBy(asc(invites.createdAt), asc(invites.id))
          .limit(1)
          .for("update");
    // The expiry above was read before the lock wait.
    const inviteLive =
      invite !== undefined &&
      (await tx.$count(
        invites,
        and(eq(invites.id, invite.id), gt(invites.expiresAt, DB_NOW)),
      )) > 0;
    let admission: {
      via: "invite" | "jit";
      workspaceId: string;
      role: MembershipRole;
    };
    if (invite && inviteLive) {
      admission = {
        via: "invite",
        workspaceId: invite.workspaceId,
        role: invite.role as MembershipRole,
      };
    } else {
      // One workspace per installation (03 §3.1): JIT joins the oldest.
      // An address the provider does not vouch for joins nothing by itself.
      const jitRole = input.ownsEmail ? input.jitRole : null;
      const [workspace] = jitRole
        ? await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
            .limit(1)
        : [];
      if (!workspace || !jitRole) {
        return { outcome: "rejected" };
      }
      admission = {
        via: "jit",
        workspaceId: workspace.id,
        role: jitRole,
      };
    }
    await tx.insert(users).values({
      id: input.newUserId,
      email,
      passwordHash: null,
      displayName: input.displayName,
    });
    await tx.insert(memberships).values({
      workspaceId: admission.workspaceId,
      userId: input.newUserId,
      role: admission.role,
    });
    await tx.insert(loginMethods).values({
      id: input.newLoginMethodId,
      userId: input.newUserId,
      kind: input.kind,
      issuer: input.issuer,
      subject: input.subject,
      emailAtLink: email,
      lastLoginAt: DB_NOW,
    });
    if (admission.via === "invite" && invite) {
      await tx
        .update(invites)
        .set({ acceptedAt: DB_NOW })
        .where(eq(invites.id, invite.id));
      // The same receipt a password accept writes.
      await tx.insert(receipts).values({
        id: input.receiptId,
        ownerId: invite.workspaceId,
        actor: {
          principal: { kind: "user", id: input.newUserId },
          actor_user_id: input.newUserId,
          agent_id: null,
        },
        operation: "accept_invite",
        targetRef: {
          resource: { kind: "invite", id: invite.id },
          workspace_id: invite.workspaceId,
        },
        status: "succeeded",
        result: {
          user_id: input.newUserId,
          role: admission.role,
          new_account: true,
          login_method: input.kind,
          issuer: input.issuer,
        },
      });
    }
    const { expiresAt } = await insertWebSession(tx, {
      ...input.session,
      userId: input.newUserId,
      loginMethodId: input.newLoginMethodId,
    });
    return {
      outcome: "signed_in",
      via: admission.via,
      userId: input.newUserId,
      workspaceId: admission.workspaceId,
      role: admission.role,
      expiresAt,
    };
  });
}

class InviteExpiredWhileWaiting extends Error {}

/**
 * A sign-up through a provider by invite token (design 6.5). The invite is
 * what admits: the one the flow was started with, read again under its row
 * lock. The provider's word decides who is signing up, never which address
 * or which account; the first-entry rules of a sign-in are not consulted,
 * so a flow that began from an invite cannot end as an ordinary sign-in.
 *
 * Locks run as in signInWithExternalIdentity: subject, provider row, the
 * invite's address, invite, then the new rows.
 */
export async function signUpWithInvite(
  db: Database,
  input: InviteSignUpInput,
): Promise<InviteSignUpResult> {
  return db
    .transaction(async (tx): Promise<InviteSignUpResult> => {
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
      // An invite's address never changes, so reading it unlocked is enough
      // to name the lock every path that creates an account takes.
      const [named] = await tx
        .select({ email: invites.email })
        .from(invites)
        .where(eq(invites.id, input.inviteId));
      if (!named) return { outcome: "invite_gone" };
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`login-email:${named.email}`}))`,
      );
      const [invite] = await tx
        .select({
          id: invites.id,
          email: invites.email,
          workspaceId: invites.workspaceId,
          role: invites.role,
        })
        .from(invites)
        .where(
          and(
            eq(invites.id, input.inviteId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, DB_NOW),
          ),
        )
        .for("update");
      // Ahead of the link below: a dead invite signs nobody in, linked or not.
      if (!invite) return { outcome: "invite_gone" };
      // The expiry above was judged before the wait for the row lock, and a
      // lock that was only held, the row unchanged, does not judge it again.
      // Asked again after every wait that ends in an answer about somebody.
      const expired = async () =>
        (await tx.$count(
          invites,
          and(eq(invites.id, invite.id), gt(invites.expiresAt, DB_NOW)),
        )) === 0;
      if (await expired()) return { outcome: "invite_gone" };
      const [linked] = await tx
        .select({ id: loginMethods.id })
        .from(loginMethods)
        .where(
          and(
            eq(loginMethods.kind, "oidc"),
            eq(loginMethods.issuer, input.issuer),
            eq(loginMethods.subject, input.subject),
          ),
        );
      if (linked) return { outcome: "already_linked" };
      const role = invite.role as MembershipRole;
      const created = await tx
        .insert(users)
        .values({
          id: input.newUserId,
          email: invite.email,
          passwordHash: null,
          displayName: (
            input.name ?? invite.email.slice(0, invite.email.indexOf("@"))
          ).slice(0, 64),
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      // The address has an account, enabled or not. Whoever holds the token
      // knows the address already, so saying so tells them nothing new. The
      // insert may have waited for that account to be made, past the expiry.
      if (created.length === 0) {
        return { outcome: (await expired()) ? "invite_gone" : "link_required" };
      }
      await tx.insert(memberships).values({
        workspaceId: invite.workspaceId,
        userId: input.newUserId,
        role,
      });
      await tx.insert(loginMethods).values({
        id: input.newLoginMethodId,
        userId: input.newUserId,
        kind: "oidc",
        issuer: input.issuer,
        subject: input.subject,
        emailAtLink: input.vouchedEmail,
        lastLoginAt: DB_NOW,
      });
      // The invite was live when locked; the waits since can outlast it.
      const spent = await tx
        .update(invites)
        .set({ acceptedAt: DB_NOW })
        .where(and(eq(invites.id, invite.id), gt(invites.expiresAt, DB_NOW)))
        .returning({ id: invites.id });
      if (spent.length === 0) throw new InviteExpiredWhileWaiting();
      // The same receipt a password accept writes.
      await tx.insert(receipts).values({
        id: input.receiptId,
        ownerId: invite.workspaceId,
        actor: {
          principal: { kind: "user", id: input.newUserId },
          actor_user_id: input.newUserId,
          agent_id: null,
        },
        operation: "accept_invite",
        targetRef: {
          resource: { kind: "invite", id: invite.id },
          workspace_id: invite.workspaceId,
        },
        status: "succeeded",
        result: {
          user_id: input.newUserId,
          role,
          new_account: true,
          login_method: "oidc",
          issuer: input.issuer,
        },
      });
      const { expiresAt } = await insertWebSession(tx, {
        ...input.session,
        userId: input.newUserId,
        loginMethodId: input.newLoginMethodId,
      });
      return {
        outcome: "signed_in",
        userId: input.newUserId,
        workspaceId: invite.workspaceId,
        role,
        expiresAt,
      };
    })
    .catch((error: unknown) => {
      // Thrown, not returned: the account made above goes with the rollback.
      if (error instanceof InviteExpiredWhileWaiting) {
        return { outcome: "invite_gone" };
      }
      throw error;
    });
}

/**
 * The cookie's session, its user and the user's live membership in one
 * query, all judged on the database clock: an expired or revoked session, a
 * disabled account and a disabled membership all come back null.
 *
 * A session that names no login method was made before sessions recorded
 * one, so nothing says how its user signed in. It stands only while the user
 * has no external login method, when it can only have been a password: a
 * session that may have come from a provider cannot be cut when that
 * provider is turned off, so it is not accepted at all.
 */
export async function resolveWebSession(
  db: Database,
  tokenHash: Uint8Array,
): Promise<ResolvedWebSession | null> {
  const [row] = await db
    .select({
      sessionId: webSessions.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      locale: users.locale,
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      expiresAt: webSessions.expiresAt,
    })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), isNull(memberships.disabledAt)),
    )
    .where(
      and(
        eq(webSessions.tokenHash, tokenHash),
        isNull(webSessions.revokedAt),
        gt(webSessions.expiresAt, DB_NOW),
        isNull(users.disabledAt),
        or(
          isNotNull(webSessions.loginMethodId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${loginMethods}
            WHERE ${loginMethods.userId} = ${users.id}
              AND ${loginMethods.kind} <> 'password'
          )`,
        ),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return row ? { ...row, role: row.role as MembershipRole } : null;
}

/**
 * Sliding expiry. Only rows whose last touch is older than `renewAfterMs`
 * are written, so a busy tab does not turn every request into an UPDATE.
 * Returns the new expiry when the row was written, so the caller can move
 * the cookie's own Expires with it; null when nothing changed.
 */
export async function renewWebSession(
  db: Database,
  sessionId: string,
  ttlMs: number,
  renewAfterMs: number,
): Promise<Date | null> {
  const [row] = await db
    .update(webSessions)
    .set({ expiresAt: fromDbNow(ttlMs), lastSeenAt: DB_NOW })
    .where(
      and(
        eq(webSessions.id, sessionId),
        isNull(webSessions.revokedAt),
        or(
          isNull(webSessions.lastSeenAt),
          lt(
            webSessions.lastSeenAt,
            sql`clock_timestamp() - ${renewAfterMs}::double precision * interval '1 millisecond'`,
          ),
        ),
      ),
    )
    .returning({ expiresAt: webSessions.expiresAt });
  return row?.expiresAt ?? null;
}

export async function revokeWebSession(
  db: Database,
  tokenHash: Uint8Array,
): Promise<void> {
  await db
    .update(webSessions)
    .set({ revokedAt: DB_NOW })
    .where(
      and(eq(webSessions.tokenHash, tokenHash), isNull(webSessions.revokedAt)),
    );
}

/** Rows a login cookie can no longer resolve to stay this long, then go. */
export const EXPIRED_WEB_SESSION_KEEP_DAYS = 30;

/**
 * Deletes up to `limit` web sessions that expired more than
 * EXPIRED_WEB_SESSION_KEEP_DAYS ago; a dry run counts them. Invites and
 * password resets are not touched.
 */
export async function deleteExpiredWebSessions(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const expired = sql`
    SELECT id FROM ${webSessions}
    WHERE expires_at < statement_timestamp()
      - make_interval(days => ${EXPIRED_WEB_SESSION_KEEP_DAYS}::int)
    ORDER BY expires_at
    LIMIT ${input.limit}`;
  const result = await db.execute(
    input.dryRun
      ? expired
      : sql`DELETE FROM ${webSessions} WHERE id IN (${expired} FOR UPDATE SKIP LOCKED) RETURNING id`,
  );
  return rowsOf<{ id: string }>(result).length;
}

export async function setUserLocale(
  db: Database,
  userId: string,
  locale: UserLocale,
): Promise<void> {
  await db.update(users).set({ locale }).where(eq(users.id, userId));
}
