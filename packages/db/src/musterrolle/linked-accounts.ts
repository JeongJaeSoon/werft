import { randomUUID } from "node:crypto";
import type {
  ExternalAccountRef,
  LinkAccountResult,
  LinkedAccountRecord,
  LinkedAccountStore,
  LinkedSubject,
  MarkStaleResult,
  Principal,
  UnlinkAccountResult,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { actorStillMember } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  linkedAccounts,
  receipts,
  slackInstallations,
  workspaces,
} from "../schema.ts";
import { findLiveRole } from "./identity-reader.ts";

const columns = {
  id: linkedAccounts.id,
  workspaceId: linkedAccounts.workspaceId,
  userId: linkedAccounts.userId,
  provider: linkedAccounts.provider,
  externalTenant: linkedAccounts.externalTenant,
  externalUserId: linkedAccounts.externalUserId,
  externalTenantName: linkedAccounts.externalTenantName,
  externalUserName: linkedAccounts.externalUserName,
  status: linkedAccounts.status,
  revokedReason: linkedAccounts.revokedReason,
  verifiedAt: linkedAccounts.verifiedAt,
  revision: linkedAccounts.revision,
};

type Row = LinkedAccountRecord & {
  revokedReason: "unlinked" | "offboarded" | null;
};

function recordOf(row: Row): LinkedAccountRecord {
  const { revokedReason: _, ...record } = row;
  return record;
}

const byExternal = (account: ExternalAccountRef) =>
  and(
    eq(linkedAccounts.provider, account.provider),
    eq(linkedAccounts.externalTenant, account.externalTenant),
    eq(linkedAccounts.externalUserId, account.externalUserId),
  );

const live = ne(linkedAccounts.status, "revoked");

function auditRow(
  principal: Principal,
  workspaceId: string,
  operation: "link_account" | "unlink_account",
  account: LinkedAccountRecord,
) {
  const receiptId = randomUUID();
  return {
    receiptId,
    values: {
      id: receiptId,
      ownerId: workspaceId,
      actor: receiptActorOf(principal),
      operation,
      targetRef: { user_id: account.userId, workspace_id: workspaceId },
      status: "succeeded" as const,
      result: {
        linked_account_id: account.id,
        provider: account.provider,
        external_tenant: account.externalTenant,
        external_user_id: account.externalUserId,
        ...(account.provider === "github"
          ? { login: account.externalUserName }
          : {}),
        revision: account.revision,
      },
    },
  };
}

export async function installedSlackTeams(
  db: Database,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ teamId: slackInstallations.teamId })
    .from(slackInstallations)
    .where(
      and(
        eq(slackInstallations.workspaceId, workspaceId),
        eq(slackInstallations.status, "verified"),
      ),
    )
    .orderBy(asc(slackInstallations.teamId));
  return rows.map((row) => row.teamId);
}

async function link(
  db: Database,
  input: Parameters<LinkedAccountStore["link"]>[0],
): Promise<LinkAccountResult> {
  const { account, names, workspaceId } = input;
  const userId = input.userId.toLowerCase();
  return db.transaction(async (tx) => {
    // Membership first, as every actor write does, so an offboarding that
    // lands meanwhile either waits for this link and then revokes it, or
    // has already disabled the caller.
    if (!(await actorStillMember(tx, input.principal))) {
      return { outcome: "actor_inactive" };
    }
    // Every link in one Slack team queues here: the partial unique indexes
    // would otherwise turn a race into a constraint error instead of an
    // answer.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`linked_accounts:${account.provider}:${account.externalTenant}`}))`,
    );
    if (account.provider === "slack") {
      const teams = await installedSlackTeams(tx, workspaceId);
      if (teams.length === 0) return { outcome: "not_installed" };
      if (!teams.includes(account.externalTenant)) {
        const [workspace] = await tx
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        return {
          outcome: "team_mismatch",
          workspaceName: workspace?.name ?? "",
        };
      }
    }
    // Locked: unlink and markStale take no team lock, so the holder is
    // judged as their commit left it (a revoked one is no holder at all).
    const [holder] = await tx
      .select(columns)
      .from(linkedAccounts)
      .where(and(byExternal(account), live))
      .for("update");
    if (
      holder &&
      (holder.userId !== userId || holder.workspaceId !== workspaceId)
    ) {
      return { outcome: "taken" };
    }
    let linked: Row | undefined;
    if (holder) {
      const reactivated = holder.status !== "active";
      [linked] = await tx
        .update(linkedAccounts)
        .set({
          ...names,
          status: "active",
          verifiedAt: DB_NOW,
          updatedAt: DB_NOW,
          ...(reactivated
            ? { revision: sql`${linkedAccounts.revision} + 1` }
            : {}),
        })
        .where(eq(linkedAccounts.id, holder.id))
        .returning(columns);
    } else {
      const [other] = await tx
        .select({ id: linkedAccounts.id })
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.userId, userId),
            eq(linkedAccounts.provider, account.provider),
            eq(linkedAccounts.externalTenant, account.externalTenant),
            live,
          ),
        );
      if (other) return { outcome: "exists" };
      [linked] = await tx
        .insert(linkedAccounts)
        .values({
          id: randomUUID(),
          workspaceId,
          userId,
          provider: account.provider,
          externalTenant: account.externalTenant,
          externalUserId: account.externalUserId,
          ...names,
          status: "active",
          verifiedVia:
            account.provider === "github" ? "github_oauth" : "slack_oidc",
          verifiedAt: DB_NOW,
        })
        .returning(columns);
    }
    if (!linked) throw new Error("linked account write returned no row");
    const record = recordOf(linked);
    const audit = auditRow(
      input.principal,
      workspaceId,
      "link_account",
      record,
    );
    await tx.insert(receipts).values(audit.values);
    return { outcome: "linked", account: record, receiptId: audit.receiptId };
  });
}

