import { randomUUID } from "node:crypto";
import {
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeApprovalId,
  type SlackNoticeVersion,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { and, asc, between, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  agents,
  memberships,
  receipts,
  slackInstallations,
  slackNoticeApprovals,
  users,
} from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";

export type SlackNoticeJudgment =
  | {
      approved: true;
      approvalId: SlackNoticeApprovalId;
      version: SlackNoticeVersion;
      slackTeamId: string;
    }
  | {
      approved: false;
      /**
       * `no_notice`: no version is published; `not_installed`: the agent has
       * no live Slack install; `not_approved`: no live approval in that
       * team within the counted versions.
       */
      reason: "no_notice" | "not_installed" | "not_approved";
    };

export type SlackNoticeApprovalRecord = {
  id: SlackNoticeApprovalId;
  workspaceId: string;
  agentId: string;
  slackTeamId: string;
  version: SlackNoticeVersion;
  approvedBy: string;
  approvedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
};

export type SlackNoticeApproval =
  | {
      /** `unchanged`: a live approval of this version in this team was there. */
      outcome: "approved" | "unchanged";
      approvalId: SlackNoticeApprovalId;
      version: SlackNoticeVersion;
      slackTeamId: string;
    }
  | { outcome: "not_found" | "not_admin" | "no_notice" | "not_installed" };

export type SlackNoticeRevoke =
  | {
      /** `unchanged`: nothing was live; no receipt is written. */
      outcome: "revoked" | "unchanged";
      approvalIds: SlackNoticeApprovalId[];
    }
  | { outcome: "not_found" | "not_admin" };

type Place = { workspaceId: string; agentId: string };

const recordColumns = {
  id: slackNoticeApprovals.id,
  workspaceId: slackNoticeApprovals.workspaceId,
  agentId: slackNoticeApprovals.agentId,
  slackTeamId: slackNoticeApprovals.slackTeamId,
  version: slackNoticeApprovals.noticeVersion,
  approvedBy: slackNoticeApprovals.approvedBy,
  approvedAt: slackNoticeApprovals.approvedAt,
  revokedBy: slackNoticeApprovals.revokedBy,
  revokedAt: slackNoticeApprovals.revokedAt,
};

const asRecord = (row: {
  id: string;
  version: number;
}): Pick<SlackNoticeApprovalRecord, "id" | "version"> => ({
  id: row.id as SlackNoticeApprovalId,
  version: row.version as SlackNoticeVersion,
});

/** The Slack team of the agent's live install, or null without one. */
async function liveTeamOf(tx: Database, place: Place): Promise<string | null> {
  const [row] = await tx
    .select({ teamId: slackInstallations.teamId })
    .from(agentIdentities)
    .innerJoin(
      slackInstallations,
      and(
        eq(slackInstallations.id, agentIdentities.installationId),
        eq(slackInstallations.workspaceId, agentIdentities.workspaceId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentIdentities.agentId),
        eq(agents.workspaceId, agentIdentities.workspaceId),
      ),
    )
    .where(
      and(
        eq(agentIdentities.workspaceId, place.workspaceId),
        eq(agentIdentities.agentId, place.agentId),
        eq(agentIdentities.status, "active"),
        ne(slackInstallations.status, "revoked"),
        notDeleted(agents),
      ),
    )
    .limit(1);
  return row?.teamId ?? null;
}

/**
 * Whether the agent is approved under the published notice: a live approval
 * in the Slack team of its live install, of a version from the latest one
 * that asked for a new approval up to the current one.
 */
export async function judgeSlackNotice(
  db: Database,
  place: Place,
  versions: readonly SlackNoticeVersionEntry[] = SLACK_NOTICE_VERSIONS,
): Promise<SlackNoticeJudgment> {
  const window = slackNoticeWindow(versions);
  if (window === null) return { approved: false, reason: "no_notice" };
  const slackTeamId = await liveTeamOf(db, place);
  if (slackTeamId === null) return { approved: false, reason: "not_installed" };
  const [row] = await db
    .select({
      id: slackNoticeApprovals.id,
      version: slackNoticeApprovals.noticeVersion,
    })
    .from(slackNoticeApprovals)
    .where(
      and(
        eq(slackNoticeApprovals.workspaceId, place.workspaceId),
        eq(slackNoticeApprovals.agentId, place.agentId),
        eq(slackNoticeApprovals.slackTeamId, slackTeamId),
        isNull(slackNoticeApprovals.revokedAt),
        between(
          slackNoticeApprovals.noticeVersion,
          window.oldestCounted,
          window.current,
        ),
      ),
    )
    .orderBy(desc(slackNoticeApprovals.noticeVersion))
    .limit(1);
  if (row === undefined) return { approved: false, reason: "not_approved" };
  const { id, version } = asRecord(row);
  return { approved: true, approvalId: id, version, slackTeamId };
}

// Lock order: the actor's membership, then the agent, as the identity and
// binding stores take theirs.
async function lockAdminAndAgent(
  tx: Database,
  place: Place,
  userId: string,
): Promise<"not_admin" | "not_found" | null> {
  const [admin] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, place.workspaceId),
        eq(memberships.userId, userId),
        inArray(memberships.role, [...WORKSPACE_MANAGER_ROLES]),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .for("share", { of: memberships });
  if (admin === undefined) return "not_admin";
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, place.workspaceId),
        eq(agents.id, place.agentId),
        notDeleted(agents),
      ),
    )
    .for("update");
  return agent === undefined ? "not_found" : null;
}