async function unlink(
  db: Database,
  input: Parameters<LinkedAccountStore["unlink"]>[0],
): Promise<UnlinkAccountResult> {
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(linkedAccounts)
      .set({
        status: "revoked",
        revokedReason: "unlinked",
        revokedAt: DB_NOW,
        updatedAt: DB_NOW,
        revision: sql`${linkedAccounts.revision} + 1`,
      })
      .where(
        and(
          eq(linkedAccounts.id, input.linkedAccountId.toLowerCase()),
          eq(linkedAccounts.workspaceId, input.workspaceId),
          eq(linkedAccounts.userId, input.userId.toLowerCase()),
          live,
        ),
      )
      .returning(columns);
    if (!revoked) return { outcome: "not_found" };
    const audit = auditRow(
      input.principal,
      input.workspaceId,
      "unlink_account",
      recordOf(revoked),
    );
    await tx.insert(receipts).values(audit.values);
    return { outcome: "unlinked", receiptId: audit.receiptId };
  });
}

/**
 * Who the external account is now (design A.7): link, then user, then
 * membership, each read at the time of the call. The Slack channel calls
 * this for every event it processes, so an input that waited in the inbox
 * while its sender unlinked resolves to no one.
 */
export async function resolveLinkedSubject(
  db: Database,
  account: ExternalAccountRef,
): Promise<LinkedSubject> {
  const [current] = await db
    .select(columns)
    .from(linkedAccounts)
    .where(and(byExternal(account), live));
  if (current) {
    const ref = { id: current.id, revision: current.revision };
    const who = { userId: current.userId, workspaceId: current.workspaceId };
    if (current.status === "stale") {
      return { status: "stale", linkedAccount: ref, ...who };
    }
    const role = await findLiveRole(db, current.userId, current.workspaceId);
    return role === null
      ? { status: "disabled", linkedAccount: ref, ...who }
      : { status: "linked", linkedAccount: ref, ...who, role };
  }
  // No live row: an offboarded person is told apart from one who never
  // linked or unlinked, who is invited to link (again).
  const [last] = await db
    .select(columns)
    .from(linkedAccounts)
    .where(byExternal(account))
    .orderBy(desc(linkedAccounts.updatedAt), desc(linkedAccounts.id))
    .limit(1);
  if (last?.revokedReason === "offboarded") {
    return {
      status: "revoked",
      linkedAccount: { id: last.id, revision: last.revision },
      userId: last.userId,
      workspaceId: last.workspaceId,
    };
  }
  return { status: "unlinked" };
}

async function markStale(
  db: Database,
  account: ExternalAccountRef,
): Promise<MarkStaleResult> {
  const [stale] = await db
    .update(linkedAccounts)
    .set({
      status: "stale",
      updatedAt: DB_NOW,
      revision: sql`${linkedAccounts.revision} + 1`,
    })
    .where(and(byExternal(account), eq(linkedAccounts.status, "active")))
    .returning(columns);
  return stale
    ? { outcome: "stale", account: recordOf(stale) }
    : { outcome: "not_found" };
}

/** Offboarding's part, inside its transaction: every live link revoked. */
/** `workspaceId` null: every workspace, for a disabled account. */
export async function revokeUserLinkedAccounts(
  tx: Database,
  workspaceId: string | null,
  userId: string,
): Promise<number> {
  const revoked = await tx
    .update(linkedAccounts)
    .set({
      status: "revoked",
      revokedReason: "offboarded",
      revokedAt: DB_NOW,
      updatedAt: DB_NOW,
      revision: sql`${linkedAccounts.revision} + 1`,
    })
    .where(
      and(
        workspaceId === null
          ? undefined
          : eq(linkedAccounts.workspaceId, workspaceId),
        eq(linkedAccounts.userId, userId),
        live,
      ),
    )
    .returning({ id: linkedAccounts.id });
  return revoked.length;
}

export function createPostgresLinkedAccountStore(
  db: Database,
): LinkedAccountStore {
  return {
    installedSlackTeams: (workspaceId) => installedSlackTeams(db, workspaceId),
    link: (input) => link(db, input),
    unlink: (input) => unlink(db, input),
    async list(workspaceId, userId, limit) {
      const rows = await db
        .select(columns)
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.workspaceId, workspaceId),
            eq(linkedAccounts.userId, userId.toLowerCase()),
            live,
          ),
        )
        .orderBy(asc(linkedAccounts.createdAt), asc(linkedAccounts.id))
        .limit(limit);
      return rows.map(recordOf);
    },
    resolveLinkedSubject: (account) => resolveLinkedSubject(db, account),
    markStale: (account) => markStale(db, account),
  };
}