const actorOf = (userId: string) => ({
  principal: { kind: "user", id: userId },
  actor_user_id: userId,
  agent_id: null,
});

/**
 * A workspace owner's or admin's approval of the current notice version for
 * the agent's app in the Slack team of its live install, with its receipt in
 * the same transaction.
 */
export async function approveSlackNotice(
  db: Database,
  input: Place & { by: string; requestId?: string },
  versions: readonly SlackNoticeVersionEntry[] = SLACK_NOTICE_VERSIONS,
): Promise<SlackNoticeApproval> {
  const window = slackNoticeWindow(versions);
  if (window === null) return { outcome: "no_notice" };
  const version = window.current;
  return db.transaction(async (tx) => {
    const refused = await lockAdminAndAgent(tx, input, input.by);
    if (refused !== null) return { outcome: refused };
    const slackTeamId = await liveTeamOf(tx, input);
    if (slackTeamId === null) return { outcome: "not_installed" };
    const [live] = await tx
      .select({ id: slackNoticeApprovals.id })
      .from(slackNoticeApprovals)
      .where(
        and(
          eq(slackNoticeApprovals.agentId, input.agentId),
          eq(slackNoticeApprovals.slackTeamId, slackTeamId),
          eq(slackNoticeApprovals.noticeVersion, version),
          isNull(slackNoticeApprovals.revokedAt),
        ),
      );
    if (live !== undefined) {
      return {
        outcome: "unchanged",
        approvalId: live.id as SlackNoticeApprovalId,
        version,
        slackTeamId,
      };
    }
    const approvalId = randomUUID() as SlackNoticeApprovalId;
    await tx.insert(slackNoticeApprovals).values({
      id: approvalId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      slackTeamId,
      noticeVersion: version,
      approvedBy: input.by,
      approvedAt: DB_NOW,
    });
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: input.workspaceId,
      operation: "approve_slack_notice",
      targetRef: {
        resource: { kind: "agent", id: input.agentId },
        workspace_id: input.workspaceId,
      },
      status: "succeeded",
      result: {
        agent_id: input.agentId,
        approval_id: approvalId,
        slack_team_id: slackTeamId,
        notice_version: version,
      },
      actor: actorOf(input.by),
      requestId: input.requestId ?? null,
    });
    return { outcome: "approved", approvalId, version, slackTeamId };
  });
}

/**
 * Revokes every live approval of the agent, in any Slack team, with one
 * receipt naming them. Nothing live is `unchanged` and writes nothing.
 */
export async function revokeSlackNotice(
  db: Database,
  input: Place & { by: string; requestId?: string },
): Promise<SlackNoticeRevoke> {
  return db.transaction(async (tx) => {
    const refused = await lockAdminAndAgent(tx, input, input.by);
    if (refused !== null) return { outcome: refused };
    const revoked = await tx
      .update(slackNoticeApprovals)
      .set({ revokedAt: DB_NOW, revokedBy: input.by })
      .where(
        and(
          eq(slackNoticeApprovals.workspaceId, input.workspaceId),
          eq(slackNoticeApprovals.agentId, input.agentId),
          isNull(slackNoticeApprovals.revokedAt),
        ),
      )
      .returning({
        id: slackNoticeApprovals.id,
        slackTeamId: slackNoticeApprovals.slackTeamId,
        version: slackNoticeApprovals.noticeVersion,
      });
    const approvalIds = revoked
      .map((row) => row.id as SlackNoticeApprovalId)
      .sort();
    if (approvalIds.length === 0) return { outcome: "unchanged", approvalIds };
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: input.workspaceId,
      operation: "revoke_slack_notice",
      targetRef: {
        resource: { kind: "agent", id: input.agentId },
        workspace_id: input.workspaceId,
      },
      status: "succeeded",
      result: {
        agent_id: input.agentId,
        approval_ids: approvalIds,
        slack_team_ids: [
          ...new Set(revoked.map((row) => row.slackTeamId)),
        ].sort(),
        notice_versions: [...new Set(revoked.map((row) => row.version))].sort(
          (a, b) => a - b,
        ),
      },
      actor: actorOf(input.by),
      requestId: input.requestId ?? null,
    });
    return { outcome: "revoked", approvalIds };
  });
}

/** Every approval row of one agent, or of a workspace's agents, oldest first. */
export async function listSlackNoticeApprovals(
  db: Database,
  filter: { agentId: string } | { workspaceId: string },
): Promise<SlackNoticeApprovalRecord[]> {
  const rows = await db
    .select(recordColumns)
    .from(slackNoticeApprovals)
    .where(
      "agentId" in filter
        ? eq(slackNoticeApprovals.agentId, filter.agentId)
        : eq(slackNoticeApprovals.workspaceId, filter.workspaceId),
    )
    .orderBy(
      asc(slackNoticeApprovals.approvedAt),
      asc(slackNoticeApprovals.id),
    );
  return rows.map((row) => ({ ...row, ...asRecord(row) }));
}
